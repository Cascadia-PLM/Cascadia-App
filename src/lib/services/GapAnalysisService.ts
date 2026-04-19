import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db'
import { designs, itemRelationships, items, requirements } from '../db/schema'
import { NotFoundError } from '../errors'
import { EBOM_SOURCE_RELATIONSHIP } from './MbomService'
import {
  ALLOCATED_TO_RELATIONSHIP,
  SATISFIES_RELATIONSHIP,
  VERIFIED_BY_RELATIONSHIP,
} from './RequirementService'
import { VALIDATES_RELATIONSHIP } from './VerificationService'
import type { ThreadDomain } from './ThreadService'

// ============================================================================
// Types
// ============================================================================

export type GapType =
  | 'unallocated_requirement'
  | 'unsatisfied_requirement'
  | 'unverified_requirement'
  | 'untested_part'
  | 'unmapped_ebom_item'
  | 'orphan_mbom_item'
  | 'missing_documentation'

export type GapSeverity = 'critical' | 'major' | 'minor'

export interface Gap {
  id: string
  type: GapType
  itemId: string
  itemNumber: string
  itemName: string | null
  itemType: string
  revision: string
  state: string
  domain: ThreadDomain
  severity: GapSeverity
  priority?: string | null
  suggestion: string
  relatedDesignId?: string
  relatedDesignName?: string
}

export interface GapAnalysisRequest {
  designId: string
  includeTypes?: Array<GapType>
  includeDomains?: Array<ThreadDomain>
  includeSeverities?: Array<GapSeverity>
}

export interface GapAnalysisResult {
  designId: string
  designName: string
  analyzedAt: Date
  gaps: Array<Gap>
  summary: {
    totalGaps: number
    byType: Record<GapType, number>
    bySeverity: Record<GapSeverity, number>
    byDomain: Record<ThreadDomain, number>
    completeness: number
  }
  coverage: {
    requirements: {
      total: number
      allocated: number
      satisfied: number
      verified: number
    }
    engineering: {
      total: number
      tested: number
      mappedToMbom: number
    }
    manufacturing: {
      total: number
      linkedToEbom: number
    }
  }
}

// ============================================================================
// Zod Schema for API validation
// ============================================================================

export const gapAnalysisRequestSchema = z.object({
  includeTypes: z
    .array(
      z.enum([
        'unallocated_requirement',
        'unsatisfied_requirement',
        'unverified_requirement',
        'untested_part',
        'unmapped_ebom_item',
        'orphan_mbom_item',
        'missing_documentation',
      ]),
    )
    .optional(),
  includeDomains: z
    .array(
      z.enum(['requirements', 'engineering', 'manufacturing', 'validation']),
    )
    .optional(),
  includeSeverities: z.array(z.enum(['critical', 'major', 'minor'])).optional(),
})

export type GapAnalysisRequestInput = z.input<typeof gapAnalysisRequestSchema>

// ============================================================================
// Service Implementation
// ============================================================================

/**
 * Service for analyzing traceability gaps across the digital thread.
 * Identifies missing links, unverified requirements, untested parts,
 * and EBOM→MBOM mapping gaps.
 */
export class GapAnalysisService {
  /**
   * Main entry point - orchestrates all gap detection for a design.
   */
  static async analyze(
    request: GapAnalysisRequest,
  ): Promise<GapAnalysisResult> {
    const { designId, includeTypes, includeDomains, includeSeverities } =
      request

    // Get design info
    const [design] = await db
      .select()
      .from(designs)
      .where(eq(designs.id, designId))
      .limit(1)

    if (!design) {
      throw new NotFoundError('Design', designId, { operation: 'gapAnalysis' })
    }

    // Collect all gaps
    const allGaps: Array<Gap> = []

    // Find requirement gaps
    const requirementGaps = await this.findRequirementGaps(designId)
    allGaps.push(...requirementGaps)

    // Find engineering gaps
    const engineeringGaps = await this.findEngineeringGaps(designId)
    allGaps.push(...engineeringGaps)

    // Find manufacturing gaps
    const manufacturingGaps = await this.findManufacturingGaps(designId)
    allGaps.push(...manufacturingGaps)

    // Apply filters
    let filteredGaps = allGaps

    if (includeTypes && includeTypes.length > 0) {
      filteredGaps = filteredGaps.filter((g) => includeTypes.includes(g.type))
    }

    if (includeDomains && includeDomains.length > 0) {
      filteredGaps = filteredGaps.filter((g) =>
        includeDomains.includes(g.domain),
      )
    }

    if (includeSeverities && includeSeverities.length > 0) {
      filteredGaps = filteredGaps.filter((g) =>
        includeSeverities.includes(g.severity),
      )
    }

    // Calculate coverage metrics
    const coverage = await this.calculateCoverageMetrics(designId)

    // Calculate summary
    const summary = this.calculateSummary(filteredGaps, coverage)

    return {
      designId,
      designName: design.name,
      analyzedAt: new Date(),
      gaps: filteredGaps,
      summary,
      coverage,
    }
  }

