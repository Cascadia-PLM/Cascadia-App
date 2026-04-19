/* eslint-disable @typescript-eslint/no-unnecessary-condition --
 * This file contains many `const [x] = await db.select()...limit(1); if (!x)` patterns
 * and record-index lookups. Under the current tsconfig (no `noUncheckedIndexedAccess`),
 * TypeScript narrows destructured array elements and record indices to non-undefined,
 * so the runtime guards look "unnecessary" to the rule. They are not — empty result
 * sets and unknown keys still produce undefined at runtime. Remove this directive
 * when the project enables `noUncheckedIndexedAccess`.
 */
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db'
import { notDeleted } from '../db/filters'
import {
  designs,
  itemRelationships,
  items,
  requirements,
  testCases,
} from '../db/schema'
import { NotFoundError } from '../errors'
import { EBOM_SOURCE_RELATIONSHIP } from './MbomService'
import {
  SATISFIES_RELATIONSHIP,
  VERIFIED_BY_RELATIONSHIP,
} from './RequirementService'
import { ThreadCacheService } from './ThreadCacheService'
import { VALIDATES_RELATIONSHIP } from './VerificationService'
import { VersionResolver } from './VersionResolver'
import type { VersionContext } from './VersionResolver'
import { serviceLogger } from '@/lib/logging/logger'

/**
 * Domain types for the digital thread
 * - requirements: Requirements domain (traceability)
 * - engineering: Engineering domain (EBOM)
 * - manufacturing: Manufacturing domain (MBOM)
 * - validation: Validation domain (test cases)
 */
export type ThreadDomain =
  | 'requirements'
  | 'engineering'
  | 'manufacturing'
  | 'validation'

