// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import {
  and,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  ne,
} from 'drizzle-orm'
import { db } from '../db'
import {
  branchItems,
  branches,
  changeOrderAffectedItems,
  items,
  workflowInstances,
} from '../db/schema'
import { ItemService } from '../items/services/ItemService'
import { ItemRelationshipService } from '../items/services/ItemRelationshipService'
import { getTypeHandler } from '../items/type-handlers'
import { FileService } from '../vault/services/FileService'
import { bomStructureOf, describeBomStructure } from './item-structure'
import '../items/type-handlers/init'
import { BranchService } from './BranchService'
import { RevisionService } from './RevisionService'
import type { TransactionClient } from '../db'
import { takeFirst } from '@/lib/db/take-first'

/**
 * Columns that identify an item version rather than describe it.
 *
 * A rebase writes merged *content* onto a working copy; it never re-identifies
 * it. `revision` in particular: the branch working revision is what the merge
 * recognises as unreleased, and the merged data carries the *base's* revision,
 * so copying it across would release the branch copy by accident.
 */
const VERSION_IDENTITY_COLUMNS = new Set([
  'id',
  'masterId',
  'itemNumber',
  'revision',
  'designId',
  'itemType',
  'isCurrent',
  'createdAt',
  'createdBy',
])

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
  'draftManifestId', // Uncommitted editor state - only committed manifests conflict
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
        // Not blocking: the release auto-checks-in every item on the branch
        // before merging (`autoCheckinBranchItems`), which is the documented
        // behaviour. Reporting this as an error meant an ECO could never be
        // released while anyone still held a checkout — and a checkout is held
        // for as long as the engineer keeps editing, since saving keeps it.
        // Still worth showing: someone has it open right now.
        severity: 'warning',
        ourBranchItemId: branchItem.id,
        ourItemId: branchItem.currentItemId || '',
        ourRevision: item?.revision || '',
        ourBranchId: branch.id,
        ourBranchName: branch.name,
        fieldConflicts: [],
        suggestedResolution: 'manual',
        resolutionNotes:
          'Still checked out; releasing the change order will check it in',
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

        // A BOM edit changes no column on the items row, so the field
        // comparison below cannot see one. The merge does compare structure and
        // refuses on a divergence — without this the Conflicts tab reported
        // nothing at all for a BOM-only change on main, and the release then
        // failed with a hard error the user had never been warned about.
        const structureConflict = await this.detectStructureConflict(
          branchItem.baseItemId,
          ourFullItem.id,
          latestMainItem.id,
        )

        // Check if main actually has meaningful changes (not just revision)
        // If the only change on main is revision, skip conflict detection entirely
        const mainChangesFromBase = this.getChangesFromBase(
          baseItem as unknown as Record<string, unknown> | null,
          latestMainItem as unknown as Record<string, unknown>,
        )
        if (
          Object.keys(mainChangesFromBase).length === 0 &&
          !structureConflict.mainDiverged
        ) {
          // No meaningful changes on main (only revision changed) - skip conflict
          continue
        }

        // Detect field-level conflicts using three-way comparison
        // (Software manifest conflicts are refined to per-file granularity)
        const fieldConflicts = await this.refineSourceConflicts(
          baseItem as unknown as Record<string, unknown> | null,
          ourFullItem as unknown as Record<string, unknown>,
          latestMainItem as unknown as Record<string, unknown>,
          this.detectFieldConflicts(
            baseItem as unknown as Record<string, unknown> | null,
            ourFullItem as unknown as Record<string, unknown>,
            latestMainItem as unknown as Record<string, unknown>,
          ),
        )
        if (structureConflict.conflict) {
          fieldConflicts.push(structureConflict.conflict)
        }

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
          itemNumber: ourFullItem.itemNumber,
          itemName: ourFullItem.name ?? null,
          conflictType: hasFieldConflicts
            ? 'field_conflict'
            : 'concurrent_modification',
          // Blocking, because the merge blocks. `validateMerge` refuses to
          // merge a branch whose base has been overtaken on main — releasing
          // anyway would replace main's content with this branch's and
          // silently revert whatever the other change order released. Reporting
          // it as a warning meant the Conflicts tab said "proceed", the release
          // gate agreed, and the merge then failed with a hard error. Rebase or
          // pull from main first; both are offered on this conflict.
          severity: 'error',

          ourBranchItemId: branchItem.id,
          ourItemId: ourFullItem.id,
          ourRevision: ourFullItem.revision,
          ourBranchId: branch.id,
          ourBranchName: branch.name,

          theirItemId: latestMainItem.id,
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

    const mainCurrentItemId = mainBranchItem[0]?.currentItemId
    if (!mainCurrentItemId) {
      return null
    }

    // If main's current item is different from our base, there was a change
    if (mainCurrentItemId !== baseItemId) {
      const mainItem = await db
        .select()
        .from(items)
        .where(eq(items.id, mainCurrentItemId))
        .limit(1)

      return mainItem.at(0) || null
    }

    return null
  }

  /**
   * Sharpen Software manifest conflicts to per-file granularity.
   *
   * A raw three-way comparison reports one opaque `manifestId` conflict when
   * both branches changed the source tree. Here we diff each side's manifest
   * against the base: only paths changed *differently on both sides* are true
   * conflicts, emitted as one FieldConflict per file (fieldPath = the file).
   * If the two branches touched disjoint files, the manifestId conflict is
   * dropped entirely - the caller's existing logic then downgrades the item
   * to a concurrent-modification/cross-ECO warning instead of an error.
   */
  static async refineSourceConflicts(
    baseItem: Record<string, unknown> | null,
    ourItem: Record<string, unknown>,
    theirItem: Record<string, unknown>,
    fieldConflicts: Array<FieldConflict>,
  ): Promise<Array<FieldConflict>> {
    if (ourItem.itemType !== 'Software') return fieldConflicts
    const manifestConflict = fieldConflicts.find(
      (c) => c.fieldName === 'manifestId',
    )
    if (!manifestConflict) return fieldConflicts

    // Lazy import: SoftwareSourceService pulls in ItemService, which this
    // module must not import at top level.
    const { SoftwareSourceService } = await import('./SoftwareSourceService')

    const baseManifest = (baseItem?.manifestId as string | null) ?? null
    const [ourDiff, theirDiff] = await Promise.all([
      SoftwareSourceService.diffManifests(
        baseManifest,
        (ourItem.manifestId as string | null) ?? null,
      ),
      SoftwareSourceService.diffManifests(
        baseManifest,
        (theirItem.manifestId as string | null) ?? null,
      ),
    ])

    const theirByPath = new Map(theirDiff.map((d) => [d.path, d]))
    const perFile: Array<FieldConflict> = []
    for (const ours of ourDiff) {
      const theirs = theirByPath.get(ours.path)
      if (!theirs) continue
      // Same path changed on both sides - only a conflict if the results differ
      if ((ours.newHash ?? null) === (theirs.newHash ?? null)) continue
      perFile.push({
        fieldName: 'source',
        fieldPath: ours.path,
        baseValue: ours.oldHash ?? null,
        ourValue: ours.newHash ?? null,
        theirValue: theirs.newHash ?? null,
      })
    }

    return [
      ...fieldConflicts.filter((c) => c.fieldName !== 'manifestId'),
      ...perFile,
    ]
  }

  /**
   * Three-way comparison of BOM structure.
   *
   * `mainDiverged` says main's structure moved away from the base at all,
   * which is what makes it a concurrent modification the merge will refuse.
   * `conflict` is set only when *both* sides restructured differently, which
   * escalates it to a blocking field conflict.
   */
  private static async detectStructureConflict(
    baseItemId: string | null,
    ourItemId: string,
    theirItemId: string,
  ): Promise<{ mainDiverged: boolean; conflict?: FieldConflict }> {
    if (!baseItemId) return { mainDiverged: false }

    const [base, ours, theirs] = await Promise.all([
      bomStructureOf(baseItemId),
      bomStructureOf(ourItemId),
      bomStructureOf(theirItemId),
    ])

    const weChanged = ours.signature !== base.signature
    const theyChanged = theirs.signature !== base.signature

    if (weChanged && theyChanged && ours.signature !== theirs.signature) {
      return {
        mainDiverged: true,
        conflict: {
          fieldName: 'BOM structure',
          baseValue: describeBomStructure(base),
          ourValue: describeBomStructure(ours),
          theirValue: describeBomStructure(theirs),
        },
      }
    }

    return { mainDiverged: theyChanged }
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
            itemNumber: ourFullItem.itemNumber,
            itemName: ourFullItem.name ?? null,
            conflictType: 'cross_eco',
            severity: 'warning',

            ourBranchItemId: ourModified.branchItem.id,
            ourItemId: ourFullItem.id,
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
        // (Software manifest conflicts are refined to per-file granularity)
        const fieldConflicts = await this.refineSourceConflicts(
          baseItem as unknown as Record<string, unknown>,
          ourFullItem as unknown as Record<string, unknown>,
          otherFullItem as unknown as Record<string, unknown>,
          this.detectFieldConflicts(
            baseItem as unknown as Record<string, unknown>,
            ourFullItem as unknown as Record<string, unknown>,
            otherFullItem as unknown as Record<string, unknown>,
          ),
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
          itemNumber: ourFullItem.itemNumber,
          itemName: ourFullItem.name ?? null,
          conflictType: hasFieldConflicts ? 'field_conflict' : 'cross_eco',
          severity: hasFieldConflicts ? 'error' : 'warning',

          ourBranchItemId: ourModified.branchItem.id,
          ourItemId: ourFullItem.id,
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
   * Is this branch item's current version the branch's own working copy?
   *
   * Two shapes reach a rebase. After `createRevisionWorkingCopy` — the normal
   * post-remediation shape, minted eagerly when an item joins an ECO —
   * `currentItemId` points at a branch-local row carrying
   * `getWorkingRevision(branchId)`, and `baseItemId` at the released row it was
   * taken from. After a plain checkout, `currentItemId` still points at the
   * shared released row, which is also the base.
   *
   * Only the first shape can be written in place; the second must mint the
   * working copy, because the row it points at belongs to main.
   */
  private static isBranchWorkingCopy(
    bi: typeof branchItems.$inferSelect,
    ourItem: { id: string; revision: string },
  ): boolean {
    return (
      RevisionService.isWorkingRevision(ourItem.revision) &&
      ourItem.id !== bi.baseItemId
    )
  }

  /**
   * Write merged values onto the working copy that already exists.
   *
   * The alternative — inserting a second row carrying the same
   * `-{branchId8}` revision — violates the items unique constraint
   * (`item_number`, `revision`, `design_id`, `item_type`, NULLS NOT
   * DISTINCT), so the whole rebase rolled back as a 23505. That is the defect
   * this exists to close: the *normal* case, an item revised on an ECO branch,
   * could never be rebased or pulled at all.
   *
   * Only content moves. `VERSION_IDENTITY_COLUMNS` are excluded because a
   * rebase re-bases a version, it does not re-identify one, and the merged
   * record carries the base's identity by construction.
   */
  private static async applyMergedDataInPlace(
    tx: TransactionClient,
    workingCopy: { id: string; itemType: string },
    mergedData: Record<string, unknown>,
    userId: string,
  ): Promise<void> {
    const itemColumns = getTableColumns(items)
    const coreUpdate: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(mergedData)) {
      if (key in itemColumns && !VERSION_IDENTITY_COLUMNS.has(key)) {
        coreUpdate[key] = value
      }
    }
    coreUpdate.modifiedAt = new Date()
    coreUpdate.modifiedBy = userId

    await tx.update(items).set(coreUpdate).where(eq(items.id, workingCopy.id))

    // Extension fields, the same way `saveChanges` writes them. Every type
    // handler's `update` recognises the keys its `insert` does — the two
    // exceptions (physical-part's identity columns, work-instruction's
    // attachment-derived ones) are not extension-row columns at all, so
    // nothing the insert path would have carried is dropped here.
    const typeHandler = getTypeHandler(workingCopy.itemType)
    if (typeHandler) {
      const { itemId: _ignored, ...extFields } = mergedData
      await typeHandler.update(workingCopy.id, extFields, tx)
    }
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

    const bi = branchItemResult[0]
    if (!bi) {
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

        // The branch already has its own working copy in the normal case
        // (createRevisionWorkingCopy mints one when the item joins the ECO).
        // Update it; do not insert a second row carrying the same working
        // revision, which the items unique constraint rejects.
        if (this.isBranchWorkingCopy(bi, ourItem)) {
          await this.applyMergedDataInPlace(tx, ourItem, mergedData, userId)

          // No file or relationship copy: the working copy already owns the
          // branch's files and edges, and copying them from itself is both
          // wrong and a no-op at best.

          // currentItemId is unchanged — the row it names is the row just
          // written. Only the base moves.
          await tx
            .update(branchItems)
            .set({ baseItemId: newBaseItemId })
            .where(eq(branchItems.id, branchItemId))

          return {
            success: true,
            itemMasterId: bi.itemMasterId,
            newBaseItemId,
            autoMerged: fieldConflicts.length === 0,
            manualResolutionRequired: false,
            fieldConflicts: [],
          }
        }

        // Plain-checkout shape: currentItemId is still the shared released
        // row, which belongs to main. Mint the branch's working copy.
        //
        // The branch-scoped working revision is what the merge recognises as
        // an unreleased copy; a literal 'DRAFT' sent it down the legacy path
        // where it minted a revision from that marker text.
        const newWorkingCopy = takeFirst(
          await tx
            .insert(items)
            .values({
              ...(mergedData as typeof items.$inferInsert),
              id: undefined,
              masterId: bi.itemMasterId,
              revision: RevisionService.getWorkingRevision(bi.branchId),
              isCurrent: false,
              modifiedAt: new Date(),
              modifiedBy: userId,
            })
            .returning(),
        )

        // The merged record carries extension fields (weight, manifestId,
        // ...) that the items insert drops. Without this the rebased copy
        // loses all type-specific data.
        const typeHandler = getTypeHandler(newWorkingCopy.itemType)
        if (typeHandler) {
          const { itemId: _ignored, ...extFields } = mergedData
          await typeHandler.insert(newWorkingCopy.id, extFields, tx)
        }

        // Rebase mints a version row like every other step that does, so the
        // copy starts with no files unless they are carried. They come from
        // the copy being rebased rather than the new base, because the branch
        // copy is the authority on branch content - sourcing them from the new
        // base would silently discard files uploaded during the ECO.
        await FileService.copyFilesToItem({
          sourceItemId: ourItem.id,
          targetItemId: newWorkingCopy.id,
          branchId: bi.branchId,
          tx,
        })

        // Relationships are branch content exactly like files: the copy being
        // rebased is the authority on the structure (lines added, re-counted
        // or deleted during the ECO), and the merge releases the copy's edges
        // as the item's structure. Sourcing them from the new base would
        // silently discard every structure edit made on the branch.
        await ItemRelationshipService.copyRelationshipsToItem({
          sourceItemId: ourItem.id,
          targetItemId: newWorkingCopy.id,
          userId,
          tx,
        })

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

    const bi = branchItemResult[0]
    if (!bi) {
      return {
        success: false,
        itemMasterId: '',
        error: 'Branch item not found',
      }
    }

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

        // Same two shapes as rebaseItem, and the same reason: inserting a
        // second row with this branch's working revision collides on the
        // items unique constraint whenever the working copy already exists.
        if (this.isBranchWorkingCopy(bi, ourItem)) {
          await this.applyMergedDataInPlace(tx, ourItem, mergedData, userId)

          // Files and relationships stay where they are — see rebaseItem.
          await tx
            .update(branchItems)
            .set({ baseItemId: mainItemId })
            .where(eq(branchItems.id, branchItemId))

          return {
            success: true,
            itemMasterId: bi.itemMasterId,
            newItemId: ourItem.id,
          }
        }

        // Create new item version with merged data
        const newWorkingCopy = takeFirst(
          await tx
            .insert(items)
            .values({
              ...(mergedData as typeof items.$inferInsert),
              id: undefined, // Generate new ID
              masterId: bi.itemMasterId,
              // Branch-scoped working revision - see rebaseItem
              revision: RevisionService.getWorkingRevision(bi.branchId),
              isCurrent: false,
              modifiedAt: new Date(),
              modifiedBy: userId,
            })
            .returning(),
        )

        // Extension fields would be dropped by the items insert
        const typeHandler = getTypeHandler(newWorkingCopy.itemType)
        if (typeHandler) {
          const { itemId: _ignored, ...extFields } = mergedData
          await typeHandler.insert(newWorkingCopy.id, extFields, tx)
        }

        // Main wins on fields here, but not on files: they are not part of the
        // three-way field comparison, so taking main's would delete whatever
        // was uploaded on the branch with no way to get it back.
        await FileService.copyFilesToItem({
          sourceItemId: ourItem.id,
          targetItemId: newWorkingCopy.id,
          branchId: bi.branchId,
          tx,
        })

        // Same for relationships: branch content, not a three-way-compared
        // field, so they come from the branch copy — the merge releases the
        // copy's edges as the item's structure.
        await ItemRelationshipService.copyRelationshipsToItem({
          sourceItemId: ourItem.id,
          targetItemId: newWorkingCopy.id,
          userId,
          tx,
        })

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
