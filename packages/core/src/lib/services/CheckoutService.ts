// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import {
  and,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
} from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db'
import { branchItems, branches, items, users } from '../db/schema'
import { takeFirst } from '../db/take-first'
import { getTypeHandler } from '../items/type-handlers'
import '../items/type-handlers/init'
import { NotFoundError, ResourceLockedError, ValidationError } from '../errors'
import { BranchService } from './BranchService'
import { CommitService } from './CommitService'
import { LifecycleService } from './LifecycleService'
import { RevisionService } from './RevisionService'
import { VersionResolver } from './VersionResolver'
import { expandSourceFieldChanges } from './software-source-changes'
import type { TransactionClient } from '../db'
import type { commits } from '../db/schema'
import type { FieldChange } from './CommitService'

// Core fields that exist on all items
const coreFields = ['name', 'state', 'revision', 'itemNumber']

// Type-specific fields, read off each type's extension table rather than
// restated here.
//
// The extension table's columns ARE the fields the type handler stores, so
// deriving makes the two ways a hand-written list drifts structurally
// impossible: a name that stores nothing can no longer be categorised 'type'
// (the old map carried 'documentType', 'content', 'requirementType',
// 'taskType' and 'proposedSolution', none of which are columns anywhere), and
// a column the handler writes can no longer be filed as an 'attribute' change
// because the list forgot it. It also covers the seven types that had no entry
// at all - TestPlan, TestCase, WorkInstruction, Issue, Tool, WorkOrder and
// PhysicalPart, whose own columns were every one of them mis-filed.
//
// `itemId` and `draftManifestId` are columns but never user-visible field
// changes; both stay excluded by `ignoreFields`, which is consulted first.
const typeFieldCache = new Map<string, ReadonlySet<string>>()

function typeFieldsFor(itemType: string): ReadonlySet<string> {
  const cached = typeFieldCache.get(itemType)
  if (cached) return cached
  const handler = getTypeHandler(itemType)
  const fields: ReadonlySet<string> = new Set(
    handler ? Object.keys(getTableColumns(handler.table)) : [],
  )
  typeFieldCache.set(itemType, fields)
  return fields
}

// Fields to ignore (metadata)
const ignoreFields = [
  'id',
  'masterId',
  'designId',
  'commitId',
  'itemType',
  // The extension row's foreign key to the item version it hangs off. Diffs
  // that read both sides from the database carry it, and it differs by
  // construction whenever the new side is a freshly minted working copy -
  // never a user-visible field change.
  'itemId',
  // Uncommitted editor state on Software working copies - never part of the
  // committed history (the commit records the manifestId change instead)
  'draftManifestId',
  'createdAt',
  'createdBy',
  'modifiedAt',
  'modifiedBy',
  'isCurrent',
  'lockedBy',
  'lockedAt',
  'isDeleted',
  'deletedAt',
  'deletedBy',
]

/**
 * Compute initial field values for a newly created item.
 * Returns FieldChange[] with oldValue=null for all non-empty fields.
 * Used to track what values were set when an item is first created.
 */
export function computeInitialFieldValues(
  newItem: Record<string, unknown>,
  itemType: string,
): Array<FieldChange> {
  const changes: Array<FieldChange> = []

  for (const [field, value] of Object.entries(newItem)) {
    if (ignoreFields.includes(field)) continue

    // Skip null/undefined/empty values
    if (value === null || value === undefined || value === '') continue

    // Handle nested attributes separately
    if (field === 'attributes' && typeof value === 'object') {
      for (const [attrKey, attrValue] of Object.entries(
        value as Record<string, unknown>,
      )) {
        if (attrValue !== null && attrValue !== undefined && attrValue !== '') {
          changes.push({
            fieldName: attrKey,
            fieldPath: `attributes.${attrKey}`,
            oldValue: null,
            newValue: attrValue,
            fieldCategory: 'attribute',
          })
        }
      }
      continue
    }

    // Determine category
    let category: 'core' | 'type' | 'attribute' | 'relationship' = 'attribute'
    if (coreFields.includes(field)) {
      category = 'core'
    } else if (typeFieldsFor(itemType).has(field)) {
      category = 'type'
    }

    changes.push({
      fieldName: field,
      oldValue: null,
      newValue: value,
      fieldCategory: category,
    })
  }

  return changes
}

/**
 * Compute field-level differences between two item versions
 */
export function computeFieldChanges(
  oldItem: Record<string, unknown> | null,
  newItem: Record<string, unknown>,
  itemType: string,
): Array<FieldChange> {
  const changes: Array<FieldChange> = []

  // If no old item (new item), return empty - use computeInitialFieldValues instead
  if (!oldItem) {
    return changes
  }

  // Check all fields
  const allFields = new Set([...Object.keys(oldItem), ...Object.keys(newItem)])

  for (const field of allFields) {
    if (ignoreFields.includes(field)) continue

    const oldVal = oldItem[field]
    const newVal = newItem[field]

    // Skip if unchanged
    if (JSON.stringify(oldVal) === JSON.stringify(newVal)) continue

    // Handle nested attributes separately
    if (field === 'attributes') {
      if (
        oldVal !== null &&
        typeof oldVal === 'object' &&
        newVal !== null &&
        typeof newVal === 'object'
      ) {
        const attrChanges = computeAttributeChanges(
          oldVal as Record<string, unknown>,
          newVal as Record<string, unknown>,
        )
        changes.push(...attrChanges)
        continue
      }
    }

    // Determine category
    let category: 'core' | 'type' | 'attribute' | 'relationship' = 'attribute'
    if (coreFields.includes(field)) {
      category = 'core'
    } else if (typeFieldsFor(itemType).has(field)) {
      category = 'type'
    }

    changes.push({
      fieldName: field,
      oldValue: oldVal,
      newValue: newVal,
      fieldCategory: category,
    })
  }

  return changes
}

/**
 * Compute changes within the attributes object
 */
