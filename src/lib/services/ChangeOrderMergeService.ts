// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

import { and, eq, isNotNull } from 'drizzle-orm'
import { db } from '../db'
import { withSerializableRetry } from '../db/retry'
import {
  branchItems,
  changeOrderDesigns,
  itemRelationships,
  items,
} from '../db/schema'
import { MergeConflictError, NotFoundError, ValidationError } from '../errors'
import { ItemService } from '../items/services/ItemService'
import { ChangeOrderService } from '../items/services/ChangeOrderService'
import { FileService } from '../vault/services/FileService'
import { BranchService } from './BranchService'
import { CommitService } from './CommitService'
import { CrossDesignReferenceService } from './CrossDesignReferenceService'
import { DesignService } from './DesignService'
import { LifecycleService } from './LifecycleService'
import { RevisionService } from './RevisionService'
import type { commits } from '../db/schema'
import type {
  ChangeAction,
  PromoteActionMapping,
  RevisionScheme,
} from '../types/lifecycle'
import type { ChangeOrder } from '../items/types/change-order'
import { serviceLogger } from '@/lib/logging/logger'

// ============================================
// Types
// ============================================

export interface MergeResult {
  mergeCommit: typeof commits.$inferSelect
  revisionsAssigned: Record<string, string> // itemNumber -> newRevision
  itemsMerged: number
  itemsAdded: number
  itemsDeleted: number
}

export interface ChangeOrderMergeResult {
  changeOrder: typeof items.$inferSelect
  designs: Array<{
    designId: string
    designName: string
    mergeResult: MergeResult
  }>
  totalRevisionsAssigned: number
}

export interface MergeConflict {
  itemId: string
  itemNumber: string
  reason: string
  /** For concurrent modification conflicts */
  mainVersion?: string
  branchBase?: string
  conflictType?:
    | 'checkout'
    | 'concurrent_modification'
    | 'no_changes'
    | 'branch_not_found'
}

export interface MergeValidation {
  canMerge: boolean
  conflicts: Array<MergeConflict>
  warnings: Array<string>
}

export interface ReleasePreviewItem {
  itemId: string
  itemNumber: string
  currentRevision: string
  newRevision: string
  changeType: 'added' | 'modified' | 'deleted'
}

export interface ReleasePreview {
  designs: Array<{
    designId: string
    designName: string
    items: Array<ReleasePreviewItem>
    /** Conflicts for this specific design/branch */
    conflicts: Array<MergeConflict>
  }>
  totalItems: number
  canRelease: boolean
  validationIssues: Array<string>
  /** All conflicts across all designs */
  allConflicts: Array<MergeConflict>
}

// ============================================
// ChangeOrderMergeService
// ============================================

/**
 * Service for change order merge/release workflow.
 * Handles merging ECO branches to main with revision letter assignment.
 * Works with all change order types (ECO, ECN, Deviation, MCO).
 */
