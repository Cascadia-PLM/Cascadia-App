// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, eq, inArray, isNull, ne, or } from 'drizzle-orm'
import { BRANCH_TYPES } from '@cascadia/commons/versioning/branch-types'
import { db, withTx } from '../db'
import { AccessControlService } from '../auth/AccessControlService'
import { notDeleted } from '../db/filters'
import { designCrossReferences } from '../db/schema/crossReferences'
import { items } from '../db/schema/items'
import { designs } from '../db/schema/designs'
import { branchItems, branches } from '../db/schema/versioning'
import { NotFoundError, ValidationError } from '../errors'
import { takeFirst } from '@/db/take-first'

/**
 * Transaction client type for database operations
 */
type TransactionClient = Parameters<Parameters<typeof db.transaction>[0]>[0]

export interface CreateReferenceInput {
  referencingDesignId: string
  referencedItemId: string
  branchId?: string | null
  notes?: string
}

export interface CrossDesignReference {
  id: string
  referencingDesignId: string
  referencedItemId: string
  sourceDesignId: string
  branchId: string | null
  changeType: string | null
  inDesignStructure: boolean | null
  notes: string | null
  createdAt: Date
  // Joined metadata (nullable because of LEFT JOIN)
  itemNumber: string | null
  itemName: string | null
  itemRevision: string | null
  itemState: string | null
  itemType: string | null
  sourceDesignCode: string | null
  sourceDesignName: string | null
}

/**
 * A `design_cross_references` row naming an item, as a hard delete of that
 * item reads it: enough to tell a reference from bookkeeping, and to name the
 * design that holds it.
 */
export interface CrossDesignReferenceToItem {
  rowId: string
  referencedItemId: string
  changeType: string | null
  branchId: string | null
  branchName: string | null
  branchArchived: boolean | null
  designId: string
  designCode: string
  designName: string
}

export class CrossDesignReferenceService {
  /**
   * A reference added or removed on a branch is that branch's content, and an
   * archived branch accepts none. Neither writer commits, so nothing
   * downstream would refuse it for them.
   *
   * BranchService is reached lazily: its workspace discards import this
   * service, and a static import back would close a cycle. Resolved at call
   * time, as CheckoutService reaches ChangeOrderService.
   */
  private static async assertBranchNotArchived(
    branchId: string,
    operation: string,
    tx?: TransactionClient,
  ): Promise<void> {
    const { BranchService } = await import('./BranchService')
    const branch = await BranchService.getById(branchId, tx)
    if (!branch) {
      throw new NotFoundError('Branch', branchId, { operation })
    }
    BranchService.assertNotArchived(branch, operation)
  }

  /**
   * Create a cross-design reference.
   * If branchId is provided, marks as 'added' on that branch.
   * Otherwise creates on main (branchId=null, changeType=null).
   *
   * The referenced item has to be part of its design. A draft that exists
   * only on a workspace or change-order branch is refused: a design structure
   * shows a reference by resolving it on the source design's main, where the
   * draft is not, so the reference would show nowhere — and could not be
   * removed from any Structure tab — while the draft's owner stayed free to
   * discard it. A change order's release makes it referenceable.
   */
  static async createReference(
    input: CreateReferenceInput,
    userId: string,
    tx?: TransactionClient,
  ): Promise<typeof designCrossReferences.$inferSelect> {
    if (input.branchId) {
      await this.assertBranchNotArchived(input.branchId, 'createReference', tx)
    }

    return withTx(tx, async (dbClient) => {
      // Validate the referenced item exists, and hold it until the reference
      // commits. `referenced_item_id` has no foreign key to take this lock,
      // and every hard delete of an item depends on it: the delete takes FOR
      // UPDATE on the item before it looks for references (see
      // `releaseReferencesToDeletedItems`), which conflicts with FOR KEY
      // SHARE. A delete that got there first leaves no row for this read to
      // find; one that comes second waits, and then sees this reference.
      const item = await dbClient
        .select({
          id: items.id,
          masterId: items.masterId,
          designId: items.designId,
        })
        .from(items)
        .where(and(eq(items.id, input.referencedItemId), notDeleted()))
        .limit(1)
        .for('key share')
        .then((r) => r.at(0))

      if (!item) {
        throw new NotFoundError('Item', input.referencedItemId)
      }

      if (!item.designId) {
        throw new ValidationError(
          'Referenced item does not belong to any design',
        )
      }

      // Cannot reference items in the same design
      if (item.designId === input.referencingDesignId) {
        throw new ValidationError(
          'Cannot create a cross-design reference to an item in the same design',
        )
      }

      if (await this.isBranchOnlyDraft(item.masterId, dbClient)) {
        throw new ValidationError(
          'Cannot reference an item that exists only as a draft on a workspace or change-order branch: no design structure can show a reference to it. Reference it once a change order has released it.',
        )
      }

      const ref = takeFirst(
        await dbClient
          .insert(designCrossReferences)
          .values({
            referencingDesignId: input.referencingDesignId,
            referencedItemId: input.referencedItemId,
            sourceDesignId: item.designId,
            branchId: input.branchId || null,
            changeType: input.branchId ? 'added' : null,
            notes: input.notes || null,
            createdBy: userId,
            modifiedBy: userId,
          })
          .returning(),
      )

      return ref
    })
  }

