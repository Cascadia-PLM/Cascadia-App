// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

import { and, eq, inArray, isNotNull, isNull, ne } from 'drizzle-orm'
import { db } from '../db'
import {
  branchItems,
  branches,
  changeOrderAffectedItems,
  items,
  workflowInstances,
} from '../db/schema'
import { ItemService } from '../items/services/ItemService'
import { BranchService } from './BranchService'

// ============================================
// Types
// ============================================

/**
 * Types of conflicts that can occur
 */
export type ConflictType =
  | 'checkout' // Item still checked out
  | 'concurrent_modification' // Same item modified on main since branch creation
  | 'field_conflict' // Same field modified differently on two branches
  | 'cross_eco' // Same item being modified by another active ECO
  | 'no_changes' // No changes to merge (warning, not blocking)
  | 'branch_not_found' // Invalid branch reference

/**
 * Severity levels for conflicts
 */
export type ConflictSeverity = 'error' | 'warning' | 'info'

/**
 * A field-level conflict between two versions
 */
export interface FieldConflict {
  fieldName: string
  fieldPath?: string
  baseValue: unknown // Value when branch was created
  ourValue: unknown // Value on our branch
  theirValue: unknown // Value on main/other branch
}

/**
 * A conflict on a specific item
 */
export interface ItemConflict {
  itemMasterId: string
  itemNumber: string
  itemName: string | null
  conflictType: ConflictType
  severity: ConflictSeverity

  // Our version (on the branch being checked)
  ourBranchItemId: string // The branchItem record ID (needed for API calls)
  ourItemId: string
  ourRevision: string
  ourBranchId: string
  ourBranchName: string

  // Their version (on main or conflicting branch)
  theirItemId?: string
  theirRevision?: string
  theirBranchId?: string
  theirBranchName?: string
  theirEcoId?: string
  theirEcoNumber?: string

  // Base version (common ancestor)
  baseItemId?: string
  baseRevision?: string

  // Field-level conflicts (if applicable)
  fieldConflicts: Array<FieldConflict>

  // Suggested resolution
  suggestedResolution?: 'rebase' | 'merge' | 'manual' | 'coordinate'
  resolutionNotes?: string
}

/**
 * Result of conflict detection for an ECO or branch
 */
export interface ConflictDetectionResult {
  hasConflicts: boolean
  hasBlockingConflicts: boolean // Conflicts that must be resolved before proceeding
  conflicts: Array<ItemConflict>
  checkedAt: Date
  summary: {
    total: number
    errors: number
    warnings: number
    info: number
  }
}

/**
 * Result of rebasing an item
 */
export interface RebaseResult {
  success: boolean
  itemMasterId: string
  newBaseItemId: string
  autoMerged: boolean
  manualResolutionRequired: boolean
  fieldConflicts: Array<FieldConflict>
  error?: string
}

// ============================================
// Constants
// ============================================

/**
 * Fields to ignore when comparing item versions.
 * These are metadata fields that naturally differ between versions
 * and should not trigger conflict detection:
 * - id, masterId: Different records have different IDs
 * - designId, commitId: Version context fields
 * - timestamps and user tracking: createdAt/By, modifiedAt/By
 * - state tracking: isCurrent, lockedBy/At, isDeleted, deletedAt/By
 * - revision: Managed by the merge process, not user-editable
 * - itemId: Foreign key from type-specific tables (parts, documents, etc.)
 */
const IGNORED_COMPARISON_FIELDS = [
  'id',
  'masterId',
  'designId',
  'commitId',
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
  'revision',
  'itemId',
  'state', // Lifecycle state changes are managed by workflow, not user-editable
] as const

// ============================================
// ConflictDetectionService
// ============================================

/**
 * Service for detecting and resolving conflicts between branches
 * Provides field-level conflict detection and cross-ECO awareness
 */
