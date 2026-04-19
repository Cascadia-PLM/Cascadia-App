// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

import { and, desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db'
import { notDeleted } from '../db/filters'
import { branchItems, branches, items, tags } from '../db/schema'
import { NotFoundError, ValidationError } from '../errors'
import { DesignService } from './DesignService'

// Zod schemas for validation
export const branchCreateSchema = z.object({
  designId: z.string().uuid(),
  branchType: z.enum(['eco', 'workspace', 'release']),
  changeOrderItemId: z.string().uuid().optional(),
  sourceTagId: z.string().uuid().optional(),
  name: z.string().min(1).max(100).optional(), // Only for release branches
})

export type CreateBranchInput = z.infer<typeof branchCreateSchema>

export interface BranchFilters {
  branchType?: 'main' | 'eco' | 'workspace' | 'release'
  includeArchived?: boolean
  limit?: number
  offset?: number
}

/**
 * Service for managing Branches within Designs
 */
export class BranchService {
  /**
   * Get branch by ID
   */
  static async getById(id: string) {
    const result = await db
      .select()
      .from(branches)
      .where(eq(branches.id, id))
      .limit(1)

    return result.at(0) || null
  }

  /**
   * Get branch by name within a design
   */
  static async getByName(designId: string, name: string) {
    const result = await db
      .select()
      .from(branches)
      .where(and(eq(branches.designId, designId), eq(branches.name, name)))
      .limit(1)

    return result.at(0) || null
  }

  /**
   * Create an ECO branch for a design
   * Branch naming: eco/{changeOrderItemNumber}
   */
  static async createEcoBranch(
    designId: string,
    changeOrderItemId: string,
    userId: string,
  ) {
    // Get the change order item to get its item number
    const changeOrderItem = await db
      .select({ itemNumber: items.itemNumber })
      .from(items)
      .where(and(eq(items.id, changeOrderItemId), notDeleted()))
      .limit(1)

    if (!changeOrderItem.at(0)) {
      throw new NotFoundError('Change Order', changeOrderItemId, {
        operation: 'createEcoBranch',
      })
    }

    const branchName = `eco/${changeOrderItem[0].itemNumber}`

    // Check if branch already exists
    const existing = await this.getByName(designId, branchName)
    if (existing) {
      throw new ValidationError(
        'ECO branch already exists for this change order on this design',
        [
          {
            field: 'changeOrderItemId',
            message: 'An ECO branch for this change order already exists',
          },
        ],
      )
    }

    return this.createBranch({
      designId,
      name: branchName,
      branchType: 'eco',
      changeOrderItemId,
      userId,
    })
  }

  /**
   * Create a workspace branch for a user
   * Users can have multiple named workspace branches per design.
   * Branch naming: workspace/{name}
   */
  static async createWorkspaceBranch(
    designId: string,
    userId: string,
    name: string,
  ) {
    // Validate name
    if (!name || name.trim().length === 0) {
      throw new ValidationError('Workspace name is required', [
        { field: 'name', message: 'Workspace name is required' },
      ])
    }

    const sanitizedName = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, '-')
    const branchName = `workspace/${sanitizedName}`

    // Check if branch with this name already exists
    const existing = await this.getByName(designId, branchName)
    if (existing) {
      throw new ValidationError(
        'A workspace with this name already exists on this design',
        [
          {
            field: 'name',
            message: 'A workspace with this name already exists',
          },
        ],
      )
    }

    return this.createBranch({
      designId,
      name: branchName,
      branchType: 'workspace',
      ownerId: userId,
      userId,
    })
  }

  /**
   * Create a release branch from a tag.
   * Branch naming: release/{name}
   *
   * Release branches are **read-only baselines**. They capture the exact state of
   * the design at a specific tag and are not intended for further modification.
   *
   * Only ECO branches can be merged to main (enforced by ChangeOrderMergeService).
   * Since all item modifications in Cascadia require an ECO branch, release branches
   * are effectively immutable after creation.
   *
   * Typical use cases:
   * - Regulatory snapshots (e.g., "FDA-510k-v2.1")
   * - Customer delivery baselines
   * - Audit trail reference points
   */
  static async createReleaseBranch(
    designId: string,
    name: string,
    tagId: string,
    userId: string,
  ) {
    const branchName = `release/${name}`

    // Check if branch already exists
    const existing = await this.getByName(designId, branchName)
    if (existing) {
      throw new ValidationError(
        'Release branch with this name already exists',
        [
          {
            field: 'name',
            message: 'A release branch with this name already exists',
          },
        ],
      )
    }

    // Get the tag to find its commit
    const tag = await db
      .select({ commitId: tags.commitId })
      .from(tags)
      .where(eq(tags.id, tagId))
      .limit(1)

    if (!tag.at(0)) {
      throw new NotFoundError('Tag', tagId, {
        operation: 'createReleaseBranch',
      })
    }

    return this.createBranch({
      designId,
      name: branchName,
      branchType: 'release',
      sourceTagId: tagId,
      baseCommitId: tag[0].commitId,
      userId,
    })
  }

  /**
   * Get or create an ECO branch
   * Useful when checking out items - creates branch on first checkout
   * Returns the branch and whether it was newly created
   */
  static async getOrCreateEcoBranch(
    designId: string,
    changeOrderItemId: string,
    userId: string,
  ): Promise<{ branch: typeof branches.$inferSelect; created: boolean }> {
    // Get the change order item to get its item number
    const changeOrderItem = await db
      .select({ itemNumber: items.itemNumber })
      .from(items)
      .where(and(eq(items.id, changeOrderItemId), notDeleted()))
      .limit(1)

    if (!changeOrderItem.at(0)) {
      throw new NotFoundError('Change Order', changeOrderItemId, {
        operation: 'getOrCreateEcoBranch',
      })
    }

    const branchName = `eco/${changeOrderItem[0].itemNumber}`

    // Check if branch already exists
    const existing = await this.getByName(designId, branchName)
    if (existing) {
      return { branch: existing, created: false }
    }

    // Create new ECO branch
    const branch = await this.createEcoBranch(
      designId,
      changeOrderItemId,
      userId,
    )
    return { branch, created: true }
  }

  /**
   * Delete a workspace branch
   * Only the owner can delete their workspace branches.
   * Also deletes all items that exist only on this workspace (changeType: 'added').
   */
  static async deleteWorkspaceBranch(branchId: string, userId: string) {
    const branch = await this.getById(branchId)
    if (!branch) {
      throw new NotFoundError('Branch', branchId, {
        operation: 'deleteWorkspaceBranch',
      })
    }

    if (branch.branchType !== 'workspace') {
      throw new ValidationError('Can only delete workspace branches', [
        {
          field: 'branchType',
          message: 'Only workspace branches can be deleted',
        },
      ])
    }

    if (branch.ownerId !== userId) {
      throw new ValidationError(
        'You can only delete your own workspace branches',
      )
    }

    await db.transaction(async (tx) => {
      // Find all items that were created on this workspace (changeType: 'added')
      // These items exist only on this branch and should be deleted
      const workspaceOnlyItems = await tx
        .select({ currentItemId: branchItems.currentItemId })
        .from(branchItems)
        .where(
          and(
            eq(branchItems.branchId, branchId),
            eq(branchItems.changeType, 'added'),
          ),
        )

      // Delete the actual items
      const itemIds = workspaceOnlyItems
        .map((bi) => bi.currentItemId)
        .filter((id): id is string => id !== null)

      if (itemIds.length > 0) {
        await tx.delete(items).where(inArray(items.id, itemIds))
      }

      // Soft delete the branch by archiving
      // This will also cascade delete branchItems records
      await tx
        .update(branches)
        .set({
          isArchived: true,
          archivedAt: new Date(),
        })
        .where(eq(branches.id, branchId))
    })
  }

  /**
   * Get count of items that exist only on this workspace branch.
   * These are items with changeType: 'added' that would be deleted with the workspace.
   */
  static async getWorkspaceOnlyItemCount(branchId: string): Promise<number> {
    const result = await db
      .select({ currentItemId: branchItems.currentItemId })
      .from(branchItems)
      .where(
        and(
          eq(branchItems.branchId, branchId),
          eq(branchItems.changeType, 'added'),
        ),
      )

    return result.length
  }

  /**
   * Lock a branch (prevents further commits)
   * Used when ECO is submitted for approval
   */
  static async lockBranch(branchId: string) {
    const branch = await this.getById(branchId)
    if (!branch) {
      throw new NotFoundError('Branch', branchId, { operation: 'lock' })
    }

    if (branch.branchType === 'main') {
      throw new ValidationError('Cannot lock main branch')
    }

    await db
      .update(branches)
      .set({ isLocked: true })
      .where(eq(branches.id, branchId))
  }

  /**
   * Unlock a branch (allows commits again)
   * Used when ECO is rejected and needs rework
   */
  static async unlockBranch(branchId: string) {
    const branch = await this.getById(branchId)
    if (!branch) {
      throw new NotFoundError('Branch', branchId, { operation: 'unlock' })
    }

    await db
      .update(branches)
      .set({ isLocked: false })
      .where(eq(branches.id, branchId))
  }

  /**
   * Archive a branch
   * Used after ECO is merged or workspace is abandoned
   */
  static async archiveBranch(branchId: string) {
    const branch = await this.getById(branchId)
    if (!branch) {
      throw new NotFoundError('Branch', branchId, { operation: 'archive' })
    }

    if (branch.branchType === 'main') {
      throw new ValidationError('Cannot archive main branch')
    }

    await db
      .update(branches)
      .set({
        isArchived: true,
        archivedAt: new Date(),
      })
      .where(eq(branches.id, branchId))
  }

  /**
   * List branches by design
   */
  static async listByDesign(designId: string, filters?: BranchFilters) {
    const conditions = [eq(branches.designId, designId)]

    if (filters?.branchType) {
      conditions.push(eq(branches.branchType, filters.branchType))
    }
    if (!filters?.includeArchived) {
      conditions.push(eq(branches.isArchived, false))
    }

    const result = await db
      .select()
      .from(branches)
      .where(and(...conditions))
      .orderBy(desc(branches.createdAt))

    // Apply pagination
    const offset = filters?.offset || 0
    const limit = filters?.limit || 100
    return result.slice(offset, offset + limit)
  }

  /**
   * List workspace branches by user (with design info)
   */
  static async listByUser(userId: string) {
    const { designs } = await import('../db/schema')

    return db
      .select({
        id: branches.id,
        name: branches.name,
        branchType: branches.branchType,
        designId: branches.designId,
        designName: designs.name,
        createdAt: branches.createdAt,
        isLocked: branches.isLocked,
        isArchived: branches.isArchived,
        ownerId: branches.ownerId,
      })
      .from(branches)
      .innerJoin(designs, eq(branches.designId, designs.id))
      .where(
        and(
          eq(branches.ownerId, userId),
          eq(branches.branchType, 'workspace'),
          eq(branches.isArchived, false),
        ),
      )
      .orderBy(desc(branches.createdAt))
  }

  /**
   * List workspace branches for a user on a specific design
   */
  static async listUserWorkspacesForDesign(designId: string, userId: string) {
    return db
      .select()
      .from(branches)
      .where(
        and(
          eq(branches.designId, designId),
          eq(branches.ownerId, userId),
          eq(branches.branchType, 'workspace'),
          eq(branches.isArchived, false),
        ),
      )
      .orderBy(desc(branches.createdAt))
  }

  /**
   * List all ECO branches for a change order (across products)
   */
  static async listByChangeOrder(changeOrderItemId: string) {
    return db
      .select()
      .from(branches)
      .where(
        and(
          eq(branches.changeOrderItemId, changeOrderItemId),
          eq(branches.branchType, 'eco'),
          eq(branches.isArchived, false),
        ),
      )
      .orderBy(desc(branches.createdAt))
  }

  /**
   * Internal: Create a branch with all options
   */
  private static async createBranch(data: {
    designId: string
    name: string
    branchType: 'eco' | 'workspace' | 'release'
    changeOrderItemId?: string
    sourceTagId?: string
    ownerId?: string
    baseCommitId?: string
    userId: string
  }) {
    // Get the design to verify it exists and get default branch
    const design = await DesignService.getById(data.designId)
    if (!design) {
      throw new NotFoundError('Design', data.designId, {
        operation: 'createBranch',
      })
    }

    // Get the main branch to use its HEAD as base commit
    const mainBranch = await DesignService.getDefaultBranch(data.designId)
    if (!mainBranch) {
      throw new ValidationError('Design has no main branch')
    }

    const baseCommitId = data.baseCommitId || mainBranch.headCommitId

    // Use a transaction for branch creation (repeatable read to prevent phantom reads)
    return db.transaction(
      async (tx) => {
        // 1. Create the branch
        const [branch] = await tx
          .insert(branches)
          .values({
            designId: data.designId,
            name: data.name,
            branchType: data.branchType,
            headCommitId: baseCommitId,
            baseCommitId: baseCommitId,
            changeOrderItemId: data.changeOrderItemId,
            ownerId: data.ownerId,
            sourceTagId: data.sourceTagId,
            createdBy: data.userId,
          })
          .returning()

        // 2. Note: branchItems are created lazily when items are first checked out
        // This avoids copying all items upfront for large designs

        return branch
      },
      { isolationLevel: 'repeatable read' },
    )
  }

  /**
   * Update branch HEAD commit
   * Called after creating a new commit
   */
  static async updateHead(branchId: string, commitId: string) {
    const branch = await this.getById(branchId)
    if (!branch) {
      throw new NotFoundError('Branch', branchId, { operation: 'updateHead' })
    }

    if (branch.isLocked) {
      throw new ValidationError('Cannot update HEAD of a locked branch')
    }

    await db
      .update(branches)
      .set({ headCommitId: commitId })
      .where(eq(branches.id, branchId))
  }

  /**
   * Check if a branch is locked
   */
  static async isLocked(branchId: string): Promise<boolean> {
    const branch = await this.getById(branchId)
    return branch?.isLocked ?? false
  }

  // ============================================================================
  // Branch Protection Methods
  // ============================================================================

  /**
   * Check if main branch is protected (has any released items).
   * Main branch becomes protected after the first release.
   * This determines whether the design is in pre-release or post-release phase.
   */
  static async isMainBranchProtected(designId: string): Promise<boolean> {
    // Check if any item in this design has state 'Released'
    const releasedItems = await db
      .select({ id: items.id })
      .from(items)
      .where(
        and(
          eq(items.designId, designId),
          eq(items.state, 'Released'),
          notDeleted(),
        ),
      )
      .limit(1)

    return releasedItems.length > 0
  }

  /**
   * Get branch protection status with detailed information.
   * Returns whether the branch is protected, why, and if it's editable.
   */
  static async getBranchStatus(branchId: string): Promise<{
    branchId: string
    branchType: string
    isProtected: boolean
    protectionReason: 'has-released-items' | 'locked' | 'archived' | null
    isEditable: boolean
  }> {
    const branch = await this.getById(branchId)
    if (!branch) {
      throw new NotFoundError('Branch', branchId, {
        operation: 'getBranchStatus',
      })
    }

    // Archived branches are never editable
    if (branch.isArchived) {
      return {
        branchId,
        branchType: branch.branchType,
        isProtected: true,
        protectionReason: 'archived',
        isEditable: false,
      }
    }

    // Locked branches are protected
    if (branch.isLocked) {
      return {
        branchId,
        branchType: branch.branchType,
        isProtected: true,
        protectionReason: 'locked',
        isEditable: false,
      }
    }

    // Main branch protection depends on released items
    if (branch.branchType === 'main') {
      const isProtected = await this.isMainBranchProtected(branch.designId)
      return {
        branchId,
        branchType: branch.branchType,
        isProtected,
        protectionReason: isProtected ? 'has-released-items' : null,
        isEditable: !isProtected,
      }
    }

    // ECO and workspace branches are always editable (unless locked/archived)
    return {
      branchId,
      branchType: branch.branchType,
      isProtected: false,
      protectionReason: null,
      isEditable: true,
    }
  }

  /**
   * Get available branch types for a design based on protection status.
   * Workspace branches are available in both phases for private development.
   * ECO branches are always available for formal change management.
   * Release branches are only available post-release (to tag baselines).
   */
  static async getAvailableBranchTypes(designId: string): Promise<{
    phase: 'pre-release' | 'post-release'
    canEditMainDirectly: boolean
    availableBranchTypes: Array<'eco' | 'workspace' | 'release'>
  }> {
    const isProtected = await this.isMainBranchProtected(designId)

    return {
      phase: isProtected ? 'post-release' : 'pre-release',
      canEditMainDirectly: !isProtected,
      availableBranchTypes: isProtected
        ? ['eco', 'workspace', 'release']
        : ['eco', 'workspace'], // Pre-release: workspace for private work, ECO for formal changes
    }
  }

  /**
   * Get the main branch for a design
   */
  static async getMainBranch(designId: string) {
    return DesignService.getDefaultBranch(designId)
  }
}
