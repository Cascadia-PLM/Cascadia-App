import { and, eq, inArray, or } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db'
import { designs, itemRelationships, items } from '../db/schema'
import { NotFoundError } from '../errors'
import { EBOM_SOURCE_RELATIONSHIP } from './MbomService'
import {
  SATISFIES_RELATIONSHIP,
  VERIFIED_BY_RELATIONSHIP,
} from './RequirementService'
import { VALIDATES_RELATIONSHIP } from './VerificationService'
import type { ThreadDomain } from './ThreadService'

// ============================================================================
// Types
// ============================================================================

export type ChangeType =
  | 'revision'
  | 'obsolescence'
  | 'bom_removal'
  | 'specification_change'

export type ImpactDirection = 'upstream' | 'downstream' | 'both'

export type ImpactSeverity = 'critical' | 'high' | 'medium' | 'low'

export type ImpactType = 'direct' | 'indirect'

export interface ImpactedItem {
  item: {
    id: string
    masterId: string
    itemNumber: string
    name: string | null
    itemType: string
    revision: string
    state: string
    designId: string | null
    designName?: string
  }
  impactPath: Array<string> // Chain of itemNumbers from source to this item
  impactType: ImpactType // direct (1 hop) or indirect (2+ hops)
  domain: ThreadDomain
  severity: ImpactSeverity
  reason: string // Human-readable explanation
  requiredAction?: string // Suggested action
  depth: number
  relationshipType: string
}

export interface ImpactAnalysisRequest {
  itemId: string
  changeType: ChangeType
  direction: ImpactDirection
  maxDepth?: number // Default: 5
  includeDomains?: Array<ThreadDomain> // Default: all domains
}

export interface ImpactAnalysisResult {
  sourceItem: {
    id: string
    itemNumber: string
    name: string | null
    itemType: string
    revision: string
    state: string
    designId: string | null
  }
  changeType: ChangeType
  impactedItems: Array<ImpactedItem>
  summary: {
    totalImpacted: number
    byDomain: Record<ThreadDomain, number>
    bySeverity: Record<ImpactSeverity, number>
    crossDesignCount: number // Items in other designs
  }
  recommendations: Array<string>
  analyzedAt: Date
}

// ============================================================================
// Zod Schema for API validation
// ============================================================================

export const impactAnalysisRequestSchema = z.object({
  changeType: z.enum([
    'revision',
    'obsolescence',
    'bom_removal',
    'specification_change',
  ]),
  direction: z.enum(['upstream', 'downstream', 'both']),
  maxDepth: z.number().int().min(1).max(10).optional().default(5),
  includeDomains: z
    .array(
      z.enum(['requirements', 'engineering', 'manufacturing', 'validation']),
    )
    .optional()
    .default(['requirements', 'engineering', 'manufacturing', 'validation']),
})

export type ImpactAnalysisRequestInput = z.input<
  typeof impactAnalysisRequestSchema
>

// ============================================================================
// Internal Types
// ============================================================================

interface TraversalNode {
  itemId: string
  masterId: string
  itemNumber: string
  name: string | null
  itemType: string
  revision: string
  state: string
  designId: string | null
  designName?: string
  depth: number
  path: Array<string> // itemNumbers in order
  relationshipType: string
  domain: ThreadDomain
}

// ============================================================================
// Service Implementation
// ============================================================================

/**
 * Service for analyzing potential impact of changes to items.
 *
 * Unlike ImpactAssessmentService (ECO-focused), this service provides
 * exploratory "what if" analysis for engineers before making changes.
 */