export class ChangeOrderMergeService {
  /**
   * Release a change order - merges all branches to main OR implements affected items
   * This is called after the workflow transition to a final state has completed.
   * Supports two workflows:
   * 1. ECO-as-branch: Merge ECO branches to main with revision assignment
   * 2. Simple affected items: Directly implement the affected items
   *
   * IMPORTANT: The workflow transition to the final state must happen BEFORE calling this.
   * This method is called by ChangeOrderService.close() after the transition completes.
   */
  static async merge(
    changeOrderId: string,
    userId: string,
  ): Promise<ChangeOrderMergeResult> {
    // Get the change order
    const changeOrder = await ItemService.findById(changeOrderId)
    if (!changeOrder) {
      throw new NotFoundError('Change order', changeOrderId)
    }
    // Note: State validation removed - the workflow transition already happened
    // before this method is called. The transition API validates state transitions.

    const results: ChangeOrderMergeResult = {
      changeOrder: changeOrder as unknown as typeof items.$inferSelect,
      designs: [],
      totalRevisionsAssigned: 0,
    }

    // 2. Get all changeOrderDesigns with branches
    const ecoDesigns = await ChangeOrderService.getEcoDesigns(changeOrderId)
    const designsWithBranches = ecoDesigns.filter((d) => d.branchId)

    // 3a. If we have ECO branches, try the branch merge workflow
    let branchesMerged = 0
    if (designsWithBranches.length > 0) {
      for (const ecoDesign of designsWithBranches) {
        if (!ecoDesign.branchId) continue

        // Auto-checkin all items on this branch before merge
        // This releases checkout locks since the ECO is being released
        await this.autoCheckinBranchItems(ecoDesign.branchId)

        // Validate merge before proceeding
        const validation = await this.validateMerge(ecoDesign.branchId)

        // Check if this is a "no changes" situation vs a real conflict
        const noChangesConflict = validation.conflicts.some(
          (c) => c.reason === 'No changes to merge',
        )
        const realConflicts = validation.conflicts.filter(
          (c) => c.reason !== 'No changes to merge',
        )

        if (realConflicts.length > 0) {
          // Real conflicts that block the merge
          throw new MergeConflictError(
            `Cannot merge: ${realConflicts.map((c) => c.reason).join(', ')}`,
            {
              changeOrderId,
              branchId: ecoDesign.branchId,
              conflicts: realConflicts,
            },
          )
        }

        if (noChangesConflict) {
          // No changes on this branch - skip merging but don't fail
          // Mark as skipped (no merge needed)
          await db
            .update(changeOrderDesigns)
            .set({
              mergeStatus: 'skipped',
              updatedAt: new Date(),
            })
            .where(eq(changeOrderDesigns.id, ecoDesign.id))
          continue
        }

        // Get design details
        const design = await DesignService.getById(ecoDesign.designId)

        // Merge branch to main
        const mergeResult = await this.mergeBranchToMain(
          ecoDesign.branchId,
          changeOrderId,
          userId,
        )

        // Update changeOrderDesign with merge info
        await db
          .update(changeOrderDesigns)
          .set({
            mergeStatus: 'merged',
            mergedAt: new Date(),
            mergeCommitId: mergeResult.mergeCommit.id,
            updatedAt: new Date(),
          })
          .where(eq(changeOrderDesigns.id, ecoDesign.id))

        results.designs.push({
          designId: ecoDesign.designId,
          designName: design?.name || 'Unknown',
          mergeResult,
        })

        results.totalRevisionsAssigned += Object.keys(
          mergeResult.revisionsAssigned,
        ).length
        branchesMerged++
      }
    }

    // 3b. If no branches were merged, use affected items workflow
    // This handles two cases:
    // - No branches exist at all (simple affected items ECO)
    // - Branches exist but ALL of them had no changes to merge (skipped)
    // In both cases, we need to process affected items directly
    if (branchesMerged === 0) {
      const affectedItems =
        await ChangeOrderService.getAffectedItems(changeOrderId)

      if (affectedItems.length === 0) {
        throw new ValidationError(
          'No affected items or designs associated with this ECO',
        )
      }

      // Implement each affected item based on its action
      // ECO releases bypass branch protection since the ECO approval process
      // already validates and authorizes the changes
      const bypassOptions = { bypassBranchProtection: true }

      // Wrap the entire affected items processing in a transaction for atomicity.
      // If any item fails to process, all changes are rolled back to prevent
      // leaving the ECO in an inconsistent partially-released state.
      await db.transaction(async (tx) => {
        // Track released items by design for creating release commits
        const releasedItemsByDesign = new Map<
          string,
          {
            items: Array<{
              itemId: string
              itemNumber: string | undefined
              changeType: 'added' | 'modified' | 'deleted'
              newRevision?: string
            }>
            designName?: string
          }
        >()

        for (const affected of affectedItems) {
          if (!affected.affectedItemId) continue

          const item = await ItemService.findById(affected.affectedItemId)
          if (!item) continue

          const action = affected.changeAction as ChangeAction

          // For release/revise/obsolete actions, check if item is already in target state
          // This makes the release operation idempotent (safe to call multiple times)
          // NOTE: Even when skipping the state transition, we still need to create branchItems
          // (lifecycle effects from workflow transitions may have already updated the state)
          let skippedStateChange = false
          if (action === 'release') {
            const targetState = await LifecycleService.getTargetState(
              item.itemType,
              'release',
            )
            if (targetState && item.state === targetState) {
              // Item already in target state (lifecycle effects set it during workflow transition)
              // Still need to assign revision since lifecycle effects only set state, not revision
              skippedStateChange = true

              const releaseScheme = await LifecycleService.getRevisionScheme(
                item.itemType,
              )
              const needsRevision =
                !item.revision ||
                item.revision === '-' ||
                item.revision === 'DRAFT' ||
                item.revision.startsWith('-')
              const finalRevision = needsRevision
                ? RevisionService.getInitialRevision(releaseScheme)
                : item.revision

              if (needsRevision) {
                await ItemService.update(
                  affected.affectedItemId,
                  { revision: finalRevision },
                  userId,
                  { bypassBranchProtection: true },
                )
                results.totalRevisionsAssigned++
              }

              // Track for release commit even though state was already set
              if (item.designId && item.id) {
                const existing = releasedItemsByDesign.get(item.designId) || {
                  items: [],
                }
                existing.items.push({
                  itemId: item.id,
                  itemNumber: item.itemNumber,
                  changeType: 'added',
                  newRevision: finalRevision,
                })
                releasedItemsByDesign.set(item.designId, existing)
              }
            }
          }

          if (!skippedStateChange) {
            // Validate the action can be applied (skip for add/remove which don't affect state)
            if (action !== 'add' && action !== 'remove') {
              const validation = await LifecycleService.canApplyAction(
                item.itemType,
                item.state || 'Draft',
                action,
              )
              if (!validation.valid) {
                throw new ValidationError(
                  `Cannot apply "${action}" to ${item.itemNumber}: ${validation.error}`,
                )
              }
            }

            switch (action) {
              case 'release': {
                // Get target state from lifecycle config
                const targetState = await LifecycleService.getTargetState(
                  item.itemType,
                  'release',
                )
                // Resolve revision scheme for this item type
                const releaseScheme = await LifecycleService.getRevisionScheme(
                  item.itemType,
                )
                // Assign initial revision if item has no real revision yet
                const needsRevision =
                  !item.revision ||
                  item.revision === '-' ||
                  item.revision === 'DRAFT' ||
                  item.revision.startsWith('-')
                const finalRevision = needsRevision
                  ? RevisionService.getInitialRevision(releaseScheme)
                  : item.revision

                const updates: Record<string, unknown> = {}
                if (targetState && item.state !== targetState) {
                  updates.state = targetState
                }
                if (needsRevision) {
                  updates.revision = finalRevision
                }

                if (Object.keys(updates).length > 0) {
                  await ItemService.update(
                    affected.affectedItemId,
                    updates,
                    userId,
                    bypassOptions,
                  )
                  results.totalRevisionsAssigned++

                  // Track for release commit
                  if (item.designId && item.id) {
                    const existing = releasedItemsByDesign.get(
                      item.designId,
                    ) || {
                      items: [],
                    }
                    existing.items.push({
                      itemId: item.id,
                      itemNumber: item.itemNumber,
                      changeType: 'added',
                      newRevision: finalRevision,
                    })
                    releasedItemsByDesign.set(item.designId, existing)
                  }
                }
                break
              }

              case 'revise': {
                // Get states from lifecycle config
                const newVersionState = await LifecycleService.getTargetState(
                  item.itemType,
                  'revise',
                )
                const oldVersionState =
                  await LifecycleService.getOldVersionState(item.itemType)

                // Check for existing working copy (created when affected item was added)
                let workingCopy: typeof items.$inferSelect | null = null

                // First, check if workingCopyId was stored on the affected item record
                if ((affected as any).workingCopyId) {
                  const found = await ItemService.findById(
                    (affected as any).workingCopyId,
                  )
                  workingCopy = found as typeof items.$inferSelect | null
                }

                // Fallback: Check ECO branch for working copy (backward compatibility)
                if (
                  !workingCopy &&
                  item.designId &&
                  affected.affectedItemMasterId
                ) {
                  const ecoDesign = await tx
                    .select()
                    .from(changeOrderDesigns)
                    .where(
                      and(
                        eq(changeOrderDesigns.changeOrderId, changeOrderId),
                        eq(changeOrderDesigns.designId, item.designId),
                      ),
                    )
                    .limit(1)
                    .then((r) => r.at(0))

                  if (ecoDesign?.branchId) {
                    workingCopy = await this.findWorkingCopyOnBranch(
                      affected.affectedItemMasterId,
                      ecoDesign.branchId,
                    )
                  }
                }

                if (workingCopy) {
                  // Working copy exists - transition it to new version state
                  // First, mark all other revisions of this item as not current
                  await tx
                    .update(items)
                    .set({
                      isCurrent: false,
                      state: oldVersionState || 'Superseded',
                    })
                    .where(eq(items.masterId, item.masterId!))

                  // Calculate final revision - if placeholder (starts with "-"), use next revision from source item
                  const reviseScheme = await LifecycleService.getRevisionScheme(
                    item.itemType,
                  )
                  let finalRevision = workingCopy.revision
                  if (workingCopy.revision.startsWith('-')) {
                    finalRevision = RevisionService.getNextRevision(
                      item.revision,
                      reviseScheme,
                    )
                  }

                  // Now transition working copy with final revision and mark as current
                  await ItemService.update(
                    workingCopy.id,
                    {
                      revision: finalRevision,
                      state: newVersionState || 'Released',
                      isCurrent: true,
                    },
                    userId,
                    bypassOptions,
                  )

                  results.totalRevisionsAssigned++

                  // Track for release commit
                  if (item.designId) {
                    const existing = releasedItemsByDesign.get(
                      item.designId,
                    ) || {
                      items: [],
                    }
                    existing.items.push({
                      itemId: workingCopy.id,
                      itemNumber: workingCopy.itemNumber,
                      changeType: 'modified',
                      newRevision: finalRevision,
                    })
                    releasedItemsByDesign.set(item.designId, existing)
                  }
                } else {
                  // No working copy - fallback to old behavior (create revision at release time)
                  const reviseFallbackScheme =
                    await LifecycleService.getRevisionScheme(item.itemType)
                  const targetRevision =
                    affected.targetRevision ||
                    RevisionService.getNextRevision(
                      item.revision,
                      reviseFallbackScheme,
                    )
                  const newRev = await ItemService.revise(
                    affected.affectedItemId,
                    targetRevision,
                    userId,
                  )
                  if (newRev.id) {
                    await ItemService.update(
                      newRev.id,
                      { state: newVersionState || 'Released' },
                      userId,
                      bypassOptions,
                    )

                    // Track for release commit
                    if (item.designId) {
                      const existing = releasedItemsByDesign.get(
                        item.designId,
                      ) || {
                        items: [],
                      }
                      existing.items.push({
                        itemId: newRev.id,
                        itemNumber: newRev.itemNumber,
                        changeType: 'modified',
                        newRevision: targetRevision,
                      })
                      releasedItemsByDesign.set(item.designId, existing)
                    }
                  }
                  results.totalRevisionsAssigned++
                }
                break
              }

              case 'obsolete': {
                // Get target state from lifecycle config
                const targetState = await LifecycleService.getTargetState(
                  item.itemType,
                  'obsolete',
                )
                await ItemService.update(
                  affected.affectedItemId,
                  { state: targetState || 'Obsolete' },
                  userId,
                  bypassOptions,
                )

                // Track for release commit
                if (item.designId && item.id) {
                  const existing = releasedItemsByDesign.get(item.designId) || {
                    items: [],
                  }
                  existing.items.push({
                    itemId: item.id,
                    itemNumber: item.itemNumber,
                    changeType: 'deleted',
                    newRevision: item.revision,
                  })
                  releasedItemsByDesign.set(item.designId, existing)
                }
                break
              }

              case 'promote': {
                // Get promote mapping from lifecycle
                const promoteMapping = (await LifecycleService.getActionMapping(
                  item.itemType,
                  'promote',
                )) as PromoteActionMapping | null

                if (promoteMapping) {
                  const promoteTargetState = promoteMapping.toState
                  const lifecycle =
                    await LifecycleService.getLifecycleForItemType(
                      item.itemType,
                    )

                  // Determine if revision should reset
                  let shouldResetRevision = promoteMapping.resetRevision
                  if (shouldResetRevision === undefined && lifecycle?.phases) {
                    // Check phase-level resetRevisionOnEntry
                    const toPhase = LifecycleService.getPhaseForState(
                      lifecycle,
                      promoteTargetState,
                    )
                    shouldResetRevision = toPhase?.resetRevisionOnEntry
                  }

                  // Resolve the target phase's revision scheme
                  let promoteScheme: RevisionScheme | undefined
                  if (lifecycle) {
                    promoteScheme = LifecycleService.getRevisionSchemeForState(
                      lifecycle,
                      promoteTargetState,
                    )
                  }

                  let promoteRevision: string
                  if (shouldResetRevision) {
                    promoteRevision =
                      RevisionService.getInitialRevision(promoteScheme)
                  } else if (promoteMapping.assignsRevision) {
                    promoteRevision = RevisionService.getNextRevision(
                      item.revision,
                      promoteScheme,
                    )
                  } else {
                    promoteRevision = item.revision
                  }

                  const promoteUpdates: Record<string, unknown> = {
                    state: promoteTargetState,
                  }
                  if (promoteRevision !== item.revision) {
                    promoteUpdates.revision = promoteRevision
                  }

                  await ItemService.update(
                    affected.affectedItemId,
                    promoteUpdates,
                    userId,
                    bypassOptions,
                  )

                  if (promoteMapping.assignsRevision || shouldResetRevision) {
                    results.totalRevisionsAssigned++
                  }

                  // Track for release commit
                  if (item.designId && item.id) {
                    const existing = releasedItemsByDesign.get(
                      item.designId,
                    ) || {
                      items: [],
                    }
                    existing.items.push({
                      itemId: item.id,
                      itemNumber: item.itemNumber,
                      changeType: 'modified',
                      newRevision: promoteRevision,
                    })
                    releasedItemsByDesign.set(item.designId, existing)
                  }
                }
                break
              }

              case 'add':
              case 'remove':
                // Membership actions - no state change, handled elsewhere
                break
            }
          } // end if (!skippedStateChange)

          // After processing each affected item, ensure it's tracked on the main branch
          // This is critical for the Design Structure view to work correctly
          if (item.designId && item.masterId) {
            const mainBranch = await BranchService.getMainBranch(item.designId)
            if (mainBranch) {
              // Get the current version of this item (the one we just released or the existing released one)
              const currentItem = await tx
                .select()
                .from(items)
                .where(
                  and(
                    eq(items.masterId, item.masterId),
                    eq(items.isCurrent, true),
                  ),
                )
                .limit(1)
                .then((r) => r.at(0))

              if (currentItem) {
                // Check if branchItem already exists
                const existingBranchItem = await tx
                  .select()
                  .from(branchItems)
                  .where(
                    and(
                      eq(branchItems.branchId, mainBranch.id),
                      eq(branchItems.itemMasterId, item.masterId),
                    ),
                  )
                  .limit(1)
                  .then((r) => r.at(0))

                if (existingBranchItem) {
                  // Update to point to current item
                  await tx
                    .update(branchItems)
                    .set({ currentItemId: currentItem.id })
                    .where(eq(branchItems.id, existingBranchItem.id))
                } else {
                  // Create new branchItem
                  await tx
                    .insert(branchItems)
                    .values({
                      branchId: mainBranch.id,
                      itemMasterId: item.masterId,
                      currentItemId: currentItem.id,
                      baseItemId: currentItem.id,
                      changeType: null,
                    })
                    .onConflictDoNothing()
                }
              }
            }
          }
        }

        // Create release commits for each design that had items released
        // This ensures the initial ECO release appears in the design's history graph
        for (const [designId, designData] of releasedItemsByDesign) {
          if (designData.items.length === 0) continue

          const mainBranch = await BranchService.getMainBranch(designId)
          if (!mainBranch) continue

          // Build revision assignments map
          const revisionsAssigned: Record<string, string> = {}
          for (const item of designData.items) {
            if (item.newRevision && item.itemNumber) {
              revisionsAssigned[item.itemNumber] = item.newRevision
            }
          }

          // Create release commit on main branch
          await CommitService.create(
            {
              branchId: mainBranch.id,
              message: `Released via ECO: ${changeOrder.itemNumber}`,
              changeOrderItemId: changeOrderId,
              revisionsAssigned,
              itemChanges: designData.items.map((item) => ({
                itemId: item.itemId,
                changeType: item.changeType,
              })),
            },
            userId,
          )
        }

        // Archive any ECO branches associated with this change order
        for (const ecoDesign of ecoDesigns) {
          if (ecoDesign.branchId) {
            await BranchService.archiveBranch(ecoDesign.branchId)
          }
        }
      }) // end db.transaction
    }

    // Note: Don't update ECO state here - let the workflow handle it via ChangeOrderService.close()
    // The workflow will transition from Approved -> Released

    // Create baseline tags on affected designs if isBaseline is set
    const changeOrderData = changeOrder as unknown as ChangeOrder
    if (changeOrderData.isBaseline && changeOrderData.baselineName) {
      const baselineName = changeOrderData.baselineName
      const ecoDesignsForTags =
        await ChangeOrderService.getEcoDesigns(changeOrderId)

      for (const ecoDesign of ecoDesignsForTags) {
        try {
          await DesignService.createTag(
            ecoDesign.designId,
            {
              name: baselineName,
              description: `Baseline created by ECO release: ${changeOrder.itemNumber}`,
              tagType: 'eco-release',
            },
            userId,
          )
        } catch (error) {
          // Log but don't fail the release if tag creation fails (e.g., duplicate name)
          serviceLogger.warn(
            { err: error, baselineName, designId: ecoDesign.designId },
            'Failed to create baseline tag',
          )
        }
      }
    }

    // Return the updated change order
    results.changeOrder = (await ItemService.findById(
      changeOrderId,
    ))! as unknown as typeof items.$inferSelect

    return results
  }