export class ConflictDetectionService {
  /**
   * Detect conflicts for an ECO before it can be approved/released
   */
  static async detectConflictsForEco(
    ecoId: string,
  ): Promise<ConflictDetectionResult> {
    const result: ConflictDetectionResult = {
      hasConflicts: false,
      hasBlockingConflicts: false,
      conflicts: [],
      checkedAt: new Date(),
      summary: { total: 0, errors: 0, warnings: 0, info: 0 },
    }

    // Get all ECO branches
    const ecoBranches = await db
      .select()
      .from(branches)
      .where(
        and(
          eq(branches.changeOrderItemId, ecoId),
          eq(branches.branchType, 'eco'),
        ),
      )

    // Check each branch for conflicts
    for (const branch of ecoBranches) {
      const branchConflicts = await this.detectConflictsForBranch(branch.id)
      result.conflicts.push(...branchConflicts.conflicts)
    }

    // Also check for conflicts between this ECO and other active ECOs
    const crossEcoConflicts = await this.detectCrossEcoConflicts(ecoId)
    result.conflicts.push(...crossEcoConflicts)

    // Update summary
    result.hasConflicts = result.conflicts.length > 0
    result.hasBlockingConflicts = result.conflicts.some(
      (c) => c.severity === 'error',
    )
    result.summary.total = result.conflicts.length
    result.summary.errors = result.conflicts.filter(
      (c) => c.severity === 'error',
    ).length
    result.summary.warnings = result.conflicts.filter(
      (c) => c.severity === 'warning',
    ).length
    result.summary.info = result.conflicts.filter(
      (c) => c.severity === 'info',
    ).length

    return result
  }

  /**
   * Detect conflicts for a specific branch against main
   */
  static async detectConflictsForBranch(
    branchId: string,
  ): Promise<ConflictDetectionResult> {
    const result: ConflictDetectionResult = {
      hasConflicts: false,
      hasBlockingConflicts: false,
      conflicts: [],
      checkedAt: new Date(),
      summary: { total: 0, errors: 0, warnings: 0, info: 0 },
    }

    // Get the branch
    const branch = await BranchService.getById(branchId)
    if (!branch) {
      result.conflicts.push({
        itemMasterId: '',
        itemNumber: '',
        itemName: null,
        conflictType: 'branch_not_found',
        severity: 'error',
        ourBranchItemId: '',
        ourItemId: '',
        ourRevision: '',
        ourBranchId: branchId,
        ourBranchName: 'Unknown',
        fieldConflicts: [],
        resolutionNotes: 'Branch not found',
      })
      result.hasConflicts = true
      result.hasBlockingConflicts = true
      result.summary.total = 1
      result.summary.errors = 1
      return result
    }

    // Get the main branch
    const mainBranch = await BranchService.getMainBranch(branch.designId)
    if (!mainBranch) {
      return result
    }

    // Check for items still checked out
    const checkedOutItems = await db
      .select({
        branchItem: branchItems,
        item: items,
      })
      .from(branchItems)
      .leftJoin(items, eq(branchItems.currentItemId, items.id))
      .where(
        and(
          eq(branchItems.branchId, branchId),
          isNotNull(branchItems.checkedOutBy),
        ),
      )

    for (const { branchItem, item } of checkedOutItems) {
      result.conflicts.push({
        itemMasterId: branchItem.itemMasterId,
        itemNumber: item?.itemNumber || 'Unknown',
        itemName: item?.name || null,
        conflictType: 'checkout',
        severity: 'error',
        ourBranchItemId: branchItem.id,
        ourItemId: branchItem.currentItemId || '',
        ourRevision: item?.revision || '',
        ourBranchId: branch.id,
        ourBranchName: branch.name,
        fieldConflicts: [],
        suggestedResolution: 'manual',
        resolutionNotes: 'Item must be checked in before merge',
      })
    }

    // Get all items modified on this branch
    const branchModifications = await db
      .select({
        branchItem: branchItems,
        currentItem: items,
      })
      .from(branchItems)
      .leftJoin(items, eq(branchItems.currentItemId, items.id))
      .where(
        and(
          eq(branchItems.branchId, branchId),
          isNotNull(branchItems.changeType),
        ),
      )

    // For each modified item, check if main has changed since branch was created
    for (const { branchItem, currentItem } of branchModifications) {
      if (!currentItem || !branchItem.currentItemId) continue

      // Skip newly added items - they can't conflict with main
      if (branchItem.changeType === 'added') continue

      // Check if this item was modified on main after the branch was created
      const mainChanges = await this.getMainChangesAfterBranchCreation(
        branchItem.itemMasterId,
        branchItem.baseItemId,
        mainBranch.id,
      )

      if (mainChanges) {
        // There's a potential conflict - main changed this item after we branched
        // Get full item data including type-specific fields for all three versions
        const [ourFullItem, baseItem, latestMainItem] = await Promise.all([
          ItemService.findById(branchItem.currentItemId),
          branchItem.baseItemId
            ? ItemService.findById(branchItem.baseItemId)
            : null,
          ItemService.findById(mainChanges.id),
        ])

        if (!ourFullItem || !latestMainItem) continue

        // Check if main actually has meaningful changes (not just revision)
        // If the only change on main is revision, skip conflict detection entirely
        const mainChangesFromBase = this.getChangesFromBase(
          baseItem as unknown as Record<string, unknown> | null,
          latestMainItem as unknown as Record<string, unknown>,
        )
        if (Object.keys(mainChangesFromBase).length === 0) {
          // No meaningful changes on main (only revision changed) - skip conflict
          continue
        }

        // Detect field-level conflicts using three-way comparison
        const fieldConflicts = this.detectFieldConflicts(
          baseItem as unknown as Record<string, unknown> | null,
          ourFullItem as unknown as Record<string, unknown>,
          latestMainItem as unknown as Record<string, unknown>,
        )

        const hasFieldConflicts = fieldConflicts.length > 0

        // For concurrent modifications (no three-way conflicts), show what main changed
        // This helps users understand what they'll get when rebasing
        let displayFieldChanges = fieldConflicts
        if (!hasFieldConflicts) {
          displayFieldChanges = this.getFieldDifferences(
            baseItem as unknown as Record<string, unknown> | null,
            ourFullItem as unknown as Record<string, unknown>,
            latestMainItem as unknown as Record<string, unknown>,
          )
        }

        const conflict: ItemConflict = {
          itemMasterId: branchItem.itemMasterId,
          itemNumber: ourFullItem.itemNumber ?? '',
          itemName: ourFullItem.name ?? null,
          conflictType: hasFieldConflicts
            ? 'field_conflict'
            : 'concurrent_modification',
          severity: hasFieldConflicts ? 'error' : 'warning',

          ourBranchItemId: branchItem.id,
          ourItemId: ourFullItem.id ?? '',
          ourRevision: ourFullItem.revision,
          ourBranchId: branch.id,
          ourBranchName: branch.name,

          theirItemId: latestMainItem.id ?? '',
          theirRevision: latestMainItem.revision,
          theirBranchId: mainBranch.id,
          theirBranchName: 'main',

          baseItemId: branchItem.baseItemId || undefined,
          baseRevision: baseItem?.revision,

          fieldConflicts: displayFieldChanges,
          suggestedResolution: hasFieldConflicts ? 'manual' : 'rebase',
          resolutionNotes: hasFieldConflicts
            ? `${fieldConflicts.length} field(s) were modified on both branches`
            : 'Item was updated on main. Pull latest changes to incorporate them.',
        }

        result.conflicts.push(conflict)
      }
    }

    // Update summary
    result.hasConflicts = result.conflicts.length > 0
    result.hasBlockingConflicts = result.conflicts.some(
      (c) => c.severity === 'error',
    )
    result.summary.total = result.conflicts.length
    result.summary.errors = result.conflicts.filter(
      (c) => c.severity === 'error',
    ).length
    result.summary.warnings = result.conflicts.filter(
      (c) => c.severity === 'warning',
    ).length
    result.summary.info = result.conflicts.filter(
      (c) => c.severity === 'info',
    ).length

    return result
  }