function computeAttributeChanges(
  oldAttrs: Record<string, unknown>,
  newAttrs: Record<string, unknown>,
): Array<FieldChange> {
  const changes: Array<FieldChange> = []

  const allKeys = new Set([...Object.keys(oldAttrs), ...Object.keys(newAttrs)])

  for (const key of allKeys) {
    const oldVal = oldAttrs[key]
    const newVal = newAttrs[key]

    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      changes.push({
        fieldName: key,
        fieldPath: `attributes.${key}`,
        oldValue: oldVal,
        newValue: newVal,
        fieldCategory: 'attribute',
      })
    }
  }

  return changes
}

// Zod schemas for validation
export const checkoutSchema = z.object({
  itemMasterId: z.string().uuid(),
  branchId: z.string().uuid(),
})

export const saveChangesSchema = z.object({
  branchId: z.string().uuid(),
  itemId: z.string().uuid(),
  changes: z.record(z.string(), z.unknown()),
  commitMessage: z.string().min(1, 'Commit message is required'),
})

export type CheckoutInput = z.infer<typeof checkoutSchema>
export type SaveChangesInput = z.infer<typeof saveChangesSchema>

export interface CheckoutStatus {
  isCheckedOut: boolean
  checkedOutBy?: { id: string; name: string | null; email: string }
  checkedOutAt?: Date
  branchItem?: typeof branchItems.$inferSelect
}

export interface CheckedOutItem {
  branchItem: typeof branchItems.$inferSelect
  item: typeof items.$inferSelect
  branch: typeof branches.$inferSelect
}

// Lazy to break the cycle: ChangeOrderService imports CheckoutService
async function getChangeOrderService() {
  const { ChangeOrderService } =
    await import('../items/services/ChangeOrderService')
  return ChangeOrderService
}

/**
 * Refuse to put a NEW item onto an ECO branch whose scope is locked.
 *
 * Scope locking is enforced on the change-order service methods, but the
 * branch itself is reachable directly (POST /items/:id/checkout, batch
 * checkout, create-on-branch, the checkout dialog, the AI tools). Content
 * added that way merges and releases, so without this an item could be
 * added to an ECO after reviewers had locked its scope and would ship
 * without ever appearing in the affected items list.
 *
 * Deliberately narrow: this blocks NEW items only. Editing working copies
 * that are already in scope stays open during review, which is the whole
 * point of separating scope from content.
 */
async function assertBranchAcceptsNewItems(
  branch: typeof branches.$inferSelect,
): Promise<void> {
  if (branch.branchType !== 'eco' || !branch.changeOrderItemId) return

  const { WorkflowService } = await import('../workflows/WorkflowService')
  const instance = await WorkflowService.getInstanceByItemId(
    branch.changeOrderItemId,
  )

  if (instance?.scopeLocked) {
    throw new ValidationError(
      'Cannot add items to this ECO branch: the change order scope is locked. ' +
        'Existing working copies can still be edited.',
    )
  }
  if (instance?.completedAt) {
    throw new ValidationError(
      'Cannot add items to this ECO branch: the change order workflow has been completed.',
    )
  }
}

/**
 * Service for managing item checkout/checkin on branches
 */