  /**
   * Find an existing working copy for an item master on a specific branch.
   * Used during ECO release to check if a working copy was created at add-time.
   */
  private static async findWorkingCopyOnBranch(
    itemMasterId: string,
    branchId: string,
  ): Promise<typeof items.$inferSelect | null> {
    const result = await db
      .select({ item: items })
      .from(branchItems)
      .innerJoin(items, eq(branchItems.currentItemId, items.id))
      .where(
        and(
          eq(branchItems.branchId, branchId),
          eq(branchItems.itemMasterId, itemMasterId),
        ),
      )
      .limit(1)

    return result.at(0)?.item || null
  }

  /**
   * Merge a single ECO branch to main branch
   * Handles revision letter assignment
   */
  static async mergeBranchToMain(
    branchId: string,
    changeOrderId: string,
    userId: string,
  ): Promise<MergeResult> {
    // 1. Get branch and validate it's an ECO branch
    const branch = await BranchService.getById(branchId)
    if (!branch) {
      throw new NotFoundError('Branch', branchId)
    }
    if (branch.branchType !== 'eco') {
      throw new ValidationError('Only ECO branches can be merged to main')
    }

    // 2. Get main branch for design
    const mainBranch = await BranchService.getMainBranch(branch.designId)
    if (!mainBranch) {
      throw new NotFoundError('Main branch', branch.designId)
    }

    // 3. Get all changed items on ECO branch
    const changedItems = await db
      .select()
      .from(branchItems)
      .where(
        and(
          eq(branchItems.branchId, branchId),
          isNotNull(branchItems.changeType),
        ),
      )

    if (changedItems.length === 0) {
      throw new ValidationError('No changes to merge')
    }

    const revisionsAssigned: Record<string, string> = {}
    let itemsMerged = 0
    let itemsAdded = 0
    let itemsDeleted = 0
    const itemChanges: Array<{
      itemId: string
      itemMasterId: string
      changeType: 'added' | 'modified' | 'deleted'
      previousItemId?: string
    }> = []

    // Track mapping of old item IDs to new released item IDs for BOM relationship updates
    // Key: baseItemId (old revision), Value: releasedItemId (new revision)
    const itemIdMapping = new Map<string, string>()
    // Also track masterId -> new item ID for resolving children that may only have masterId
    const masterIdToNewItemId = new Map<string, string>()

    // 4. Build lifecycle config lookup for all affected item types
    // Pre-fetch outside transaction to avoid async issues
    const lifecycleStateCache = new Map<
      string,
      {
        releaseState: string
        obsoleteState: string
        revisionScheme?: RevisionScheme
      }
    >()
    for (const bi of changedItems) {
      if (!bi.currentItemId) continue
      const item = await db
        .select()
        .from(items)
        .where(eq(items.id, bi.currentItemId))
        .limit(1)
        .then((r) => r.at(0))
      if (item && !lifecycleStateCache.has(item.itemType)) {
        const releaseState =
          (await LifecycleService.getTargetState(item.itemType, 'release')) ||
          'Released'
        const obsoleteState =
          (await LifecycleService.getTargetState(item.itemType, 'obsolete')) ||
          'Obsolete'
        const revisionScheme = await LifecycleService.getRevisionScheme(
          item.itemType,
        )
        lifecycleStateCache.set(item.itemType, {
          releaseState,
          obsoleteState,
          revisionScheme,
        })
      }
    }

    // 5. Process each changed item (serializable to prevent race conditions during ECO merge)
    await withSerializableRetry(() =>
      db.transaction(
        async (tx) => {
          for (const bi of changedItems) {
            if (!bi.currentItemId || !bi.changeType) continue

            // Get the current item version on the ECO branch
            const currentItem = await tx
              .select()
              .from(items)
              .where(eq(items.id, bi.currentItemId))
              .limit(1)
              .then((r) => r.at(0))

            if (!currentItem) continue

            // Get lifecycle states for this item type (fallback to standard values)
            const lifecycleStates = lifecycleStateCache.get(
              currentItem.itemType,
            ) || { releaseState: 'Released', obsoleteState: 'Obsolete' }

            if (bi.changeType === 'added') {
              // New item - assign initial revision based on scheme
              const newRevision = RevisionService.getInitialRevision(
                lifecycleStates.revisionScheme,
              )

              // Create new item version with assigned revision
              const [releasedItem] = await tx
                .insert(items)
                .values({
                  ...currentItem,
                  id: undefined,
                  revision: newRevision,
                  state: lifecycleStates.releaseState,
                  isCurrent: true,
                  modifiedAt: new Date(),
                  modifiedBy: userId,
                } as typeof items.$inferInsert)
                .returning()

              // Mark old item as not current
              await tx
                .update(items)
                .set({ isCurrent: false })
                .where(eq(items.id, currentItem.id))

              // Update or create main branch branchItem
              const mainBranchItem = await tx
                .select()
                .from(branchItems)
                .where(
                  and(
                    eq(branchItems.branchId, mainBranch.id),
                    eq(branchItems.itemMasterId, bi.itemMasterId),
                  ),
                )
                .limit(1)
                .then((r) => r.at(0))

              if (mainBranchItem) {
                await tx
                  .update(branchItems)
                  .set({ currentItemId: releasedItem.id })
                  .where(eq(branchItems.id, mainBranchItem.id))
              } else {
                await tx.insert(branchItems).values({
                  branchId: mainBranch.id,
                  itemMasterId: bi.itemMasterId,
                  currentItemId: releasedItem.id,
                  baseItemId: releasedItem.id,
                  changeType: null,
                })
              }

              // Track mapping for BOM relationship updates
              // For added items, map from the draft item to the released item
              itemIdMapping.set(currentItem.id, releasedItem.id)
              masterIdToNewItemId.set(bi.itemMasterId, releasedItem.id)

              revisionsAssigned[currentItem.itemNumber] = newRevision
              itemsAdded++
              itemChanges.push({
                itemId: releasedItem.id,
                itemMasterId: bi.itemMasterId,
                changeType: 'added',
              })
            } else if (bi.changeType === 'modified') {
              // Check if currentItem is already a working copy (placeholder revision)
              // If so, release it directly instead of creating another revision
              const isWorkingCopy = currentItem.revision.startsWith('-')

              let releasedItemId: string
              let finalRevision: string

              if (isWorkingCopy) {
                // Working copy exists - transition it to Released
                // If revision is placeholder (starts with "-"), calculate next revision from main's CURRENT item
                // (not the base item, since another ECO may have released a newer revision)
                if (currentItem.revision.startsWith('-')) {
                  // Get main's current item for this master to get the latest revision
                  const mainCurrentItem = await tx
                    .select({ item: items })
                    .from(branchItems)
                    .innerJoin(items, eq(branchItems.currentItemId, items.id))
                    .where(
                      and(
                        eq(branchItems.branchId, mainBranch.id),
                        eq(branchItems.itemMasterId, bi.itemMasterId),
                      ),
                    )
                    .limit(1)
                    .then((r) => r.at(0)?.item)

                  // Calculate next revision from main's current (which may be ahead of our base)
                  finalRevision = RevisionService.getNextRevision(
                    mainCurrentItem?.revision ||
                      RevisionService.getInitialRevision(
                        lifecycleStates.revisionScheme,
                      ),
                    lifecycleStates.revisionScheme,
                  )
                } else {
                  finalRevision = currentItem.revision
                }

                // Update working copy with final revision and release state
                await tx
                  .update(items)
                  .set({
                    revision: finalRevision,
                    state: lifecycleStates.releaseState,
                    isCurrent: true,
                    modifiedAt: new Date(),
                    modifiedBy: userId,
                  })
                  .where(eq(items.id, currentItem.id))

                releasedItemId = currentItem.id
              } else {
                // No working copy - create new revision (legacy fallback)
                const newRevision = RevisionService.getNextRevision(
                  currentItem.revision,
                  lifecycleStates.revisionScheme,
                )
                const [releasedItem] = await tx
                  .insert(items)
                  .values({
                    ...currentItem,
                    id: undefined,
                    revision: newRevision,
                    state: lifecycleStates.releaseState,
                    isCurrent: true,
                    modifiedAt: new Date(),
                    modifiedBy: userId,
                  } as typeof items.$inferInsert)
                  .returning()

                releasedItemId = releasedItem.id
                finalRevision = newRevision
              }

              // Mark old current item as not current (the one on main)
              if (bi.baseItemId) {
                await tx
                  .update(items)
                  .set({ isCurrent: false })
                  .where(eq(items.id, bi.baseItemId))
              }

              // Update main branch branchItem
              const mainBranchItem = await tx
                .select()
                .from(branchItems)
                .where(
                  and(
                    eq(branchItems.branchId, mainBranch.id),
                    eq(branchItems.itemMasterId, bi.itemMasterId),
                  ),
                )
                .limit(1)
                .then((r) => r.at(0))

              if (mainBranchItem) {
                await tx
                  .update(branchItems)
                  .set({ currentItemId: releasedItemId })
                  .where(eq(branchItems.id, mainBranchItem.id))
              } else {
                await tx.insert(branchItems).values({
                  branchId: mainBranch.id,
                  itemMasterId: bi.itemMasterId,
                  currentItemId: releasedItemId,
                  baseItemId: bi.baseItemId,
                  changeType: null,
                })
              }

              // Track mapping for BOM relationship updates
              // Map from base item (old revision) to released item (new revision)
              if (bi.baseItemId) {
                itemIdMapping.set(bi.baseItemId, releasedItemId)
              }
              masterIdToNewItemId.set(bi.itemMasterId, releasedItemId)

              revisionsAssigned[currentItem.itemNumber] = finalRevision
              itemsMerged++
              itemChanges.push({
                itemId: releasedItemId,
                itemMasterId: bi.itemMasterId,
                changeType: 'modified',
                previousItemId: bi.baseItemId || undefined,
              })
            } else if (bi.changeType === 'deleted') {
              // Deleted item - mark as obsolete on main using lifecycle config
              if (bi.baseItemId) {
                await tx
                  .update(items)
                  .set({
                    state: lifecycleStates.obsoleteState,
                    isDeleted: true,
                    deletedAt: new Date(),
                    deletedBy: userId,
                  })
                  .where(eq(items.id, bi.baseItemId))

                // Remove from main branch tracking
                await tx
                  .delete(branchItems)
                  .where(
                    and(
                      eq(branchItems.branchId, mainBranch.id),
                      eq(branchItems.itemMasterId, bi.itemMasterId),
                    ),
                  )
              }

              itemsDeleted++
              itemChanges.push({
                itemId: bi.baseItemId || bi.currentItemId,
                itemMasterId: bi.itemMasterId,
                changeType: 'deleted',
              })
            }
          }

          // 5b. Copy BOM relationships for all modified/added items
          // This is done after all items are processed so we can resolve child references
          // to their new released versions when both parent and child are revised
          for (const bi of changedItems) {
            if (!bi.currentItemId || bi.changeType === 'deleted') continue

            // Get the released item ID for this item
            const releasedItemId = bi.baseItemId
              ? itemIdMapping.get(bi.baseItemId)
              : masterIdToNewItemId.get(bi.itemMasterId)

            if (!releasedItemId) continue

            // Get source of BOM relationships:
            // - For modified items: copy from baseItemId (old revision)
            // - For added items: copy from currentItemId (draft item may have relationships)
            const sourceItemId =
              bi.changeType === 'modified' ? bi.baseItemId : bi.currentItemId
            if (!sourceItemId) continue

            // Get all relationships where source item is the parent
            const parentRelationships = await tx
              .select()
              .from(itemRelationships)
              .where(eq(itemRelationships.sourceId, sourceItemId))

            // Copy each relationship, resolving child references to new revisions
            for (const rel of parentRelationships) {
              // Check if the child (target) was also revised in this ECO
              // If so, use the new released item ID instead of the old one
              let resolvedTargetId = rel.targetId

              // First check if we have a direct mapping for this target ID
              if (itemIdMapping.has(rel.targetId)) {
                resolvedTargetId = itemIdMapping.get(rel.targetId)!
              } else {
                // Check if the target item's masterId was revised
                // We need to look up the masterId of the target item
                const targetItem = await tx
                  .select({ masterId: items.masterId })
                  .from(items)
                  .where(eq(items.id, rel.targetId))
                  .limit(1)
                  .then((r) => r.at(0))

                if (
                  targetItem &&
                  masterIdToNewItemId.has(targetItem.masterId)
                ) {
                  resolvedTargetId = masterIdToNewItemId.get(
                    targetItem.masterId,
                  )!
                }
              }

              await tx
                .insert(itemRelationships)
                .values({
                  sourceId: releasedItemId,
                  targetId: resolvedTargetId,
                  relationshipType: rel.relationshipType,
                  quantity: rel.quantity,
                  findNumber: rel.findNumber,
                  referenceDesignator: rel.referenceDesignator,
                  createdBy: userId,
                })
                .onConflictDoNothing()
            }
          }
        },
        { isolationLevel: 'serializable' },
      ),
    )

    // 5c. Merge cross-design references (promote added, remove deleted)
    await CrossDesignReferenceService.mergeReferencesOnRelease(
      branch.designId,
      branchId,
    )

    // 6. Create merge commit
    const mergeCommit = await CommitService.createMergeCommit(
      {
        targetBranchId: mainBranch.id,
        sourceBranchId: branchId,
        message: `Merged ECO branch: ${branch.name}`,
        changeOrderItemId: changeOrderId,
        revisionsAssigned,
        itemChanges,
      },
      userId,
    )

    // 7. Promote files from ECO branch to main (makes them visible everywhere)
    const filesPromoted = await FileService.promoteFilesToMain(branchId)
    if (filesPromoted > 0) {
      serviceLogger.info(
        { filesPromoted },
        'Promoted files from ECO branch to main',
      )
    }

    // 7.5. Submit WI change alert job for modified/added parts
    try {
      const changedPartIds = itemChanges
        .filter((c) => c.changeType === 'modified' || c.changeType === 'added')
        .map((c) => c.itemMasterId)

      if (changedPartIds.length > 0) {
        const { JobService } = await import('@/lib/jobs')
        await JobService.submit(
          'notification.workinstruction.partchanged',
          {
            ecoId: changeOrderId,
            changedPartIds,
            userId,
          },
          userId,
        )
      }
    } catch (error) {
      // WI alert job failure should not block ECO merge
      serviceLogger.warn({ error }, 'Failed to submit WI change alert job')
    }

    // 8. Archive ECO branch
    await BranchService.archiveBranch(branchId)

    return {
      mergeCommit,
      revisionsAssigned,
      itemsMerged,
      itemsAdded,
      itemsDeleted,
    }
  }

