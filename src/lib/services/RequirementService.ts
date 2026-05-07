import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../db'
import { notDeleted } from '../db/filters'
import { designs } from '../db/schema/designs'
import { itemRelationships, items, requirements } from '../db/schema/items'
import { NotFoundError, ValidationError } from '../errors'
import { ItemService } from '../items/services/ItemService'
import type { Requirement } from '../items/types/requirement'

/**
 * Relationship type constants for requirements domain
 */
export const SATISFIES_RELATIONSHIP = 'SATISFIES' // Part/Document → Requirement
export const DERIVES_FROM_RELATIONSHIP = 'DERIVES_FROM' // ChildReq → ParentReq
export const ALLOCATED_TO_RELATIONSHIP = 'ALLOCATED_TO' // Requirement → Part
export const VERIFIED_BY_RELATIONSHIP = 'VERIFIED_BY' // TestCase → Requirement (Phase 3)

/**
 * Gap information for requirements coverage
 */
export interface RequirementGap {
  id: string
  itemNumber: string
  name: string | null
  priority: string | null
  gapType: 'not_allocated' | 'not_satisfied' | 'not_verified'
}

/**
 * Requirements coverage metrics for a design
 */
export interface RequirementsCoverage {
  totalRequirements: number
  allocated: number
  satisfied: number
  verified: number
  allocatedPercent: number
  satisfiedPercent: number
  verifiedPercent: number
  gaps: Array<RequirementGap>
}

/**
 * Item that satisfies a requirement
 */
export interface SatisfyingItem {
  id: string
  itemNumber: string
  name: string | null
  itemType: string
  revision: string
  state: string
  relationshipId: string
}

/**
 * Service for requirements traceability and satisfaction linking
 */
export class RequirementService {
  /**
   * Create SATISFIES relationships between items and a requirement.
   * Direction: Item (Part/Document) → Requirement (source → target)
   */
  static async linkSatisfaction(
    requirementId: string,
    itemIds: Array<string>,
    userId: string,
  ): Promise<void> {
    // Verify requirement exists
    const requirement = await ItemService.findById(requirementId)
    if (!requirement || requirement.itemType !== 'Requirement') {
      throw new NotFoundError('Requirement', requirementId, {
        operation: 'linkSatisfaction',
      })
    }

    // Create relationships for each item
    for (const itemId of itemIds) {
      const item = await ItemService.findById(itemId)
      if (!item) {
        throw new NotFoundError('Item', itemId, {
          operation: 'linkSatisfaction',
        })
      }

      // Check if relationship already exists
      const existing = await db
        .select()
        .from(itemRelationships)
        .where(
          and(
            eq(itemRelationships.sourceId, itemId),
            eq(itemRelationships.targetId, requirementId),
            eq(itemRelationships.relationshipType, SATISFIES_RELATIONSHIP),
          ),
        )
        .limit(1)

      if (existing.length === 0) {
        await ItemService.addRelationship(
          itemId,
          requirementId,
          SATISFIES_RELATIONSHIP,
          userId,
        )
      }
    }
  }

