// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/* eslint-disable @typescript-eslint/no-unnecessary-condition --
 * This file contains many `const [x] = await db.select()...limit(1); if (!x)` patterns
 * and record-index lookups. Under the current tsconfig (no `noUncheckedIndexedAccess`),
 * TypeScript narrows destructured array elements and record indices to non-undefined,
 * so the runtime guards look "unnecessary" to the rule. They are not — empty result
 * sets and unknown keys still produce undefined at runtime. Remove this directive
 * when the project enables `noUncheckedIndexedAccess`.
 */
import { and, eq, inArray, or } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db'
import { notDeleted } from '../db/filters'
import {
  designs,
  itemRelationships,
  items,
  physicalParts,
  requirements,
  workOrders,
} from '../db/schema'
import { NotFoundError } from '../errors'
import { EBOM_SOURCE_RELATIONSHIP } from './MbomService'
import { RELATIONSHIP_EVIDENCES } from './QualificationService'
import {
  SATISFIES_RELATIONSHIP,
  VERIFIED_BY_RELATIONSHIP,
} from './RequirementService'
import { ThreadCacheService } from './ThreadCacheService'
import { VALIDATES_RELATIONSHIP } from './VerificationService'
import { VersionResolver } from './VersionResolver'
import {
  RELATIONSHIP_CONSUMES,
  RELATIONSHIP_PRODUCES,
} from './WorkOrderMaterialService'
import type { VersionContext } from './VersionResolver'
import { serviceLogger } from '@/lib/logging/logger'

/**
 * Domain types for the digital thread
 * - requirements: Requirements domain (traceability)
 * - engineering: Engineering domain (EBOM)
 * - manufacturing: Manufacturing domain (MBOM)
 * - validation: Validation domain (test cases)
 * - physical: Physical domain (work orders, serialized units, lots)
 */
export type ThreadDomain =
  'requirements' | 'engineering' | 'manufacturing' | 'validation' | 'physical'

/**
 * Synthetic thread edge types (derived from columns, not stored edges):
 * INSTANCE_OF links a PhysicalPart to the Part lineage it instantiates;
 * BUILDS links a WorkOrder to the exact part version it builds.
 */
export const INSTANCE_OF_RELATIONSHIP = 'INSTANCE_OF'
export const BUILDS_RELATIONSHIP = 'BUILDS'

/**
 * Node in the digital thread graph.
 * Design fields are null for design-less operational items (WorkOrder,
 * PhysicalPart) — the physical domain rides the identity layer only.
 */
export interface ThreadNode {
  id: string
  masterId: string
  itemNumber: string
  name: string | null
  itemType: string
  revision: string
  state: string
  domain: ThreadDomain
  designId: string | null
  designCode: string | null
  designName: string | null
  isFocalItem: boolean
}

/**
 * Edge in the digital thread graph
 */
export interface ThreadEdge {
  id: string
  sourceId: string
  targetId: string
  relationshipType: string
  domain: 'same' | 'cross' // Same domain (BOM) or cross-domain (EBOM_SOURCE)
  quantity: string | null
  derivationMethod: string | null
}

/**
 * Complete digital thread response
 */
export interface ThreadResponse {
  focalItem: ThreadNode
  domains: {
    requirements: Array<ThreadNode>
    engineering: Array<ThreadNode>
    manufacturing: Array<ThreadNode>
    validation: Array<ThreadNode>
    physical: Array<ThreadNode>
  }
  relationships: Array<ThreadEdge>
  stats: {
    totalNodes: number
    totalRelationships: number
    mbomCoverage: number // % of EBOM items with MBOM mapping
    requirementsCoverage: number // % of items with requirements satisfied
    testCoverage: number // % of requirements with test cases
  }
}

/**
 * Request parameters for getting a thread
 */
export const threadRequestSchema = z.object({
  itemId: z.string().uuid(),
  domains: z
    .array(
      z.enum([
        'requirements',
        'engineering',
        'manufacturing',
        'validation',
        'physical',
      ]),
    )
    .optional()
    .default([
      'requirements',
      'engineering',
      'manufacturing',
      'validation',
      'physical',
    ]),
  upstreamDepth: z.number().int().min(0).max(10).optional().default(5),
  downstreamDepth: z.number().int().min(0).max(10).optional().default(5),
  bomDepth: z.number().int().min(0).max(10).optional().default(3),
  requirementsDepth: z.number().int().min(0).max(10).optional().default(3),
  validationDepth: z.number().int().min(0).max(10).optional().default(3),
  /** WO↔PhysicalPart hops beyond the focal item's first physical ring */
  physicalDepth: z.number().int().min(0).max(10).optional().default(4),
})

export type ThreadRequest = z.input<typeof threadRequestSchema>

/**
 * Shared state for one physical-domain walk (WO ↔ PhysicalPart web).
 */
interface PhysicalWalkContext {
  focalId: string
  focalMasterId: string
  physicalNodes: Array<ThreadNode>
  engineeringNodes: Array<ThreadNode>
  manufacturingNodes: Array<ThreadNode>
  relationships: Array<ThreadEdge>
  visitedIds: Set<string>
  /** Instances reached in this walk, for evidence collection */
  physicalPartIds: Set<string>
}

/** Full item row as stored — what traversals fetch and resolvers return. */
type ItemRow = typeof items.$inferSelect

/**
 * Strategy for resolving a fetched item row to the version that should
 * appear in the thread. The live thread shows rows as-is (identity); the
 * at-context thread maps each row's lineage to its version at a
 * VersionContext via VersionResolver, or null when the item does not exist
 * there. The shared traversals are parameterized by this strategy — it is
 * the only intended difference between the live and at-context walks.
 */
interface ItemResolutionStrategy {
  /**
   * True when resolve() always returns the row it was given (live thread).
   * Traversals use this to skip already-visited raw ids before fetching the
   * row — an optimization that is only sound when raw and resolved ids
   * coincide.
   */
  readonly preservesIdentity: boolean
  /** Resolve a row, or null when the item does not exist at the context. */
  resolve: (item: ItemRow) => Promise<ItemRow | null>
}

/** Live-thread strategy: every fetched row is already the version to show. */
const CURRENT_ITEMS: ItemResolutionStrategy = {
  preservesIdentity: true,
  resolve: (item) => Promise.resolve(item),
}

/**
 * At-context strategy. Design-less rows (WorkOrder, PhysicalPart) pass
 * through unchanged — they are non-versioned.
 */
function itemsAtContext(context: VersionContext): ItemResolutionStrategy {
  return {
    preservesIdentity: false,
    resolve: (item) =>
      item.designId
        ? VersionResolver.getItemAtContext(
            item.masterId,
            item.designId,
            context,
          )
        : Promise.resolve(item),
  }
}