export class ImpactAnalysisService {
  /**
   * Analyze the potential impact of a change to an item.
   *
   * @param request - Analysis parameters including item, change type, and direction
   * @returns Complete impact analysis result with impacted items and recommendations
   */
  static async analyze(
    request: ImpactAnalysisRequest,
  ): Promise<ImpactAnalysisResult> {
    const {
      itemId,
      changeType,
      direction,
      maxDepth = 5,
      includeDomains = [
        'requirements',
        'engineering',
        'manufacturing',
        'validation',
      ],
    } = request

    // Get source item
    const [sourceItem] = await db
      .select({
        id: items.id,
        masterId: items.masterId,
        itemNumber: items.itemNumber,
        name: items.name,
        itemType: items.itemType,
        revision: items.revision,
        state: items.state,
        designId: items.designId,
      })
      .from(items)
      .where(eq(items.id, itemId))
      .limit(1)

    if (!sourceItem) {
      throw new NotFoundError('Item', itemId, { operation: 'impactAnalysis' })
    }

    // Collect impacted items through traversal
    const visitedIds = new Set<string>([itemId])
    const impactedNodes: Array<TraversalNode> = []

    // Traverse based on direction
    if (direction === 'upstream' || direction === 'both') {
      await this.traverseUpstream(
        itemId,
        sourceItem.itemNumber,
        maxDepth,
        visitedIds,
        impactedNodes,
        includeDomains,
      )
    }

    if (direction === 'downstream' || direction === 'both') {
      await this.traverseDownstream(
        itemId,
        sourceItem.itemNumber,
        maxDepth,
        visitedIds,
        impactedNodes,
        includeDomains,
      )
    }

    // Also traverse cross-domain relationships
    await this.traverseCrossDomain(
      itemId,
      sourceItem.itemNumber,
      maxDepth,
      visitedIds,
      impactedNodes,
      includeDomains,
      direction,
    )

    // Convert nodes to ImpactedItem with severity and actions
    const impactedItems = impactedNodes.map((node) =>
      this.buildImpactedItem(node, changeType, sourceItem.designId),
    )

    // Calculate summary
    const summary = this.calculateSummary(impactedItems, sourceItem.designId)

    // Generate recommendations
    const recommendations = this.generateRecommendations(
      impactedItems,
      changeType,
      summary,
    )

    return {
      sourceItem,
      changeType,
      impactedItems,
      summary,
      recommendations,
      analyzedAt: new Date(),
    }
  }