  /**
   * Get the current main branch item if it differs from the base
   */
  private static async getMainChangesAfterBranchCreation(
    itemMasterId: string,
    baseItemId: string | null,
    mainBranchId: string,
  ): Promise<typeof items.$inferSelect | null> {
    if (!baseItemId) {
      return null
    }

    // Get main's current branchItem for this master ID
    const mainBranchItem = await db
      .select()
      .from(branchItems)
      .where(
        and(
          eq(branchItems.branchId, mainBranchId),
          eq(branchItems.itemMasterId, itemMasterId),
        ),
      )
      .limit(1)

    if (!mainBranchItem.at(0) || !mainBranchItem[0].currentItemId) {
      return null
    }

    // If main's current item is different from our base, there was a change
    if (mainBranchItem[0].currentItemId !== baseItemId) {
      const mainItem = await db
        .select()
        .from(items)
        .where(eq(items.id, mainBranchItem[0].currentItemId))
        .limit(1)

      return mainItem.at(0) || null
    }

    return null
  }

  /**
   * Detect field-level conflicts between base, ours, and theirs using three-way comparison
   */
  static detectFieldConflicts(
    baseItem: Record<string, unknown> | null,
    ourItem: Record<string, unknown>,
    theirItem: Record<string, unknown>,
  ): Array<FieldConflict> {
    if (!baseItem) {
      // No base item - can't do three-way comparison
      return []
    }

    const conflicts: Array<FieldConflict> = []

    const allFields = new Set([
      ...Object.keys(baseItem),
      ...Object.keys(ourItem),
      ...Object.keys(theirItem),
    ])

    for (const field of allFields) {
      if (
        IGNORED_COMPARISON_FIELDS.includes(
          field as (typeof IGNORED_COMPARISON_FIELDS)[number],
        )
      )
        continue

      const baseVal = baseItem[field]
      const ourVal = ourItem[field]
      const theirVal = theirItem[field]

      const baseJson = JSON.stringify(baseVal)
      const ourJson = JSON.stringify(ourVal)
      const theirJson = JSON.stringify(theirVal)

      // Check if both branches modified this field differently
      const weChanged = ourJson !== baseJson
      const theyChanged = theirJson !== baseJson
      const differentChanges = ourJson !== theirJson

      if (weChanged && theyChanged && differentChanges) {
        // Both modified, with different values = conflict
        conflicts.push({
          fieldName: field,
          baseValue: baseVal,
          ourValue: ourVal,
          theirValue: theirVal,
        })
      }
    }

    return conflicts
  }