  /**
   * Whether an item master exists only as a draft on a workspace or
   * change-order branch: created there, which leaves an 'added' tracking row,
   * and never on its design's main, where a release — or a creation on an
   * unprotected main — leaves a main-branch tracking row. A working copy of an
   * item already on main is not a draft, and neither is a master no branch
   * tracks, such as an item created directly under a design.
   */
  private static async isBranchOnlyDraft(
    masterId: string,
    client: TransactionClient,
  ): Promise<boolean> {
    const tracking = await client
      .select({
        branchType: branches.branchType,
        changeType: branchItems.changeType,
      })
      .from(branchItems)
      .innerJoin(branches, eq(branchItems.branchId, branches.id))
      .where(eq(branchItems.itemMasterId, masterId))

    return (
      !tracking.some((row) => row.branchType === BRANCH_TYPES.main) &&
      tracking.some(
        (row) =>
          row.changeType === 'added' &&
          (row.branchType === BRANCH_TYPES.changeOrder ||
            row.branchType === BRANCH_TYPES.workspace),
      )
    )
  }

  /**
   * Whether a reference row is one a design's structure shows: a baseline row,
   * or an addition on a branch that is still open. A branch's 'deleted' marker
   * only masks a baseline row, and an archived branch's work is over — released,
   * cancelled or discarded — so neither is a claim on the item.
   */
  static isLive(row: CrossDesignReferenceToItem): boolean {
    return (
      row.changeType !== 'deleted' &&
      (row.branchId === null || row.branchArchived !== true)
    )
  }

  /**
   * Every row naming one of these items rows, with what a hard delete needs to
   * tell a reference from bookkeeping and to name the design that holds it.
   */
  static async referencesToItems(
    itemIds: ReadonlyArray<string>,
    client: TransactionClient | typeof db = db,
  ): Promise<Array<CrossDesignReferenceToItem>> {
    if (itemIds.length === 0) return []
    return client
      .select({
        rowId: designCrossReferences.id,
        referencedItemId: designCrossReferences.referencedItemId,
        changeType: designCrossReferences.changeType,
        branchId: designCrossReferences.branchId,
        branchName: branches.name,
        branchArchived: branches.isArchived,
        designId: designs.id,
        designCode: designs.code,
        designName: designs.name,
      })
      .from(designCrossReferences)
      .innerJoin(
        designs,
        eq(designCrossReferences.referencingDesignId, designs.id),
      )
      .leftJoin(branches, eq(designCrossReferences.branchId, branches.id))
      .where(inArray(designCrossReferences.referencedItemId, [...itemIds]))
  }

  /**
   * Keep this table consistent with a hard delete of items rows, in the
   * deleting transaction and before it writes anything else.
   * `ItemService.delete` and the workspace discards in `BranchService` all
   * come through here.
   *
   * `referenced_item_id` carries no foreign key, so nothing cascades from an
   * item to the rows naming it. The items are locked first: `createReference`
   * takes FOR KEY SHARE on the item it validates, and FOR UPDATE conflicts
   * with that, so the two serialize. A reference whose transaction locked the
   * item first has committed by the time the read below runs; one that comes
   * second waits for the delete, and then finds no item to reference.
   *
   * Live references are returned with nothing written, and the caller
   * refuses. A reference is not taken with the item, because it belongs to
   * the design holding it: that design's main may be protected, it may sit in
   * a program the deleting user cannot read, and a reference removed on main
   * records nothing. Otherwise every row naming the items is bookkeeping — a
   * branch's 'deleted' marker, or an addition on an archived branch — and is
   * removed, so no row outlives the item it names.
   */
  static async releaseReferencesToDeletedItems(
    itemIds: ReadonlyArray<string>,
    tx: TransactionClient,
  ): Promise<Array<CrossDesignReferenceToItem>> {
    if (itemIds.length === 0) return []

    await tx
      .select({ id: items.id })
      .from(items)
      .where(inArray(items.id, [...itemIds]))
      .orderBy(items.id)
      .for('update')

    const rows = await this.referencesToItems(itemIds, tx)
    const live = rows.filter((row) => this.isLive(row))
    if (live.length > 0) return live

    if (rows.length > 0) {
      await tx.delete(designCrossReferences).where(
        inArray(
          designCrossReferences.id,
          rows.map((row) => row.rowId),
        ),
      )
    }
    return []
  }