  /**
   * Find requirement-related gaps:
   * - unallocated_requirement: Not allocated to any design element
   * - unsatisfied_requirement: Not satisfied by any part/document
   * - unverified_requirement: Not linked to any test case
   */
  static async findRequirementGaps(designId: string): Promise<Array<Gap>> {
    const gaps: Array<Gap> = []

    // Get all requirements for this design
    const allRequirements = await db
      .select({
        id: items.id,
        itemNumber: items.itemNumber,
        name: items.name,
        itemType: items.itemType,
        revision: items.revision,
        state: items.state,
        priority: requirements.priority,
        verificationStatus: requirements.verificationStatus,
      })
      .from(items)
      .innerJoin(requirements, eq(items.id, requirements.itemId))
      .where(
        and(
          eq(items.designId, designId),
          eq(items.itemType, 'Requirement'),
          eq(items.isCurrent, true),
          eq(items.isDeleted, false),
        ),
      )

    if (allRequirements.length === 0) {
      return gaps
    }

    const requirementIds = allRequirements.map((r) => r.id)

    // Find allocated requirements (have ALLOCATED_TO relationship)
    const allocatedReqs = await db
      .select({ reqId: itemRelationships.sourceId })
      .from(itemRelationships)
      .where(
        and(
          inArray(itemRelationships.sourceId, requirementIds),
          eq(itemRelationships.relationshipType, ALLOCATED_TO_RELATIONSHIP),
        ),
      )
    const allocatedIds = new Set(allocatedReqs.map((r) => r.reqId))

    // Find satisfied requirements (have SATISFIES relationship)
    const satisfiedReqs = await db
      .select({ reqId: itemRelationships.targetId })
      .from(itemRelationships)
      .where(
        and(
          inArray(itemRelationships.targetId, requirementIds),
          eq(itemRelationships.relationshipType, SATISFIES_RELATIONSHIP),
        ),
      )
    const satisfiedIds = new Set(satisfiedReqs.map((r) => r.reqId))

    // Find verified requirements (have VERIFIED_BY relationship OR status is Passed)
    const verifiedReqs = await db
      .select({ reqId: itemRelationships.targetId })
      .from(itemRelationships)
      .where(
        and(
          inArray(itemRelationships.targetId, requirementIds),
          eq(itemRelationships.relationshipType, VERIFIED_BY_RELATIONSHIP),
        ),
      )
    const verifiedByTestIds = new Set(verifiedReqs.map((r) => r.reqId))

    // Process each requirement
    for (const req of allRequirements) {
      // Check for unallocated
      if (!allocatedIds.has(req.id)) {
        gaps.push({
          id: `gap-${req.id}-unallocated`,
          type: 'unallocated_requirement',
          itemId: req.id,
          itemNumber: req.itemNumber,
          itemName: req.name,
          itemType: req.itemType,
          revision: req.revision,
          state: req.state,
          domain: 'requirements',
          severity: this.calculateRequirementSeverity(req.priority),
          priority: req.priority,
          suggestion:
            'Allocate this requirement to a design element (part or assembly)',
        })
      }
      // Check for unsatisfied (only if allocated)
      else if (!satisfiedIds.has(req.id)) {
        gaps.push({
          id: `gap-${req.id}-unsatisfied`,
          type: 'unsatisfied_requirement',
          itemId: req.id,
          itemNumber: req.itemNumber,
          itemName: req.name,
          itemType: req.itemType,
          revision: req.revision,
          state: req.state,
          domain: 'requirements',
          severity: this.calculateRequirementSeverity(req.priority),
          priority: req.priority,
          suggestion:
            'Link parts that implement this requirement via SATISFIES relationship',
        })
      }
      // Check for unverified (only if satisfied)
      else if (
        !verifiedByTestIds.has(req.id) &&
        req.verificationStatus !== 'Passed'
      ) {
        gaps.push({
          id: `gap-${req.id}-unverified`,
          type: 'unverified_requirement',
          itemId: req.id,
          itemNumber: req.itemNumber,
          itemName: req.name,
          itemType: req.itemType,
          revision: req.revision,
          state: req.state,
          domain: 'requirements',
          severity: this.calculateRequirementSeverity(req.priority),
          priority: req.priority,
          suggestion: 'Create test cases to verify this requirement',
        })
      }
    }

    return gaps
  }