  /**
   * Calculate next revision letter.
   * @deprecated Use RevisionService.getNextRevision() instead for scheme-aware revision logic.
   */
  static getNextRevision(
    currentRevision: string,
    scheme?: RevisionScheme,
  ): string {
    return RevisionService.getNextRevision(currentRevision, scheme)
  }

  /**
   * Auto-checkin all items on a branch.
   * Releases checkout locks — used during both ECO release (merge) and cancellation.
   */
  static async autoCheckinBranchItems(branchId: string): Promise<number> {
    const result = await db
      .update(branchItems)
      .set({
        checkedOutBy: null,
        checkedOutAt: null,
      })
      .where(eq(branchItems.branchId, branchId))
      .returning()

    return result.length
  }

  /**
   * Validate merge is possible (no conflicts)
   */
  static async validateMerge(branchId: string): Promise<MergeValidation> {
    const branch = await BranchService.getById(branchId)
    if (!branch) {
      return {
        canMerge: false,
        conflicts: [
          {
            itemId: '',
            itemNumber: '',
            reason: 'Branch not found',
            conflictType: 'branch_not_found',
          },
        ],
        warnings: [],
      }
    }

    const conflicts: Array<MergeConflict> = []
    const warnings: Array<string> = []

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

    if (checkedOutItems.length > 0) {
      for (const { branchItem, item } of checkedOutItems) {
        conflicts.push({
          itemId: branchItem.itemMasterId,
          itemNumber: item?.itemNumber || 'Unknown',
          reason: 'Item is still checked out',
          conflictType: 'checkout',
        })
      }
    }

    // Check if branch is locked (should be locked for merge)
    if (!branch.isLocked) {
      warnings.push('Branch is not locked - consider locking before merge')
    }

    // Check for changes
    const changedItems = await db
      .select({
        branchItem: branchItems,
        item: items,
      })
      .from(branchItems)
      .leftJoin(items, eq(branchItems.currentItemId, items.id))
      .where(
        and(
          eq(branchItems.branchId, branchId),
          isNotNull(branchItems.changeType),
        ),
      )

    if (changedItems.length === 0) {
      conflicts.push({
        itemId: '',
        itemNumber: '',
        reason: 'No changes to merge',
        conflictType: 'no_changes',
      })
    }

    // Check for concurrent modifications on main
    // If an item's base (what was on main when we branched) differs from main's current item,
    // someone else modified it while we were working on the ECO branch
    const mainBranch = await BranchService.getMainBranch(branch.designId)
    if (mainBranch) {
      for (const { branchItem, item } of changedItems) {
        // Only check items that have a baseItemId (modified items, not newly added)
        if (!branchItem.baseItemId) continue

        // Get the current item on main for this item master
        const mainBranchItem = await db
          .select()
          .from(branchItems)
          .where(
            and(
              eq(branchItems.branchId, mainBranch.id),
              eq(branchItems.itemMasterId, branchItem.itemMasterId),
            ),
          )
          .limit(1)
          .then((r) => r.at(0))

        // If main's currentItemId is different from our baseItemId, check for real conflicts
        if (
          mainBranchItem &&
          mainBranchItem.currentItemId !== branchItem.baseItemId
        ) {
          // Get the main item and base item for comparison
          const [mainItem, baseItem] = await Promise.all([
            db
              .select()
              .from(items)
              .where(eq(items.id, mainBranchItem.currentItemId!))
              .limit(1)
              .then((r) => r.at(0)),
            db
              .select()
              .from(items)
              .where(eq(items.id, branchItem.baseItemId))
              .limit(1)
              .then((r) => r.at(0)),
          ])

          // Check if main actually has meaningful changes (not just revision)
          // Fields to ignore when checking for real changes
          const ignoreFields = [
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
          ]

          let hasMeaningfulChanges = false
          if (baseItem && mainItem) {
            for (const key of Object.keys(mainItem)) {
              if (ignoreFields.includes(key)) continue
              const baseVal = (baseItem as Record<string, unknown>)[key]
              const mainVal = (mainItem as Record<string, unknown>)[key]
              if (JSON.stringify(baseVal) !== JSON.stringify(mainVal)) {
                hasMeaningfulChanges = true
                break
              }
            }
          }

          // Only flag as conflict if there are meaningful field changes on main
          if (hasMeaningfulChanges) {
            conflicts.push({
              itemId: branchItem.itemMasterId,
              itemNumber: item?.itemNumber || 'Unknown',
              reason: `Item was modified on main since branch creation (main has ${mainItem?.revision || 'unknown'}, branch based on ${baseItem?.revision || 'unknown'})`,
              mainVersion: mainBranchItem.currentItemId || undefined,
              branchBase: branchItem.baseItemId,
              conflictType: 'concurrent_modification',
            })
          }
        }
      }
    }

    return {
      canMerge: conflicts.length === 0,
      conflicts,
      warnings,
    }
  }