  /**
   * The designs holding these references, as a refusal names them: each one
   * the caller can read — with its branches, where the references exist only
   * on branches — and a count of the rest, so a refusal discloses nothing
   * across a program boundary. It reads the caller's access scope on the
   * pool, so call it once the transaction that found the references is over.
   */
  static async describeReferencingDesigns(
    references: ReadonlyArray<CrossDesignReferenceToItem>,
    userId: string,
  ): Promise<{ designs: string; designCount: number }> {
    const byDesign = new Map<
      string,
      { label: string; onMain: boolean; branchNames: Set<string> }
    >()
    for (const row of references) {
      const design = byDesign.get(row.designId) ?? {
        label: `${row.designCode} (${row.designName})`,
        onMain: false,
        branchNames: new Set<string>(),
      }
      if (row.branchId === null) {
        design.onMain = true
      } else {
        design.branchNames.add(`"${row.branchName ?? row.branchId}"`)
      }
      byDesign.set(row.designId, design)
    }

    const readable = await AccessControlService.getAccessibleDesignIds(userId)
    const readableIds = readable === null ? null : new Set(readable)
    const list = new Intl.ListFormat('en', { type: 'conjunction' })

    const named: Array<string> = []
    let unnamed = 0
    for (const [designId, design] of byDesign) {
      if (readableIds !== null && !readableIds.has(designId)) {
        unnamed++
      } else if (design.onMain) {
        named.push(design.label)
      } else {
        const branchNames = [...design.branchNames]
        named.push(
          `${design.label} on ${branchNames.length === 1 ? 'branch' : 'branches'} ${list.format(branchNames)}`,
        )
      }
    }
    if (unnamed > 0) {
      named.push(
        `${unnamed} ${named.length > 0 ? 'other ' : ''}${unnamed === 1 ? 'design' : 'designs'} you do not have access to`,
      )
    }

    return { designs: list.format(named), designCount: byDesign.size }
  }

  /**
   * Remove a cross-design reference.
   * On a branch: marks as 'deleted'.
   * On main (no branch): physically deletes.
   */
  static async removeReference(
    refId: string,
    branchId: string | null,
    userId: string,
    tx?: TransactionClient,
  ): Promise<void> {
    const dbClient = tx || db

    if (branchId) {
      await this.assertBranchNotArchived(branchId, 'removeReference', tx)
    }

    const ref = await dbClient
      .select()
      .from(designCrossReferences)
      .where(eq(designCrossReferences.id, refId))
      .limit(1)
      .then((r) => r.at(0))

    if (!ref) {
      throw new NotFoundError('CrossDesignReference', refId)
    }

    if (branchId) {
      // On a branch: if the ref was 'added' on this same branch, just delete it
      if (ref.branchId === branchId && ref.changeType === 'added') {
        await dbClient
          .delete(designCrossReferences)
          .where(eq(designCrossReferences.id, refId))
      } else {
        // Baseline ref being removed on a branch — insert a 'deleted' marker.
        // onConflictDoNothing() makes this idempotent: if the 'deleted' marker
        // already exists (e.g., removeReference called twice for the same ref
        // on the same branch), the second insert is silently ignored.
        // This is safe — the ref is already marked deleted.
        await dbClient
          .insert(designCrossReferences)
          .values({
            referencingDesignId: ref.referencingDesignId,
            referencedItemId: ref.referencedItemId,
            sourceDesignId: ref.sourceDesignId,
            branchId,
            changeType: 'deleted',
            modifiedBy: userId,
            createdBy: userId,
          })
          .onConflictDoNothing()
      }
    } else {
      // On main: physically delete
      await dbClient
        .delete(designCrossReferences)
        .where(eq(designCrossReferences.id, refId))
    }
  }