  /**
   * Find engineering-related gaps:
   * - untested_part: Part/assembly without any VALIDATES test cases
   * - unmapped_ebom_item: EBOM item without EBOM_SOURCE relationship from MBOM
   * - missing_documentation: Part without attached documents
   */
  static async findEngineeringGaps(designId: string): Promise<Array<Gap>> {
    const gaps: Array<Gap> = []

    // Get design info
    const [design] = await db
      .select()
      .from(designs)
      .where(eq(designs.id, designId))
      .limit(1)

    if (!design) return gaps

    // Only check engineering designs
    if (design.designType !== 'Engineering') {
      return gaps
    }

    // Get all parts for this design
    const allParts = await db
      .select({
        id: items.id,
        itemNumber: items.itemNumber,
        name: items.name,
        itemType: items.itemType,
        revision: items.revision,
        state: items.state,
      })
      .from(items)
      .where(
        and(
          eq(items.designId, designId),
          eq(items.itemType, 'Part'),
          eq(items.isCurrent, true),
          eq(items.isDeleted, false),
        ),
      )

    if (allParts.length === 0) {
      return gaps
    }

    const partIds = allParts.map((p) => p.id)

    // Find parts with VALIDATES test cases
    const testedParts = await db
      .select({ partId: itemRelationships.targetId })
      .from(itemRelationships)
      .where(
        and(
          inArray(itemRelationships.targetId, partIds),
          eq(itemRelationships.relationshipType, VALIDATES_RELATIONSHIP),
        ),
      )
    const testedPartIds = new Set(testedParts.map((p) => p.partId))

    // Find parts with EBOM_SOURCE (mapped to MBOM)
    const mappedParts = await db
      .select({ partId: itemRelationships.sourceId })
      .from(itemRelationships)
      .where(
        and(
          inArray(itemRelationships.sourceId, partIds),
          eq(itemRelationships.relationshipType, EBOM_SOURCE_RELATIONSHIP),
        ),
      )
    const mappedPartIds = new Set(mappedParts.map((p) => p.partId))

    // Check if any MBOM exists for this design
    const derivedMboms = await db
      .select({ id: designs.id })
      .from(designs)
      .where(
        and(
          eq(designs.sourceDesignId, designId),
          eq(designs.designType, 'Manufacturing'),
          eq(designs.isArchived, false),
        ),
      )
      .limit(1)

    const hasMbom = derivedMboms.length > 0

    // Process each part
    for (const part of allParts) {
      // Check for untested parts
      if (!testedPartIds.has(part.id)) {
        gaps.push({
          id: `gap-${part.id}-untested`,
          type: 'untested_part',
          itemId: part.id,
          itemNumber: part.itemNumber,
          itemName: part.name,
          itemType: part.itemType,
          revision: part.revision,
          state: part.state,
          domain: 'engineering',
          severity: this.calculatePartSeverity(part.state),
          suggestion: 'Create test cases to validate this part',
        })
      }

      // Check for unmapped EBOM items (only if MBOM exists)
      if (hasMbom && !mappedPartIds.has(part.id)) {
        gaps.push({
          id: `gap-${part.id}-unmapped`,
          type: 'unmapped_ebom_item',
          itemId: part.id,
          itemNumber: part.itemNumber,
          itemName: part.name,
          itemType: part.itemType,
          revision: part.revision,
          state: part.state,
          domain: 'engineering',
          severity: 'minor',
          suggestion: 'Map this EBOM item to corresponding MBOM item',
        })
      }
    }

    return gaps
  }