  /**
   * Get all field differences between versions (for informational display).
   * Unlike detectFieldConflicts which only returns true three-way conflicts,
   * this returns all fields where any version differs - useful for showing
   * users what changed on main during concurrent modifications.
   */
  static getFieldDifferences(
    baseItem: Record<string, unknown> | null,
    ourItem: Record<string, unknown>,
    theirItem: Record<string, unknown>,
  ): Array<FieldConflict> {
    if (!baseItem) {
      return []
    }

    const differences: Array<FieldConflict> = []

    const allFields = new Set([
      ...Object.keys(baseItem),
      ...Object.keys(ourItem),
      ...Object.keys(theirItem),
    ])

    for (const field of allFields) {
      if (
        IGNORED_COMPARISON_FIELDS.includes(
          field as (typeof IGNORED_COMPARISON_FIELDS)[number],
        )
      )
        continue

      const baseVal = baseItem[field]
      const ourVal = ourItem[field]
      const theirVal = theirItem[field]

      const baseJson = JSON.stringify(baseVal)
      const ourJson = JSON.stringify(ourVal)
      const theirJson = JSON.stringify(theirVal)

      // Include any field where theirs differs from base (main made a change)
      // or where ours differs from base (we made a change)
      const theyChanged = theirJson !== baseJson
      const weChanged = ourJson !== baseJson

      if (theyChanged || weChanged) {
        differences.push({
          fieldName: field,
          baseValue: baseVal,
          ourValue: ourVal,
          theirValue: theirVal,
        })
      }
    }

    return differences
  }

