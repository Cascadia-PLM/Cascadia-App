// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { ZodError } from 'zod'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../../db'
import { branchItems, branches, designs, users } from '../../db/schema'
import {
  BranchProtectionError,
  ItemCheckoutRequiredError,
  NotFoundError,
  ResourceLockedError,
  ValidationError,
} from '../../errors'
import { VersionResolver } from '../../services/VersionResolver'
import { CommitService } from '../../services/CommitService'
import { CheckoutService } from '../../services/CheckoutService'
import { BranchService } from '../../services/BranchService'
import { NumberingService } from '../numbering'
import { ItemTypeRegistry } from '../registry'
import type { commits } from '../../db/schema'
import type {
  ItemFilters,
  VersionContext,
} from '../../services/VersionResolver'
import type { ItemHistoryEntry } from '../../services/CommitService'
import type { BaseItem } from '../types/base'

/**
 * Facade for versioning-related item operations.
 *
 * Extracted from ItemService to keep versioning logic separate from core CRUD.
 *
 * **Internal to `ItemService`.** Nothing else references this class and it is
 * not re-exported from any barrel — `ItemService` re-exports the same public
 * API, and every one of the ~38 call sites in the codebase goes through it,
 * which is what `docs/architecture` and CLAUDE.md's service table both point
 * callers at. Keep it that way: importing this directly would give the same
 * operations two entry points and turn a private split into a public one.
 */
export class ItemVersioningFacade {
  // ============================================================================
  // Versioning Methods
  // ============================================================================

  /**
   * Get an item at a specific version context (branch, commit, or tag)
   */
  static async getAtContext(
    itemMasterId: string,
    designId: string,
    context: VersionContext,
  ): Promise<BaseItem | null> {
    const { ItemService } = await import('./ItemService')

    const item = await VersionResolver.getItemAtContext(
      itemMasterId,
      designId,
      context,
    )
    if (!item) {
      return null
    }

    const typeSpecificData = await ItemService.getTypeSpecificData(
      item.itemType,
      item.id,
    )
    return { ...item, ...typeSpecificData }
  }

  /**
   * Get items at a specific version context (list view)
   */
  static async listAtContext(
    designId: string,
    context: VersionContext,
    filters?: ItemFilters,
  ): Promise<{ items: Array<BaseItem>; total: number }> {
    const { ItemService } = await import('./ItemService')

    const result = await VersionResolver.getItemsAtContext(
      designId,
      context,
      filters,
    )

    // Enrich with type-specific data
    const enrichedItems = await Promise.all(
      result.items.map(async (item) => {
        const typeSpecificData = await ItemService.getTypeSpecificData(
          item.itemType,
          item.id,
        )
        return { ...item, ...typeSpecificData }
      }),
    )

    return { items: enrichedItems, total: result.total }
  }

  /**
   * Get version history for an item
   * @param itemMasterId - The master ID of the item
   * @param designId - The design ID
   * @param options.untilCommitId - Optional commit ID to limit history to (for viewing at a specific version)
   * @param options.branchId - Optional branch ID to filter commits by (only show commits on this branch)
   */
  static async getHistory(
    itemMasterId: string,
    designId: string,
    options?: {
      untilCommitId?: string
      branchId?: string
    },
  ): Promise<Array<ItemHistoryEntry>> {
    return CommitService.getItemCommits(itemMasterId, designId, options)
  }

  /**
   * Compare two versions of an item
   */
  static async diff(
    itemId1: string,
    itemId2: string,
  ): Promise<{
    fields: Array<{
      field: string
      oldValue: unknown
      newValue: unknown
    }>
  }> {
    const { ItemService } = await import('./ItemService')

    const [item1, item2] = await Promise.all([
      ItemService.findById(itemId1),
      ItemService.findById(itemId2),
    ])

    if (!item1 || !item2) {
      throw new NotFoundError('Item', item1 ? itemId2 : itemId1, {
        operation: 'diff',
      })
    }

    // Compare fields
    const fields: Array<{
      field: string
      oldValue: unknown
      newValue: unknown
    }> = []
    const allKeys = new Set([...Object.keys(item1), ...Object.keys(item2)])

    // Exclude metadata fields from diff
    const excludeFields = [
      'id',
      'createdAt',
      'createdBy',
      'modifiedAt',
      'modifiedBy',
      'commitId',
    ]

    for (const key of allKeys) {
      if (excludeFields.includes(key)) continue

      const val1 = (item1 as unknown as Record<string, unknown>)[key]
      const val2 = (item2 as unknown as Record<string, unknown>)[key]

      if (JSON.stringify(val1) !== JSON.stringify(val2)) {
        fields.push({
          field: key,
          oldValue: val1,
          newValue: val2,
        })
      }
    }

    return { fields }
  }

