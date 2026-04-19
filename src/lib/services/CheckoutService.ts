// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

import { and, eq, isNotNull } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db'
import { branchItems, branches, items, users } from '../db/schema'
import { NotFoundError, ValidationError } from '../errors'
import { BranchService } from './BranchService'
import { CommitService } from './CommitService'
import { VersionResolver } from './VersionResolver'
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
}

// Fields to ignore (metadata)
const ignoreFields = [
  'id',
  'masterId',
  'designId',
  'commitId',
  'itemType',
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
    } else if (itemType in typeFields && typeFields[itemType].includes(field)) {
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
    } else if (itemType in typeFields && typeFields[itemType].includes(field)) {
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

    // Can't checkout on main branch
    if (branch.branchType === 'main') {
      throw new ValidationError(
        'Cannot checkout items on the main branch. Use an ECO or workspace branch.',
      )
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

    if (existingBranchItem.at(0)) {
      const bi = existingBranchItem[0]
      if (bi.checkedOutBy) {
        if (bi.checkedOutBy === userId) {
          // Already checked out by same user - return existing
          return bi
        } else {
          // Checked out by another user
          const otherUser = await db
            .select({ name: users.name, email: users.email })
            .from(users)
            .where(eq(users.id, bi.checkedOutBy))
            .limit(1)
          throw new ValidationError(
            `Item is already checked out by ${otherUser.at(0)?.name || otherUser.at(0)?.email || 'another user'}`,
          )
        }
      }

      // BranchItem exists but not checked out - update it
      const [updated] = await db
        .update(branchItems)
        .set({
          checkedOutBy: userId,
          checkedOutAt: new Date(),
        })
        .where(eq(branchItems.id, bi.id))
        .returning()

      return updated
    }

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
    const [branchItem] = await db
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

    return branchItem
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

    if (!branchItem.at(0) || !branchItem[0].checkedOutBy) {
      return { isCheckedOut: false }
    }

    const bi = branchItem[0]
    const user = await db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, bi.checkedOutBy!))
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

    if (!branchItem.at(0)) {
      throw new NotFoundError('BranchItem', `${branchId}/${itemMasterId}`, {
        operation: 'cancelCheckout',
      })
    }

    const bi = branchItem[0]
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

    const result: Array<CheckedOutItem> = []
    for (const { branchItem, branch } of branchItemsList) {
      if (branchItem.currentItemId) {
        const item = await db
          .select()
          .from(items)
          .where(eq(items.id, branchItem.currentItemId))
          .limit(1)

        if (item.at(0)) {
          result.push({ branchItem, item: item[0], branch })
        }
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

    const result: Array<CheckedOutItem> = []
    for (const branchItem of branchItemsList) {
      if (branchItem.currentItemId) {
        const item = await db
          .select()
          .from(items)
          .where(eq(items.id, branchItem.currentItemId))
          .limit(1)

        if (item.at(0)) {
          result.push({ branchItem, item: item[0], branch })
        }
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

    if (!currentItem.at(0)) {
      throw new NotFoundError('Item', validated.itemId, {
        operation: 'saveChanges',
      })
    }

    const item = currentItem[0]

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

    if (!branchItem.at(0)) {
      throw new ValidationError('Item is not checked out on this branch')
    }

    const bi = branchItem[0]
    if (bi.checkedOutBy !== userId) {
      throw new ValidationError('You do not have this item checked out')
    }

    return db.transaction(
      async (tx) => {
        // 1. Create new item record with changes
        // Use 'DRAFT' revision for working copies
        const newItemData = {
          ...item,
          ...validated.changes,
          id: undefined, // Let it generate a new ID
          revision: 'DRAFT',
          modifiedAt: new Date(),
          modifiedBy: userId,
          commitId: undefined, // Will be set after commit
        }

        // Remove undefined fields
        delete (newItemData as { id?: string }).id
        delete (newItemData as { commitId?: string }).commitId

        const [newItem] = await tx
          .insert(items)
          .values(newItemData as typeof items.$inferInsert)
          .returning()

        // 2. Determine change type
        const isNewItem = bi.changeType === 'added'
        const changeType = isNewItem ? 'added' : 'modified'

        // 3. Compute field-level changes (only for modified items)
        const fieldChanges =
          changeType === 'modified'
            ? computeFieldChanges(
                item as Record<string, unknown>,
                newItem as Record<string, unknown>,
                item.itemType,
              )
            : []

        // 4. Update branchItem
        await tx
          .update(branchItems)
          .set({
            currentItemId: newItem.id,
            changeType: changeType,
            // Keep checkout - user may continue editing
          })
          .where(eq(branchItems.id, bi.id))

        // 5. Create commit with field changes (uses savepoint via outerTx)
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

        return { item: newItem, commit }
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

    return db.transaction(async (tx) => {
      // 1. Generate a new masterId for this item
      const masterId = crypto.randomUUID()

      // 2. Create the item
      const [newItem] = await tx
        .insert(items)
        .values({
          masterId,
          designId: data.designId,
          itemNumber: data.itemNumber,
          revision: 'DRAFT',
          itemType: data.itemType,
          name: data.name,
          state: data.state || 'Draft',
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

      return { item: newItem, commit }
    })
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

    // If item was added on this branch, we can actually remove the branchItem
    if (branchItem.at(0)?.changeType === 'added') {
      return db.transaction(async (tx) => {
        await tx.delete(branchItems).where(eq(branchItems.id, branchItem[0].id))

        // Create commit for the removal
        return CommitService.create(
          {
            branchId,
            message: commitMessage,
            itemChanges: [
              {
                itemId: branchItem[0].currentItemId!,
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
      if (branchItem.at(0)) {
        await tx
          .update(branchItems)
          .set({
            changeType: 'deleted',
            checkedOutBy: null,
            checkedOutAt: null,
          })
          .where(eq(branchItems.id, branchItem[0].id))
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

    if (!branchItem.at(0)) {
      throw new NotFoundError('BranchItem', `${branchId}/${itemMasterId}`, {
        operation: 'checkin',
      })
    }

    const bi = branchItem[0]
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
