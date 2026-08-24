// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../../db'
import { branchItems, branches, users } from '../../db/schema'
import {
  BranchProtectionError,
  ItemCheckoutRequiredError,
  ResourceLockedError,
  ValidationError,
} from '../../errors'
import { BranchService } from '../../services/BranchService'
import { LifecycleService } from '../../services/LifecycleService'
import { isBranchProtectionExempt } from '../branch-protection'

/**
 * Who may edit an item's content right now.
 *
 * This is authorization and concurrency control, not versioning: it answers
 * "is this caller allowed to mutate this item at this moment", from branch
 * protection (has the design released anything?), branch state (is the ECO
 * locked for approval?), and the checkout recorded in
 * `branch_items.checkedOutBy` (does this caller hold the lock?).
 *
 * It lived in `ItemVersioningFacade` until the two concerns were separated —
 * the versioning half is about resolving an item at a point in history, this
 * half is about permission to change it. They share only the branch tables.
 *
 * **Internal to `ItemService`.** Nothing else references this class and it is
 * not re-exported from any barrel — `ItemService` re-exports the same public
 * API, and every call site in the codebase goes through it, which is what
 * `docs/architecture` and CLAUDE.md's service table both point callers at.
 * Keep it that way: importing this directly would give the same operations two
 * entry points and turn a private split into a public one.
 *
 * Invariants are covered in `CheckoutService.test.ts` ("edit-lock enforcement"),
 * driven through `ItemService.update` / `.addRelationship` rather than against
 * this class, so the tests survive moves like this one.
 */
export class ItemEditPolicy {
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
          (await LifecycleService.isReleasedFamilyState(
            item.itemType,
            item.state,
          ))
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

    // Main context — respects branch protection, then mutual exclusion.
    // Exempt types (work instructions) skip the protection gate but still
    // honour another user's checkout below.
    if (!(await isBranchProtectionExempt(item.itemType))) {
      const canEdit = await this.canEditDirectly(item.designId)
      if (!canEdit.allowed) {
        throw new BranchProtectionError(
          `Cannot modify item directly: ${canEdit.reason}`,
          { operation: 'requireContentEditable', itemId: item.id },
        )
      }
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