  /**
   * Find manufacturing-related gaps:
   * - orphan_mbom_item: MBOM item with broken/missing EBOM_SOURCE link
   */
  static async findManufacturingGaps(designId: string): Promise<Array<Gap>> {
    const gaps: Array<Gap> = []

    // Get design info
    const [design] = await db
      .select()
      .from(designs)
      .where(eq(designs.id, designId))
      .limit(1)

    if (!design) return gaps

    // Only check manufacturing designs
    if (design.designType !== 'Manufacturing') {
      return gaps
    }

    // Get all parts for this design
    const allMbomItems = await db
      .select({
        id: items.id,
        itemNumber: items.itemNumber,
        name: items.name,
        itemType: items.itemType,
        revision: items.revision,
        state: items.state,
      })
      .from(items)
      .where(
        and(
          eq(items.designId, designId),
          eq(items.itemType, 'Part'),
          eq(items.isCurrent, true),
          eq(items.isDeleted, false),
        ),
      )

    if (allMbomItems.length === 0) {
      return gaps
    }

    const mbomItemIds = allMbomItems.map((p) => p.id)

    // Find MBOM items with EBOM_SOURCE relationship (linked to EBOM)
    const linkedMbomItems = await db
      .select({ mbomId: itemRelationships.targetId })
      .from(itemRelationships)
      .where(
        and(
          inArray(itemRelationships.targetId, mbomItemIds),
          eq(itemRelationships.relationshipType, EBOM_SOURCE_RELATIONSHIP),
        ),
      )
    const linkedIds = new Set(linkedMbomItems.map((p) => p.mbomId))

    // Process each MBOM item
    for (const mbomItem of allMbomItems) {
      // Check for orphan MBOM items (no EBOM_SOURCE link)
      if (!linkedIds.has(mbomItem.id)) {
        gaps.push({
          id: `gap-${mbomItem.id}-orphan`,
          type: 'orphan_mbom_item',
          itemId: mbomItem.id,
          itemNumber: mbomItem.itemNumber,
          itemName: mbomItem.name,
          itemType: mbomItem.itemType,
          revision: mbomItem.revision,
          state: mbomItem.state,
          domain: 'manufacturing',
          severity: 'major',
          suggestion:
            'Link this MBOM item to its EBOM source or remove if not needed',
        })
      }
    }

    return gaps
  }

  /**
   * Calculate coverage metrics for a design.
   */
  private static async calculateCoverageMetrics(
    designId: string,
  ): Promise<GapAnalysisResult['coverage']> {
    // Get design info
    const [design] = await db
      .select()
      .from(designs)
      .where(eq(designs.id, designId))
      .limit(1)

    // Requirements coverage
    const allRequirements = await db
      .select({ id: items.id })
      .from(items)
      .innerJoin(requirements, eq(items.id, requirements.itemId))
      .where(
        and(
          eq(items.designId, designId),
          eq(items.itemType, 'Requirement'),
          eq(items.isCurrent, true),
          eq(items.isDeleted, false),
        ),
      )

    const requirementIds = allRequirements.map((r) => r.id)
    let allocated = 0
    let satisfied = 0
    let verified = 0

    if (requirementIds.length > 0) {
      const allocatedReqs = await db
        .select({ reqId: itemRelationships.sourceId })
        .from(itemRelationships)
        .where(
          and(
            inArray(itemRelationships.sourceId, requirementIds),
            eq(itemRelationships.relationshipType, ALLOCATED_TO_RELATIONSHIP),
          ),
        )
      allocated = new Set(allocatedReqs.map((r) => r.reqId)).size

      const satisfiedReqs = await db
        .select({ reqId: itemRelationships.targetId })
        .from(itemRelationships)
        .where(
          and(
            inArray(itemRelationships.targetId, requirementIds),
            eq(itemRelationships.relationshipType, SATISFIES_RELATIONSHIP),
          ),
        )
      satisfied = new Set(satisfiedReqs.map((r) => r.reqId)).size

      const verifiedReqs = await db
        .select({ reqId: itemRelationships.targetId })
        .from(itemRelationships)
        .where(
          and(
            inArray(itemRelationships.targetId, requirementIds),
            eq(itemRelationships.relationshipType, VERIFIED_BY_RELATIONSHIP),
          ),
        )
      verified = new Set(verifiedReqs.map((r) => r.reqId)).size
    }

    // Engineering coverage
    const allParts = await db
      .select({ id: items.id })
      .from(items)
      .where(
        and(
          eq(items.designId, designId),
          eq(items.itemType, 'Part'),
          eq(items.isCurrent, true),
          eq(items.isDeleted, false),
        ),
      )

    const partIds = allParts.map((p) => p.id)
    let tested = 0
    let mappedToMbom = 0

    if (partIds.length > 0) {
      const testedParts = await db
        .select({ partId: itemRelationships.targetId })
        .from(itemRelationships)
        .where(
          and(
            inArray(itemRelationships.targetId, partIds),
            eq(itemRelationships.relationshipType, VALIDATES_RELATIONSHIP),
          ),
        )
      tested = new Set(testedParts.map((p) => p.partId)).size

      const mappedParts = await db
        .select({ partId: itemRelationships.sourceId })
        .from(itemRelationships)
        .where(
          and(
            inArray(itemRelationships.sourceId, partIds),
            eq(itemRelationships.relationshipType, EBOM_SOURCE_RELATIONSHIP),
          ),
        )
      mappedToMbom = new Set(mappedParts.map((p) => p.partId)).size
    }

    // Manufacturing coverage (for MBOM designs)
    let mbomTotal = 0
    let linkedToEbom = 0

    if (design?.designType === 'Manufacturing') {
      const allMbomItems = await db
        .select({ id: items.id })
        .from(items)
        .where(
          and(
            eq(items.designId, designId),
            eq(items.itemType, 'Part'),
            eq(items.isCurrent, true),
            eq(items.isDeleted, false),
          ),
        )

      mbomTotal = allMbomItems.length
      const mbomItemIds = allMbomItems.map((p) => p.id)

      if (mbomItemIds.length > 0) {
        const linkedItems = await db
          .select({ mbomId: itemRelationships.targetId })
          .from(itemRelationships)
          .where(
            and(
              inArray(itemRelationships.targetId, mbomItemIds),
              eq(itemRelationships.relationshipType, EBOM_SOURCE_RELATIONSHIP),
            ),
          )
        linkedToEbom = new Set(linkedItems.map((p) => p.mbomId)).size
      }
    }

    return {
      requirements: {
        total: allRequirements.length,
        allocated,
        satisfied,
        verified,
      },
      engineering: {
        total: allParts.length,
        tested,
        mappedToMbom,
      },
      manufacturing: {
        total: mbomTotal,
        linkedToEbom,
      },
    }
  }