/**
 * Service for traversing and visualizing the Digital Thread
 */
export class ThreadService {
  /**
   * Get the digital thread for an item.
   * Returns nodes organized by domain and relationships between them.
   * Uses caching to avoid N+1 query patterns on repeated requests.
   */
  static async getThread(request: ThreadRequest): Promise<ThreadResponse> {
    // Check cache first
    const cached = await ThreadCacheService.getCachedThread(request)
    if (cached) {
      return cached
    }

    // Cache miss - compute the thread
    const startTime = Date.now()
    const result = await this.computeThread(request)
    const computationTimeMs = Date.now() - startTime

    // Cache the result (fire and forget)
    ThreadCacheService.cacheThread(request, result, computationTimeMs).catch(
      (err) => {
        serviceLogger.warn({ err }, 'Failed to cache thread result')
      },
    )

    return result
  }

  /**
   * Internal method to compute the thread (without caching).
   * Separated from getThread to enable caching wrapper.
   */
  private static async computeThread(
    request: ThreadRequest,
  ): Promise<ThreadResponse> {
    const validated = threadRequestSchema.parse(request)

    // Get the focal item
    const [focalItemData] = await db
      .select()
      .from(items)
      .where(and(eq(items.id, validated.itemId), notDeleted()))
      .limit(1)

    if (!focalItemData) {
      throw new NotFoundError('Item', validated.itemId, {
        operation: 'getThread',
      })
    }

    return this.buildThread(validated, focalItemData, CURRENT_ITEMS, {
      includePhysical: true,
    })
  }

  /**
   * Get the digital thread for an item at a specific version context.
   * Uses VersionResolver to resolve items at the given context (tag, branch, commit, or released).
   * Uses caching to avoid N+1 query patterns on repeated requests.
   */
  static async getThreadAtContext(
    request: ThreadRequest,
    context: VersionContext,
  ): Promise<ThreadResponse> {
    // Check cache first
    const cached = await ThreadCacheService.getCachedThread(request, context)
    if (cached) {
      return cached
    }

    // Cache miss - compute the thread
    const startTime = Date.now()
    const result = await this.computeThreadAtContext(request, context)
    const computationTimeMs = Date.now() - startTime

    // Cache the result (fire and forget)
    ThreadCacheService.cacheThread(
      request,
      result,
      computationTimeMs,
      context,
    ).catch((err) => {
      serviceLogger.warn({ err }, 'Failed to cache thread result')
    })

    return result
  }

  /**
   * Internal method to compute the thread at a version context (without caching).
   * Separated from getThreadAtContext to enable caching wrapper.
   */
  private static async computeThreadAtContext(
    request: ThreadRequest,
    context: VersionContext,
  ): Promise<ThreadResponse> {
    const validated = threadRequestSchema.parse(request)

    // Get the focal item
    const [focalItemData] = await db
      .select()
      .from(items)
      .where(and(eq(items.id, validated.itemId), notDeleted()))
      .limit(1)

    if (!focalItemData) {
      throw new NotFoundError('Item', validated.itemId, {
        operation: 'getThreadAtContext',
      })
    }

    const designId = focalItemData.designId
    if (!designId) {
      throw new NotFoundError('Design', 'null', {
        operation: 'getThreadAtContext',
        detail: 'Item has no associated design',
      })
    }

    // Resolve the focal item at the specified context
    const resolvedFocalItem = await VersionResolver.getItemAtContext(
      focalItemData.masterId,
      designId,
      context,
    )

    // If item doesn't exist at this context, throw error
    if (!resolvedFocalItem) {
      throw new NotFoundError('Item', validated.itemId, {
        operation: 'getThreadAtContext',
        detail: 'Item does not exist at the specified version context',
      })
    }

    // Physical reality does not time-travel: WOs and physical parts are
    // non-versioned, so a context thread has no physical lane. The live
    // thread (computeThread) carries it.
    return this.buildThread(
      validated,
      resolvedFocalItem,
      itemsAtContext(context),
      { includePhysical: false },
    )
  }