  /**
   * Preview what will be merged/released
   */
  static async previewMerge(changeOrderId: string): Promise<ReleasePreview> {
    const changeOrder = await ItemService.findById(changeOrderId)
    if (!changeOrder) {
      throw new NotFoundError('Change order', changeOrderId)
    }

    const ecoDesigns = await ChangeOrderService.getEcoDesigns(changeOrderId)
    const designs: ReleasePreview['designs'] = []
    let totalItems = 0
    const validationIssues: Array<string> = []
    const allConflicts: Array<MergeConflict> = []

    for (const ecoDesign of ecoDesigns) {
      if (!ecoDesign.branchId) {
        continue
      }

      const design = await DesignService.getById(ecoDesign.designId)

      // Get changed items on this branch
      const changedItems = await db
        .select({
          branchItem: branchItems,
          item: items,
        })
        .from(branchItems)
        .leftJoin(items, eq(branchItems.currentItemId, items.id))
        .where(
          and(
            eq(branchItems.branchId, ecoDesign.branchId),
            isNotNull(branchItems.changeType),
          ),
        )

      const previewItems: Array<ReleasePreviewItem> = []

      for (const { branchItem, item } of changedItems) {
        if (!item) continue

        const previewScheme = await LifecycleService.getRevisionScheme(
          item.itemType,
        )
        let newRevision: string
        if (branchItem.changeType === 'added') {
          newRevision = RevisionService.getInitialRevision(previewScheme)
        } else if (branchItem.changeType === 'modified') {
          newRevision = RevisionService.getNextRevision(
            item.revision,
            previewScheme,
          )
        } else {
          newRevision = item.revision // deleted items keep their revision
        }

        previewItems.push({
          itemId: item.id,
          itemNumber: item.itemNumber,
          currentRevision: item.revision,
          newRevision,
          changeType: branchItem.changeType as 'added' | 'modified' | 'deleted',
        })
      }

      // Validate this branch (includes conflict detection)
      const validation = await this.validateMerge(ecoDesign.branchId)

      // Collect conflicts for this design
      const designConflicts = validation.conflicts.map((c) => ({
        ...c,
        // Add design context to conflict reason if not already there
        reason: c.reason.includes(design?.name || '')
          ? c.reason
          : `${design?.name || 'Design'}: ${c.reason}`,
      }))
      allConflicts.push(...designConflicts)

      if (!validation.canMerge) {
        validationIssues.push(
          ...validation.conflicts.map(
            (c) => `${design?.name || 'Design'}: ${c.reason}`,
          ),
        )
      }
      validationIssues.push(
        ...validation.warnings.map((w) => `${design?.name || 'Design'}: ${w}`),
      )

      designs.push({
        designId: ecoDesign.designId,
        designName: design?.name || 'Unknown',
        items: previewItems,
        conflicts: validation.conflicts,
      })

      totalItems += previewItems.length
    }

    // Can release if: ECO is approved AND no blocking conflicts (warnings are ok)
    const blockingConflicts = allConflicts.filter(
      (c) => c.conflictType !== 'no_changes',
    )
    const canRelease =
      changeOrder.state === 'Approved' && blockingConflicts.length === 0

    return {
      designs,
      totalItems,
      canRelease,
      validationIssues,
      allConflicts,
    }
  }
}
