// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, eq, inArray, isNotNull } from 'drizzle-orm'
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
import type { commits } from '../db/schema'
import type { FieldChange } from './CommitService'

// Core fields that exist on all items
const coreFields = ['name', 'state', 'revision', 'itemNumber']

// Type-specific fields by item type
const typeFields: Record<string, Array<string>> = {
  Part: [
    'description',
    'weight',
    'material',
    'uom',
    'partType',
    'cost',
    'leadTime',
  ],
  Document: ['documentType', 'description', 'content'],
  Requirement: [
    'requirementType',
    'description',
    'priority',
    'verificationMethod',
    'acceptanceCriteria',
  ],
  ChangeOrder: [
    'changeType',
    'priority',
    'reasonForChange',
    'proposedSolution',
  ],
  Task: ['taskType', 'description', 'priority', 'dueDate', 'assignee'],
  Software: [
    'description',
    'softwareType',
    'sourceMode',
    'version',
    'targetHardware',
    'toolchain',
    'manifestId',
    'buildArtifactFileId',
  ],
}

// Fields to ignore (metadata)
const ignoreFields = [
  'id',
  'masterId',
  'designId',
  'commitId',
  'itemType',
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
    } else if (typeFields[itemType]?.includes(field)) {
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
    } else if (typeFields[itemType]?.includes(field)) {
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

    const bi = existingBranchItem[0]
    if (bi) {
      if (bi.checkedOutBy) {
        if (bi.checkedOutBy === userId) {
          // Already checked out by same user - return existing
          return bi
        } else {
          // Checked out by another user — the lock is exclusive
          const otherUser = await db
            .select({ name: users.name, email: users.email })
            .from(users)
            .where(eq(users.id, bi.checkedOutBy))
            .limit(1)
          throw new ResourceLockedError(
            'Item',
            `already checked out by ${otherUser.at(0)?.name || otherUser.at(0)?.email || 'another user'}`,
            { operation: 'checkout', itemMasterId: validated.itemMasterId },
          )
        }
      }

      // BranchItem exists but not checked out - update it
      const updated = await db
        .update(branchItems)
        .set({
          checkedOutBy: userId,
          checkedOutAt: new Date(),
        })
        .where(eq(branchItems.id, bi.id))
        .returning()

      return takeFirst(updated, 'updated branchItem')
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

    // Create branchItem entry
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
      .returning()

    // Record it on the owning change order, so what merges and what
    // reviewers see stay the same set
    const ChangeOrderService = await getChangeOrderService()
    await ChangeOrderService.registerBranchChange(
      branch.id,
      validated.itemMasterId,
      releasedItem.id,
      userId,
    )

    return takeFirst(branchItem, 'branchItem')
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

    const item = currentItem[0]
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

          const fieldChanges = await expandSourceFieldChanges(
            item.itemType,
            computeFieldChanges(
              { ...item, ...extData },
              { ...item, ...extData, ...sanitizedChanges },
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

          const updated = takeFirst(
            await tx
              .update(items)
              .set({ commitId: commit.id })
              .where(eq(items.id, item.id))
              .returning(),
            'item',
          )

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
    // lifecycle's initial state. Resolved from the revise mapping's `fromState`
    // rather than the literal 'Released', so a lifecycle whose released state is
    // named differently still resets (it previously kept the released state on
    // the draft, which then read as released everywhere).
    const reviseFromState = (
      await LifecycleService.getActionMapping(item.itemType, 'revise')
    )?.fromState
    const workingState =
      item.state === (reviseFromState ?? 'Released')
        ? await LifecycleService.getInitialStateId(item.itemType)
        : item.state

    // Loaded dynamically, and before the transaction opens: ItemService imports
    // this module, so importing FileService statically here would close the
    // cycle CheckoutService -> FileService -> ItemService -> CheckoutService.
    const { FileService } = await import('../vault/services/FileService')

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

        // 2. Compute field-level changes
        // Include extension fields on both sides so type-category changes
        // (weight, manifestId, ...) are recorded in the commit. Software
        // manifest changes expand into per-file 'source' rows.
        const fieldChanges = await expandSourceFieldChanges(
          item.itemType,
          computeFieldChanges(
            { ...item, ...extData },
            { ...newItem, ...extData, ...sanitizedChanges },
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

        // 5. Update item with commitId
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

      // 3. Create branchItem entry
      await tx.insert(branchItems).values({
        branchId,
        itemMasterId: masterId,
        currentItemId: newItem.id,
        baseItemId: null, // No base - this is a new item
        changeType: 'added',
        checkedOutBy: null,
        checkedOutAt: null,
      })

      // 4. Create commit (uses savepoint via outerTx)
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

      return { item: newItem, commit, masterId }
    })

    // Record the new item on the owning change order
    const ChangeOrderService = await getChangeOrderService()
    await ChangeOrderService.registerBranchChange(
      branchId,
      created.masterId,
      created.item.id,
      userId,
    )

    return { item: created.item, commit: created.commit }
  }

  /**
   * Delete an item on a branch (soft delete)
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

    // Get or create branchItem
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

    const existing = branchItem[0]

    // If item was added on this branch, we can actually remove the branchItem
    if (existing?.changeType === 'added') {
      return db.transaction(async (tx) => {
        await tx.delete(branchItems).where(eq(branchItems.id, existing.id))

        // Create commit for the removal
        return CommitService.create(
          {
            branchId,
            message: commitMessage,
            itemChanges: [
              {
                itemId: existing.currentItemId!,
                changeType: 'deleted',
              },
            ],
          },
          userId,
          tx,
        )
      })
    }

    // Get the current item
    const currentItem = await VersionResolver.getWorkingVersion(
      itemMasterId,
      branchId,
    )
    if (!currentItem) {
      throw new NotFoundError('Item', itemMasterId, {
        operation: 'deleteOnBranch',
      })
    }

    return db.transaction(async (tx) => {
      // Update branchItem to mark as deleted
      if (existing) {
        await tx
          .update(branchItems)
          .set({
            changeType: 'deleted',
            checkedOutBy: null,
            checkedOutAt: null,
          })
          .where(eq(branchItems.id, existing.id))
      } else {
        // Create branchItem with deleted status
        await tx.insert(branchItems).values({
          branchId,
          itemMasterId,
          currentItemId: currentItem.id,
          baseItemId: currentItem.id,
          changeType: 'deleted',
        })
      }

      // Create commit (uses savepoint via outerTx)
      return CommitService.create(
        {
          branchId,
          message: commitMessage,
          itemChanges: [
            {
              itemId: currentItem.id,
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