  /**
   * Detect conflicts between this ECO and other active ECOs.
   * Performs field-level comparison to detect actual conflicts (not just co-modification).
   * Field conflicts are blocking errors; simple co-modification is a warning.
   */
  private static async detectCrossEcoConflicts(
    ecoId: string,
  ): Promise<Array<ItemConflict>> {
    const conflicts: Array<ItemConflict> = []

    // Get this ECO's branches to find working copies
    const ourBranches = await db
      .select()
      .from(branches)
      .where(
        and(
          eq(branches.changeOrderItemId, ecoId),
          eq(branches.branchType, 'eco'),
        ),
      )

    if (ourBranches.length === 0) {
      return conflicts
    }

    // Get all items being modified by this ECO (from branchItems)
    const ourBranchIds = ourBranches.map((b) => b.id)
    const ourModifiedItems = await db
      .select({
        branchItem: branchItems,
        currentItem: items,
      })
      .from(branchItems)
      .leftJoin(items, eq(branchItems.currentItemId, items.id))
      .where(
        and(
          inArray(branchItems.branchId, ourBranchIds),
          isNotNull(branchItems.changeType),
        ),
      )

    if (ourModifiedItems.length === 0) {
      return conflicts
    }

    const ourMasterIds = ourModifiedItems.map((m) => m.branchItem.itemMasterId)

    if (ourMasterIds.length === 0) {
      return conflicts
    }

    // Find other active ECOs affecting the same items
    // Join to workflowInstances and check completedAt IS NULL to exclude closed ECOs
    const otherAffectedItems = await db
      .select({
        affectedItem: changeOrderAffectedItems,
        ecoItem: items,
      })
      .from(changeOrderAffectedItems)
      .innerJoin(items, eq(changeOrderAffectedItems.changeOrderId, items.id))
      .innerJoin(workflowInstances, eq(workflowInstances.itemId, items.id))
      .where(
        and(
          ne(changeOrderAffectedItems.changeOrderId, ecoId),
          inArray(changeOrderAffectedItems.affectedItemMasterId, ourMasterIds),
          isNull(workflowInstances.completedAt),
        ),
      )

    if (otherAffectedItems.length === 0) {
      return conflicts
    }

    // Group by item master ID
    const conflictsByItem = new Map<string, typeof otherAffectedItems>()
    for (const other of otherAffectedItems) {
      if (!other.affectedItem.affectedItemMasterId) continue
      const masterId = other.affectedItem.affectedItemMasterId
      const existing = conflictsByItem.get(masterId) || []
      existing.push(other)
      conflictsByItem.set(masterId, existing)
    }

    // For each conflicting item, get working copies and compare fields
    for (const [masterId, otherEcos] of conflictsByItem) {
      // Get our working copy and base for this item
      const ourModified = ourModifiedItems.find(
        (m) => m.branchItem.itemMasterId === masterId,
      )
      if (
        !ourModified?.branchItem.currentItemId ||
        !ourModified.branchItem.baseItemId
      )
        continue

      // Get full item data including type-specific fields (e.g., description from parts table)
      const [ourFullItem, baseItem] = await Promise.all([
        ItemService.findById(ourModified.branchItem.currentItemId),
        ItemService.findById(ourModified.branchItem.baseItemId),
      ])
      if (!ourFullItem || !baseItem) continue

      for (const other of otherEcos) {
        // Get the other ECO's branch and working copy for this item
        const otherEcoBranches = await db
          .select()
          .from(branches)
          .where(
            and(
              eq(branches.changeOrderItemId, other.ecoItem.id),
              eq(branches.branchType, 'eco'),
            ),
          )

        if (otherEcoBranches.length === 0) continue

        const otherBranchIds = otherEcoBranches.map((b) => b.id)
        const otherBranchItem = await db
          .select()
          .from(branchItems)
          .where(
            and(
              inArray(branchItems.branchId, otherBranchIds),
              eq(branchItems.itemMasterId, masterId),
              isNotNull(branchItems.changeType),
            ),
          )
          .limit(1)

        const otherBranchItemRecord = otherBranchItem.at(0)
        if (!otherBranchItemRecord?.currentItemId) {
          // Other ECO doesn't have a working copy yet, just show as co-modification warning
          conflicts.push({
            itemMasterId: masterId,
            itemNumber: ourFullItem.itemNumber ?? '',
            itemName: ourFullItem.name ?? null,
            conflictType: 'cross_eco',
            severity: 'warning',

            ourBranchItemId: ourModified.branchItem.id,
            ourItemId: ourFullItem.id ?? '',
            ourRevision: ourFullItem.revision,
            ourBranchId: ourModified.branchItem.branchId,
            ourBranchName: 'This ECO',

            theirEcoId: other.ecoItem.id,
            theirEcoNumber: other.ecoItem.itemNumber,
            theirBranchName: `ECO ${other.ecoItem.itemNumber}`,

            fieldConflicts: [],
            suggestedResolution: 'coordinate',
            resolutionNotes: `This item is also being modified by ${other.ecoItem.itemNumber}. Coordinate with that ECO's owner.`,
          })
          continue
        }

        // Get full item data for other ECO's working copy
        const otherFullItem = await ItemService.findById(
          otherBranchItemRecord.currentItemId,
        )
        if (!otherFullItem) continue

        // Both ECOs have working copies - do three-way field comparison
        // Base = common ancestor (what both branched from)
        // Ours = our working copy
        // Theirs = other ECO's working copy
        const fieldConflicts = this.detectFieldConflicts(
          baseItem as unknown as Record<string, unknown>,
          ourFullItem as unknown as Record<string, unknown>,
          otherFullItem as unknown as Record<string, unknown>,
        )

        const hasFieldConflicts = fieldConflicts.length > 0

        // For cross-ECO without true conflicts, show all field differences
        let displayFieldChanges = fieldConflicts
        if (!hasFieldConflicts) {
          displayFieldChanges = this.getFieldDifferences(
            baseItem as unknown as Record<string, unknown>,
            ourFullItem as unknown as Record<string, unknown>,
            otherFullItem as unknown as Record<string, unknown>,
          )
        }

        conflicts.push({
          itemMasterId: masterId,
          itemNumber: ourFullItem.itemNumber ?? '',
          itemName: ourFullItem.name ?? null,
          conflictType: hasFieldConflicts ? 'field_conflict' : 'cross_eco',
          severity: hasFieldConflicts ? 'error' : 'warning',

          ourBranchItemId: ourModified.branchItem.id,
          ourItemId: ourFullItem.id ?? '',
          ourRevision: ourFullItem.revision,
          ourBranchId: ourModified.branchItem.branchId,
          ourBranchName: 'This ECO',

          theirItemId: otherFullItem.id,
          theirRevision: otherFullItem.revision,
          theirEcoId: other.ecoItem.id,
          theirEcoNumber: other.ecoItem.itemNumber,
          theirBranchName: `ECO ${other.ecoItem.itemNumber}`,

          baseItemId: ourModified.branchItem.baseItemId,
          baseRevision: baseItem.revision,

          fieldConflicts: displayFieldChanges,
          suggestedResolution: hasFieldConflicts ? 'coordinate' : 'coordinate',
          resolutionNotes: hasFieldConflicts
            ? `${displayFieldChanges.length} field(s) modified differently by both ECOs. Coordinate with ${other.ecoItem.itemNumber} owner to resolve.`
            : `This item is also being modified by ${other.ecoItem.itemNumber}. Coordinate with that ECO's owner.`,
        })
      }
    }

    return conflicts
  }