  /**
   * Create a new item on a branch (delegated to CheckoutService)
   */
  static async createOnBranch(
    type: string,
    data: BaseItem,
    branchId: string,
    commitMessage: string,
    userId: string,
  ): Promise<{ item: BaseItem; commit: typeof commits.$inferSelect }> {
    const { ItemService } = await import('./ItemService')

    const typeConfig = ItemTypeRegistry.getType(type)
    if (!typeConfig) {
      throw new NotFoundError('Item type', type, {
        operation: 'createOnBranch',
      })
    }

    // Merge itemType into data before validation
    const dataWithType = { ...data, itemType: type }

    // Validate data against schema
    let validatedData: BaseItem
    try {
      validatedData = typeConfig.schema.parse(dataWithType)
    } catch (error) {
      if (error instanceof ZodError) {
        throw ValidationError.fromZodError(error, {
          operation: 'createOnBranch',
          resource: type,
        })
      }
      throw error
    }

    // Get the branch to get designId
    const { BranchService: BranchSvc } =
      await import('../../services/BranchService')
    const branch = await BranchSvc.getById(branchId)
    if (!branch) {
      throw new NotFoundError('Branch', branchId, {
        operation: 'createOnBranch',
      })
    }

    // Handle item number generation
    if (!validatedData.itemNumber) {
      // Auto-generate item number
      const design = await db.query.designs.findFirst({
        where: eq(designs.id, branch.designId),
        columns: { code: true },
      })

      validatedData.itemNumber = await NumberingService.generate(type, {
        designId: branch.designId,
        designCode: design?.code ?? null,
        fields: validatedData as unknown as Record<string, unknown>,
      })
    } else {
      // Manual entry - validate if allowed
      if (!NumberingService.allowsManualEntry(type)) {
        throw new ValidationError(
          `Manual item numbers are not allowed for ${type}`,
          undefined,
          { operation: 'createOnBranch', resource: type },
        )
      }
      if (
        !NumberingService.validateManualNumber(type, validatedData.itemNumber)
      ) {
        throw new ValidationError(
          `Item number '${validatedData.itemNumber}' does not match the required format`,
          undefined,
          { operation: 'createOnBranch', resource: type },
        )
      }
    }

    // Create item via CheckoutService
    const result = await CheckoutService.createOnBranch(
      {
        designId: branch.designId,
        itemNumber: validatedData.itemNumber,
        itemType: type,
        name: validatedData.name,
        state: validatedData.state || typeConfig.defaultState,
        attributes: (validatedData as unknown as Record<string, unknown>)
          .attributes as Record<string, unknown> | undefined,
      },
      branchId,
      commitMessage,
      userId,
    )

    // Insert type-specific data
    await ItemService.insertTypeSpecificData(
      type,
      result.item.id,
      validatedData,
    )

    // Fetch complete item with type-specific data
    const completeItem = await ItemService.findById(result.item.id)

    return {
      item: completeItem!,
      commit: result.commit,
    }
  }

  /**
   * Delete an item on a branch (soft delete, delegated to CheckoutService)
   */
  static async deleteOnBranch(
    itemMasterId: string,
    branchId: string,
    commitMessage: string,
    userId: string,
  ): Promise<typeof commits.$inferSelect> {
    return CheckoutService.deleteOnBranch(
      itemMasterId,
      branchId,
      commitMessage,
      userId,
    )
  }

  // ============================================================================
  // Branch Protection Methods
  // ============================================================================

  /**
   * Check if direct editing is allowed for a design.
   *
   * In pre-release phase: Direct editing on main branch is allowed
   * In post-release phase: Main branch is protected, must use ECO/workspace branches
   *
   * @param designId - The design to check
   * @returns Whether direct editing is allowed and the reason if not
   */
  static async canEditDirectly(designId: string): Promise<{
    allowed: boolean
    reason?: string
    requiresCheckout: boolean
  }> {
    const isProtected = await BranchService.isMainBranchProtected(designId)

    if (isProtected) {
      return {
        allowed: false,
        reason:
          'Design has released items. Use an ECO or workspace branch to make changes.',
        requiresCheckout: true,
      }
    }

    return {
      allowed: true,
      requiresCheckout: false,
    }
  }

  /**
   * Get branch information for an item if it's tracked on a non-main branch.
   * Returns null if the item is not on any ECO/workspace branch.
   *
   * @param itemId - The item ID to check
   * @returns Branch info or null if not on a branch
   */
  static async getItemBranchInfo(itemId: string): Promise<{
    branchId: string
    branchName: string
    branchType: string
    isLocked: boolean
    checkedOutBy: string | null
    changeType: string | null
  } | null> {
    // After a merge the released item is referenced by BOTH the main branch's
    // tracking row and the ECO branch it came from, so `limit(1)` on its own
    // returned whichever the planner happened to pick. When that was the ECO
    // row, the caller treated a released item on main as an editable working
    // copy and updated it in place - no new version, no change tracking, and
    // invisible to the merge. Filtering to non-main branches makes the answer
    // deterministic and, for a released item, correctly nothing to edit.
    const result = await db
      .select({
        branchId: branches.id,
        branchName: branches.name,
        branchType: branches.branchType,
        isLocked: branches.isLocked,
        checkedOutBy: branchItems.checkedOutBy,
        changeType: branchItems.changeType,
      })
      .from(branchItems)
      .innerJoin(branches, eq(branchItems.branchId, branches.id))
      .where(
        and(
          eq(branchItems.currentItemId, itemId),
          inArray(branches.branchType, ['eco', 'workspace']),
          eq(branches.isArchived, false),
        ),
      )
      .limit(1)

    const branchInfo = result.at(0)
    if (!branchInfo) {
      return null
    }

    return {
      branchId: branchInfo.branchId,
      branchName: branchInfo.branchName,
      branchType: branchInfo.branchType,
      isLocked: branchInfo.isLocked ?? false,
      checkedOutBy: branchInfo.checkedOutBy,
      changeType: branchInfo.changeType,
    }
  }

