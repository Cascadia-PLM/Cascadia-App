// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../db'
import { notDeleted } from '../db/filters'
import { designs } from '../db/schema/designs'
import { itemRelationships, items, requirements } from '../db/schema/items'
import { branchItems } from '../db/schema/versioning'
import { NotFoundError, ValidationError } from '../errors'
import { ItemService } from '../items/services/ItemService'
import { ItemRelationshipService } from '../items/services/ItemRelationshipService'
import {
  ALLOCATED_TO_RELATIONSHIP,
  DERIVES_FROM_RELATIONSHIP,
  SATISFIES_RELATIONSHIP,
  VERIFIED_BY_RELATIONSHIP,
} from '../items/traceability-relationships'
import { BranchService } from './BranchService'
import type { PersistedItem } from '../items/types/base'
import type { Requirement } from '../items/types/requirement'

/**
 * Relationship type constants for requirements domain.
 * Defined in `lib/items/traceability-relationships` so the edit-lock policy
 * can name them without importing this service back; re-exported here because
 * this is where callers have always found them.
 */
export {
  ALLOCATED_TO_RELATIONSHIP,
  DERIVES_FROM_RELATIONSHIP,
  SATISFIES_RELATIONSHIP,
  VERIFIED_BY_RELATIONSHIP,
}

/**
 * Where a traceability link write lands.
 *
 * Every link here is a content edit of one of its two items, so it obeys the
 * same rule as any other structural edit: a branch row whose checkout the
 * caller holds, or main before anything in the design has released
 * (`ItemEditPolicy.requireContentEditable`). `branchId` is how a caller says
 * "inside this ECO": both ends resolve to the rows that branch is working
 * from, so the caller can keep naming items by the ids it already has —
 * usually main's — without knowing any working-copy id. Without it the link
 * is written against the rows named, which on a released design means main,
 * and is refused with the ECO hint.
 *
 * Deliberately **not** a checkout: naming a branch resolves rows, it does not
 * take locks or start revisions. Pulling an item into an ECO's scope is
 * `POST /change-orders/:id/checkout` and stays an explicit act — a link
 * endpoint that silently added items to the reviewed set would put content in
 * a release nobody asked for. Same stance as the ECO BOM editor, which
 * refuses a parent that is not already an affected item.
 */
export interface TraceabilityLinkOptions {
  branchId?: string
}

/**
 * The subset of the items asked about that had at least one link, for the
 * coverage counters that only care whether an item is covered at all.
 */