  /**
   * Rebase an item's working copy onto a newer base version
   * Attempts auto-merge for non-conflicting changes
   */
  static async rebaseItem(
    branchItemId: string,
    newBaseItemId: string,
    userId: string,
    resolutions?: Record<string, unknown>, // Field name -> resolved value
  ): Promise<RebaseResult> {
    const branchItemResult = await db
      .select()
      .from(branchItems)
      .where(eq(branchItems.id, branchItemId))
      .limit(1)

    if (!branchItemResult.at(0)) {
      return {
        success: false,
        itemMasterId: '',
        newBaseItemId,
        autoMerged: false,
        manualResolutionRequired: false,
        fieldConflicts: [],
        error: 'Branch item not found',
      }
    }

    const bi = branchItemResult[0]

    // Get current working copy, old base, and new base
    const [ourItem, oldBase, newBase] = await Promise.all([
      bi.currentItemId ? ItemService.findById(bi.currentItemId) : null,
      bi.baseItemId ? ItemService.findById(bi.baseItemId) : null,
      ItemService.findById(newBaseItemId),
    ])

    if (!ourItem || !newBase) {
      return {
        success: false,
        itemMasterId: bi.itemMasterId,
        newBaseItemId,
        autoMerged: false,
        manualResolutionRequired: false,
        fieldConflicts: [],
        error: 'Could not find required items',
      }
    }

    // Detect field conflicts using three-way comparison
    const fieldConflicts = await this.detectFieldConflicts(
      oldBase as unknown as Record<string, unknown> | null,
      ourItem as unknown as Record<string, unknown>,
      newBase as unknown as Record<string, unknown>,
    )

    if (fieldConflicts.length > 0 && !resolutions) {
      // Conflicts exist and no resolutions provided - return for manual resolution
      return {
        success: false,
        itemMasterId: bi.itemMasterId,
        newBaseItemId,
        autoMerged: false,
        manualResolutionRequired: true,
        fieldConflicts,
        error: 'Manual resolution required for field conflicts',
      }
    }

    // Apply rebase (repeatable read to prevent phantom reads during conflict resolution)
    return await db.transaction(
      async (tx) => {
        // Create new working copy with merged values
        const mergedData: Record<string, unknown> = {
          ...(newBase as unknown as Record<string, unknown>),
        }

        // Apply our changes that don't conflict
        const ourChanges = this.getChangesFromBase(
          oldBase as unknown as Record<string, unknown> | null,
          ourItem as unknown as Record<string, unknown>,
        )

        for (const [field, value] of Object.entries(ourChanges)) {
          const hasConflict = fieldConflicts.some((c) => c.fieldName === field)
          if (!hasConflict) {
            // No conflict - apply our change
            mergedData[field] = value
          } else if (resolutions && field in resolutions) {
            // Conflict resolved - apply resolution
            mergedData[field] = resolutions[field]
          }
          // If conflict and no resolution, keep newBase value
        }

        // Create new item with merged data
        const [newWorkingCopy] = await tx
          .insert(items)
          .values({
            ...(mergedData as typeof items.$inferInsert),
            id: undefined,
            masterId: bi.itemMasterId,
            revision: 'DRAFT',
            isCurrent: false,
            modifiedAt: new Date(),
            modifiedBy: userId,
          })
          .returning()

        // Update branch item
        await tx
          .update(branchItems)
          .set({
            currentItemId: newWorkingCopy.id,
            baseItemId: newBaseItemId,
          })
          .where(eq(branchItems.id, branchItemId))

        return {
          success: true,
          itemMasterId: bi.itemMasterId,
          newBaseItemId,
          autoMerged: fieldConflicts.length === 0,
          manualResolutionRequired: false,
          fieldConflicts: [],
        }
      },
      { isolationLevel: 'repeatable read' },
    )
  }