  /**
   * Shared thread computation behind computeThread/computeThreadAtContext.
   * The focal item row is already resolved by the caller; every further
   * item reached by a traversal is resolved through the injected strategy.
   */
  private static async buildThread(
    validated: z.output<typeof threadRequestSchema>,
    focalItemData: ItemRow,
    resolver: ItemResolutionStrategy,
    options: { includePhysical: boolean },
  ): Promise<ThreadResponse> {
    // Get the design for the focal item
    const focalDesign = await this.getDesign(focalItemData.designId)

    // Determine focal item domain - requirements and test cases have their own domains
    const focalDomain =
      focalItemData.itemType === 'Requirement'
        ? 'requirements'
        : this.inferDomain(
            focalDesign?.designType ?? 'Engineering',
            focalItemData.itemType,
          )

    const focalNode: ThreadNode = {
      id: focalItemData.id,
      masterId: focalItemData.masterId,
      itemNumber: focalItemData.itemNumber,
      name: focalItemData.name,
      itemType: focalItemData.itemType,
      revision: focalItemData.revision,
      state: focalItemData.state,
      domain: focalDomain,
      designId: focalDesign?.id ?? null,
      designCode: focalDesign?.code ?? null,
      designName: focalDesign?.name ?? null,
      isFocalItem: true,
    }

    const requirementsNodes: Array<ThreadNode> = []
    const engineeringNodes: Array<ThreadNode> = []
    const manufacturingNodes: Array<ThreadNode> = []
    const validationNodes: Array<ThreadNode> = []
    const physicalNodes: Array<ThreadNode> = []
    const allRelationships: Array<ThreadEdge> = []
    const visitedIds = new Set<string>([focalItemData.id])

    // Add focal item to appropriate domain
    if (focalDomain === 'requirements') {
      requirementsNodes.push(focalNode)
    } else if (focalDomain === 'engineering') {
      engineeringNodes.push(focalNode)
    } else if (focalDomain === 'validation') {
      validationNodes.push(focalNode)
    } else if (focalDomain === 'physical') {
      physicalNodes.push(focalNode)
    } else {
      manufacturingNodes.push(focalNode)
    }

    // Traverse upstream (toward source)
    if (
      validated.upstreamDepth > 0 &&
      validated.domains.includes('engineering')
    ) {
      await this.traverseUpstream(
        focalItemData.id,
        validated.upstreamDepth,
        engineeringNodes,
        manufacturingNodes,
        allRelationships,
        visitedIds,
        resolver,
      )
    }

    // Traverse downstream (toward derived)
    if (
      validated.downstreamDepth > 0 &&
      validated.domains.includes('manufacturing')
    ) {
      await this.traverseDownstream(
        focalItemData.id,
        validated.downstreamDepth,
        engineeringNodes,
        manufacturingNodes,
        allRelationships,
        visitedIds,
        resolver,
      )
    }

    // Traverse BOM within the focal item's domain
    if (validated.bomDepth > 0 && focalDomain !== 'requirements') {
      await this.traverseBom(
        focalItemData.id,
        validated.bomDepth,
        engineeringNodes,
        manufacturingNodes,
        allRelationships,
        visitedIds,
        resolver,
      )
    }

    // Traverse requirements (SATISFIES relationships)
    if (
      validated.requirementsDepth > 0 &&
      validated.domains.includes('requirements')
    ) {
      await this.traverseRequirements(
        focalItemData.id,
        validated.requirementsDepth,
        requirementsNodes,
        allRelationships,
        visitedIds,
        resolver,
      )
    }

    // Traverse validation (VERIFIED_BY and VALIDATES relationships)
    if (
      validated.validationDepth > 0 &&
      validated.domains.includes('validation')
    ) {
      await this.traverseValidation(
        focalItemData.id,
        validated.validationDepth,
        validationNodes,
        requirementsNodes,
        allRelationships,
        visitedIds,
        resolver,
      )
    }

    // Traverse the physical domain (Consumes/Produces edges) — live only
    if (
      options.includePhysical &&
      validated.physicalDepth > 0 &&
      validated.domains.includes('physical')
    ) {
      await this.traversePhysical(
        {
          id: focalItemData.id,
          masterId: focalItemData.masterId,
          itemType: focalItemData.itemType,
        },
        validated.physicalDepth,
        validated.domains.includes('requirements'),
        physicalNodes,
        engineeringNodes,
        manufacturingNodes,
        requirementsNodes,
        allRelationships,
        visitedIds,
      )
    }

    // Calculate coverage metrics
    const mbomCoverage = this.calculateMbomCoverage(
      engineeringNodes,
      manufacturingNodes,
      allRelationships,
    )

    const requirementsCoverage = this.calculateRequirementsCoverage(
      engineeringNodes,
      manufacturingNodes,
      requirementsNodes,
      allRelationships,
    )

    const testCoverage = this.calculateTestCoverage(
      requirementsNodes,
      validationNodes,
      allRelationships,
    )

    return {
      focalItem: focalNode,
      domains: {
        requirements: requirementsNodes,
        engineering: engineeringNodes,
        manufacturing: manufacturingNodes,
        validation: validationNodes,
        physical: physicalNodes,
      },
      relationships: allRelationships,
      stats: {
        totalNodes:
          requirementsNodes.length +
          engineeringNodes.length +
          manufacturingNodes.length +
          validationNodes.length +
          physicalNodes.length,
        totalRelationships: allRelationships.length,
        mbomCoverage,
        requirementsCoverage,
        testCoverage,
      },
    }
  }

  /** Fetch a design row by id (null id → null). */
  private static async getDesign(
    designId: string | null,
  ): Promise<typeof designs.$inferSelect | null> {
    if (!designId) return null

    const [design] = await db
      .select()
      .from(designs)
      .where(eq(designs.id, designId))
      .limit(1)

    return design ?? null
  }

  /**
   * Fetch a related item row (optionally constrained to an item type) and
   * resolve it through the strategy. Null when the row is missing, deleted,
   * or absent at the strategy's context.
   */
  private static async fetchResolved(
    itemId: string,
    resolver: ItemResolutionStrategy,
    itemType?: string,
  ): Promise<ItemRow | null> {
    const conditions = [eq(items.id, itemId), notDeleted()]
    if (itemType) {
      conditions.push(eq(items.itemType, itemType))
    }

    const [row] = await db
      .select()
      .from(items)
      .where(and(...conditions))
      .limit(1)

    if (!row) return null

    return resolver.resolve(row)
  }

  /**
   * Build a non-focal ThreadNode for an item; the domain is inferred from
   * the item's design unless fixed by the caller.
   */
  private static async toNode(
    item: ItemRow,
    fixedDomain?: ThreadDomain,
  ): Promise<ThreadNode> {
    const design = await this.getDesign(item.designId)
    const domain =
      fixedDomain ??
      this.inferDomain(design?.designType ?? 'Engineering', item.itemType)

    return {
      id: item.id,
      masterId: item.masterId,
      itemNumber: item.itemNumber,
      name: item.name,
      itemType: item.itemType,
      revision: item.revision,
      state: item.state,
      domain,
      designId: design?.id ?? null,
      designCode: design?.code ?? null,
      designName: design?.name ?? null,
      isFocalItem: false,
    }
  }

  /** Route a node into the engineering or manufacturing lane by domain. */
  private static pushDesignDomainNode(
    node: ThreadNode,
    engineeringNodes: Array<ThreadNode>,
    manufacturingNodes: Array<ThreadNode>,
  ): void {
    if (node.domain === 'engineering') {
      engineeringNodes.push(node)
    } else if (node.domain === 'manufacturing') {
      manufacturingNodes.push(node)
    }
  }

  /** Push an edge unless one with the same id is already recorded. */
  private static pushEdgeUnique(
    relationships: Array<ThreadEdge>,
    edge: ThreadEdge,
  ): void {
    if (!relationships.some((r) => r.id === edge.id)) {
      relationships.push(edge)
    }
  }

  /**
   * Infer the domain from design type and item type
   */
  static inferDomain(
    designType: string | null,
    itemType?: string,
  ): ThreadDomain {
    // Test cases belong to validation domain
    if (itemType === 'TestCase' || itemType === 'TestPlan') {
      return 'validation'
    }
    // Design-less operational items belong to the physical domain
    if (itemType === 'WorkOrder' || itemType === 'PhysicalPart') {
      return 'physical'
    }
    if (designType === 'Manufacturing') {
      return 'manufacturing'
    }
    // Engineering, design, or any other type is considered engineering
    return 'engineering'
  }