export function idsWithLinks(links: Map<string, Array<unknown>>): Set<string> {
  const covered = new Set<string>()
  for (const [id, found] of links) {
    if (found.length > 0) covered.add(id)
  }
  return covered
}

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
   * Resolve one end of a link onto `branchId`: the row that branch is
   * currently working from for this item's master, or the item itself when
   * the branch does not track it (it inherits main's row).
   *
   * Callers name items by whatever id they hold — usually main's — so
   * finding the branch's own row is this service's job, not theirs. What the
   * caller may then do with that row is the edit-lock policy's call, made
   * where the edge is written.
   */
  private static async resolveOnBranch(
    item: PersistedItem,
    branchId: string,
  ): Promise<PersistedItem> {
    const branch = await BranchService.getById(branchId)
    if (!branch) {
      throw new NotFoundError('Branch', branchId, {
        operation: 'resolveOnBranch',
      })
    }
    if (item.designId && item.designId !== branch.designId) {
      throw new ValidationError(
        `Item '${item.itemNumber}' is not in the design that branch '${branch.name}' belongs to`,
        undefined,
        { operation: 'resolveOnBranch', itemId: item.id },
      )
    }

    const [branchRow] = await db
      .select({ currentItemId: branchItems.currentItemId })
      .from(branchItems)
      .where(
        and(
          eq(branchItems.branchId, branchId),
          eq(branchItems.itemMasterId, item.masterId),
        ),
      )
      .limit(1)

    if (!branchRow?.currentItemId || branchRow.currentItemId === item.id) {
      return item
    }
    return (await ItemService.findById(branchRow.currentItemId)) ?? item
  }

  /**
   * Resolve both ends of a link for the branch the caller named. A no-op
   * without one — the link is then written exactly where the caller pointed.
   */
  private static async resolveLinkEnds(
    source: PersistedItem,
    target: PersistedItem,
    branchId: string | undefined,
  ): Promise<{ source: PersistedItem; target: PersistedItem }> {
    if (!branchId) return { source, target }
    return {
      source: await this.resolveOnBranch(source, branchId),
      target: await this.resolveOnBranch(target, branchId),
    }
  }

  /**
   * `resolveLinkEnds` for the unlink paths, which work in ids and treat an
   * item that no longer exists as "no such link" rather than an error — the
   * behaviour those paths have always had.
   */
  private static async resolveLinkEndIds(
    sourceId: string,
    targetId: string,
    branchId: string | undefined,
  ): Promise<{ sourceId: string; targetId: string }> {
    if (!branchId) return { sourceId, targetId }

    const [source, target] = await Promise.all([
      ItemService.findById(sourceId),
      ItemService.findById(targetId),
    ])
    if (!source || !target) return { sourceId, targetId }

    const ends = await this.resolveLinkEnds(source, target, branchId)
    return { sourceId: ends.source.id, targetId: ends.target.id }
  }

  /**
   * Create SATISFIES relationships between items and a requirement.
   * Direction: Item (Part/Document) → Requirement (source → target)
   */
  static async linkSatisfaction(
    requirementId: string,
    itemIds: Array<string>,
    userId: string,
    options?: TraceabilityLinkOptions,
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

      const ends = await this.resolveLinkEnds(
        item,
        requirement,
        options?.branchId,
      )

      // Check if relationship already exists
      const existing = await db
        .select()
        .from(itemRelationships)
        .where(
          and(
            eq(itemRelationships.sourceId, ends.source.id),
            eq(itemRelationships.targetId, ends.target.id),
            eq(itemRelationships.relationshipType, SATISFIES_RELATIONSHIP),
          ),
        )
        .limit(1)

      if (existing.length === 0) {
        await ItemService.addRelationship(
          ends.source.id,
          ends.target.id,
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
    options?: TraceabilityLinkOptions,
  ): Promise<void> {
    const ends = await this.resolveLinkEndIds(
      itemId,
      requirementId,
      options?.branchId,
    )

    // Find the relationship
    const [relationship] = await db
      .select()
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.sourceId, ends.sourceId),
          eq(itemRelationships.targetId, ends.targetId),
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
    // Everything that satisfies this requirement now: links it inherited from
    // the revision it replaced, minus links a revision left behind.
    const relationships =
      (
        await ItemRelationshipService.findIncomingLinks(
          [requirementId],
          SATISFIES_RELATIONSHIP,
        )
      ).get(requirementId) ?? []

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
        relationshipId: rel!.id,
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
    // A requirement revised since this link was made is named by the row the
    // release superseded, so targets resolve forward.
    const relationships =
      (
        await ItemRelationshipService.findOutgoingLinks(
          [itemId],
          SATISFIES_RELATIONSHIP,
        )
      ).get(itemId) ?? []

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
        relationshipId: rel!.id,
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
    options?: TraceabilityLinkOptions,
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

    const ends = await this.resolveLinkEnds(
      requirement,
      targetItem,
      options?.branchId,
    )

    // Check if relationship already exists
    const existing = await db
      .select()
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.sourceId, ends.source.id),
          eq(itemRelationships.targetId, ends.target.id),
          eq(itemRelationships.relationshipType, ALLOCATED_TO_RELATIONSHIP),
        ),
      )
      .limit(1)

    if (existing.length === 0) {
      await ItemService.addRelationship(
        ends.source.id,
        ends.target.id,
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
    options?: TraceabilityLinkOptions,
  ): Promise<void> {
    const ends = await this.resolveLinkEndIds(
      requirementId,
      targetItemId,
      options?.branchId,
    )

    // Find the relationship
    const [relationship] = await db
      .select()
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.sourceId, ends.sourceId),
          eq(itemRelationships.targetId, ends.targetId),
          eq(itemRelationships.relationshipType, ALLOCATED_TO_RELATIONSHIP),
        ),
      )
      .limit(1)

    if (relationship) {
      await ItemService.removeRelationship(relationship.id, userId)
    }
  }

  /**
   * Get the items a requirement is allocated to (ALLOCATED_TO relationships).
   *
   * The mirror of `getSatisfyingItems`: allocation runs requirement → item,
   * so this reads the requirement's outgoing edges. Gap analysis reports
   * `unallocated_requirement` against exactly this set.
   */
  static async getAllocatedItems(
    requirementId: string,
  ): Promise<Array<SatisfyingItem>> {
    const relationships =
      (
        await ItemRelationshipService.findOutgoingLinks(
          [requirementId],
          ALLOCATED_TO_RELATIONSHIP,
        )
      ).get(requirementId) ?? []

    if (relationships.length === 0) {
      return []
    }

    const targetIds = relationships.map((r) => r.targetId)
    const targetItems = await db
      .select({
        id: items.id,
        itemNumber: items.itemNumber,
        name: items.name,
        itemType: items.itemType,
        revision: items.revision,
        state: items.state,
      })
      .from(items)
      .where(and(inArray(items.id, targetIds), notDeleted()))

    return targetItems.map((item) => {
      const rel = relationships.find((r) => r.targetId === item.id)
      return {
        ...item,
        relationshipId: rel!.id,
      }
    })
  }

  /**
   * Create a derived requirement from a parent requirement.
   * Sets up the parentRequirementId field for the derived requirement.
   *
   * Where the child lands, in order:
   *
   * 1. `options.branchId`, when the caller names one.
   * 2. The parent's own branch, when the parent row is the working copy on an
   *    ECO or workspace branch — a refinement of a requirement being edited
   *    under a change order belongs in that change order.
   * 3. Main, which only succeeds while the design is pre-release.
   *
   * Requirements are ECO-driven, so once anything in the design has been
   * released main is protected and a branch is the only place a child can go.
   * That is exactly when requirements get decomposed, so a derive with no way
   * to name a branch was unusable for the whole post-release life of a design.
   */
  static async deriveRequirement(
    parentRequirementId: string,
    childData: Partial<Requirement>,
    userId: string,
    options?: { branchId?: string; commitMessage?: string },
  ): Promise<Requirement> {
    // Verify parent requirement exists
    const parentRequirement = await ItemService.findById(parentRequirementId)
    if (!parentRequirement || parentRequirement.itemType !== 'Requirement') {
      throw new NotFoundError('Requirement', parentRequirementId, {
        operation: 'deriveRequirement',
      })
    }

    // findById merges the type-specific row into the item, so the requirement
    // columns are there at runtime; `PersistedItem` types only the base ones,
    // and they come back nullable because that is what the columns are.
    const parentFields = parentRequirement as typeof parentRequirement & {
      verificationMethod?: Requirement['verificationMethod'] | null
      category?: string | null
      source?: string | null
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

    // Ensure child has designId from parent if not specified. No revision:
    // requirements are ECO-driven, so the release that assigns one is what
    // names it — inventing 'A' here made the first release read it as a real
    // revision A and revise the child straight to B.
    //
    // A derived requirement refines its parent, so it also inherits the
    // parent's verification method and its classification/provenance unless
    // the caller overrides them. Without this the child came back with no
    // verification method at all and had to be PUT immediately afterwards.
    const derivedData: Partial<Requirement> = {
      ...childData,
      itemNumber,
      parentRequirementId,
      designId: childData.designId || parentRequirement.designId,
      verificationMethod:
        childData.verificationMethod ??
        parentFields.verificationMethod ??
        undefined,
      category: childData.category ?? parentFields.category ?? undefined,
      source: childData.source ?? parentFields.source ?? undefined,
    }

    // Defensive runtime check: callers may pass a wrongly-typed itemType via
    // `as Requirement` casts despite the static `'Requirement'` constraint.
    if (
      derivedData.itemType &&
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- caller may bypass static type via cast
      derivedData.itemType !== 'Requirement'
    ) {
      throw new ValidationError(
        'Derived item must be a Requirement',
        undefined,
        { operation: 'deriveRequirement' },
      )
    }

    const branchId =
      options?.branchId ??
      (await ItemService.getItemBranchInfo(parentRequirementId))?.branchId

    // No branch in play: create on main. ItemService.create is what rejects
    // this once the design has released something.
    if (!branchId) {
      return ItemService.create(
        'Requirement',
        derivedData as Requirement,
        userId,
      )
    }

    const branch = await BranchService.getById(branchId)
    if (!branch) {
      throw new NotFoundError('Branch', branchId, {
        operation: 'deriveRequirement',
      })
    }
    // createOnBranch takes the item's design from the branch, so a branch in
    // some other design would silently file the child away from its parent.
    if (branch.designId !== derivedData.designId) {
      throw new ValidationError(
        'Target branch belongs to a different design than the parent requirement',
        undefined,
        { operation: 'deriveRequirement' },
      )
    }

    const { item } = await ItemService.createOnBranch(
      'Requirement',
      derivedData as Requirement,
      branchId,
      options?.commitMessage ??
        `Derived ${itemNumber} from ${parentRequirement.itemNumber}`,
      userId,
    )

    return item as Requirement
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

    // Allocation runs requirement → item, so it rides the requirement's own
    // outgoing edges and a revision carries it. Satisfaction and verification
    // point the other way and need the version-aware read.
    const allocatedLinks = await ItemRelationshipService.findOutgoingLinks(
      requirementIds,
      ALLOCATED_TO_RELATIONSHIP,
    )
    const allocatedIds = idsWithLinks(allocatedLinks)

    const satisfiedIds = idsWithLinks(
      await ItemRelationshipService.findIncomingLinks(
        requirementIds,
        SATISFIES_RELATIONSHIP,
      ),
    )

    // A requirement counts as verified with a test case OR verificationStatus 'Passed'
    const verifiedByTestIds = idsWithLinks(
      await ItemRelationshipService.findIncomingLinks(
        requirementIds,
        VERIFIED_BY_RELATIONSHIP,
      ),
    )

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
    options?: TraceabilityLinkOptions,
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

      const ends = await this.resolveLinkEnds(
        testCase,
        requirement,
        options?.branchId,
      )

      // Check if relationship already exists
      const existing = await db
        .select()
        .from(itemRelationships)
        .where(
          and(
            eq(itemRelationships.sourceId, ends.source.id),
            eq(itemRelationships.targetId, ends.target.id),
            eq(itemRelationships.relationshipType, VERIFIED_BY_RELATIONSHIP),
          ),
        )
        .limit(1)

      if (existing.length === 0) {
        await ItemService.addRelationship(
          ends.source.id,
          ends.target.id,
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
    options?: TraceabilityLinkOptions,
  ): Promise<void> {
    const ends = await this.resolveLinkEndIds(
      testCaseId,
      requirementId,
      options?.branchId,
    )

    // Find the relationship
    const [relationship] = await db
      .select()
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.sourceId, ends.sourceId),
          eq(itemRelationships.targetId, ends.targetId),
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
    // Inherited across revisions, and without the rows a revision left
    // behind — see ItemRelationshipService.findIncomingLinks.
    const relationships =
      (
        await ItemRelationshipService.findIncomingLinks(
          [requirementId],
          VERIFIED_BY_RELATIONSHIP,
        )
      ).get(requirementId) ?? []

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
        relationshipId: rel!.id,
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
    // Targets resolve forward: a requirement revised since the link was made
    // is named by the row the release superseded.
    const relationships =
      (
        await ItemRelationshipService.findOutgoingLinks(
          [testCaseId],
          VERIFIED_BY_RELATIONSHIP,
        )
      ).get(testCaseId) ?? []

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
        relationshipId: rel!.id,
      }
    })
  }
}