  /**
   * Traverse upstream (where-used) relationships via BOM.
   * Finds parent assemblies that contain the item.
   */
  private static async traverseUpstream(
    itemId: string,
    sourceItemNumber: string,
    maxDepth: number,
    visitedIds: Set<string>,
    results: Array<TraversalNode>,
    includeDomains: Array<ThreadDomain>,
    currentDepth: number = 1,
    currentPath: Array<string> = [],
  ): Promise<void> {
    if (currentDepth > maxDepth) return

    // Find BOM relationships where this item is the child (target)
    const parentRels = await db
      .select({
        relId: itemRelationships.id,
        sourceId: itemRelationships.sourceId,
        relationshipType: itemRelationships.relationshipType,
      })
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.targetId, itemId),
          eq(itemRelationships.relationshipType, 'BOM'),
        ),
      )

    for (const rel of parentRels) {
      if (visitedIds.has(rel.sourceId)) continue

      // Get parent item details
      const [parentItem] = await db
        .select({
          id: items.id,
          masterId: items.masterId,
          itemNumber: items.itemNumber,
          name: items.name,
          itemType: items.itemType,
          revision: items.revision,
          state: items.state,
          designId: items.designId,
          isCurrent: items.isCurrent,
        })
        .from(items)
        .where(and(eq(items.id, rel.sourceId), eq(items.isCurrent, true)))
        .limit(1)

      if (!parentItem) continue

      visitedIds.add(parentItem.id)

      // Get design info
      const designName = parentItem.designId
        ? await this.getDesignName(parentItem.designId)
        : undefined

      // Determine domain
      const domain = await this.inferDomain(
        parentItem.designId,
        parentItem.itemType,
      )

      // Skip if domain not included
      if (!includeDomains.includes(domain)) continue

      const path = [
        ...currentPath,
        sourceItemNumber,
        parentItem.itemNumber,
      ].filter((p, i, arr) => arr.indexOf(p) === i)

      const node: TraversalNode = {
        itemId: parentItem.id,
        masterId: parentItem.masterId,
        itemNumber: parentItem.itemNumber,
        name: parentItem.name,
        itemType: parentItem.itemType,
        revision: parentItem.revision,
        state: parentItem.state,
        designId: parentItem.designId,
        designName,
        depth: currentDepth,
        path,
        relationshipType: 'BOM',
        domain,
      }

      results.push(node)

      // Continue traversing up
      await this.traverseUpstream(
        parentItem.id,
        sourceItemNumber,
        maxDepth,
        visitedIds,
        results,
        includeDomains,
        currentDepth + 1,
        path,
      )
    }
  }

  /**
   * Traverse downstream relationships via BOM.
   * Finds child components.
   */
  private static async traverseDownstream(
    itemId: string,
    sourceItemNumber: string,
    maxDepth: number,
    visitedIds: Set<string>,
    results: Array<TraversalNode>,
    includeDomains: Array<ThreadDomain>,
    currentDepth: number = 1,
    currentPath: Array<string> = [],
  ): Promise<void> {
    if (currentDepth > maxDepth) return

    // Find BOM relationships where this item is the parent (source)
    const childRels = await db
      .select({
        relId: itemRelationships.id,
        targetId: itemRelationships.targetId,
        relationshipType: itemRelationships.relationshipType,
      })
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.sourceId, itemId),
          eq(itemRelationships.relationshipType, 'BOM'),
        ),
      )

    for (const rel of childRels) {
      if (visitedIds.has(rel.targetId)) continue

      // Get child item details
      const [childItem] = await db
        .select({
          id: items.id,
          masterId: items.masterId,
          itemNumber: items.itemNumber,
          name: items.name,
          itemType: items.itemType,
          revision: items.revision,
          state: items.state,
          designId: items.designId,
          isCurrent: items.isCurrent,
        })
        .from(items)
        .where(and(eq(items.id, rel.targetId), eq(items.isCurrent, true)))
        .limit(1)

      if (!childItem) continue

      visitedIds.add(childItem.id)

      // Get design info
      const designName = childItem.designId
        ? await this.getDesignName(childItem.designId)
        : undefined

      // Determine domain
      const domain = await this.inferDomain(
        childItem.designId,
        childItem.itemType,
      )

      // Skip if domain not included
      if (!includeDomains.includes(domain)) continue

      const path = [
        ...currentPath,
        sourceItemNumber,
        childItem.itemNumber,
      ].filter((p, i, arr) => arr.indexOf(p) === i)

      const node: TraversalNode = {
        itemId: childItem.id,
        masterId: childItem.masterId,
        itemNumber: childItem.itemNumber,
        name: childItem.name,
        itemType: childItem.itemType,
        revision: childItem.revision,
        state: childItem.state,
        designId: childItem.designId,
        designName,
        depth: currentDepth,
        path,
        relationshipType: 'BOM',
        domain,
      }

      results.push(node)

      // Continue traversing down
      await this.traverseDownstream(
        childItem.id,
        sourceItemNumber,
        maxDepth,
        visitedIds,
        results,
        includeDomains,
        currentDepth + 1,
        path,
      )
    }
  }

  /**
   * Traverse cross-domain relationships (EBOM_SOURCE, SATISFIES, VERIFIED_BY, VALIDATES).
   */
  private static async traverseCrossDomain(
    itemId: string,
    sourceItemNumber: string,
    maxDepth: number,
    visitedIds: Set<string>,
    results: Array<TraversalNode>,
    includeDomains: Array<ThreadDomain>,
    direction: ImpactDirection,
    currentDepth: number = 1,
  ): Promise<void> {
    if (currentDepth > maxDepth) return

    const crossDomainTypes = [
      EBOM_SOURCE_RELATIONSHIP,
      SATISFIES_RELATIONSHIP,
      VERIFIED_BY_RELATIONSHIP,
      VALIDATES_RELATIONSHIP,
    ]

    // Find relationships in both directions based on the direction parameter
    const rels = await db
      .select({
        id: itemRelationships.id,
        sourceId: itemRelationships.sourceId,
        targetId: itemRelationships.targetId,
        relationshipType: itemRelationships.relationshipType,
      })
      .from(itemRelationships)
      .where(
        and(
          or(
            eq(itemRelationships.sourceId, itemId),
            eq(itemRelationships.targetId, itemId),
          ),
          inArray(itemRelationships.relationshipType, crossDomainTypes),
        ),
      )

    for (const rel of rels) {
      const isSource = rel.sourceId === itemId
      const relatedItemId = isSource ? rel.targetId : rel.sourceId

      // Determine if this relationship direction matches our analysis direction
      // EBOM_SOURCE: source = EBOM (engineering), target = MBOM (manufacturing)
      // SATISFIES: source = Part, target = Requirement
      // VERIFIED_BY: source = TestCase, target = Requirement
      // VALIDATES: source = TestCase, target = Part
      const isUpstreamRel = !isSource
      const isDownstreamRel = isSource

      if (direction === 'upstream' && !isUpstreamRel) continue
      if (direction === 'downstream' && !isDownstreamRel) continue

      if (visitedIds.has(relatedItemId)) continue

      // Get related item details
      const [relatedItem] = await db
        .select({
          id: items.id,
          masterId: items.masterId,
          itemNumber: items.itemNumber,
          name: items.name,
          itemType: items.itemType,
          revision: items.revision,
          state: items.state,
          designId: items.designId,
          isCurrent: items.isCurrent,
        })
        .from(items)
        .where(and(eq(items.id, relatedItemId), eq(items.isCurrent, true)))
        .limit(1)

      if (!relatedItem) continue

      visitedIds.add(relatedItem.id)

      // Get design info
      const designName = relatedItem.designId
        ? await this.getDesignName(relatedItem.designId)
        : undefined

      // Determine domain
      const domain = await this.inferDomain(
        relatedItem.designId,
        relatedItem.itemType,
      )

      // Skip if domain not included
      if (!includeDomains.includes(domain)) continue

      const node: TraversalNode = {
        itemId: relatedItem.id,
        masterId: relatedItem.masterId,
        itemNumber: relatedItem.itemNumber,
        name: relatedItem.name,
        itemType: relatedItem.itemType,
        revision: relatedItem.revision,
        state: relatedItem.state,
        designId: relatedItem.designId,
        designName,
        depth: currentDepth,
        path: [sourceItemNumber, relatedItem.itemNumber],
        relationshipType: rel.relationshipType,
        domain,
      }

      results.push(node)

      // Continue traversing cross-domain relationships
      await this.traverseCrossDomain(
        relatedItem.id,
        sourceItemNumber,
        maxDepth,
        visitedIds,
        results,
        includeDomains,
        direction,
        currentDepth + 1,
      )
    }
  }

  /**
   * Build an ImpactedItem from a traversal node.
   */
  private static buildImpactedItem(
    node: TraversalNode,
    changeType: ChangeType,
    sourceDesignId: string | null,
  ): ImpactedItem {
    const severity = this.calculateSeverity(node, changeType, sourceDesignId)
    const { reason, requiredAction } = this.generateImpactDetails(
      node,
      changeType,
      severity,
    )

    return {
      item: {
        id: node.itemId,
        masterId: node.masterId,
        itemNumber: node.itemNumber,
        name: node.name,
        itemType: node.itemType,
        revision: node.revision,
        state: node.state,
        designId: node.designId,
        designName: node.designName,
      },
      impactPath: node.path,
      impactType: node.depth === 1 ? 'direct' : 'indirect',
      domain: node.domain,
      severity,
      reason,
      requiredAction,
      depth: node.depth,
      relationshipType: node.relationshipType,
    }
  }

  /**
   * Calculate severity based on item properties and change type.
   */
  private static calculateSeverity(
    node: TraversalNode,
    changeType: ChangeType,
    sourceDesignId: string | null,
  ): ImpactSeverity {
    // Critical: Released items, cross-design impacts
    if (node.state === 'Released') {
      if (changeType === 'obsolescence') return 'critical'
      if (node.designId !== sourceDesignId && sourceDesignId !== null) {
        return 'critical'
      }
      return 'high'
    }

    // Critical: Requirements with test cases, manufacturing items
    if (node.itemType === 'Requirement' && node.domain === 'validation') {
      return 'critical'
    }

    if (node.domain === 'manufacturing') {
      return changeType === 'obsolescence' ? 'critical' : 'high'
    }

    // High: Direct children/parents (depth=1)
    if (node.depth === 1) {
      return 'high'
    }

    // Cross-design impacts are higher severity
    if (node.designId !== sourceDesignId && sourceDesignId !== null) {
      return node.depth <= 2 ? 'high' : 'medium'
    }

    // Medium: Indirect impacts (depth 2-3)
    if (node.depth <= 3) {
      return 'medium'
    }

    // Low: Distant impacts (depth 4+), draft items
    if (node.state === 'Draft') {
      return 'low'
    }

    return 'low'
  }

  /**
   * Generate human-readable impact reason and suggested action.
   */
  private static generateImpactDetails(
    node: TraversalNode,
    changeType: ChangeType,
    severity: ImpactSeverity,
  ): { reason: string; requiredAction?: string } {
    // Base reason on relationship type and domain
    let reason = ''
    let requiredAction: string | undefined

    switch (node.relationshipType) {
      case 'BOM':
        if (node.depth === 1) {
          reason = `Directly ${node.domain === 'engineering' ? 'uses' : 'contains'} this item in BOM`
        } else {
          reason = `Indirectly affected through ${node.depth}-level BOM hierarchy`
        }
        if (changeType === 'obsolescence') {
          requiredAction = 'Update BOM to use replacement part'
        } else if (changeType === 'bom_removal') {
          requiredAction =
            'Verify assembly still functional without this component'
        }
        break

      case EBOM_SOURCE_RELATIONSHIP:
        reason = 'Manufacturing BOM derived from this engineering item'
        if (changeType === 'revision') {
          requiredAction = 'Update MBOM derivation to new revision'
        } else if (changeType === 'obsolescence') {
          requiredAction = 'Re-derive MBOM from replacement item'
        }
        break

      case SATISFIES_RELATIONSHIP:
        reason = 'Satisfies this requirement'
        if (changeType === 'specification_change') {
          requiredAction = 'Verify requirement satisfaction still valid'
        } else if (changeType === 'obsolescence') {
          requiredAction = 'Identify alternative item to satisfy requirement'
        }
        break

      case VERIFIED_BY_RELATIONSHIP:
        reason = 'Test case verifies this requirement'
        if (changeType === 'specification_change') {
          requiredAction = 'Update test case to verify new specification'
        }
        break

      case VALIDATES_RELATIONSHIP:
        reason = 'Test case validates this part'
        if (changeType === 'revision') {
          requiredAction = 'Re-run validation test on new revision'
        } else if (changeType === 'obsolescence') {
          requiredAction = 'Archive test case or redirect to replacement'
        }
        break

      default:
        reason = `Related through ${node.relationshipType} relationship`
    }

    // Add severity-specific context
    if (severity === 'critical') {
      reason += ` [${node.state}${node.designId ? ', cross-design' : ''}]`
    }

    return { reason, requiredAction }
  }

  /**
   * Calculate summary statistics.
   */
  private static calculateSummary(
    impactedItems: Array<ImpactedItem>,
    sourceDesignId: string | null,
  ): ImpactAnalysisResult['summary'] {
    const byDomain: Record<ThreadDomain, number> = {
      requirements: 0,
      engineering: 0,
      manufacturing: 0,
      validation: 0,
    }

    const bySeverity: Record<ImpactSeverity, number> = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    }

    let crossDesignCount = 0

    for (const item of impactedItems) {
      byDomain[item.domain]++
      bySeverity[item.severity]++

      if (
        sourceDesignId &&
        item.item.designId &&
        item.item.designId !== sourceDesignId
      ) {
        crossDesignCount++
      }
    }

    return {
      totalImpacted: impactedItems.length,
      byDomain,
      bySeverity,
      crossDesignCount,
    }
  }

  /**
   * Generate actionable recommendations.
   */
  private static generateRecommendations(
    impactedItems: Array<ImpactedItem>,
    changeType: ChangeType,
    summary: ImpactAnalysisResult['summary'],
  ): Array<string> {
    const recommendations: Array<string> = []

    // Cross-design warning
    if (summary.crossDesignCount > 0) {
      recommendations.push(
        `Coordinate with ${summary.crossDesignCount} other design team(s) before proceeding`,
      )
    }

    // Critical items warning
    if (summary.bySeverity.critical > 0) {
      recommendations.push(
        `Review ${summary.bySeverity.critical} critical impact(s) with stakeholders before making changes`,
      )
    }

    // Manufacturing impact
    if (summary.byDomain.manufacturing > 0) {
      if (changeType === 'obsolescence') {
        recommendations.push(
          'Update MBOM mappings to use replacement parts before release',
        )
      } else {
        recommendations.push(
          `Verify ${summary.byDomain.manufacturing} manufacturing item(s) will be updated automatically`,
        )
      }
    }

    // Requirements impact
    if (summary.byDomain.requirements > 0) {
      recommendations.push(
        `Re-verify ${summary.byDomain.requirements} requirement(s) after change implementation`,
      )
    }

    // Validation impact
    if (summary.byDomain.validation > 0) {
      recommendations.push(
        `Re-run ${summary.byDomain.validation} test case(s) to validate changes`,
      )
    }

    // High-volume changes
    if (summary.totalImpacted > 20) {
      recommendations.push(
        'Consider phased rollout due to high number of impacted items',
      )
    }

    // Change-type specific recommendations
    if (changeType === 'obsolescence') {
      const released = impactedItems.filter(
        (item) => item.item.state === 'Released',
      )
      if (released.length > 0) {
        recommendations.push(
          `Ensure replacement items are defined for ${released.length} released item(s)`,
        )
      }
    }

    if (changeType === 'bom_removal') {
      const assemblies = impactedItems.filter(
        (item) => item.relationshipType === 'BOM' && item.depth === 1,
      )
      if (assemblies.length > 0) {
        recommendations.push(
          `Verify ${assemblies.length} parent assembly(-ies) will function without this component`,
        )
      }
    }

    // If no specific recommendations, add a general one
    if (recommendations.length === 0) {
      recommendations.push('No critical issues detected - proceed with caution')
    }

    return recommendations
  }

  /**
   * Get design name by ID.
   */
  private static async getDesignName(
    designId: string,
  ): Promise<string | undefined> {
    const [design] = await db
      .select({ name: designs.name })
      .from(designs)
      .where(eq(designs.id, designId))
      .limit(1)

    return design?.name
  }

  /**
   * Infer thread domain from design type and item type.
   */
  private static async inferDomain(
    designId: string | null,
    itemType: string,
  ): Promise<ThreadDomain> {
    // Test cases belong to validation domain
    if (itemType === 'TestCase' || itemType === 'TestPlan') {
      return 'validation'
    }

    // Requirements belong to requirements domain
    if (itemType === 'Requirement') {
      return 'requirements'
    }

    if (!designId) {
      return 'engineering'
    }

    // Check design type
    const [design] = await db
      .select({ designType: designs.designType })
      .from(designs)
      .where(eq(designs.id, designId))
      .limit(1)

    if (design?.designType === 'Manufacturing') {
      return 'manufacturing'
    }

    return 'engineering'
  }
}