  /**
   * Traverse upstream (toward EBOM source from MBOM)
   */
  private static async traverseUpstream(
    itemId: string,
    depth: number,
    engineeringNodes: Array<ThreadNode>,
    manufacturingNodes: Array<ThreadNode>,
    relationships: Array<ThreadEdge>,
    visitedIds: Set<string>,
    resolver: ItemResolutionStrategy,
  ): Promise<void> {
    if (depth <= 0) return

    // Find EBOM_SOURCE relationships where this item is the target (MBOM item)
    const upstreamRels = await db
      .select()
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.targetId, itemId),
          eq(itemRelationships.relationshipType, EBOM_SOURCE_RELATIONSHIP),
        ),
      )

    for (const rel of upstreamRels) {
      if (resolver.preservesIdentity && visitedIds.has(rel.sourceId)) continue

      // Get the source item (EBOM item) at the resolver's context
      const resolvedItem = await this.fetchResolved(rel.sourceId, resolver)
      if (!resolvedItem || visitedIds.has(resolvedItem.id)) continue

      visitedIds.add(resolvedItem.id)

      const node = await this.toNode(resolvedItem)
      this.pushDesignDomainNode(node, engineeringNodes, manufacturingNodes)

      relationships.push({
        id: rel.id,
        sourceId: resolvedItem.id,
        targetId: itemId,
        relationshipType: rel.relationshipType,
        domain: 'cross',
        quantity: rel.quantity,
        derivationMethod: rel.derivationMethod,
      })

      // Continue traversing upstream
      await this.traverseUpstream(
        resolvedItem.id,
        depth - 1,
        engineeringNodes,
        manufacturingNodes,
        relationships,
        visitedIds,
        resolver,
      )
    }
  }

  /**
   * Traverse downstream (toward MBOM derived from EBOM)
   */
  private static async traverseDownstream(
    itemId: string,
    depth: number,
    engineeringNodes: Array<ThreadNode>,
    manufacturingNodes: Array<ThreadNode>,
    relationships: Array<ThreadEdge>,
    visitedIds: Set<string>,
    resolver: ItemResolutionStrategy,
  ): Promise<void> {
    if (depth <= 0) return

    // Find EBOM_SOURCE relationships where this item is the source (EBOM item)
    const downstreamRels = await db
      .select()
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.sourceId, itemId),
          eq(itemRelationships.relationshipType, EBOM_SOURCE_RELATIONSHIP),
        ),
      )

    for (const rel of downstreamRels) {
      if (resolver.preservesIdentity && visitedIds.has(rel.targetId)) continue

      // Get the target item (MBOM item) at the resolver's context
      const resolvedItem = await this.fetchResolved(rel.targetId, resolver)
      if (!resolvedItem || visitedIds.has(resolvedItem.id)) continue

      visitedIds.add(resolvedItem.id)

      const node = await this.toNode(resolvedItem)
      this.pushDesignDomainNode(node, engineeringNodes, manufacturingNodes)

      relationships.push({
        id: rel.id,
        sourceId: itemId,
        targetId: resolvedItem.id,
        relationshipType: rel.relationshipType,
        domain: 'cross',
        quantity: rel.quantity,
        derivationMethod: rel.derivationMethod,
      })

      // Continue traversing downstream
      await this.traverseDownstream(
        resolvedItem.id,
        depth - 1,
        engineeringNodes,
        manufacturingNodes,
        relationships,
        visitedIds,
        resolver,
      )
    }
  }

  /**
   * Traverse BOM relationships within the same domain
   */
  private static async traverseBom(
    itemId: string,
    depth: number,
    engineeringNodes: Array<ThreadNode>,
    manufacturingNodes: Array<ThreadNode>,
    relationships: Array<ThreadEdge>,
    visitedIds: Set<string>,
    resolver: ItemResolutionStrategy,
  ): Promise<void> {
    if (depth <= 0) return

    // Find BOM relationships where this item is the parent
    const bomRels = await db
      .select()
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.sourceId, itemId),
          eq(itemRelationships.relationshipType, 'BOM'),
        ),
      )

    for (const rel of bomRels) {
      if (resolver.preservesIdentity && visitedIds.has(rel.targetId)) continue

      // Get the child item at the resolver's context
      const resolvedItem = await this.fetchResolved(rel.targetId, resolver)
      if (!resolvedItem || visitedIds.has(resolvedItem.id)) continue

      visitedIds.add(resolvedItem.id)

      const node = await this.toNode(resolvedItem)
      this.pushDesignDomainNode(node, engineeringNodes, manufacturingNodes)

      relationships.push({
        id: rel.id,
        sourceId: itemId,
        targetId: resolvedItem.id,
        relationshipType: rel.relationshipType,
        domain: 'same',
        quantity: rel.quantity,
        derivationMethod: null,
      })

      // Continue traversing BOM
      await this.traverseBom(
        resolvedItem.id,
        depth - 1,
        engineeringNodes,
        manufacturingNodes,
        relationships,
        visitedIds,
        resolver,
      )

      // Also traverse cross-domain for BOM children
      await this.traverseDownstream(
        resolvedItem.id,
        1, // Only one level for BOM children
        engineeringNodes,
        manufacturingNodes,
        relationships,
        visitedIds,
        resolver,
      )
    }
  }

  /**
   * Traverse requirements (SATISFIES relationships)
   * Finds requirements that the item satisfies (item is source, requirement is target)
   * Also finds items that satisfy requirements if starting from a requirement
   */
  private static async traverseRequirements(
    itemId: string,
    depth: number,
    requirementsNodes: Array<ThreadNode>,
    relationships: Array<ThreadEdge>,
    visitedIds: Set<string>,
    resolver: ItemResolutionStrategy,
  ): Promise<void> {
    if (depth <= 0) return

    // Find SATISFIES relationships where this item is the source (satisfies a requirement)
    const satisfiesRels = await db
      .select()
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.sourceId, itemId),
          eq(itemRelationships.relationshipType, SATISFIES_RELATIONSHIP),
        ),
      )

    for (const rel of satisfiesRels) {
      if (resolver.preservesIdentity && visitedIds.has(rel.targetId)) continue

      // Get the requirement at the resolver's context
      const resolvedItem = await this.fetchResolved(
        rel.targetId,
        resolver,
        'Requirement',
      )
      if (!resolvedItem || visitedIds.has(resolvedItem.id)) continue

      visitedIds.add(resolvedItem.id)

      requirementsNodes.push(await this.toNode(resolvedItem, 'requirements'))

      relationships.push({
        id: rel.id,
        sourceId: itemId,
        targetId: resolvedItem.id,
        relationshipType: rel.relationshipType,
        domain: 'cross',
        quantity: rel.quantity,
        derivationMethod: null,
      })

      // Traverse parent requirements
      await this.traverseParentRequirements(
        resolvedItem.id,
        depth - 1,
        requirementsNodes,
        relationships,
        visitedIds,
        resolver,
      )
    }

    // Find SATISFIES relationships where this item is the target (is a requirement being satisfied)
    const satisfiedByRels = await db
      .select()
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.targetId, itemId),
          eq(itemRelationships.relationshipType, SATISFIES_RELATIONSHIP),
        ),
      )

    for (const rel of satisfiedByRels) {
      if (visitedIds.has(rel.sourceId)) continue

      // The satisfying item must still exist (not deleted) for the edge to
      // be meaningful. It is not added to requirementsNodes — it belongs in
      // the engineering/manufacturing domains — but the relationship is
      // recorded to show the connection.
      const [sourceItem] = await db
        .select({ id: items.id })
        .from(items)
        .where(and(eq(items.id, rel.sourceId), notDeleted()))
        .limit(1)

      if (!sourceItem) continue

      relationships.push({
        id: rel.id,
        sourceId: rel.sourceId,
        targetId: itemId,
        relationshipType: rel.relationshipType,
        domain: 'cross',
        quantity: rel.quantity,
        derivationMethod: null,
      })
    }
  }

  /**
   * Traverse parent requirements (DERIVES_FROM hierarchy via parentRequirementId)
   */
  private static async traverseParentRequirements(
    requirementId: string,
    depth: number,
    requirementsNodes: Array<ThreadNode>,
    relationships: Array<ThreadEdge>,
    visitedIds: Set<string>,
    resolver: ItemResolutionStrategy,
  ): Promise<void> {
    if (depth <= 0) return

    // Get requirement to find parent
    const [reqData] = await db
      .select({
        parentRequirementId: requirements.parentRequirementId,
      })
      .from(requirements)
      .where(eq(requirements.itemId, requirementId))
      .limit(1)

    if (!reqData?.parentRequirementId) return
    if (
      resolver.preservesIdentity &&
      visitedIds.has(reqData.parentRequirementId)
    ) {
      return
    }

    // Get the parent requirement at the resolver's context
    const resolvedItem = await this.fetchResolved(
      reqData.parentRequirementId,
      resolver,
    )
    if (!resolvedItem || visitedIds.has(resolvedItem.id)) return

    visitedIds.add(resolvedItem.id)

    requirementsNodes.push(await this.toNode(resolvedItem, 'requirements'))

    // Add synthetic relationship for DERIVES_FROM (child → parent)
    relationships.push({
      id: `derives-${requirementId}-${resolvedItem.id}`,
      sourceId: requirementId,
      targetId: resolvedItem.id,
      relationshipType: 'DERIVES_FROM',
      domain: 'same',
      quantity: null,
      derivationMethod: null,
    })

    // Continue traversing up
    await this.traverseParentRequirements(
      resolvedItem.id,
      depth - 1,
      requirementsNodes,
      relationships,
      visitedIds,
      resolver,
    )
  }

  /**
   * Traverse validation domain (VERIFIED_BY and VALIDATES relationships).
   * Finds test cases that verify requirements or validate parts, and — when
   * the focal item is itself a test case — the requirements it verifies and
   * the parts it validates.
   */
  private static async traverseValidation(
    itemId: string,
    depth: number,
    validationNodes: Array<ThreadNode>,
    requirementsNodes: Array<ThreadNode>,
    relationships: Array<ThreadEdge>,
    visitedIds: Set<string>,
    resolver: ItemResolutionStrategy,
  ): Promise<void> {
    if (depth <= 0) return

    // Find VERIFIED_BY relationships where this item is the target (requirement being verified)
    const verifiedByRels = await db
      .select()
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.targetId, itemId),
          eq(itemRelationships.relationshipType, VERIFIED_BY_RELATIONSHIP),
        ),
      )

    for (const rel of verifiedByRels) {
      await this.addVerifyingTestCase(
        rel,
        itemId,
        validationNodes,
        relationships,
        visitedIds,
        resolver,
      )
    }

    // Find VERIFIED_BY relationships where this test case is the source
    const verifiesRels = await db
      .select()
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.sourceId, itemId),
          eq(itemRelationships.relationshipType, VERIFIED_BY_RELATIONSHIP),
        ),
      )

    for (const rel of verifiesRels) {
      // If the verified requirement is not yet in the graph, add it
      let edgeTargetId = rel.targetId
      if (!visitedIds.has(rel.targetId)) {
        const resolvedReq = await this.fetchResolved(
          rel.targetId,
          resolver,
          'Requirement',
        )
        if (resolvedReq) {
          edgeTargetId = resolvedReq.id
          if (!visitedIds.has(resolvedReq.id)) {
            visitedIds.add(resolvedReq.id)
            requirementsNodes.push(
              await this.toNode(resolvedReq, 'requirements'),
            )
          }
        }
      }

      this.pushEdgeUnique(relationships, {
        id: rel.id,
        sourceId: itemId,
        targetId: edgeTargetId,
        relationshipType: rel.relationshipType,
        domain: 'cross',
        quantity: rel.quantity,
        derivationMethod: null,
      })
    }

    // Find VALIDATES relationships (test case → part)
    const validatesRels = await db
      .select()
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.sourceId, itemId),
          eq(itemRelationships.relationshipType, VALIDATES_RELATIONSHIP),
        ),
      )

    for (const rel of validatesRels) {
      // Add the relationship but don't add parts to validation nodes
      this.pushEdgeUnique(relationships, {
        id: rel.id,
        sourceId: itemId,
        targetId: rel.targetId,
        relationshipType: rel.relationshipType,
        domain: 'cross',
        quantity: rel.quantity,
        derivationMethod: null,
      })
    }

    // Find VALIDATES relationships where this part is the target
    const validatedByRels = await db
      .select()
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.targetId, itemId),
          eq(itemRelationships.relationshipType, VALIDATES_RELATIONSHIP),
        ),
      )

    for (const rel of validatedByRels) {
      await this.addVerifyingTestCase(
        rel,
        itemId,
        validationNodes,
        relationships,
        visitedIds,
        resolver,
      )
    }
  }

  /**
   * Add the test case on the source side of a VERIFIED_BY/VALIDATES edge to
   * the validation lane, recording the edge either way (deduplicated when
   * the node was already reached from another direction).
   */
  private static async addVerifyingTestCase(
    rel: typeof itemRelationships.$inferSelect,
    targetItemId: string,
    validationNodes: Array<ThreadNode>,
    relationships: Array<ThreadEdge>,
    visitedIds: Set<string>,
    resolver: ItemResolutionStrategy,
  ): Promise<void> {
    if (visitedIds.has(rel.sourceId)) {
      // Still add the relationship even if node was visited
      this.pushEdgeUnique(relationships, {
        id: rel.id,
        sourceId: rel.sourceId,
        targetId: targetItemId,
        relationshipType: rel.relationshipType,
        domain: 'cross',
        quantity: rel.quantity,
        derivationMethod: null,
      })
      return
    }

    // Get the test case at the resolver's context
    const resolvedItem = await this.fetchResolved(rel.sourceId, resolver)
    if (!resolvedItem) return

    if (visitedIds.has(resolvedItem.id)) {
      // Two raw rows resolved to the same version — record the edge only
      this.pushEdgeUnique(relationships, {
        id: rel.id,
        sourceId: resolvedItem.id,
        targetId: targetItemId,
        relationshipType: rel.relationshipType,
        domain: 'cross',
        quantity: rel.quantity,
        derivationMethod: null,
      })
      return
    }

    visitedIds.add(resolvedItem.id)
    validationNodes.push(await this.toNode(resolvedItem, 'validation'))

    relationships.push({
      id: rel.id,
      sourceId: resolvedItem.id,
      targetId: targetItemId,
      relationshipType: rel.relationshipType,
      domain: 'cross',
      quantity: rel.quantity,
      derivationMethod: null,
    })
  }

  /**
   * Calculate the MBOM coverage percentage
   * (% of engineering items that have a corresponding manufacturing item)
   */
  private static calculateMbomCoverage(
    engineeringNodes: Array<ThreadNode>,
    _manufacturingNodes: Array<ThreadNode>,
    relationships: Array<ThreadEdge>,
  ): number {
    if (engineeringNodes.length === 0) return 0

    // Find engineering items that have EBOM_SOURCE relationships
    const engineeringIdsWithMbom = new Set<string>()

    for (const rel of relationships) {
      if (rel.relationshipType === EBOM_SOURCE_RELATIONSHIP) {
        engineeringIdsWithMbom.add(rel.sourceId)
      }
    }

    const coverage =
      (engineeringIdsWithMbom.size / engineeringNodes.length) * 100
    return Math.round(coverage * 10) / 10 // Round to 1 decimal place
  }

  /**
   * Calculate the requirements coverage percentage
   * (% of engineering/manufacturing items that satisfy at least one requirement)
   */
  private static calculateRequirementsCoverage(
    engineeringNodes: Array<ThreadNode>,
    manufacturingNodes: Array<ThreadNode>,
    _requirementsNodes: Array<ThreadNode>,
    relationships: Array<ThreadEdge>,
  ): number {
    const allItems = [...engineeringNodes, ...manufacturingNodes]
    if (allItems.length === 0) return 0

    // Find items that have SATISFIES relationships (as source)
    const itemsWithRequirements = new Set<string>()

    for (const rel of relationships) {
      if (rel.relationshipType === SATISFIES_RELATIONSHIP) {
        itemsWithRequirements.add(rel.sourceId)
      }
    }

    const coverage = (itemsWithRequirements.size / allItems.length) * 100
    return Math.round(coverage * 10) / 10 // Round to 1 decimal place
  }

  /**
   * Calculate the test coverage percentage
   * (% of requirements that have at least one test case via VERIFIED_BY)
   */
  private static calculateTestCoverage(
    requirementsNodes: Array<ThreadNode>,
    _validationNodes: Array<ThreadNode>,
    relationships: Array<ThreadEdge>,
  ): number {
    if (requirementsNodes.length === 0) return 0

    // Find requirements that have VERIFIED_BY relationships (as target)
    const requirementsWithTests = new Set<string>()

    for (const rel of relationships) {
      if (rel.relationshipType === VERIFIED_BY_RELATIONSHIP) {
        requirementsWithTests.add(rel.targetId)
      }
    }

    const coverage =
      (requirementsWithTests.size / requirementsNodes.length) * 100
    return Math.round(coverage * 10) / 10 // Round to 1 decimal place
  }

  /**
   * Traverse the physical domain (live thread only — physical reality does
   * not time-travel, so context threads skip it).
   *
   * From a Part focal item: Consumes edges targeting any version row of its
   * lineage (bulk consumption, re-pointed to the focal node so the edge
   * lands on the lineage's representative in this graph) and the lineage's
   * PhysicalParts (linked with synthetic INSTANCE_OF edges), then each
   * instance's producing/consuming work orders. From a WorkOrder or
   * PhysicalPart focal item: both directions, plus a bridge node into the
   * design domains (the built part / the instantiated part version).
   * Evidences edges on reached instances pull their requirements when the
   * requirements domain is requested — the customer's requirement → lot walk.
   *
   * Depth counts WO↔PhysicalPart hops beyond the focal item's first ring.
   */
  private static async traversePhysical(
    focal: { id: string; masterId: string; itemType: string },
    depth: number,
    includeRequirements: boolean,
    physicalNodes: Array<ThreadNode>,
    engineeringNodes: Array<ThreadNode>,
    manufacturingNodes: Array<ThreadNode>,
    requirementsNodes: Array<ThreadNode>,
    relationships: Array<ThreadEdge>,
    visitedIds: Set<string>,
  ): Promise<void> {
    const ctx: PhysicalWalkContext = {
      focalId: focal.id,
      focalMasterId: focal.masterId,
      physicalNodes,
      engineeringNodes,
      manufacturingNodes,
      relationships,
      visitedIds,
      physicalPartIds: new Set(),
    }

    if (focal.itemType === 'WorkOrder') {
      await this.addBuiltPartBridge(focal.id, ctx)
      await this.walkWorkOrder(focal.id, depth, ctx)
    } else if (focal.itemType === 'PhysicalPart') {
      ctx.physicalPartIds.add(focal.id)
      await this.addInstancePartBridge(focal.id, ctx)
      await this.walkPhysicalPart(focal.id, depth, ctx)
    } else {
      // Versioned focal item (Part et al.): find its physical footprint.
      const versionRows = await db
        .select({ id: items.id })
        .from(items)
        .where(and(eq(items.masterId, focal.masterId), notDeleted()))
      const versionIds = versionRows.map((v) => v.id)

      // Bulk consumption pins exact part version rows as edge targets.
      if (versionIds.length > 0) {
        const bulkEdges = await db
          .select()
          .from(itemRelationships)
          .where(
            and(
              inArray(itemRelationships.targetId, versionIds),
              eq(itemRelationships.relationshipType, RELATIONSHIP_CONSUMES),
            ),
          )
        for (const rel of bulkEdges) {
          const added = await this.addPhysicalNode(rel.sourceId, ctx)
          this.pushEdge(ctx, {
            id: rel.id,
            sourceId: rel.sourceId,
            targetId: focal.id,
            relationshipType: rel.relationshipType,
            domain: 'cross',
            quantity: rel.quantity,
            derivationMethod: null,
          })
          if (added) await this.walkWorkOrder(rel.sourceId, depth, ctx)
        }
      }

      // The lineage's physical instances (units and lots)
      const instances = await db
        .select({ itemId: physicalParts.itemId })
        .from(physicalParts)
        .innerJoin(items, eq(items.id, physicalParts.itemId))
        .where(
          and(eq(physicalParts.partMasterId, focal.masterId), notDeleted()),
        )
      for (const instance of instances) {
        const added = await this.addPhysicalNode(instance.itemId, ctx)
        this.pushEdge(ctx, {
          id: `instance-${instance.itemId}-${focal.id}`,
          sourceId: instance.itemId,
          targetId: focal.id,
          relationshipType: INSTANCE_OF_RELATIONSHIP,
          domain: 'cross',
          quantity: null,
          derivationMethod: null,
        })
        if (added) await this.walkPhysicalPart(instance.itemId, depth, ctx)
      }
    }

    // Qualification evidence on reached instances
    if (includeRequirements && ctx.physicalPartIds.size > 0) {
      await this.collectEvidence(ctx, requirementsNodes)
    }
  }

  /** Everything a work order consumed and produced, recursing outward. */
  private static async walkWorkOrder(
    workOrderId: string,
    depth: number,
    ctx: PhysicalWalkContext,
  ): Promise<void> {
    if (depth <= 0) return

    const materialEdges = await db
      .select()
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.sourceId, workOrderId),
          inArray(itemRelationships.relationshipType, [
            RELATIONSHIP_CONSUMES,
            RELATIONSHIP_PRODUCES,
          ]),
        ),
      )

    for (const rel of materialEdges) {
      if (ctx.relationships.some((r) => r.id === rel.id)) continue

      const [target] = await db
        .select()
        .from(items)
        .where(and(eq(items.id, rel.targetId), notDeleted()))
        .limit(1)
      if (!target) continue

      if (target.itemType === 'PhysicalPart') {
        const added = await this.addPhysicalNode(target.id, ctx)
        this.pushEdge(ctx, {
          id: rel.id,
          sourceId: workOrderId,
          targetId: target.id,
          relationshipType: rel.relationshipType,
          domain: 'same',
          quantity: rel.quantity,
          derivationMethod: null,
        })
        if (added) await this.walkPhysicalPart(target.id, depth - 1, ctx)
      } else {
        // Bulk line: the target is a pinned part version row. Targets in
        // the focal lineage map onto the focal node; others enter their
        // design domain as pinned-version nodes.
        const isFocalLineage = target.masterId === ctx.focalMasterId
        if (!isFocalLineage) {
          await this.addDesignNode(target, ctx)
        }
        this.pushEdge(ctx, {
          id: rel.id,
          sourceId: workOrderId,
          targetId: isFocalLineage ? ctx.focalId : target.id,
          relationshipType: rel.relationshipType,
          domain: 'cross',
          quantity: rel.quantity,
          derivationMethod: null,
        })
      }
    }
  }

  /** Producing and consuming work orders of a physical instance. */
  private static async walkPhysicalPart(
    physicalPartId: string,
    depth: number,
    ctx: PhysicalWalkContext,
  ): Promise<void> {
    if (depth <= 0) return

    const woEdges = await db
      .select()
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.targetId, physicalPartId),
          inArray(itemRelationships.relationshipType, [
            RELATIONSHIP_CONSUMES,
            RELATIONSHIP_PRODUCES,
          ]),
        ),
      )

    for (const rel of woEdges) {
      const alreadyRecorded = ctx.relationships.some((r) => r.id === rel.id)
      const added = await this.addPhysicalNode(rel.sourceId, ctx)
      if (!alreadyRecorded) {
        this.pushEdge(ctx, {
          id: rel.id,
          sourceId: rel.sourceId,
          targetId: physicalPartId,
          relationshipType: rel.relationshipType,
          domain: 'same',
          quantity: rel.quantity,
          derivationMethod: null,
        })
      }
      if (added) await this.walkWorkOrder(rel.sourceId, depth - 1, ctx)
    }
  }

  /**
   * Add a WorkOrder/PhysicalPart node to the physical lane.
   * Returns true when the node is new (caller may recurse from it).
   */
  private static async addPhysicalNode(
    itemId: string,
    ctx: PhysicalWalkContext,
  ): Promise<boolean> {
    const [item] = await db
      .select()
      .from(items)
      .where(and(eq(items.id, itemId), notDeleted()))
      .limit(1)
    if (!item) return false
    if (item.itemType !== 'WorkOrder' && item.itemType !== 'PhysicalPart') {
      return false
    }
    // Track instances for evidence collection even when already visited
    // (the focal instance is pre-visited but still carries evidence).
    if (item.itemType === 'PhysicalPart') ctx.physicalPartIds.add(item.id)

    if (ctx.visitedIds.has(item.id)) return false
    ctx.visitedIds.add(item.id)

    ctx.physicalNodes.push({
      id: item.id,
      masterId: item.masterId,
      itemNumber: item.itemNumber,
      name: item.name,
      itemType: item.itemType,
      revision: item.revision,
      state: item.state,
      domain: 'physical',
      designId: null,
      designCode: null,
      designName: null,
      isFocalItem: false,
    })
    return true
  }

  /** Add a pinned part version row to its design domain (bulk consumption). */
  private static async addDesignNode(
    item: typeof items.$inferSelect,
    ctx: PhysicalWalkContext,
  ): Promise<void> {
    if (ctx.visitedIds.has(item.id)) return
    ctx.visitedIds.add(item.id)

    const node = await this.toNode(item)
    this.pushDesignDomainNode(
      node,
      ctx.engineeringNodes,
      ctx.manufacturingNodes,
    )
  }

  /** WorkOrder focal: bridge to the exact part version it builds. */
  private static async addBuiltPartBridge(
    workOrderId: string,
    ctx: PhysicalWalkContext,
  ): Promise<void> {
    const [wo] = await db
      .select({ partId: workOrders.partId })
      .from(workOrders)
      .where(eq(workOrders.itemId, workOrderId))
      .limit(1)
    if (!wo?.partId) return

    const [part] = await db
      .select()
      .from(items)
      .where(and(eq(items.id, wo.partId), notDeleted()))
      .limit(1)
    if (!part) return

    await this.addDesignNode(part, ctx)
    this.pushEdge(ctx, {
      id: `builds-${workOrderId}-${part.id}`,
      sourceId: workOrderId,
      targetId: part.id,
      relationshipType: BUILDS_RELATIONSHIP,
      domain: 'cross',
      quantity: null,
      derivationMethod: null,
    })
  }

  /** PhysicalPart focal: bridge to the part version it instantiates. */
  private static async addInstancePartBridge(
    physicalPartId: string,
    ctx: PhysicalWalkContext,
  ): Promise<void> {
    const [pp] = await db
      .select({
        partMasterId: physicalParts.partMasterId,
        asBuiltItemId: physicalParts.asBuiltItemId,
      })
      .from(physicalParts)
      .where(eq(physicalParts.itemId, physicalPartId))
      .limit(1)
    if (!pp) return

    // Prefer the as-built pin (exact version); fall back to the lineage's
    // current version for registered-not-yet-produced instances.
    const [part] = pp.asBuiltItemId
      ? await db
          .select()
          .from(items)
          .where(and(eq(items.id, pp.asBuiltItemId), notDeleted()))
          .limit(1)
      : await db
          .select()
          .from(items)
          .where(
            and(
              eq(items.masterId, pp.partMasterId),
              eq(items.itemType, 'Part'),
              eq(items.isCurrent, true),
              notDeleted(),
            ),
          )
          .limit(1)
    if (!part) return

    await this.addDesignNode(part, ctx)
    this.pushEdge(ctx, {
      id: `instance-${physicalPartId}-${part.id}`,
      sourceId: physicalPartId,
      targetId: part.id,
      relationshipType: INSTANCE_OF_RELATIONSHIP,
      domain: 'cross',
      quantity: null,
      derivationMethod: null,
    })
  }

  /** Requirements evidenced by reached instances (Evidences edges). */
  private static async collectEvidence(
    ctx: PhysicalWalkContext,
    requirementsNodes: Array<ThreadNode>,
  ): Promise<void> {
    const evidenceEdges = await db
      .select()
      .from(itemRelationships)
      .where(
        and(
          inArray(itemRelationships.sourceId, [...ctx.physicalPartIds]),
          eq(itemRelationships.relationshipType, RELATIONSHIP_EVIDENCES),
        ),
      )

    for (const rel of evidenceEdges) {
      if (!ctx.visitedIds.has(rel.targetId)) {
        const [reqItem] = await db
          .select()
          .from(items)
          .where(
            and(
              eq(items.id, rel.targetId),
              eq(items.itemType, 'Requirement'),
              notDeleted(),
            ),
          )
          .limit(1)
        if (!reqItem) continue
        ctx.visitedIds.add(reqItem.id)

        requirementsNodes.push(await this.toNode(reqItem, 'requirements'))
      }
      this.pushEdge(ctx, {
        id: rel.id,
        sourceId: rel.sourceId,
        targetId: rel.targetId,
        relationshipType: rel.relationshipType,
        domain: 'cross',
        quantity: rel.quantity,
        derivationMethod: null,
      })
    }
  }

  /** Push an edge unless one with the same id is already recorded. */
  private static pushEdge(ctx: PhysicalWalkContext, edge: ThreadEdge): void {
    this.pushEdgeUnique(ctx.relationships, edge)
  }

  /**
   * Get a simplified thread summary for an item
   */
  static async getThreadSummary(itemId: string): Promise<{
    hasUpstream: boolean
    hasDownstream: boolean
    hasRequirements: boolean
    hasValidation: boolean
    hasPhysical: boolean
    upstreamCount: number
    downstreamCount: number
    requirementsCount: number
    validationCount: number
    physicalCount: number
    domains: Array<ThreadDomain>
  }> {
    // Count upstream relationships
    const upstreamCount = await db
      .select()
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.targetId, itemId),
          eq(itemRelationships.relationshipType, EBOM_SOURCE_RELATIONSHIP),
        ),
      )
      .then((r) => r.length)

    // Count downstream relationships
    const downstreamCount = await db
      .select()
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.sourceId, itemId),
          eq(itemRelationships.relationshipType, EBOM_SOURCE_RELATIONSHIP),
        ),
      )
      .then((r) => r.length)

    // Count requirements relationships (where item satisfies a requirement)
    const requirementsCount = await db
      .select()
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.sourceId, itemId),
          eq(itemRelationships.relationshipType, SATISFIES_RELATIONSHIP),
        ),
      )
      .then((r) => r.length)

    // Count validation relationships (VERIFIED_BY where item is target OR VALIDATES where item is target)
    const verifiedByCount = await db
      .select()
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.targetId, itemId),
          eq(itemRelationships.relationshipType, VERIFIED_BY_RELATIONSHIP),
        ),
      )
      .then((r) => r.length)

    const validatesCount = await db
      .select()
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.targetId, itemId),
          eq(itemRelationships.relationshipType, VALIDATES_RELATIONSHIP),
        ),
      )
      .then((r) => r.length)

    const validationCount = verifiedByCount + validatesCount

    // Determine domains
    const domains: Array<ThreadDomain> = []
    if (requirementsCount > 0) {
      domains.push('requirements')
    }
    if (upstreamCount > 0) {
      domains.push('engineering')
    }
    if (downstreamCount > 0) {
      domains.push('manufacturing')
    }
    if (validationCount > 0) {
      domains.push('validation')
    }

    // Get item's own domain if not already included
    const [item] = await db
      .select({
        designId: items.designId,
        itemType: items.itemType,
        masterId: items.masterId,
      })
      .from(items)
      .where(and(eq(items.id, itemId), notDeleted()))
      .limit(1)

    // Physical relationships: Consumes/Produces edges touching this item,
    // plus — for versioned items — instances of its lineage.
    const physicalEdgeCount = await db
      .select()
      .from(itemRelationships)
      .where(
        and(
          or(
            eq(itemRelationships.sourceId, itemId),
            eq(itemRelationships.targetId, itemId),
          ),
          inArray(itemRelationships.relationshipType, [
            RELATIONSHIP_CONSUMES,
            RELATIONSHIP_PRODUCES,
          ]),
        ),
      )
      .then((r) => r.length)
    const instanceCount =
      item && item.itemType !== 'WorkOrder' && item.itemType !== 'PhysicalPart'
        ? await db
            .select({ itemId: physicalParts.itemId })
            .from(physicalParts)
            .where(eq(physicalParts.partMasterId, item.masterId))
            .then((r) => r.length)
        : 0
    const physicalCount = physicalEdgeCount + instanceCount
    if (physicalCount > 0) {
      domains.push('physical')
    }

    // Requirements are in their own domain
    if (item?.itemType === 'Requirement') {
      if (!domains.includes('requirements')) {
        domains.push('requirements')
      }
    } else if (item?.itemType === 'TestCase' || item?.itemType === 'TestPlan') {
      if (!domains.includes('validation')) {
        domains.push('validation')
      }
    } else if (
      item?.itemType === 'WorkOrder' ||
      item?.itemType === 'PhysicalPart'
    ) {
      if (!domains.includes('physical')) {
        domains.push('physical')
      }
    } else if (item?.designId) {
      const [design] = await db
        .select({ designType: designs.designType })
        .from(designs)
        .where(eq(designs.id, item.designId))
        .limit(1)

      const itemDomain = this.inferDomain(
        design?.designType ?? 'Engineering',
        item?.itemType,
      )
      if (!domains.includes(itemDomain)) {
        domains.push(itemDomain)
      }
    }

    return {
      hasUpstream: upstreamCount > 0,
      hasDownstream: downstreamCount > 0,
      hasRequirements: requirementsCount > 0,
      hasValidation: validationCount > 0,
      hasPhysical: physicalCount > 0,
      upstreamCount,
      downstreamCount,
      requirementsCount,
      validationCount,
      physicalCount,
      domains,
    }
  }
}