  /**
   * Get all cross-design references for a design, branch-aware.
   * Returns refs on main + refs added on branch, minus refs deleted on branch.
   */
  static async getReferencesForDesign(
    designId: string,
    branchId?: string | null,
  ): Promise<Array<CrossDesignReference>> {
    // Get all baseline refs (on main) + branch-specific refs
    const conditions = [eq(designCrossReferences.referencingDesignId, designId)]

    if (branchId) {
      // Baseline (branchId IS NULL) OR on this branch
      conditions.push(
        or(
          isNull(designCrossReferences.branchId),
          eq(designCrossReferences.branchId, branchId),
        )!,
      )
    } else {
      // Only baseline refs
      conditions.push(isNull(designCrossReferences.branchId))
    }

    const refs = await db
      .select({
        id: designCrossReferences.id,
        referencingDesignId: designCrossReferences.referencingDesignId,
        referencedItemId: designCrossReferences.referencedItemId,
        sourceDesignId: designCrossReferences.sourceDesignId,
        branchId: designCrossReferences.branchId,
        changeType: designCrossReferences.changeType,
        inDesignStructure: designCrossReferences.inDesignStructure,
        notes: designCrossReferences.notes,
        createdAt: designCrossReferences.createdAt,
        // Join item metadata
        itemNumber: items.itemNumber,
        itemName: items.name,
        itemRevision: items.revision,
        itemState: items.state,
        itemType: items.itemType,
        // Join source design metadata
        sourceDesignCode: designs.code,
        sourceDesignName: designs.name,
      })
      .from(designCrossReferences)
      .leftJoin(items, eq(designCrossReferences.referencedItemId, items.id))
      .leftJoin(designs, eq(designCrossReferences.sourceDesignId, designs.id))
      .where(and(...conditions))

    if (!branchId) {
      return refs
    }

    // Branch-aware: filter out baseline refs that have a 'deleted' marker on this branch
    const deletedItemIds = new Set(
      refs
        .filter((r) => r.branchId === branchId && r.changeType === 'deleted')
        .map((r) => r.referencedItemId),
    )

    return refs.filter((r) => {
      // Exclude the 'deleted' marker rows themselves
      if (r.changeType === 'deleted') return false
      // Exclude baseline refs that were deleted on this branch
      if (r.branchId === null && deletedItemIds.has(r.referencedItemId))
        return false
      return true
    })
  }

  /**
   * The references a design holds, as one caller may see them — the view a
   * response is built from. `getReferencesForDesign` above is the engine's
   * view and stays complete: the structure tree and the release both act on
   * every reference, whoever is asking.
   *
   * A row is the referencing design's own, but nearly everything on it is
   * about the other end: the item's number, name, revision, state and type,
   * and its design's code and name. A reference into a design the caller
   * cannot read is withheld whole, and `hasRestricted` says one was — never
   * how many, the rule `withholdUnreadableNodes` applies to the tree these
   * references root. A row kept with those fields blanked would still count
   * the references that reach into programs the caller cannot open.
   *
   * Both ends are charged: the source design recorded on the reference, whose
   * code and name the row carries, and the design the item is in now, whose
   * fields it carries. They differ only for an item that has moved since the
   * reference was made. A reference to an item that no longer exists is
   * charged on its source design alone.
   */
  static async getReferencesForViewer(
    designId: string,
    branchId: string | null | undefined,
    accessDesignIds: Array<string> | null,
  ): Promise<{
    references: Array<CrossDesignReference>
    hasRestricted: boolean
  }> {
    const all = await this.getReferencesForDesign(designId, branchId)
    if (accessDesignIds === null) {
      return { references: all, hasRestricted: false }
    }

    const itemDesignIds = new Map<string, string | null>()
    const referencedIds = [...new Set(all.map((ref) => ref.referencedItemId))]
    if (referencedIds.length > 0) {
      const rows = await db
        .select({ id: items.id, designId: items.designId })
        .from(items)
        .where(inArray(items.id, referencedIds))
      for (const row of rows) itemDesignIds.set(row.id, row.designId)
    }

    const readable = new Set(accessDesignIds)
    const references = all.filter((ref) => {
      if (!readable.has(ref.sourceDesignId)) return false
      const itemDesignId = itemDesignIds.get(ref.referencedItemId)
      return !itemDesignId || readable.has(itemDesignId)
    })

    return { references, hasRestricted: references.length < all.length }
  }