  /**
   * Enforce the edit-lock policy on an item content mutation (field updates,
   * relationship changes, work-instruction content). The checkout recorded in
   * branch_items.checkedOutBy is the server-side counterpart of the UI's Edit
   * button — mutations are rejected unless the caller may edit right now:
   *
   * - Working copy on an ECO/workspace branch: the branch must be unlocked and
   *   the caller must HOLD the checkout (exclusive lock, traditional PLM).
   * - Main context: main must be unprotected (pre-release phase), and nobody
   *   else may hold a checkout on the item's main-branch row. Holding no lock
   *   is allowed here so programmatic flows keep working; a lock taken via the
   *   Edit button still excludes other users.
   * - ChangeOrders and design-less items (Tool-pattern types) are exempt.
   *
   * Returns the branch info (as from getItemBranchInfo) so callers can reuse
   * it without a second lookup.
   */
  static async requireContentEditable(
    item: {
      id: string
      masterId: string
      designId?: string | null
      itemType: string
      itemNumber?: string | null
      state?: string | null
    },
    userId: string,
    options?: {
      /**
       * Allow edits while the branch row still points at the shared base
       * version (changeType null). Only ItemService.update sets this — it
       * reroutes such edits through saveChanges, which creates the working
       * copy. Structural edits (relationships, WI content) cannot reroute,
       * so for them a shared released base is rejected outright.
       */
      allowSharedBase?: boolean
    },
  ): Promise<{
    branchId: string
    branchName: string
    branchType: string
    isLocked: boolean
    checkedOutBy: string | null
    changeType: string | null
  } | null> {
    if (!item.designId || item.itemType === 'ChangeOrder') {
      return null
    }

    const identifier = item.itemNumber || item.id
    const branchInfo = await this.getItemBranchInfo(item.id)

    if (branchInfo) {
      if (branchInfo.isLocked) {
        throw new BranchProtectionError(
          `Cannot modify item: Branch "${branchInfo.branchName}" is locked (ECO submitted for approval)`,
          { operation: 'requireContentEditable', itemId: item.id },
        )
      }
      if (branchInfo.checkedOutBy === userId) {
        if (
          !options?.allowSharedBase &&
          branchInfo.changeType === null &&
          ['Released', 'Superseded', 'Obsolete'].includes(item.state ?? '')
        ) {
          throw new ValidationError(
            `Item '${identifier}' is checked out but its branch entry still points at the shared ${item.state} version. Create the revision working copy (re-run checkout) before editing its structure.`,
          )
        }
        return branchInfo
      }
      if (branchInfo.checkedOutBy) {
        throw new ResourceLockedError(
          identifier,
          `checked out by ${await this.lookupUserLabel(branchInfo.checkedOutBy)}`,
          { operation: 'requireContentEditable', itemId: item.id },
        )
      }
      throw new ItemCheckoutRequiredError(identifier, {
        operation: 'requireContentEditable',
        itemId: item.id,
        branchId: branchInfo.branchId,
      })
    }

    // Main context — respects branch protection, then mutual exclusion
    const canEdit = await this.canEditDirectly(item.designId)
    if (!canEdit.allowed) {
      throw new BranchProtectionError(
        `Cannot modify item directly: ${canEdit.reason}`,
        { operation: 'requireContentEditable', itemId: item.id },
      )
    }

    const mainBranch = await BranchService.getMainBranch(item.designId)
    if (mainBranch) {
      const [mainRow] = await db
        .select({ checkedOutBy: branchItems.checkedOutBy })
        .from(branchItems)
        .where(
          and(
            eq(branchItems.branchId, mainBranch.id),
            eq(branchItems.itemMasterId, item.masterId),
          ),
        )
        .limit(1)

      if (mainRow?.checkedOutBy && mainRow.checkedOutBy !== userId) {
        throw new ResourceLockedError(
          identifier,
          `checked out by ${await this.lookupUserLabel(mainRow.checkedOutBy)}`,
          { operation: 'requireContentEditable', itemId: item.id },
        )
      }
    }

    return null
  }

  private static async lookupUserLabel(userId: string): Promise<string> {
    const [holder] = await db
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
    return holder?.name || holder?.email || 'another user'
  }
}