export class CheckoutService {
  /**
   * Checkout an item to a branch for editing
   */
  /**
   * Name the holder of an exclusive checkout, and refuse.
   *
   * Both race paths end here, so the message a loser gets does not depend on
   * which of them lost.
   */
  private static async refuseLockedByAnother(
    holderId: string,
    itemMasterId: string,
    client: TransactionClient | typeof db = db,
  ): Promise<never> {
    const holder = await client
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, holderId))
      .limit(1)

    throw new ResourceLockedError(
      'Item',
      `already checked out by ${holder.at(0)?.name || holder.at(0)?.email || 'another user'}`,
      { operation: 'checkout', itemMasterId },
    )
  }

  /**
   * Take the lock on a `branch_items` row that already exists.
   *
   * The claim is a compare-and-set: the UPDATE carries
   * `checkedOutBy IS NULL` in its WHERE, so the database decides who wins
   * rather than a SELECT taken moments earlier. An empty `returning()` is a
   * legitimate outcome — somebody else got there — which is why this reads it
   * with `.at(0)` and not `takeFirst`.
   *
   * The loop exists for one case only: losing the CAS to a caller who then
   * checked the item straight back in, leaving the row free again. Two passes,
   * then stop. Spinning against real contention would turn a 409 into a hang,
   * and the second failure is answered by naming whoever holds it now.
   */
  private static async claimExistingCheckout(
    branchId: string,
    itemMasterId: string,
    userId: string,
  ): Promise<typeof branchItems.$inferSelect> {
    const read = async () =>
      db
        .select()
        .from(branchItems)
        .where(
          and(
            eq(branchItems.branchId, branchId),
            eq(branchItems.itemMasterId, itemMasterId),
          ),
        )
        .limit(1)
        .then((rows) => rows.at(0))

    for (let attempt = 0; attempt < 2; attempt++) {
      const row = await read()
      if (!row) {
        throw new NotFoundError('Item', itemMasterId, { operation: 'checkout' })
      }
      // Already ours: a double-click is not a conflict.
      if (row.checkedOutBy === userId) return row
      if (row.checkedOutBy) {
        await this.refuseLockedByAnother(row.checkedOutBy, itemMasterId)
      }

      const claimed = await db
        .update(branchItems)
        .set({ checkedOutBy: userId, checkedOutAt: new Date() })
        .where(
          and(eq(branchItems.id, row.id), isNull(branchItems.checkedOutBy)),
        )
        .returning()

      const won = claimed.at(0)
      if (won) return won
    }

    const settled = await read()
    if (settled?.checkedOutBy === userId) return settled
    if (settled?.checkedOutBy) {
      await this.refuseLockedByAnother(settled.checkedOutBy, itemMasterId)
    }
    throw new ResourceLockedError(
      'Item',
      'contended by concurrent checkouts; try again',
      { operation: 'checkout', itemMasterId },
    )
  }

  static async checkout(
    data: CheckoutInput,
    userId: string,
  ): Promise<typeof branchItems.$inferSelect> {
    const validated = checkoutSchema.parse(data)

    // Get the branch
    const branch = await BranchService.getById(validated.branchId)
    if (!branch) {
      throw new NotFoundError('Branch', validated.branchId, {
        operation: 'checkout',
      })
    }

    // Checkout on main is only possible in the pre-release phase. Once main
    // is protected (released items exist) all changes flow through ECO or
    // workspace branches. While unprotected, the checkout row on main is the
    // edit lock behind the UI's Edit button for draft items.
    if (branch.branchType === 'main') {
      const isProtected = await BranchService.isMainBranchProtected(
        branch.designId,
      )
      if (isProtected) {
        throw new ValidationError(
          'Cannot checkout items on the protected main branch. Use an ECO or workspace branch.',
        )
      }
    }

    // Check if branch is locked
    if (branch.isLocked) {
      throw new ValidationError('Cannot checkout items on a locked branch')
    }

    // Check if already checked out on this branch
    const existingBranchItem = await db
      .select()
      .from(branchItems)
      .where(
        and(
          eq(branchItems.branchId, validated.branchId),
          eq(branchItems.itemMasterId, validated.itemMasterId),
        ),
      )
      .limit(1)

    // The row exists: claiming it is a compare-and-set, not a decision taken
    // from the SELECT above. That read is a hint — between it and the write,
    // another caller can take the lock — and an unguarded UPDATE would simply
    // overwrite them, handing the same exclusive checkout to two people.
    if (existingBranchItem[0]) {
      return await this.claimExistingCheckout(
        validated.branchId,
        validated.itemMasterId,
        userId,
      )
    }

    // Bringing a new item onto the branch - scope has to still be open
    await assertBranchAcceptsNewItems(branch)

    // No branchItem exists - get the current released version
    const releasedItem = await VersionResolver.getReleasedVersion(
      validated.itemMasterId,
      branch.designId,
    )
    if (!releasedItem) {
      throw new NotFoundError('Item', validated.itemMasterId, {
        operation: 'checkout',
      })
    }

    // Create branchItem entry. `onConflictDoNothing` rather than a bare
    // insert: two callers reaching the check above at the same time both find
    // no row, and `branch_items_unique` would turn the loser's insert into a
    // raw 23505 — a 500 with a constraint name in it, for what is really "the
    // other tab got there first".
    const branchItem = await db
      .insert(branchItems)
      .values({
        branchId: validated.branchId,
        itemMasterId: validated.itemMasterId,
        currentItemId: releasedItem.id, // Start with the released version
        baseItemId: releasedItem.id, // Base for diff calculation
        changeType: null, // No changes yet
        checkedOutBy: userId,
        checkedOutAt: new Date(),
      })
      .onConflictDoNothing({
        target: [branchItems.branchId, branchItems.itemMasterId],
      })
      .returning()

    const created = branchItem.at(0)
    if (!created) {
      // Lost the insert. The row now exists and belongs to whoever won, so
      // resolve against it exactly as the update path does — and do not
      // register the branch change: that is the winner's to do, and doing it
      // twice would be two callers racing on the affected-items list as well.
      return await this.claimExistingCheckout(
        validated.branchId,
        validated.itemMasterId,
        userId,
      )
    }

    // Record it on the owning change order, so what merges and what
    // reviewers see stay the same set
    const ChangeOrderService = await getChangeOrderService()
    await ChangeOrderService.registerBranchChange(
      branch.id,
      validated.itemMasterId,
      releasedItem.id,
      userId,
    )

    return created
  }

  /**
   * Give a released item a branch-local working copy before the edit lock is
   * taken, so every subsequent content edit (fields, relationships,
   * work-instruction steps) targets the branch copy — never the shared
   * released row.
   *
   * The single-item and batch checkout routes used to do this inline: mint
   * the copy, then call `checkout` — which found the row already present,
   * took the claim path, and never registered the change on the owning
   * change order (registration is the row-creator's job). The branch then
   * carried modified content the affected-items list did not show, and the
   * release preview refused the change order with nothing left for the user
   * but to re-add the item by hand. Minting and registering are one
   * transaction here, the same pairing `addAffectedItem`,
   * `checkoutItemToEco` and the plain-checkout create path each guarantee.
   *
   * A master the branch does not track yet is new scope, so it runs the
   * same gate as `checkout` bringing a new item onto the branch: refused
   * once the change order leaves its initial state. A master the branch
   * already tracks without branch-local content (checked out earlier, copy
   * not yet minted) is scope the reviewers already see — minting its copy
   * stays open during review, exactly like the lazy mint in `saveChanges`.
   *
   * No-op on main, for items whose state does not imply a revision, and for
   * masters whose branch row already carries branch-local content.
   */
  static async ensureRevisionWorkingCopy(
    sourceItem: typeof items.$inferSelect,
    branchId: string,
    userId: string,
  ): Promise<void> {
    const branch = await BranchService.getById(branchId)
    if (!branch || branch.branchType === 'main') return

    // "Released" is whatever state the lifecycle revises from, not the
    // literal name — inferChangeAction reads the mappings.
    const ChangeOrderService = await getChangeOrderService()
    const action = await ChangeOrderService.inferChangeAction(
      sourceItem.itemType,
      sourceItem.state,
    )
    if (action !== 'revise') return

    const existingRow = await db
      .select({ changeType: branchItems.changeType })
      .from(branchItems)
      .where(
        and(
          eq(branchItems.branchId, branchId),
          eq(branchItems.itemMasterId, sourceItem.masterId),
        ),
      )
      .limit(1)
      .then((rows) => rows.at(0))

    // Already tracking branch-local content: nothing to mint.
    if (existingRow && existingRow.changeType !== null) return

    if (!existingRow) {
      await assertBranchAcceptsNewItems(branch)
    }

    await db.transaction(async (tx) => {
      await ChangeOrderService.createRevisionWorkingCopy(
        sourceItem,
        branchId,
        userId,
        tx,
      )
      // Record it on the owning change order, so what merges and what
      // reviewers see stay the same set. Idempotent, and a no-op for
      // branches no change order owns.
      await ChangeOrderService.registerBranchChange(
        branch.id,
        sourceItem.masterId,
        sourceItem.id,
        userId,
        tx,
      )
    })
  }

  /**
   * Get checkout status for an item on a branch
   */
  static async getCheckoutStatus(
    itemMasterId: string,
    branchId: string,
  ): Promise<CheckoutStatus> {
    const branchItem = await db
      .select()
      .from(branchItems)
      .where(
        and(
          eq(branchItems.branchId, branchId),
          eq(branchItems.itemMasterId, itemMasterId),
        ),
      )
      .limit(1)

    const bi = branchItem[0]
    if (!bi?.checkedOutBy) {
      return { isCheckedOut: false }
    }

    const user = await db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, bi.checkedOutBy))
      .limit(1)

    return {
      isCheckedOut: true,
      checkedOutBy: user.at(0),
      checkedOutAt: bi.checkedOutAt || undefined,
      branchItem: bi,
    }
  }

  /**
   * Cancel checkout (release without saving changes)
   */
  static async cancelCheckout(
    itemMasterId: string,
    branchId: string,
    userId: string,
  ): Promise<void> {
    const branchItem = await db
      .select()
      .from(branchItems)
      .where(
        and(
          eq(branchItems.branchId, branchId),
          eq(branchItems.itemMasterId, itemMasterId),
        ),
      )
      .limit(1)

    const bi = branchItem[0]
    if (!bi) {
      throw new NotFoundError('BranchItem', `${branchId}/${itemMasterId}`, {
        operation: 'cancelCheckout',
      })
    }

    if (bi.checkedOutBy !== userId) {
      throw new ValidationError('You do not have this item checked out')
    }

    // If no changes were made (changeType is null), remove the branchItem entirely
    if (!bi.changeType) {
      await db.delete(branchItems).where(eq(branchItems.id, bi.id))
    } else {
      // Otherwise, just clear the checkout
      await db
        .update(branchItems)
        .set({
          checkedOutBy: null,
          checkedOutAt: null,
        })
        .where(eq(branchItems.id, bi.id))
    }
  }

  /**
   * The item rows for a set of ids, keyed by id, skipping nulls.
   *
   * Both checkout listings walked their rows fetching one item each, which is
   * a query per checked-out item on a page that exists to show all of them.
   */
  private static async loadItemsById(
    ids: Array<string | null>,
  ): Promise<Map<string, typeof items.$inferSelect>> {
    const present = [...new Set(ids.filter((id): id is string => Boolean(id)))]
    if (present.length === 0) return new Map()

    const rows = await db.select().from(items).where(inArray(items.id, present))
    return new Map(rows.map((row) => [row.id, row]))
  }

  /**
   * List all checked out items for a user
   */
  static async listUserCheckouts(
    userId: string,
  ): Promise<Array<CheckedOutItem>> {
    const branchItemsList = await db
      .select({
        branchItem: branchItems,
        branch: branches,
      })
      .from(branchItems)
      .innerJoin(branches, eq(branchItems.branchId, branches.id))
      .where(eq(branchItems.checkedOutBy, userId))

    const itemsById = await this.loadItemsById(
      branchItemsList.map((row) => row.branchItem.currentItemId),
    )

    const result: Array<CheckedOutItem> = []
    for (const { branchItem, branch } of branchItemsList) {
      const found = branchItem.currentItemId
        ? itemsById.get(branchItem.currentItemId)
        : undefined
      if (found) {
        result.push({ branchItem, item: found, branch })
      }
    }

    return result
  }

  /**
   * List all checked out items on a branch
   */
  static async listBranchCheckouts(
    branchId: string,
  ): Promise<Array<CheckedOutItem>> {
    const branch = await BranchService.getById(branchId)
    if (!branch) {
      throw new NotFoundError('Branch', branchId, {
        operation: 'listBranchCheckouts',
      })
    }

    const branchItemsList = await db
      .select()
      .from(branchItems)
      .where(
        and(
          eq(branchItems.branchId, branchId),
          isNotNull(branchItems.checkedOutBy),
        ),
      )

    const itemsById = await this.loadItemsById(
      branchItemsList.map((bi) => bi.currentItemId),
    )

    const result: Array<CheckedOutItem> = []
    for (const branchItem of branchItemsList) {
      const found = branchItem.currentItemId
        ? itemsById.get(branchItem.currentItemId)
        : undefined
      if (found) {
        result.push({ branchItem, item: found, branch })
      }
    }

    return result
  }

  /**
   * Save changes to a checked out item
   * Creates a new item record and a commit
   */
  static async saveChanges(
    data: SaveChangesInput,
    userId: string,
  ): Promise<{
    item: typeof items.$inferSelect
    commit: typeof commits.$inferSelect
  }> {
    const validated = saveChangesSchema.parse(data)

    // Get the branch
    const branch = await BranchService.getById(validated.branchId)
    if (!branch) {
      throw new NotFoundError('Branch', validated.branchId, {
        operation: 'saveChanges',
      })
    }

    // Check if branch is locked
    if (branch.isLocked) {
      throw new ValidationError('Cannot save changes to a locked branch')
    }

    // Get the current item being edited
    const currentItem = await db
      .select()
      .from(items)
      .where(eq(items.id, validated.itemId))
      .limit(1)

    let item = currentItem[0]
    if (!item) {
      throw new NotFoundError('Item', validated.itemId, {
        operation: 'saveChanges',
      })
    }

    // Check if item is checked out by this user
    const branchItem = await db
      .select()
      .from(branchItems)
      .where(
        and(
          eq(branchItems.branchId, validated.branchId),
          eq(branchItems.itemMasterId, item.masterId),
        ),
      )
      .limit(1)

    const bi = branchItem[0]
    if (!bi) {
      throw new ValidationError('Item is not checked out on this branch')
    }

    if (bi.checkedOutBy !== userId) {
      throw new ValidationError('You do not have this item checked out')
    }

    // The caller's id picks the master; the branch row picks the row to edit.
    // A detail page addresses the save by the row it checked out from (still
    // in its URL) while the branch may already track a working copy — a
    // revise-checkout mints one up front — and applying the changes to the
    // addressed row would mutate the shared released version that every other
    // context reads.
    if (bi.currentItemId && bi.currentItemId !== item.id) {
      const branchRow = await db
        .select()
        .from(items)
        .where(eq(items.id, bi.currentItemId))
        .limit(1)
      const branchCurrent = branchRow[0]
      if (!branchCurrent) {
        throw new NotFoundError('Item', bi.currentItemId, {
          operation: 'saveChanges',
        })
      }
      item = branchCurrent
    }

    // Extension-table data of the version being edited - the items row alone
    // is not the item (weight, manifestId, ... live in the extension table).
    const typeHandler = getTypeHandler(item.itemType)
    const extData = (await typeHandler?.get(item.id)) as
      Record<string, unknown> | undefined

    // Metadata, identity, and lifecycle-controlled fields never change through
    // a save - forms echo the whole item back, so strip rather than reject.
    const sanitizedChanges: Record<string, unknown> = {}
    const excludedFields = new Set([
      ...ignoreFields,
      'revision',
      'state',
      'itemNumber',
    ])
    for (const [key, value] of Object.entries(validated.changes)) {
      if (!excludedFields.has(key)) {
        sanitizedChanges[key] = value
      }
    }

    const changeType = bi.changeType === 'added' ? 'added' : 'modified'

    // A branch-local working copy already exists (first save happened, or the
    // item was added on this branch): update it in place. Inserting another
    // row per save would collide with the (itemNumber, revision, designId,
    // itemType) unique constraint.
    if (bi.changeType !== null) {
      return db.transaction(
        async (tx) => {
          // The baseline for the history diff, read inside the transaction:
          // `item`/`extData` above were read before it opened and can be
          // stale, and the diff must compare two snapshots of the same row.
          const before = takeFirst(
            await tx.select().from(items).where(eq(items.id, item.id)).limit(1),
            'item',
          )
          const beforeExt = (await typeHandler?.get(item.id, tx)) as
            Record<string, unknown> | undefined

          // Deliberately narrow, and matching `ItemService.update`'s own
          // updateData: a generic field save writes name and attributes, and
          // nothing else on the items row. The structural columns (sysmlType,
          // metamodel, usageOf, inDesignStructure) are set at create/clone/
          // usage time and by their own endpoints - do not widen this to
          // "everything the caller sent".
          const coreUpdate: Record<string, unknown> = {
            modifiedAt: new Date(),
            modifiedBy: userId,
          }
          if (sanitizedChanges.name !== undefined)
            coreUpdate.name = sanitizedChanges.name
          if (sanitizedChanges.attributes !== undefined)
            coreUpdate.attributes = sanitizedChanges.attributes

          await tx.update(items).set(coreUpdate).where(eq(items.id, item.id))

          if (typeHandler) {
            await typeHandler.update(item.id, sanitizedChanges, tx)
          }

          // History is a diff of what was STORED, never of what was asked
          // for. `sanitizedChanges` is the input to the writes above and is
          // deliberately not an input here: a key neither `coreUpdate` nor
          // the type handler writes (the update schemas admit several with no
          // column behind them) would otherwise be recorded as an edit no
          // reader can find on the item. `ItemService.update` re-reads the
          // item for the same reason.
          const after = takeFirst(
            await tx.select().from(items).where(eq(items.id, item.id)).limit(1),
            'item',
          )
          const afterExt = (await typeHandler?.get(item.id, tx)) as
            Record<string, unknown> | undefined

          const fieldChanges = await expandSourceFieldChanges(
            item.itemType,
            computeFieldChanges(
              { ...before, ...beforeExt },
              { ...after, ...afterExt },
              item.itemType,
            ),
          )

          const commit = await CommitService.create(
            {
              branchId: validated.branchId,
              message: validated.commitMessage,
              itemChanges: [
                {
                  itemId: item.id,
                  changeType,
                  fieldChanges,
                },
              ],
            },
            userId,
            tx,
          )

          // An UPDATE with a WHERE can legitimately match nothing, so this is
          // a guard-and-throw rather than `takeFirst` (which is for
          // statements that provably return a row).
          const updated = (
            await tx
              .update(items)
              .set({ commitId: commit.id })
              .where(eq(items.id, item.id))
              .returning()
          ).at(0)
          if (!updated) {
            throw new NotFoundError('Item', item.id, {
              operation: 'saveChanges',
            })
          }

          return { item: updated, commit }
        },
        { isolationLevel: 'repeatable read' },
      )
    }

    // First save on this branch: create the branch-local working copy so the
    // shared base version (still visible on main) is never mutated in place.
    // The branch-specific placeholder revision (same scheme as ECO working
    // copies) keeps concurrent branches from colliding on the unique
    // constraint; the real revision letter is assigned at merge.
    const placeholderRevision = RevisionService.getWorkingRevision(
      validated.branchId,
    )
    // A working copy of an already-released version starts over at the
    // lifecycle's initial state. Resolved from the revise mapping's `fromState`;
    // a lifecycle with no revise mapping (Free) has no released state to reset
    // from, so the working copy keeps the item's state.
    const reviseFromState = (
      await LifecycleService.getActionMapping(item.itemType, 'revise')
    )?.fromState
    const workingState =
      reviseFromState != null && item.state === reviseFromState
        ? await LifecycleService.getInitialStateId(item.itemType)
        : item.state

    // Loaded dynamically, and before the transaction opens: ItemService imports
    // this module, so importing FileService statically here would close the
    // cycle CheckoutService -> FileService -> ItemService -> CheckoutService.
    const { FileService } = await import('../vault/services/FileService')
    const { ItemRelationshipService } =
      await import('../items/services/ItemRelationshipService')

    return db.transaction(
      async (tx) => {
        // 1. Create new item record with changes. Working copies are never
        // the released-current version (the source row keeps its isCurrent);
        // the merge flips isCurrent when the branch releases.
        const newItemData = {
          ...item,
          ...sanitizedChanges,
          id: undefined, // Let it generate a new ID
          revision: placeholderRevision,
          state: workingState,
          isCurrent: false,
          modifiedAt: new Date(),
          modifiedBy: userId,
          commitId: undefined, // Will be set after commit
        }

        // Remove undefined fields
        delete (newItemData as { id?: string }).id
        delete (newItemData as { commitId?: string }).commitId

        const newItem = takeFirst(
          await tx
            .insert(items)
            .values(newItemData as typeof items.$inferInsert)
            .returning(),
          'item',
        )

        // 1b. Carry the extension row onto the new version, applying any
        // extension-field changes - otherwise the new version silently loses
        // all type-specific data.
        if (typeHandler && extData) {
          const { itemId: _oldItemId, ...extFields } = extData
          await typeHandler.insert(
            newItem.id,
            { ...extFields, ...sanitizedChanges },
            tx,
          )
        }

        // 1c. Carry the base version's files onto the working copy. Files hang
        // off an item version, so without this the first save on a branch
        // silently strips the item of its CAD and attachments - and the merge
        // releases that copy in place, making the loss permanent.
        await FileService.copyFilesToItem({
          sourceItemId: item.id,
          targetItemId: newItem.id,
          branchId: validated.branchId,
          tx,
        })

        // 1d. Carry the base version's outgoing relationships for the same
        // reason: the working copy's edges ARE the structure the merge
        // releases, so a copy minted by a field edit must not release an
        // assembly with an empty BOM.
        await ItemRelationshipService.copyRelationshipsToItem({
          sourceItemId: item.id,
          targetItemId: newItem.id,
          userId,
          tx,
        })

        // 2. Compute field-level changes
        // Include extension fields on both sides so type-category changes
        // (weight, manifestId, ...) are recorded in the commit. Software
        // manifest changes expand into per-file 'source' rows.
        //
        // The new side is read back from the rows just written, not built
        // from `sanitizedChanges`: the handler's insert whitelists its own
        // columns, so a key it drops must not be recorded as an edit. Same
        // rule as the in-place path above and as `ItemService.update`.
        const newExtData = (await typeHandler?.get(newItem.id, tx)) as
          Record<string, unknown> | undefined
        const fieldChanges = await expandSourceFieldChanges(
          item.itemType,
          computeFieldChanges(
            { ...item, ...extData },
            { ...newItem, ...newExtData },
            item.itemType,
          ),
        )

        // 3. Update branchItem to point at the working copy
        await tx
          .update(branchItems)
          .set({
            currentItemId: newItem.id,
            changeType: changeType,
            // Keep checkout - user may continue editing
          })
          .where(eq(branchItems.id, bi.id))

        // 4. Create commit with field changes (uses savepoint via outerTx)
        const commit = await CommitService.create(
          {
            branchId: validated.branchId,
            message: validated.commitMessage,
            itemChanges: [
              {
                itemId: newItem.id,
                changeType: changeType,
                previousItemId: bi.currentItemId || undefined,
                fieldChanges: fieldChanges,
              },
            ],
          },
          userId,
          tx,
        )

        // 6. Update item with commitId
        await tx
          .update(items)
          .set({ commitId: commit.id })
          .where(eq(items.id, newItem.id))

        return { item: { ...newItem, commitId: commit.id }, commit }
      },
      { isolationLevel: 'repeatable read' },
    )
  }

  /**
   * Create a new item on a branch
   *
   * `insertTypeData` is how a caller gets the type-specific extension row
   * (`parts`, `documents`, …) written inside the same transaction as the
   * `items` row it extends. It is a callback rather than a payload so this
   * service stays ignorant of every type's data shape — the caller keeps the
   * validated data and the type-handler context and only lends the write.
   */
  static async createOnBranch(
    data: {
      designId: string
      itemNumber: string
      itemType: string
      name?: string
      state?: string
      attributes?: Record<string, unknown>
      // SysML metadata
      sysmlType?: string | null
      metamodel?: string | null
      usageOf?: string | null
    },
    branchId: string,
    commitMessage: string,
    userId: string,
    insertTypeData?: (tx: TransactionClient, itemId: string) => Promise<void>,
  ): Promise<{
    item: typeof items.$inferSelect
    commit: typeof commits.$inferSelect
  }> {
    const branch = await BranchService.getById(branchId)
    if (!branch) {
      throw new NotFoundError('Branch', branchId, {
        operation: 'createOnBranch',
      })
    }

    if (branch.branchType === 'main') {
      const isProtected = await BranchService.isMainBranchProtected(
        branch.designId,
      )
      if (isProtected) {
        throw new ValidationError(
          'Cannot create items directly on the main branch',
        )
      }
    }

    if (branch.isLocked) {
      throw new ValidationError('Cannot create items on a locked branch')
    }

    // A new item on an ECO branch is new scope
    await assertBranchAcceptsNewItems(branch)

    // The lifecycle decides where a new item starts; 'Draft' is only the
    // fallback for a type with no lifecycle assigned
    const initialState =
      data.state ?? (await LifecycleService.getInitialStateId(data.itemType))

    // Resolved before the transaction: a dynamic import inside one buys
    // nothing and the module is needed on every path.
    const ChangeOrderService = await getChangeOrderService()

    const created = await db.transaction(async (tx) => {
      // 1. Generate a new masterId for this item
      const masterId = crypto.randomUUID()

      // 2. Create the item
      const newItemRows = await tx
        .insert(items)
        .values({
          masterId,
          designId: data.designId,
          itemNumber: data.itemNumber,
          // Branch-scoped working revision, so the same item number can be
          // drafted on two branches and so later saves edit this row in
          // place rather than colliding with it
          revision: RevisionService.getWorkingRevision(branchId),
          itemType: data.itemType,
          name: data.name,
          state: initialState,
          isCurrent: true,
          attributes: data.attributes || {},
          // SysML metadata - preserve from input data if provided
          sysmlType: data.sysmlType,
          metamodel: data.metamodel,
          usageOf: data.usageOf,
          createdBy: userId,
          modifiedBy: userId,
        })
        .returning()
      const newItem = takeFirst(newItemRows, 'item')

      // 3. Write the type-specific extension row — in this transaction, not
      // after it. Run on the pool once the base row had committed, a throwing
      // handler (a bad `outputPartId`, a `parentRequirementId` naming
      // nothing) left an `items` row with no extension row behind it, and
      // nothing reports that: `findById` spreads the missing type data, so
      // `{ ...item, ...undefined }` resolves everywhere as a fieldless item
      // with no error and no rollback to reach for. Ahead of the branch row
      // and the registration below, so `registerBranchChange` — which reads
      // the item back — sees a complete one.
      await insertTypeData?.(tx, newItem.id)

      // 4. Create branchItem entry
      await tx.insert(branchItems).values({
        branchId,
        itemMasterId: masterId,
        currentItemId: newItem.id,
        baseItemId: null, // No base - this is a new item
        changeType: 'added',
        checkedOutBy: null,
        checkedOutAt: null,
      })

      // 5. Create commit (uses savepoint via outerTx)
      const commit = await CommitService.create(
        {
          branchId,
          message: commitMessage,
          itemChanges: [
            {
              itemId: newItem.id,
              changeType: 'added',
            },
          ],
        },
        userId,
        tx,
      )

      // 5. Update item with commitId
      await tx
        .update(items)
        .set({ commitId: commit.id })
        .where(eq(items.id, newItem.id))

      // 7. Record the new item on the owning change order — inside this
      // transaction, not after it. Registering on the pool once the item and
      // its branch row had already committed left a window where a crash
      // produced branch content no affected-items row lists: the exact shape
      // `findUnlistedBranchContent` reports and the release refuses, with
      // nothing left for the user but to re-add the item by hand. Now a
      // registration failure rolls the creation back whole.
      await ChangeOrderService.registerBranchChange(
        branchId,
        masterId,
        newItem.id,
        userId,
        tx,
      )

      return { item: newItem, commit, masterId }
    })

    return { item: created.item, commit: created.commit }
  }

  /**
   * Delete an item on a branch (soft delete)
   *
   * A delete is a write to the branch working copy, so it answers to the same
   * three rules every other writer here does, and used to answer to none of
   * them: it cleared whoever held the exclusive checkout instead of refusing
   * them, it minted branch tracking for a master the branch did not track
   * without asking whether the change order still accepts new scope, and it
   * never recorded the deletion on the owning change order — so a late delete
   * produced branch content the affected-items list did not show, which the
   * release refuses with no in-app way out.
   */
  static async deleteOnBranch(
    itemMasterId: string,
    branchId: string,
    commitMessage: string,
    userId: string,
  ): Promise<typeof commits.$inferSelect> {
    const branch = await BranchService.getById(branchId)
    if (!branch) {
      throw new NotFoundError('Branch', branchId, {
        operation: 'deleteOnBranch',
      })
    }

    if (branch.branchType === 'main') {
      throw new ValidationError(
        'Cannot delete items directly on the main branch',
      )
    }

    if (branch.isLocked) {
      throw new ValidationError('Cannot delete items on a locked branch')
    }

    // A hint, not a decision. Everything below re-reads the row under a lock
    // inside the transaction; this read only answers the two questions that
    // have to be settled on the pool, because neither collaborator is
    // tx-aware.
    const hint = await db
      .select({ changeType: branchItems.changeType })
      .from(branchItems)
      .where(
        and(
          eq(branchItems.branchId, branchId),
          eq(branchItems.itemMasterId, itemMasterId),
        ),
      )
      .limit(1)
      .then((rows) => rows.at(0))

    // Deleting a master the branch does not track yet mints branch content
    // for it, which is new scope — the same gate `checkout` and
    // `createOnBranch` run before bringing a new item onto the branch.
    // Without it, a delete after reviewers locked the scope left content the
    // change order could not list and the release could not accept.
    if (!hint) {
      await assertBranchAcceptsNewItems(branch)
    }

    const ChangeOrderService = await getChangeOrderService()

    // `VersionResolver.getWorkingVersion` is pool-bound and takes no tx, so
    // it resolves here. It returns null once the branch already records this
    // master as deleted, which is what turns a second concurrent delete into
    // a clean NotFoundError rather than a unique-constraint 500. Skipped for
    // a master the branch added: that path retires the branch row outright
    // and reads the item off the row itself.
    const workingItem =
      hint?.changeType === 'added'
        ? null
        : await VersionResolver.getWorkingVersion(itemMasterId, branchId)

    return db.transaction(async (tx) => {
      // One transaction, one row lock, both paths. The read above is stale by
      // the time this runs — another caller can take the checkout, mint the
      // row, or delete it in between — so the branch is taken from a row read
      // FOR UPDATE and every writer for a given master queues behind it.
      const locked = await tx
        .select()
        .from(branchItems)
        .where(
          and(
            eq(branchItems.branchId, branchId),
            eq(branchItems.itemMasterId, itemMasterId),
          ),
        )
        .limit(1)
        .for('update')
        .then((rows) => rows.at(0))

      // The checkout is an exclusive lock, and this used to be the one writer
      // that ignored it: the update below sets `checkedOutBy: null`, so a
      // delete by anyone silently discarded the holder's claim on their
      // in-progress working copy. `cancelCheckout`, `saveChanges` and
      // `checkin` all refuse a non-holder; so does this now, with the same
      // named-holder error `checkout` gives a loser. There is no bypass flag —
      // the holder cancels their own checkout, and admin lock-force stays the
      // deliberate override.
      if (locked?.checkedOutBy && locked.checkedOutBy !== userId) {
        await this.refuseLockedByAnother(locked.checkedOutBy, itemMasterId, tx)
      }

      // If item was added on this branch, we can actually remove the branchItem
      if (locked?.changeType === 'added') {
        if (!locked.currentItemId) {
          throw new NotFoundError('Item', itemMasterId, {
            operation: 'deleteOnBranch',
          })
        }
        await tx.delete(branchItems).where(eq(branchItems.id, locked.id))

        // Retire the working copy too. Dropping only the tracking left the
        // `items` row itself current and undeleted, owned by no branch:
        // `ItemSearchService` reads `items` directly on notDeleted() plus
        // isCurrent and never consults branch_items, so the deleted draft went
        // on answering global searches under its working revision while every
        // version-resolved view showed nothing — and it could not be deleted
        // again either, because `ItemEditPolicy.getItemBranchInfo` finds no
        // branch for it and the main-context protection gate then refuses.
        // Soft, not hard: `itemVersions.itemId` is ON DELETE CASCADE, so
        // removing the row would take the version row of the very commit
        // below with it and blank the history entry recording the deletion.
        // `state` is deliberately left alone — the release-time deletion maps
        // to an obsolete state because it is retiring a released item on main,
        // and this draft never left its branch.
        await tx
          .update(items)
          .set({
            isCurrent: false,
            isDeleted: true,
            deletedAt: new Date(),
            deletedBy: userId,
          })
          .where(eq(items.id, locked.currentItemId))

        // The item existed only on this branch, so the change order has
        // nothing left to release for it — leave the scope row behind and the
        // branchless merge path would release a draft the user just deleted.
        await ChangeOrderService.unregisterBranchChange(
          branchId,
          itemMasterId,
          tx,
        )

        // Create commit for the removal
        return CommitService.create(
          {
            branchId,
            message: commitMessage,
            itemChanges: [
              {
                itemId: locked.currentItemId,
                changeType: 'deleted',
              },
            ],
          },
          userId,
          tx,
        )
      }

      if (!workingItem) {
        throw new NotFoundError('Item', itemMasterId, {
          operation: 'deleteOnBranch',
        })
      }

      if (locked) {
        await tx
          .update(branchItems)
          .set({
            changeType: 'deleted',
            checkedOutBy: null,
            checkedOutAt: null,
          })
          .where(eq(branchItems.id, locked.id))
      } else {
        // Create branchItem with deleted status. `onConflictDoNothing` rather
        // than a bare insert: FOR UPDATE locks no row when there is none to
        // lock, so two callers can both find nothing here and both insert
        // into `branch_items_unique` — and the loser got a raw 23505 back,
        // the same 500-with-a-constraint-name `checkout` was fixed for.
        const inserted = await tx
          .insert(branchItems)
          .values({
            branchId,
            itemMasterId,
            currentItemId: workingItem.id,
            baseItemId: workingItem.id,
            changeType: 'deleted',
          })
          .onConflictDoNothing({
            target: [branchItems.branchId, branchItems.itemMasterId],
          })
          .returning()

        if (!inserted.at(0)) {
          // Lost the insert. The row now exists and is whoever won it: take
          // it under the same lock, re-run the ownership guard against what
          // is actually there, and mark it deleted rather than erroring.
          const won = await tx
            .select()
            .from(branchItems)
            .where(
              and(
                eq(branchItems.branchId, branchId),
                eq(branchItems.itemMasterId, itemMasterId),
              ),
            )
            .limit(1)
            .for('update')
            .then((rows) => rows.at(0))

          if (!won) {
            throw new NotFoundError('Item', itemMasterId, {
              operation: 'deleteOnBranch',
            })
          }
          if (won.checkedOutBy && won.checkedOutBy !== userId) {
            await this.refuseLockedByAnother(won.checkedOutBy, itemMasterId, tx)
          }
          await tx
            .update(branchItems)
            .set({
              changeType: 'deleted',
              checkedOutBy: null,
              checkedOutAt: null,
            })
            .where(eq(branchItems.id, won.id))
        }
      }

      // Record the deletion on the owning change order, so what merges and
      // what reviewers approved stay the same set. Order matters: the branch
      // row already says 'deleted' by now, and that is what
      // `registerBranchChange` reads to record the master as `obsolete`.
      // Idempotent, and a no-op on branches no change order owns.
      await ChangeOrderService.registerBranchChange(
        branchId,
        itemMasterId,
        workingItem.id,
        userId,
        tx,
      )

      // Create commit (uses savepoint via outerTx)
      return CommitService.create(
        {
          branchId,
          message: commitMessage,
          itemChanges: [
            {
              itemId: workingItem.id,
              changeType: 'deleted',
            },
          ],
        },
        userId,
        tx,
      )
    })
  }

  /**
   * Check in an item (release checkout but keep changes)
   */
  static async checkin(
    itemMasterId: string,
    branchId: string,
    userId: string,
  ): Promise<void> {
    const branchItem = await db
      .select()
      .from(branchItems)
      .where(
        and(
          eq(branchItems.branchId, branchId),
          eq(branchItems.itemMasterId, itemMasterId),
        ),
      )
      .limit(1)

    const bi = branchItem[0]
    if (!bi) {
      throw new NotFoundError('BranchItem', `${branchId}/${itemMasterId}`, {
        operation: 'checkin',
      })
    }

    if (bi.checkedOutBy !== userId) {
      throw new ValidationError('You do not have this item checked out')
    }

    await db
      .update(branchItems)
      .set({
        checkedOutBy: null,
        checkedOutAt: null,
      })
      .where(eq(branchItems.id, bi.id))
  }
}