  /**
   * Convert a cross-design reference to a usage-copy.
   *
   * When branchId is null (pre-release, viewing main): physically deletes the reference.
   * When branchId is set (ECO/workspace branch): creates a 'deleted' marker.
   *
   * This removes the reference and returns metadata needed for the caller
   * to invoke the existing usage-copy creation flow.
   */
  static async pullInReference(
    refId: string,
    branchId: string | null,
    userId: string,
  ): Promise<{
    referencedItemId: string
    referencingDesignId: string
    sourceDesignId: string
  } | null> {
    const ref = await db
      .select()
      .from(designCrossReferences)
      .where(eq(designCrossReferences.id, refId))
      .limit(1)
      .then((r) => r.at(0))

    if (!ref) {
      // Already removed (e.g. by a prior batch chain) — idempotent
      return null
    }

    // Remove the reference (branch-aware)
    await this.removeReference(refId, branchId, userId)

    return {
      referencedItemId: ref.referencedItemId,
      referencingDesignId: ref.referencingDesignId,
      sourceDesignId: ref.sourceDesignId,
    }
  }

  /**
   * Find all cross-design references pointing at specific items,
   * excluding references from certain designs (typically the ECO's own designs).
   */
  static async getReferencesToItems(
    itemIds: Array<string>,
    excludeDesignIds: Array<string>,
  ): Promise<
    Array<{
      referencingDesignId: string
      referencedItemId: string
      designCode: string
      designName: string
    }>
  > {
    if (itemIds.length === 0) return []

    const conditions = [
      inArray(designCrossReferences.referencedItemId, itemIds),
    ]

    if (excludeDesignIds.length > 0) {
      conditions.push(
        ...excludeDesignIds.map((id) =>
          ne(designCrossReferences.referencingDesignId, id),
        ),
      )
    }

    // Exclude deleted references
    conditions.push(
      or(
        isNull(designCrossReferences.changeType),
        ne(designCrossReferences.changeType, 'deleted'),
      )!,
    )

    const refs = await db
      .select({
        referencingDesignId: designCrossReferences.referencingDesignId,
        referencedItemId: designCrossReferences.referencedItemId,
        designCode: designs.code,
        designName: designs.name,
      })
      .from(designCrossReferences)
      .innerJoin(
        designs,
        eq(designCrossReferences.referencingDesignId, designs.id),
      )
      .where(and(...conditions))

    return refs.map((r) => ({
      referencingDesignId: r.referencingDesignId,
      referencedItemId: r.referencedItemId,
      designCode: r.designCode,
      designName: r.designName,
    }))
  }

  /**
   * Merge cross-design references when an ECO is released.
   * Called during ChangeOrderMergeService.mergeBranchToMain().
   *
   * - 'added' rows: promote to main (set branchId=null, changeType=null)
   * - 'deleted' rows: physically delete both the marker and the baseline row
   */
  static async mergeReferencesOnRelease(
    designId: string,
    branchId: string,
    tx?: TransactionClient,
  ): Promise<void> {
    const dbClient = tx || db

    // Get all branch-specific references for this design
    const branchRefs = await dbClient
      .select()
      .from(designCrossReferences)
      .where(
        and(
          eq(designCrossReferences.referencingDesignId, designId),
          eq(designCrossReferences.branchId, branchId),
        ),
      )

    for (const ref of branchRefs) {
      if (ref.changeType === 'added') {
        // Promote to main: set branchId=null, changeType=null
        await dbClient
          .update(designCrossReferences)
          .set({
            branchId: null,
            changeType: null,
          })
          .where(eq(designCrossReferences.id, ref.id))
      } else if (ref.changeType === 'deleted') {
        // Remove the 'deleted' marker
        await dbClient
          .delete(designCrossReferences)
          .where(eq(designCrossReferences.id, ref.id))

        // Also remove the baseline row it was masking
        await dbClient
          .delete(designCrossReferences)
          .where(
            and(
              eq(
                designCrossReferences.referencingDesignId,
                ref.referencingDesignId,
              ),
              eq(designCrossReferences.referencedItemId, ref.referencedItemId),
              isNull(designCrossReferences.branchId),
            ),
          )
      }
    }
  }
}