  /**
   * Pull all changes from main into a branch item's working copy.
   * Unlike rebaseItem which does three-way merge, this simply accepts all of main's
   * field values (main always wins). Used for non-conflicting concurrent modifications.
   *
   * @param branchItemId - The branch item to update
   * @param mainItemId - The current item on main to pull from
   * @param userId - User performing the operation
   * @returns Result indicating success/failure
   */
  static async pullChangesFromMain(
    branchItemId: string,
    mainItemId: string,
    userId: string,
  ): Promise<{
    success: boolean
    itemMasterId: string
    newItemId?: string
    error?: string
  }> {
    // Get the branch item
    const branchItemResult = await db
      .select()
      .from(branchItems)
      .where(eq(branchItems.id, branchItemId))
      .limit(1)

    if (!branchItemResult.at(0)) {
      return {
        success: false,
        itemMasterId: '',
        error: 'Branch item not found',
      }
    }

    const bi = branchItemResult[0]

    // Get our current working copy and main's item
    const [ourItem, mainItem] = await Promise.all([
      bi.currentItemId ? ItemService.findById(bi.currentItemId) : null,
      ItemService.findById(mainItemId),
    ])

    if (!ourItem || !mainItem) {
      return {
        success: false,
        itemMasterId: bi.itemMasterId,
        error: 'Could not find required items',
      }
    }

    // Apply pull within a transaction (repeatable read to prevent phantom reads)
    return await db.transaction(
      async (tx) => {
        // Create new working copy that starts with main's values
        // but preserves our non-conflicting changes
        const mainData = mainItem as unknown as Record<string, unknown>

        // Start with main's data (main wins for all fields)
        const mergedData: Record<string, unknown> = { ...mainData }

        // Create new item version with merged data
        const [newWorkingCopy] = await tx
          .insert(items)
          .values({
            ...(mergedData as typeof items.$inferInsert),
            id: undefined, // Generate new ID
            masterId: bi.itemMasterId,
            revision: 'DRAFT', // Keep as draft on branch
            isCurrent: false,
            modifiedAt: new Date(),
            modifiedBy: userId,
          })
          .returning()

        // Update branch item to point to new working copy and new base
        await tx
          .update(branchItems)
          .set({
            currentItemId: newWorkingCopy.id,
            baseItemId: mainItemId, // Main's item is now our base
          })
          .where(eq(branchItems.id, branchItemId))

        return {
          success: true,
          itemMasterId: bi.itemMasterId,
          newItemId: newWorkingCopy.id,
        }
      },
      { isolationLevel: 'repeatable read' },
    )
  }

  /**
   * Get fields that changed from base to current
   */
  private static getChangesFromBase(
    base: Record<string, unknown> | null,
    current: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!base) return { ...current }

    const changes: Record<string, unknown> = {}

    for (const [field, value] of Object.entries(current)) {
      if (
        IGNORED_COMPARISON_FIELDS.includes(
          field as (typeof IGNORED_COMPARISON_FIELDS)[number],
        )
      )
        continue
      if (JSON.stringify(base[field]) !== JSON.stringify(value)) {
        changes[field] = value
      }
    }

    return changes
  }
}