  /**
   * Calculate severity for a requirement gap based on priority.
   */
  private static calculateRequirementSeverity(
    priority: string | null,
  ): GapSeverity {
    switch (priority) {
      case 'MustHave':
        return 'critical'
      case 'ShouldHave':
        return 'major'
      case 'CouldHave':
        return 'minor'
      case 'WontHave':
        return 'minor'
      default:
        return 'major'
    }
  }

  /**
   * Calculate severity for a part gap based on state.
   */
  private static calculatePartSeverity(state: string): GapSeverity {
    switch (state) {
      case 'Released':
        return 'major'
      case 'In Review':
        return 'major'
      case 'Draft':
        return 'minor'
      default:
        return 'minor'
    }
  }

  /**
   * Calculate summary statistics from gaps.
   */
  private static calculateSummary(
    gaps: Array<Gap>,
    coverage: GapAnalysisResult['coverage'],
  ): GapAnalysisResult['summary'] {
    const byType: Record<GapType, number> = {
      unallocated_requirement: 0,
      unsatisfied_requirement: 0,
      unverified_requirement: 0,
      untested_part: 0,
      unmapped_ebom_item: 0,
      orphan_mbom_item: 0,
      missing_documentation: 0,
    }

    const bySeverity: Record<GapSeverity, number> = {
      critical: 0,
      major: 0,
      minor: 0,
    }

    const byDomain: Record<ThreadDomain, number> = {
      requirements: 0,
      engineering: 0,
      manufacturing: 0,
      validation: 0,
    }

    for (const gap of gaps) {
      byType[gap.type]++
      bySeverity[gap.severity]++
      byDomain[gap.domain]++
    }

    // Calculate completeness (weighted average)
    const { requirements: req, engineering: eng } = coverage

    const allocatedPercent =
      req.total > 0 ? (req.allocated / req.total) * 100 : 100
    const satisfiedPercent =
      req.total > 0 ? (req.satisfied / req.total) * 100 : 100
    const verifiedPercent =
      req.total > 0 ? (req.verified / req.total) * 100 : 100
    const testedPercent = eng.total > 0 ? (eng.tested / eng.total) * 100 : 100

    const completeness = Math.round(
      allocatedPercent * 0.2 +
        satisfiedPercent * 0.3 +
        verifiedPercent * 0.3 +
        testedPercent * 0.2,
    )

    return {
      totalGaps: gaps.length,
      byType,
      bySeverity,
      byDomain,
      completeness,
    }
  }
}