  /**
   * Remove a SATISFIES relationship between an item and a requirement.
   */
  static async unlinkSatisfaction(
    requirementId: string,
    itemId: string,
    userId: string,
  ): Promise<void> {
    // Find the relationship
    const [relationship] = await db
      .select()
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.sourceId, itemId),
          eq(itemRelationships.targetId, requirementId),
          eq(itemRelationships.relationshipType, SATISFIES_RELATIONSHIP),
        ),
      )
      .limit(1)

    if (relationship) {
      await ItemService.removeRelationship(relationship.id, userId)
    }
  }

  /**
   * Get items that satisfy a requirement.
   */
  static async getSatisfyingItems(
    requirementId: string,
  ): Promise<Array<SatisfyingItem>> {
    // Find all SATISFIES relationships where this requirement is the target
    const relationships = await db
      .select({
        relationshipId: itemRelationships.id,
        sourceId: itemRelationships.sourceId,
      })
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.targetId, requirementId),
          eq(itemRelationships.relationshipType, SATISFIES_RELATIONSHIP),
        ),
      )

    if (relationships.length === 0) {
      return []
    }

    // Get details for each satisfying item
    const sourceIds = relationships.map((r) => r.sourceId)
    const sourceItems = await db
      .select({
        id: items.id,
        itemNumber: items.itemNumber,
        name: items.name,
        itemType: items.itemType,
        revision: items.revision,
        state: items.state,
      })
      .from(items)
      .where(and(inArray(items.id, sourceIds), notDeleted()))

    // Map items to include relationship ID
    return sourceItems.map((item) => {
      const rel = relationships.find((r) => r.sourceId === item.id)
      return {
        ...item,
        relationshipId: rel!.relationshipId,
      }
    })
  }

  /**
   * Get requirements that an item satisfies.
   */
  static async getRequirementsSatisfiedBy(itemId: string): Promise<
    Array<{
      id: string
      itemNumber: string
      name: string | null
      priority: string | null
      verificationStatus: string | null
      relationshipId: string
    }>
  > {
    // Find all SATISFIES relationships where this item is the source
    const relationships = await db
      .select({
        relationshipId: itemRelationships.id,
        targetId: itemRelationships.targetId,
      })
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.sourceId, itemId),
          eq(itemRelationships.relationshipType, SATISFIES_RELATIONSHIP),
        ),
      )

    if (relationships.length === 0) {
      return []
    }

    // Get details for each requirement
    const targetIds = relationships.map((r) => r.targetId)
    const requirementItems = await db
      .select({
        id: items.id,
        itemNumber: items.itemNumber,
        name: items.name,
      })
      .from(items)
      .where(
        and(
          inArray(items.id, targetIds),
          eq(items.itemType, 'Requirement'),
          notDeleted(),
        ),
      )

    // Get requirement-specific data
    const requirementData = await db
      .select({
        itemId: requirements.itemId,
        priority: requirements.priority,
        verificationStatus: requirements.verificationStatus,
      })
      .from(requirements)
      .where(inArray(requirements.itemId, targetIds))

    // Combine data
    return requirementItems.map((req) => {
      const rel = relationships.find((r) => r.targetId === req.id)
      const reqData = requirementData.find((r) => r.itemId === req.id)
      return {
        id: req.id,
        itemNumber: req.itemNumber,
        name: req.name,
        priority: reqData?.priority ?? null,
        verificationStatus: reqData?.verificationStatus ?? null,
        relationshipId: rel!.relationshipId,
      }
    })
  }

  /**
   * Allocate a requirement to a target item (Part or Document).
   * Creates an ALLOCATED_TO relationship.
   */
  static async allocateToDesign(
    requirementId: string,
    targetItemId: string,
    userId: string,
  ): Promise<void> {
    // Verify requirement exists
    const requirement = await ItemService.findById(requirementId)
    if (!requirement || requirement.itemType !== 'Requirement') {
      throw new NotFoundError('Requirement', requirementId, {
        operation: 'allocateToDesign',
      })
    }

    // Verify target item exists
    const targetItem = await ItemService.findById(targetItemId)
    if (!targetItem) {
      throw new NotFoundError('Item', targetItemId, {
        operation: 'allocateToDesign',
      })
    }

    // Check if relationship already exists
    const existing = await db
      .select()
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.sourceId, requirementId),
          eq(itemRelationships.targetId, targetItemId),
          eq(itemRelationships.relationshipType, ALLOCATED_TO_RELATIONSHIP),
        ),
      )
      .limit(1)

    if (existing.length === 0) {
      await ItemService.addRelationship(
        requirementId,
        targetItemId,
        ALLOCATED_TO_RELATIONSHIP,
        userId,
      )
    }
  }

  /**
   * Remove allocation of a requirement to a target item.
   */
  static async removeAllocation(
    requirementId: string,
    targetItemId: string,
    userId: string,
  ): Promise<void> {
    // Find the relationship
    const [relationship] = await db
      .select()
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.sourceId, requirementId),
          eq(itemRelationships.targetId, targetItemId),
          eq(itemRelationships.relationshipType, ALLOCATED_TO_RELATIONSHIP),
        ),
      )
      .limit(1)

    if (relationship) {
      await ItemService.removeRelationship(relationship.id, userId)
    }
  }

  /**
   * Create a derived requirement from a parent requirement.
   * Sets up the parentRequirementId field for the derived requirement.
   */
  static async deriveRequirement(
    parentRequirementId: string,
    childData: Partial<Requirement>,
    userId: string,
  ): Promise<Requirement> {
    // Verify parent requirement exists
    const parentRequirement = await ItemService.findById(parentRequirementId)
    if (!parentRequirement || parentRequirement.itemType !== 'Requirement') {
      throw new NotFoundError('Requirement', parentRequirementId, {
        operation: 'deriveRequirement',
      })
    }

    // Generate itemNumber for derived requirement if not provided
    // Format: PARENT-D1, PARENT-D2, etc.
    let itemNumber = childData.itemNumber
    if (!itemNumber) {
      // Count existing children to generate suffix
      const existingChildren =
        await this.getChildRequirements(parentRequirementId)
      const suffix = existingChildren.length + 1
      itemNumber = `${parentRequirement.itemNumber}-D${suffix}`
    }

    // Ensure child has designId from parent if not specified
    const derivedData: Partial<Requirement> = {
      ...childData,
      itemNumber,
      revision: childData.revision || 'A',
      parentRequirementId,
      designId: childData.designId || parentRequirement.designId,
    }


    // Create the derived requirement
    const childRequirement = await ItemService.create(
      'Requirement',
      derivedData as Requirement,
      userId,
    )

    return childRequirement
  }

  /**
   * Get child requirements that derive from a parent requirement.
   */
  static async getChildRequirements(parentRequirementId: string): Promise<
    Array<{
      id: string
      itemNumber: string
      name: string | null
      state: string
      priority: string | null
    }>
  > {
    // Find requirements where parentRequirementId matches
    const childReqs = await db
      .select({
        itemId: requirements.itemId,
        priority: requirements.priority,
      })
      .from(requirements)
      .where(eq(requirements.parentRequirementId, parentRequirementId))

    if (childReqs.length === 0) {
      return []
    }

    // Get base item details
    const itemIds = childReqs.map((r) => r.itemId)
    const itemDetails = await db
      .select({
        id: items.id,
        itemNumber: items.itemNumber,
        name: items.name,
        state: items.state,
      })
      .from(items)
      .where(and(inArray(items.id, itemIds), notDeleted()))

    // Combine data
    return itemDetails.map((item) => {
      const reqData = childReqs.find((r) => r.itemId === item.id)
      return {
        id: item.id,
        itemNumber: item.itemNumber,
        name: item.name,
        state: item.state,
        priority: reqData?.priority ?? null,
      }
    })
  }

  /**
   * Get parent requirement if this is a derived requirement.
   */
  static async getParentRequirement(requirementId: string): Promise<{
    id: string
    itemNumber: string
    name: string | null
    state: string
  } | null> {
    // Get the requirement to find parentRequirementId
    const [reqData] = await db
      .select({
        parentRequirementId: requirements.parentRequirementId,
      })
      .from(requirements)
      .where(eq(requirements.itemId, requirementId))
      .limit(1)

    if (!reqData?.parentRequirementId) {
      return null
    }

    // Get parent requirement details
    const [parent] = await db
      .select({
        id: items.id,
        itemNumber: items.itemNumber,
        name: items.name,
        state: items.state,
      })
      .from(items)
      .where(and(eq(items.id, reqData.parentRequirementId), notDeleted()))
      .limit(1)

    return parent || null
  }

  /**
   * Calculate requirements coverage for a design.
   * Returns allocation, satisfaction, and verification metrics.
   */
  static async getCoverage(designId: string): Promise<RequirementsCoverage> {
    // Verify design exists
    const [design] = await db
      .select()
      .from(designs)
      .where(eq(designs.id, designId))
      .limit(1)

    if (!design) {
      throw new NotFoundError('Design', designId, {
        operation: 'getCoverage',
      })
    }

    // Get all requirements for this design
    const allRequirements = await db
      .select({
        id: items.id,
        itemNumber: items.itemNumber,
        name: items.name,
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
          notDeleted(),
        ),
      )

    const totalRequirements = allRequirements.length
    if (totalRequirements === 0) {
      return {
        totalRequirements: 0,
        allocated: 0,
        satisfied: 0,
        verified: 0,
        allocatedPercent: 0,
        satisfiedPercent: 0,
        verifiedPercent: 0,
        gaps: [],
      }
    }

    const requirementIds = allRequirements.map((r) => r.id)

    // Count allocated requirements (have ALLOCATED_TO relationship)
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

    // Count satisfied requirements (have SATISFIES relationship)
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

    // Count verified requirements (have VERIFIED_BY relationship OR verificationStatus === 'Passed')
    const verifiedByTestReqs = await db
      .select({ reqId: itemRelationships.targetId })
      .from(itemRelationships)
      .where(
        and(
          inArray(itemRelationships.targetId, requirementIds),
          eq(itemRelationships.relationshipType, VERIFIED_BY_RELATIONSHIP),
        ),
      )
    const verifiedByTestIds = new Set(verifiedByTestReqs.map((r) => r.reqId))

    // A requirement is considered verified if it has a test case OR if its status is 'Passed'
    const verifiedCount = allRequirements.filter(
      (r) => verifiedByTestIds.has(r.id) || r.verificationStatus === 'Passed',
    ).length

    // Calculate percentages
    const allocated = allocatedIds.size
    const satisfied = satisfiedIds.size
    const verified = verifiedCount

    // Identify gaps
    const gaps: Array<RequirementGap> = []
    for (const req of allRequirements) {
      if (!allocatedIds.has(req.id)) {
        gaps.push({
          id: req.id,
          itemNumber: req.itemNumber,
          name: req.name,
          priority: req.priority,
          gapType: 'not_allocated',
        })
      } else if (!satisfiedIds.has(req.id)) {
        gaps.push({
          id: req.id,
          itemNumber: req.itemNumber,
          name: req.name,
          priority: req.priority,
          gapType: 'not_satisfied',
        })
      } else if (
        !verifiedByTestIds.has(req.id) &&
        req.verificationStatus !== 'Passed'
      ) {
        // Not verified = no test case AND status not 'Passed'
        gaps.push({
          id: req.id,
          itemNumber: req.itemNumber,
          name: req.name,
          priority: req.priority,
          gapType: 'not_verified',
        })
      }
    }

    // Sort gaps by priority (MustHave first)
    const priorityOrder = ['MustHave', 'ShouldHave', 'CouldHave', 'WontHave']
    gaps.sort((a, b) => {
      const aOrder = a.priority
        ? priorityOrder.indexOf(a.priority)
        : priorityOrder.length
      const bOrder = b.priority
        ? priorityOrder.indexOf(b.priority)
        : priorityOrder.length
      return aOrder - bOrder
    })

    return {
      totalRequirements,
      allocated,
      satisfied,
      verified,
      allocatedPercent: Math.round((allocated / totalRequirements) * 1000) / 10,
      satisfiedPercent: Math.round((satisfied / totalRequirements) * 1000) / 10,
      verifiedPercent: Math.round((verified / totalRequirements) * 1000) / 10,
      gaps,
    }
  }

  /**
   * Update the verification status of a requirement.
   */
  static async updateVerificationStatus(
    requirementId: string,
    verificationStatus: string,
    userId: string,
  ): Promise<void> {
    await ItemService.update(
      requirementId,
      { verificationStatus } as Partial<Requirement>,
      userId,
    )
  }

  /**
   * Update the verification method of a requirement.
   */
  static async updateVerificationMethod(
    requirementId: string,
    verificationMethod: string,
    userId: string,
  ): Promise<void> {
    await ItemService.update(
      requirementId,
      { verificationMethod } as Partial<Requirement>,
      userId,
    )
  }

  /**
   * Create VERIFIED_BY relationships between test cases and a requirement.
   * Direction: TestCase → Requirement (source → target)
   * A test case "verifies" a requirement.
   */
  static async linkVerification(
    requirementId: string,
    testCaseIds: Array<string>,
    userId: string,
  ): Promise<void> {
    // Verify requirement exists
    const requirement = await ItemService.findById(requirementId)
    if (!requirement || requirement.itemType !== 'Requirement') {
      throw new NotFoundError('Requirement', requirementId, {
        operation: 'linkVerification',
      })
    }

    // Create relationships for each test case
    for (const testCaseId of testCaseIds) {
      const testCase = await ItemService.findById(testCaseId)
      if (!testCase) {
        throw new NotFoundError('TestCase', testCaseId, {
          operation: 'linkVerification',
        })
      }

      if (testCase.itemType !== 'TestCase') {
        throw new ValidationError(
          `Item ${testCaseId} is not a TestCase`,
          undefined,
          { operation: 'linkVerification' },
        )
      }

      // Check if relationship already exists
      const existing = await db
        .select()
        .from(itemRelationships)
        .where(
          and(
            eq(itemRelationships.sourceId, testCaseId),
            eq(itemRelationships.targetId, requirementId),
            eq(itemRelationships.relationshipType, VERIFIED_BY_RELATIONSHIP),
          ),
        )
        .limit(1)

      if (existing.length === 0) {
        await ItemService.addRelationship(
          testCaseId,
          requirementId,
          VERIFIED_BY_RELATIONSHIP,
          userId,
        )
      }
    }
  }

  /**
   * Remove a VERIFIED_BY relationship between a test case and a requirement.
   */
  static async unlinkVerification(
    requirementId: string,
    testCaseId: string,
    userId: string,
  ): Promise<void> {
    // Find the relationship
    const [relationship] = await db
      .select()
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.sourceId, testCaseId),
          eq(itemRelationships.targetId, requirementId),
          eq(itemRelationships.relationshipType, VERIFIED_BY_RELATIONSHIP),
        ),
      )
      .limit(1)

    if (relationship) {
      await ItemService.removeRelationship(relationship.id, userId)
    }
  }

  /**
   * Get test cases that verify a requirement (VERIFIED_BY relationships).
   */
  static async getVerifyingTests(requirementId: string): Promise<
    Array<{
      id: string
      itemNumber: string
      name: string | null
      testType: string | null
      executionStatus: string | null
      lastExecutedAt: Date | null
      relationshipId: string
    }>
  > {
    // Find all VERIFIED_BY relationships where this requirement is the target
    const relationships = await db
      .select({
        relationshipId: itemRelationships.id,
        sourceId: itemRelationships.sourceId,
      })
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.targetId, requirementId),
          eq(itemRelationships.relationshipType, VERIFIED_BY_RELATIONSHIP),
        ),
      )

    if (relationships.length === 0) {
      return []
    }

    // Get details for each test case
    const sourceIds = relationships.map((r) => r.sourceId)
    const testCaseItems = await db
      .select({
        id: items.id,
        itemNumber: items.itemNumber,
        name: items.name,
      })
      .from(items)
      .where(
        and(
          inArray(items.id, sourceIds),
          eq(items.itemType, 'TestCase'),
          notDeleted(),
        ),
      )

    // Import testCases table dynamically to avoid circular dependencies
    const { testCases } = await import('../db/schema/items')

    // Get test case specific data
    const testCaseData = await db
      .select({
        itemId: testCases.itemId,
        testType: testCases.testType,
        executionStatus: testCases.executionStatus,
        lastExecutedAt: testCases.lastExecutedAt,
      })
      .from(testCases)
      .where(inArray(testCases.itemId, sourceIds))

    // Combine data
    return testCaseItems.map((tc) => {
      const rel = relationships.find((r) => r.sourceId === tc.id)
      const tcData = testCaseData.find((t) => t.itemId === tc.id)
      return {
        id: tc.id,
        itemNumber: tc.itemNumber,
        name: tc.name,
        testType: tcData?.testType ?? null,
        executionStatus: tcData?.executionStatus ?? null,
        lastExecutedAt: tcData?.lastExecutedAt ?? null,
        relationshipId: rel!.relationshipId,
      }
    })
  }

  /**
   * Get requirements that a test case verifies (VERIFIED_BY relationships).
   */
  static async getRequirementsVerifiedBy(testCaseId: string): Promise<
    Array<{
      id: string
      itemNumber: string
      name: string | null
      priority: string | null
      verificationStatus: string | null
      relationshipId: string
    }>
  > {
    // Find all VERIFIED_BY relationships where this test case is the source
    const relationships = await db
      .select({
        relationshipId: itemRelationships.id,
        targetId: itemRelationships.targetId,
      })
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.sourceId, testCaseId),
          eq(itemRelationships.relationshipType, VERIFIED_BY_RELATIONSHIP),
        ),
      )

    if (relationships.length === 0) {
      return []
    }

    // Get details for each requirement
    const targetIds = relationships.map((r) => r.targetId)
    const requirementItems = await db
      .select({
        id: items.id,
        itemNumber: items.itemNumber,
        name: items.name,
      })
      .from(items)
      .where(
        and(
          inArray(items.id, targetIds),
          eq(items.itemType, 'Requirement'),
          notDeleted(),
        ),
      )

    // Get requirement-specific data
    const requirementData = await db
      .select({
        itemId: requirements.itemId,
        priority: requirements.priority,
        verificationStatus: requirements.verificationStatus,
      })
      .from(requirements)
      .where(inArray(requirements.itemId, targetIds))

    // Combine data
    return requirementItems.map((req) => {
      const rel = relationships.find((r) => r.targetId === req.id)
      const reqData = requirementData.find((r) => r.itemId === req.id)
      return {
        id: req.id,
        itemNumber: req.itemNumber,
        name: req.name,
        priority: reqData?.priority ?? null,
        verificationStatus: reqData?.verificationStatus ?? null,
        relationshipId: rel!.relationshipId,
      }
    })
  }
}