/**
 * Node in the digital thread graph
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
  designId: string
  designCode: string
  designName: string
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
      z.enum(['requirements', 'engineering', 'manufacturing', 'validation']),
    )
    .optional()
    .default(['requirements', 'engineering', 'manufacturing', 'validation']),
  upstreamDepth: z.number().int().min(0).max(10).optional().default(5),
  downstreamDepth: z.number().int().min(0).max(10).optional().default(5),
  bomDepth: z.number().int().min(0).max(10).optional().default(3),
  requirementsDepth: z.number().int().min(0).max(10).optional().default(3),
  validationDepth: z.number().int().min(0).max(10).optional().default(3),
})

export type ThreadRequest = z.input<typeof threadRequestSchema>

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

    // Get the design for the focal item
    const focalDesign = focalItemData.designId
      ? await db
          .select()
          .from(designs)
          .where(eq(designs.id, focalItemData.designId))
          .limit(1)
          .then((r) => r[0])
      : null

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
      designId: focalDesign?.id ?? '',
      designCode: focalDesign?.code ?? '',
      designName: focalDesign?.name ?? '',
      isFocalItem: true,
    }

    const requirementsNodes: Array<ThreadNode> = []
    const engineeringNodes: Array<ThreadNode> = []
    const manufacturingNodes: Array<ThreadNode> = []
    const validationNodes: Array<ThreadNode> = []
    const allRelationships: Array<ThreadEdge> = []
    const visitedIds = new Set<string>([focalItemData.id])

    // Add focal item to appropriate domain
    if (focalDomain === 'requirements') {
      requirementsNodes.push(focalNode)
    } else if (focalDomain === 'engineering') {
      engineeringNodes.push(focalNode)
    } else if (focalDomain === 'validation') {
      validationNodes.push(focalNode)
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
      )
    }

    // Traverse BOM within the focal item's domain
    if (validated.bomDepth > 0 && focalDomain !== 'requirements') {
      await this.traverseBom(
        focalItemData.id,
        focalDomain,
        validated.bomDepth,
        engineeringNodes,
        manufacturingNodes,
        allRelationships,
        visitedIds,
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
      )
    }

    // Calculate MBOM coverage
    const mbomCoverage = this.calculateMbomCoverage(
      engineeringNodes,
      manufacturingNodes,
      allRelationships,
    )

    // Calculate requirements coverage
    const requirementsCoverage = this.calculateRequirementsCoverage(
      engineeringNodes,
      manufacturingNodes,
      requirementsNodes,
      allRelationships,
    )

    // Calculate test coverage
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
      },
      relationships: allRelationships,
      stats: {
        totalNodes:
          requirementsNodes.length +
          engineeringNodes.length +
          manufacturingNodes.length +
          validationNodes.length,
        totalRelationships: allRelationships.length,
        mbomCoverage,
        requirementsCoverage,
        testCoverage,
      },
    }
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

    // Get the design for the resolved focal item
    const focalDesign = resolvedFocalItem.designId
      ? await db
          .select()
          .from(designs)
          .where(eq(designs.id, resolvedFocalItem.designId))
          .limit(1)
          .then((r) => r[0])
      : null

    // Determine focal item domain
    const focalDomain =
      resolvedFocalItem.itemType === 'Requirement'
        ? 'requirements'
        : this.inferDomain(
            focalDesign?.designType ?? 'Engineering',
            resolvedFocalItem.itemType,
          )

    const focalNode: ThreadNode = {
      id: resolvedFocalItem.id,
      masterId: resolvedFocalItem.masterId,
      itemNumber: resolvedFocalItem.itemNumber,
      name: resolvedFocalItem.name,
      itemType: resolvedFocalItem.itemType,
      revision: resolvedFocalItem.revision,
      state: resolvedFocalItem.state,
      domain: focalDomain,
      designId: focalDesign?.id ?? '',
      designCode: focalDesign?.code ?? '',
      designName: focalDesign?.name ?? '',
      isFocalItem: true,
    }

    const requirementsNodes: Array<ThreadNode> = []
    const engineeringNodes: Array<ThreadNode> = []
    const manufacturingNodes: Array<ThreadNode> = []
    const validationNodes: Array<ThreadNode> = []
    const allRelationships: Array<ThreadEdge> = []
    const visitedIds = new Set<string>([resolvedFocalItem.id])

    // Add focal item to appropriate domain
    if (focalDomain === 'requirements') {
      requirementsNodes.push(focalNode)
    } else if (focalDomain === 'engineering') {
      engineeringNodes.push(focalNode)
    } else if (focalDomain === 'validation') {
      validationNodes.push(focalNode)
    } else {
      manufacturingNodes.push(focalNode)
    }

    // Traverse upstream (toward source) with version context
    if (
      validated.upstreamDepth > 0 &&
      validated.domains.includes('engineering')
    ) {
      await this.traverseUpstreamAtContext(
        resolvedFocalItem.id,
        validated.upstreamDepth,
        engineeringNodes,
        manufacturingNodes,
        allRelationships,
        visitedIds,
        context,
        designId,
      )
    }

    // Traverse downstream (toward derived) with version context
    if (
      validated.downstreamDepth > 0 &&
      validated.domains.includes('manufacturing')
    ) {
      await this.traverseDownstreamAtContext(
        resolvedFocalItem.id,
        validated.downstreamDepth,
        engineeringNodes,
        manufacturingNodes,
        allRelationships,
        visitedIds,
        context,
        designId,
      )
    }

    // Traverse BOM within the focal item's domain with version context
    if (validated.bomDepth > 0 && focalDomain !== 'requirements') {
      await this.traverseBomAtContext(
        resolvedFocalItem.id,
        focalDomain,
        validated.bomDepth,
        engineeringNodes,
        manufacturingNodes,
        allRelationships,
        visitedIds,
        context,
        designId,
      )
    }

    // Traverse requirements (SATISFIES relationships) with version context
    if (
      validated.requirementsDepth > 0 &&
      validated.domains.includes('requirements')
    ) {
      await this.traverseRequirementsAtContext(
        resolvedFocalItem.id,
        validated.requirementsDepth,
        requirementsNodes,
        allRelationships,
        visitedIds,
        context,
        designId,
      )
    }

    // Traverse validation with version context
    if (
      validated.validationDepth > 0 &&
      validated.domains.includes('validation')
    ) {
      await this.traverseValidationAtContext(
        resolvedFocalItem.id,
        validated.validationDepth,
        validationNodes,
        requirementsNodes,
        allRelationships,
        visitedIds,
        context,
        designId,
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
      },
      relationships: allRelationships,
      stats: {
        totalNodes:
          requirementsNodes.length +
          engineeringNodes.length +
          manufacturingNodes.length +
          validationNodes.length,
        totalRelationships: allRelationships.length,
        mbomCoverage,
        requirementsCoverage,
        testCoverage,
      },
    }
  }

  /**
   * Traverse upstream relationships at a specific version context.
   */
  private static async traverseUpstreamAtContext(
    itemId: string,
    depth: number,
    engineeringNodes: Array<ThreadNode>,
    manufacturingNodes: Array<ThreadNode>,
    relationships: Array<ThreadEdge>,
    visitedIds: Set<string>,
    context: VersionContext,
    designId: string,
  ): Promise<void> {
    if (depth <= 0) return

    // Find EBOM_SOURCE relationships where this item is the target
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
      // Get the source item's master ID first
      const [sourceItem] = await db
        .select()
        .from(items)
        .where(and(eq(items.id, rel.sourceId), notDeleted()))
        .limit(1)

      if (!sourceItem) continue

      // Resolve to the version at context
      const resolvedItem = sourceItem.designId
        ? await VersionResolver.getItemAtContext(
            sourceItem.masterId,
            sourceItem.designId,
            context,
          )
        : sourceItem

      if (!resolvedItem || visitedIds.has(resolvedItem.id)) continue

      visitedIds.add(resolvedItem.id)

      // Get design info
      const sourceDesign = resolvedItem.designId
        ? await db
            .select()
            .from(designs)
            .where(eq(designs.id, resolvedItem.designId))
            .limit(1)
            .then((r) => r[0])
        : null

      const domain = this.inferDomain(
        sourceDesign?.designType ?? 'Engineering',
        resolvedItem.itemType,
      )

      const node: ThreadNode = {
        id: resolvedItem.id,
        masterId: resolvedItem.masterId,
        itemNumber: resolvedItem.itemNumber,
        name: resolvedItem.name,
        itemType: resolvedItem.itemType,
        revision: resolvedItem.revision,
        state: resolvedItem.state,
        domain,
        designId: sourceDesign?.id ?? '',
        designCode: sourceDesign?.code ?? '',
        designName: sourceDesign?.name ?? '',
        isFocalItem: false,
      }

      if (domain === 'engineering') {
        engineeringNodes.push(node)
      } else if (domain === 'manufacturing') {
        manufacturingNodes.push(node)
      }

      relationships.push({
        id: rel.id,
        sourceId: resolvedItem.id,
        targetId: itemId,
        relationshipType: rel.relationshipType,
        domain: 'cross',
        quantity: rel.quantity,
        derivationMethod: rel.derivationMethod,
      })

      // Continue traversing
      await this.traverseUpstreamAtContext(
        resolvedItem.id,
        depth - 1,
        engineeringNodes,
        manufacturingNodes,
        relationships,
        visitedIds,
        context,
        designId,
      )
    }
  }

  /**
   * Traverse downstream relationships at a specific version context.
   */
  private static async traverseDownstreamAtContext(
    itemId: string,
    depth: number,
    engineeringNodes: Array<ThreadNode>,
    manufacturingNodes: Array<ThreadNode>,
    relationships: Array<ThreadEdge>,
    visitedIds: Set<string>,
    context: VersionContext,
    designId: string,
  ): Promise<void> {
    if (depth <= 0) return

    // Find EBOM_SOURCE relationships where this item is the source
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
      const [targetItem] = await db
        .select()
        .from(items)
        .where(and(eq(items.id, rel.targetId), notDeleted()))
        .limit(1)

      if (!targetItem) continue

      const resolvedItem = targetItem.designId
        ? await VersionResolver.getItemAtContext(
            targetItem.masterId,
            targetItem.designId,
            context,
          )
        : targetItem

      if (!resolvedItem || visitedIds.has(resolvedItem.id)) continue

      visitedIds.add(resolvedItem.id)

      const targetDesign = resolvedItem.designId
        ? await db
            .select()
            .from(designs)
            .where(eq(designs.id, resolvedItem.designId))
            .limit(1)
            .then((r) => r[0])
        : null

      const domain = this.inferDomain(
        targetDesign?.designType ?? 'Engineering',
        resolvedItem.itemType,
      )

      const node: ThreadNode = {
        id: resolvedItem.id,
        masterId: resolvedItem.masterId,
        itemNumber: resolvedItem.itemNumber,
        name: resolvedItem.name,
        itemType: resolvedItem.itemType,
        revision: resolvedItem.revision,
        state: resolvedItem.state,
        domain,
        designId: targetDesign?.id ?? '',
        designCode: targetDesign?.code ?? '',
        designName: targetDesign?.name ?? '',
        isFocalItem: false,
      }

      if (domain === 'engineering') {
        engineeringNodes.push(node)
      } else if (domain === 'manufacturing') {
        manufacturingNodes.push(node)
      }

      relationships.push({
        id: rel.id,
        sourceId: itemId,
        targetId: resolvedItem.id,
        relationshipType: rel.relationshipType,
        domain: 'cross',
        quantity: rel.quantity,
        derivationMethod: rel.derivationMethod,
      })

      await this.traverseDownstreamAtContext(
        resolvedItem.id,
        depth - 1,
        engineeringNodes,
        manufacturingNodes,
        relationships,
        visitedIds,
        context,
        designId,
      )
    }
  }

  /**
   * Traverse BOM relationships at a specific version context.
   */
  private static async traverseBomAtContext(
    itemId: string,
    _domain: ThreadDomain,
    depth: number,
    engineeringNodes: Array<ThreadNode>,
    manufacturingNodes: Array<ThreadNode>,
    relationships: Array<ThreadEdge>,
    visitedIds: Set<string>,
    context: VersionContext,
    designId: string,
  ): Promise<void> {
    if (depth <= 0) return

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
      const [childItem] = await db
        .select()
        .from(items)
        .where(and(eq(items.id, rel.targetId), notDeleted()))
        .limit(1)

      if (!childItem) continue

      const resolvedItem = childItem.designId
        ? await VersionResolver.getItemAtContext(
            childItem.masterId,
            childItem.designId,
            context,
          )
        : childItem

      if (!resolvedItem || visitedIds.has(resolvedItem.id)) continue

      visitedIds.add(resolvedItem.id)

      const childDesign = resolvedItem.designId
        ? await db
            .select()
            .from(designs)
            .where(eq(designs.id, resolvedItem.designId))
            .limit(1)
            .then((r) => r[0])
        : null

      const childDomain = this.inferDomain(
        childDesign?.designType ?? 'Engineering',
        resolvedItem.itemType,
      )

      const node: ThreadNode = {
        id: resolvedItem.id,
        masterId: resolvedItem.masterId,
        itemNumber: resolvedItem.itemNumber,
        name: resolvedItem.name,
        itemType: resolvedItem.itemType,
        revision: resolvedItem.revision,
        state: resolvedItem.state,
        domain: childDomain,
        designId: childDesign?.id ?? '',
        designCode: childDesign?.code ?? '',
        designName: childDesign?.name ?? '',
        isFocalItem: false,
      }

      if (childDomain === 'engineering') {
        engineeringNodes.push(node)
      } else if (childDomain === 'manufacturing') {
        manufacturingNodes.push(node)
      }

      relationships.push({
        id: rel.id,
        sourceId: itemId,
        targetId: resolvedItem.id,
        relationshipType: rel.relationshipType,
        domain: 'same',
        quantity: rel.quantity,
        derivationMethod: null,
      })

      await this.traverseBomAtContext(
        resolvedItem.id,
        childDomain,
        depth - 1,
        engineeringNodes,
        manufacturingNodes,
        relationships,
        visitedIds,
        context,
        designId,
      )

      await this.traverseDownstreamAtContext(
        resolvedItem.id,
        1,
        engineeringNodes,
        manufacturingNodes,
        relationships,
        visitedIds,
        context,
        designId,
      )
    }
  }

  /**
   * Traverse requirements at a specific version context.
   */
  private static async traverseRequirementsAtContext(
    itemId: string,
    depth: number,
    requirementsNodes: Array<ThreadNode>,
    relationships: Array<ThreadEdge>,
    visitedIds: Set<string>,
    context: VersionContext,
    designId: string,
  ): Promise<void> {
    if (depth <= 0) return

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

      const resolvedItem = reqItem.designId
        ? await VersionResolver.getItemAtContext(
            reqItem.masterId,
            reqItem.designId,
            context,
          )
        : reqItem

      if (!resolvedItem || visitedIds.has(resolvedItem.id)) continue

      visitedIds.add(resolvedItem.id)

      const reqDesign = resolvedItem.designId
        ? await db
            .select()
            .from(designs)
            .where(eq(designs.id, resolvedItem.designId))
            .limit(1)
            .then((r) => r[0])
        : null

      const node: ThreadNode = {
        id: resolvedItem.id,
        masterId: resolvedItem.masterId,
        itemNumber: resolvedItem.itemNumber,
        name: resolvedItem.name,
        itemType: resolvedItem.itemType,
        revision: resolvedItem.revision,
        state: resolvedItem.state,
        domain: 'requirements',
        designId: reqDesign?.id ?? '',
        designCode: reqDesign?.code ?? '',
        designName: reqDesign?.name ?? '',
        isFocalItem: false,
      }

      requirementsNodes.push(node)

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
      await this.traverseParentRequirementsAtContext(
        resolvedItem.id,
        depth - 1,
        requirementsNodes,
        relationships,
        visitedIds,
        context,
        designId,
      )
    }

    // Find SATISFIES relationships where this item is the target
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
   * Traverse parent requirements at a specific version context.
   */
  private static async traverseParentRequirementsAtContext(
    requirementId: string,
    depth: number,
    requirementsNodes: Array<ThreadNode>,
    relationships: Array<ThreadEdge>,
    visitedIds: Set<string>,
    context: VersionContext,
    designId: string,
  ): Promise<void> {
    if (depth <= 0) return

    const [reqData] = await db
      .select({
        parentRequirementId: requirements.parentRequirementId,
      })
      .from(requirements)
      .where(eq(requirements.itemId, requirementId))
      .limit(1)

    if (!reqData?.parentRequirementId) return

    const [parentItem] = await db
      .select()
      .from(items)
      .where(and(eq(items.id, reqData.parentRequirementId), notDeleted()))
      .limit(1)

    if (!parentItem) return

    const resolvedItem = parentItem.designId
      ? await VersionResolver.getItemAtContext(
          parentItem.masterId,
          parentItem.designId,
          context,
        )
      : parentItem

    if (!resolvedItem || visitedIds.has(resolvedItem.id)) return

    visitedIds.add(resolvedItem.id)

    const parentDesign = resolvedItem.designId
      ? await db
          .select()
          .from(designs)
          .where(eq(designs.id, resolvedItem.designId))
          .limit(1)
          .then((r) => r[0])
      : null

    const node: ThreadNode = {
      id: resolvedItem.id,
      masterId: resolvedItem.masterId,
      itemNumber: resolvedItem.itemNumber,
      name: resolvedItem.name,
      itemType: resolvedItem.itemType,
      revision: resolvedItem.revision,
      state: resolvedItem.state,
      domain: 'requirements',
      designId: parentDesign?.id ?? '',
      designCode: parentDesign?.code ?? '',
      designName: parentDesign?.name ?? '',
      isFocalItem: false,
    }

    requirementsNodes.push(node)

    relationships.push({
      id: `derives-${requirementId}-${resolvedItem.id}`,
      sourceId: requirementId,
      targetId: resolvedItem.id,
      relationshipType: 'DERIVES_FROM',
      domain: 'same',
      quantity: null,
      derivationMethod: null,
    })

    await this.traverseParentRequirementsAtContext(
      resolvedItem.id,
      depth - 1,
      requirementsNodes,
      relationships,
      visitedIds,
      context,
      designId,
    )
  }

  /**
   * Traverse validation domain at a specific version context.
   */
  private static async traverseValidationAtContext(
    itemId: string,
    depth: number,
    validationNodes: Array<ThreadNode>,
    requirementsNodes: Array<ThreadNode>,
    relationships: Array<ThreadEdge>,
    visitedIds: Set<string>,
    context: VersionContext,
    designId: string,
  ): Promise<void> {
    if (depth <= 0) return

    // Find VERIFIED_BY relationships
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
      if (visitedIds.has(rel.sourceId)) {
        const existingRel = relationships.find((r) => r.id === rel.id)
        if (!existingRel) {
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
        continue
      }

      const [testCaseItem] = await db
        .select()
        .from(items)
        .where(and(eq(items.id, rel.sourceId), notDeleted()))
        .limit(1)

      if (!testCaseItem) continue

      const resolvedItem = testCaseItem.designId
        ? await VersionResolver.getItemAtContext(
            testCaseItem.masterId,
            testCaseItem.designId,
            context,
          )
        : testCaseItem

      if (!resolvedItem) continue

      visitedIds.add(resolvedItem.id)

      const testDesign = resolvedItem.designId
        ? await db
            .select()
            .from(designs)
            .where(eq(designs.id, resolvedItem.designId))
            .limit(1)
            .then((r) => r[0])
        : null

      const node: ThreadNode = {
        id: resolvedItem.id,
        masterId: resolvedItem.masterId,
        itemNumber: resolvedItem.itemNumber,
        name: resolvedItem.name,
        itemType: resolvedItem.itemType,
        revision: resolvedItem.revision,
        state: resolvedItem.state,
        domain: 'validation',
        designId: testDesign?.id ?? '',
        designCode: testDesign?.code ?? '',
        designName: testDesign?.name ?? '',
        isFocalItem: false,
      }

      validationNodes.push(node)

      relationships.push({
        id: rel.id,
        sourceId: resolvedItem.id,
        targetId: itemId,
        relationshipType: rel.relationshipType,
        domain: 'cross',
        quantity: rel.quantity,
        derivationMethod: null,
      })
    }

    // Find VALIDATES relationships
    const validatesRels = await db
      .select()
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.targetId, itemId),
          eq(itemRelationships.relationshipType, VALIDATES_RELATIONSHIP),
        ),
      )

    for (const rel of validatesRels) {
      if (visitedIds.has(rel.sourceId)) {
        const existingRel = relationships.find((r) => r.id === rel.id)
        if (!existingRel) {
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
        continue
      }

      const [testCaseItem] = await db
        .select()
        .from(items)
        .where(and(eq(items.id, rel.sourceId), notDeleted()))
        .limit(1)

      if (!testCaseItem) continue

      const resolvedItem = testCaseItem.designId
        ? await VersionResolver.getItemAtContext(
            testCaseItem.masterId,
            testCaseItem.designId,
            context,
          )
        : testCaseItem

      if (!resolvedItem) continue

      visitedIds.add(resolvedItem.id)

      const testDesign = resolvedItem.designId
        ? await db
            .select()
            .from(designs)
            .where(eq(designs.id, resolvedItem.designId))
            .limit(1)
            .then((r) => r[0])
        : null

      const node: ThreadNode = {
        id: resolvedItem.id,
        masterId: resolvedItem.masterId,
        itemNumber: resolvedItem.itemNumber,
        name: resolvedItem.name,
        itemType: resolvedItem.itemType,
        revision: resolvedItem.revision,
        state: resolvedItem.state,
        domain: 'validation',
        designId: testDesign?.id ?? '',
        designCode: testDesign?.code ?? '',
        designName: testDesign?.name ?? '',
        isFocalItem: false,
      }

      validationNodes.push(node)

      relationships.push({
        id: rel.id,
        sourceId: resolvedItem.id,
        targetId: itemId,
        relationshipType: rel.relationshipType,
        domain: 'cross',
        quantity: rel.quantity,
        derivationMethod: null,
      })
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
      if (visitedIds.has(rel.sourceId)) continue

      // Get the source item (EBOM item)
      const [sourceItem] = await db
        .select()
        .from(items)
        .where(and(eq(items.id, rel.sourceId), notDeleted()))
        .limit(1)

      if (!sourceItem) continue

      visitedIds.add(sourceItem.id)

      // Get design info
      const sourceDesign = sourceItem.designId
        ? await db
            .select()
            .from(designs)
            .where(eq(designs.id, sourceItem.designId))
            .limit(1)
            .then((r) => r[0])
        : null

      const domain = this.inferDomain(
        sourceDesign?.designType ?? 'Engineering',
        sourceItem.itemType,
      )

      const node: ThreadNode = {
        id: sourceItem.id,
        masterId: sourceItem.masterId,
        itemNumber: sourceItem.itemNumber,
        name: sourceItem.name,
        itemType: sourceItem.itemType,
        revision: sourceItem.revision,
        state: sourceItem.state,
        domain,
        designId: sourceDesign?.id ?? '',
        designCode: sourceDesign?.code ?? '',
        designName: sourceDesign?.name ?? '',
        isFocalItem: false,
      }

      if (domain === 'engineering') {
        engineeringNodes.push(node)
      } else if (domain === 'manufacturing') {
        manufacturingNodes.push(node)
      }

      relationships.push({
        id: rel.id,
        sourceId: rel.sourceId,
        targetId: rel.targetId,
        relationshipType: rel.relationshipType,
        domain: 'cross',
        quantity: rel.quantity,
        derivationMethod: rel.derivationMethod,
      })

      // Continue traversing upstream
      await this.traverseUpstream(
        sourceItem.id,
        depth - 1,
        engineeringNodes,
        manufacturingNodes,
        relationships,
        visitedIds,
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
      if (visitedIds.has(rel.targetId)) continue

      // Get the target item (MBOM item)
      const [targetItem] = await db
        .select()
        .from(items)
        .where(and(eq(items.id, rel.targetId), notDeleted()))
        .limit(1)

      if (!targetItem) continue

      visitedIds.add(targetItem.id)

      // Get design info
      const targetDesign = targetItem.designId
        ? await db
            .select()
            .from(designs)
            .where(eq(designs.id, targetItem.designId))
            .limit(1)
            .then((r) => r[0])
        : null

      const domain = this.inferDomain(
        targetDesign?.designType ?? 'Engineering',
        targetItem.itemType,
      )

      const node: ThreadNode = {
        id: targetItem.id,
        masterId: targetItem.masterId,
        itemNumber: targetItem.itemNumber,
        name: targetItem.name,
        itemType: targetItem.itemType,
        revision: targetItem.revision,
        state: targetItem.state,
        domain,
        designId: targetDesign?.id ?? '',
        designCode: targetDesign?.code ?? '',
        designName: targetDesign?.name ?? '',
        isFocalItem: false,
      }

      if (domain === 'engineering') {
        engineeringNodes.push(node)
      } else if (domain === 'manufacturing') {
        manufacturingNodes.push(node)
      }

      relationships.push({
        id: rel.id,
        sourceId: rel.sourceId,
        targetId: rel.targetId,
        relationshipType: rel.relationshipType,
        domain: 'cross',
        quantity: rel.quantity,
        derivationMethod: rel.derivationMethod,
      })

      // Continue traversing downstream
      await this.traverseDownstream(
        targetItem.id,
        depth - 1,
        engineeringNodes,
        manufacturingNodes,
        relationships,
        visitedIds,
      )
    }
  }

  /**
   * Traverse BOM relationships within the same domain
   */
  private static async traverseBom(
    itemId: string,
    _domain: ThreadDomain,
    depth: number,
    engineeringNodes: Array<ThreadNode>,
    manufacturingNodes: Array<ThreadNode>,
    relationships: Array<ThreadEdge>,
    visitedIds: Set<string>,
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
      if (visitedIds.has(rel.targetId)) continue

      // Get the child item
      const [childItem] = await db
        .select()
        .from(items)
        .where(and(eq(items.id, rel.targetId), notDeleted()))
        .limit(1)

      if (!childItem) continue

      visitedIds.add(childItem.id)

      // Get design info
      const childDesign = childItem.designId
        ? await db
            .select()
            .from(designs)
            .where(eq(designs.id, childItem.designId))
            .limit(1)
            .then((r) => r[0])
        : null

      const childDomain = this.inferDomain(
        childDesign?.designType ?? 'Engineering',
        childItem.itemType,
      )

      const node: ThreadNode = {
        id: childItem.id,
        masterId: childItem.masterId,
        itemNumber: childItem.itemNumber,
        name: childItem.name,
        itemType: childItem.itemType,
        revision: childItem.revision,
        state: childItem.state,
        domain: childDomain,
        designId: childDesign?.id ?? '',
        designCode: childDesign?.code ?? '',
        designName: childDesign?.name ?? '',
        isFocalItem: false,
      }

      if (childDomain === 'engineering') {
        engineeringNodes.push(node)
      } else if (childDomain === 'manufacturing') {
        manufacturingNodes.push(node)
      }

      relationships.push({
        id: rel.id,
        sourceId: rel.sourceId,
        targetId: rel.targetId,
        relationshipType: rel.relationshipType,
        domain: 'same',
        quantity: rel.quantity,
        derivationMethod: null,
      })

      // Continue traversing BOM
      await this.traverseBom(
        childItem.id,
        childDomain,
        depth - 1,
        engineeringNodes,
        manufacturingNodes,
        relationships,
        visitedIds,
      )

      // Also traverse cross-domain for BOM children
      await this.traverseDownstream(
        childItem.id,
        1, // Only one level for BOM children
        engineeringNodes,
        manufacturingNodes,
        relationships,
        visitedIds,
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
      if (visitedIds.has(rel.targetId)) continue

      // Get the requirement
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

      visitedIds.add(reqItem.id)

      // Get design info
      const reqDesign = reqItem.designId
        ? await db
            .select()
            .from(designs)
            .where(eq(designs.id, reqItem.designId))
            .limit(1)
            .then((r) => r[0])
        : null

      const node: ThreadNode = {
        id: reqItem.id,
        masterId: reqItem.masterId,
        itemNumber: reqItem.itemNumber,
        name: reqItem.name,
        itemType: reqItem.itemType,
        revision: reqItem.revision,
        state: reqItem.state,
        domain: 'requirements',
        designId: reqDesign?.id ?? '',
        designCode: reqDesign?.code ?? '',
        designName: reqDesign?.name ?? '',
        isFocalItem: false,
      }

      requirementsNodes.push(node)

      relationships.push({
        id: rel.id,
        sourceId: rel.sourceId,
        targetId: rel.targetId,
        relationshipType: rel.relationshipType,
        domain: 'cross',
        quantity: rel.quantity,
        derivationMethod: null,
      })

      // Traverse parent requirements
      await this.traverseParentRequirements(
        reqItem.id,
        depth - 1,
        requirementsNodes,
        relationships,
        visitedIds,
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

      // Get the satisfying item
      const [sourceItem] = await db
        .select()
        .from(items)
        .where(and(eq(items.id, rel.sourceId), notDeleted()))
        .limit(1)

      if (!sourceItem) continue

      // Note: We don't add satisfying items to requirementsNodes
      // They belong in engineering/manufacturing domains
      // But we do add the relationship to show the connection

      relationships.push({
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

  /**
   * Traverse parent requirements (DERIVES_FROM hierarchy via parentRequirementId)
   */
  private static async traverseParentRequirements(
    requirementId: string,
    depth: number,
    requirementsNodes: Array<ThreadNode>,
    relationships: Array<ThreadEdge>,
    visitedIds: Set<string>,
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
    if (visitedIds.has(reqData.parentRequirementId)) return

    // Get parent requirement
    const [parentItem] = await db
      .select()
      .from(items)
      .where(and(eq(items.id, reqData.parentRequirementId), notDeleted()))
      .limit(1)

    if (!parentItem) return

    visitedIds.add(parentItem.id)

    // Get design info
    const parentDesign = parentItem.designId
      ? await db
          .select()
          .from(designs)
          .where(eq(designs.id, parentItem.designId))
          .limit(1)
          .then((r) => r[0])
      : null

    const node: ThreadNode = {
      id: parentItem.id,
      masterId: parentItem.masterId,
      itemNumber: parentItem.itemNumber,
      name: parentItem.name,
      itemType: parentItem.itemType,
      revision: parentItem.revision,
      state: parentItem.state,
      domain: 'requirements',
      designId: parentDesign?.id ?? '',
      designCode: parentDesign?.code ?? '',
      designName: parentDesign?.name ?? '',
      isFocalItem: false,
    }

    requirementsNodes.push(node)

    // Add synthetic relationship for DERIVES_FROM (child → parent)
    relationships.push({
      id: `derives-${requirementId}-${parentItem.id}`,
      sourceId: requirementId,
      targetId: parentItem.id,
      relationshipType: 'DERIVES_FROM',
      domain: 'same',
      quantity: null,
      derivationMethod: null,
    })

    // Continue traversing up
    await this.traverseParentRequirements(
      parentItem.id,
      depth - 1,
      requirementsNodes,
      relationships,
      visitedIds,
    )
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
   * Traverse validation domain (VERIFIED_BY and VALIDATES relationships)
   * Finds test cases that verify requirements or validate parts
   */
  private static async traverseValidation(
    itemId: string,
    depth: number,
    validationNodes: Array<ThreadNode>,
    requirementsNodes: Array<ThreadNode>,
    relationships: Array<ThreadEdge>,
    visitedIds: Set<string>,
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
      if (visitedIds.has(rel.sourceId)) {
        // Still add the relationship even if node was visited
        const existingRel = relationships.find((r) => r.id === rel.id)
        if (!existingRel) {
          relationships.push({
            id: rel.id,
            sourceId: rel.sourceId,
            targetId: rel.targetId,
            relationshipType: rel.relationshipType,
            domain: 'cross',
            quantity: rel.quantity,
            derivationMethod: null,
          })
        }
        continue
      }

      // Get the test case
      const [testCaseItem] = await db
        .select()
        .from(items)
        .where(and(eq(items.id, rel.sourceId), notDeleted()))
        .limit(1)

      if (!testCaseItem) continue

      visitedIds.add(testCaseItem.id)

      // Get design info
      const testDesign = testCaseItem.designId
        ? await db
            .select()
            .from(designs)
            .where(eq(designs.id, testCaseItem.designId))
            .limit(1)
            .then((r) => r[0])
        : null

      const node: ThreadNode = {
        id: testCaseItem.id,
        masterId: testCaseItem.masterId,
        itemNumber: testCaseItem.itemNumber,
        name: testCaseItem.name,
        itemType: testCaseItem.itemType,
        revision: testCaseItem.revision,
        state: testCaseItem.state,
        domain: 'validation',
        designId: testDesign?.id ?? '',
        designCode: testDesign?.code ?? '',
        designName: testDesign?.name ?? '',
        isFocalItem: false,
      }

      validationNodes.push(node)

      relationships.push({
        id: rel.id,
        sourceId: rel.sourceId,
        targetId: rel.targetId,
        relationshipType: rel.relationshipType,
        domain: 'cross',
        quantity: rel.quantity,
        derivationMethod: null,
      })
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
      // Add the relationship
      const existingRel = relationships.find((r) => r.id === rel.id)
      if (!existingRel) {
        relationships.push({
          id: rel.id,
          sourceId: rel.sourceId,
          targetId: rel.targetId,
          relationshipType: rel.relationshipType,
          domain: 'cross',
          quantity: rel.quantity,
          derivationMethod: null,
        })
      }

      // If requirement not visited, add it
      if (!visitedIds.has(rel.targetId)) {
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

        if (reqItem) {
          visitedIds.add(reqItem.id)

          const reqDesign = reqItem.designId
            ? await db
                .select()
                .from(designs)
                .where(eq(designs.id, reqItem.designId))
                .limit(1)
                .then((r) => r[0])
            : null

          const node: ThreadNode = {
            id: reqItem.id,
            masterId: reqItem.masterId,
            itemNumber: reqItem.itemNumber,
            name: reqItem.name,
            itemType: reqItem.itemType,
            revision: reqItem.revision,
            state: reqItem.state,
            domain: 'requirements',
            designId: reqDesign?.id ?? '',
            designCode: reqDesign?.code ?? '',
            designName: reqDesign?.name ?? '',
            isFocalItem: false,
          }

          requirementsNodes.push(node)
        }
      }
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
      const existingRel = relationships.find((r) => r.id === rel.id)
      if (!existingRel) {
        relationships.push({
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
      if (visitedIds.has(rel.sourceId)) {
        const existingRel = relationships.find((r) => r.id === rel.id)
        if (!existingRel) {
          relationships.push({
            id: rel.id,
            sourceId: rel.sourceId,
            targetId: rel.targetId,
            relationshipType: rel.relationshipType,
            domain: 'cross',
            quantity: rel.quantity,
            derivationMethod: null,
          })
        }
        continue
      }

      // Get the test case
      const [testCaseItem] = await db
        .select()
        .from(items)
        .where(and(eq(items.id, rel.sourceId), notDeleted()))
        .limit(1)

      if (!testCaseItem) continue

      visitedIds.add(testCaseItem.id)

      const testDesign = testCaseItem.designId
        ? await db
            .select()
            .from(designs)
            .where(eq(designs.id, testCaseItem.designId))
            .limit(1)
            .then((r) => r[0])
        : null

      const node: ThreadNode = {
        id: testCaseItem.id,
        masterId: testCaseItem.masterId,
        itemNumber: testCaseItem.itemNumber,
        name: testCaseItem.name,
        itemType: testCaseItem.itemType,
        revision: testCaseItem.revision,
        state: testCaseItem.state,
        domain: 'validation',
        designId: testDesign?.id ?? '',
        designCode: testDesign?.code ?? '',
        designName: testDesign?.name ?? '',
        isFocalItem: false,
      }

      validationNodes.push(node)

      relationships.push({
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

  /**
   * Get a simplified thread summary for an item
   */
  static async getThreadSummary(itemId: string): Promise<{
    hasUpstream: boolean
    hasDownstream: boolean
    hasRequirements: boolean
    hasValidation: boolean
    upstreamCount: number
    downstreamCount: number
    requirementsCount: number
    validationCount: number
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
      .select({ designId: items.designId, itemType: items.itemType })
      .from(items)
      .where(and(eq(items.id, itemId), notDeleted()))
      .limit(1)

    // Requirements are in their own domain
    if (item?.itemType === 'Requirement') {
      if (!domains.includes('requirements')) {
        domains.push('requirements')
      }
    } else if (item?.itemType === 'TestCase' || item?.itemType === 'TestPlan') {
      if (!domains.includes('validation')) {
        domains.push('validation')
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
      upstreamCount,
      downstreamCount,
      requirementsCount,
      validationCount,
      domains,
    }
  }
}
