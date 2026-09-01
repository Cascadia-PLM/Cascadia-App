// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, desc, eq, inArray, isNotNull, ne } from 'drizzle-orm'
import { db } from '../db'
import { withSerializableRetry } from '../db/retry'
import {
  branchItems,
  changeOrderDesigns,
  itemRelationships,
  items,
  software,
  workflowInstances,
} from '../db/schema'
import {
  InternalError,
  MergeConflictError,
  NotFoundError,
  ValidationError,
} from '../errors'
import { getTypeHandler } from '../items/type-handlers'
import { copyTypeSpecificData } from '../items/type-handlers/copy'
import '../items/type-handlers/init'
import { ItemService } from '../items/services/ItemService'
import { ChangeOrderService } from '../items/services/ChangeOrderService'
import { FileService } from '../vault/services/FileService'
import { changeActionSchema } from '../items/types/change-order'
import { BranchService } from './BranchService'
import { CommitService } from './CommitService'
import { CrossDesignReferenceService } from './CrossDesignReferenceService'
import { DesignService } from './DesignService'
import { LifecycleService } from './LifecycleService'
import { MbomService } from './MbomService'
import { ReleaseHookRegistry } from './release-hooks'
import { RevisionService } from './RevisionService'
import { bomStructureOf } from './item-structure'
import type { TransactionClient } from '../db'
import type { ResolvedActionStates } from './LifecycleService'
import type { RevisionScheme } from '../types/lifecycle'
import type { UpstreamChangeItem, commits } from '../db/schema'
import type { ChangeAction, ChangeOrder } from '../items/types/change-order'
import { serviceLogger } from '@/lib/logging/logger'
import { takeFirst } from '@/lib/db/take-first'

// ============================================
// Types
// ============================================

export interface MergeResult {
  mergeCommit: typeof commits.$inferSelect
  revisionsAssigned: Record<string, string> // itemNumber -> newRevision
  itemsMerged: number
  itemsAdded: number
  itemsDeleted: number
  /** What this merge changed, as notified to MBOMs derived from the design. */
  changedItems: Array<UpstreamChangeItem>
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
    'checkout' | 'concurrent_modification' | 'no_changes' | 'branch_not_found'
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
  /**
   * The release already ran: the change order's workflow finished in a
   * releasing final state, or one of its designs is recorded merged. Whatever
   * is still to merge — nothing, unless a release failed part way through —
   * is in `designs` as usual, so a closed change order previews empty rather
   * than predicting its own release a second time.
   */
  alreadyReleased: boolean
}

/**
 * Whether a stored `change_action` is one this build still acts on.
 *
 * `add` and `remove` were retired: they never did anything at merge, and BOM
 * membership is a branch edit that the merge releases with the branch. Rows
 * written before that stay in the database, so every release loop skips what it
 * does not recognise rather than throwing — they were inert then and stay inert
 * now, which is the same outcome without a failed release.
 */
function isKnownChangeAction(action: string): action is ChangeAction {
  return changeActionSchema.safeParse(action).success
}

/** A change order's association with one design, as `getEcoDesigns` returns it. */
type EcoDesignRecord = Awaited<
  ReturnType<typeof ChangeOrderService.getEcoDesigns>
>[number]

/** One item a release recorded, for the design's release commit. */
interface ReleasedItem {
  itemId: string
  itemNumber: string | undefined
  changeType: 'added' | 'modified' | 'deleted'
  newRevision?: string
}

interface ReleasedItemsForDesign {
  items: Array<ReleasedItem>
  designName?: string
}

// ============================================
// ChangeOrderMergeService
// ============================================

/**
 * Narrow a nullable action-target state at a site that already validated the
 * action via `canApplyAction`. A null here means the lifecycle stopped
 * defining the action between intake and merge — surface that as the
 * validation failure it is rather than writing a null state.
 */
function requireActionState(
  value: string | null,
  itemType: string,
  action: string,
): string {
  if (value === null) {
    throw new ValidationError(
      `The ${itemType} lifecycle no longer defines a "${action}" action; remove the affected item or restore the mapping`,
    )
  }
  return value
}

/**
 * Service for change order merge/release workflow.
 * Handles merging ECO branches to main with revision letter assignment.
 * Works with all change order types (ECO, ECN, Deviation, MCO).
 */
export class ChangeOrderMergeService {
  /**
   * WI-4.4: verify the change order's Driving lifecycle is an authorized
   * driver of every Driven lifecycle its state-changing affected items
   * belong to. `drivers` is an allow-list on the Driven side; an empty
   * list is permissive. Without a workflow instance no Driving lifecycle
   * is acting, so there is nothing to gate.
   */
  private static async assertDriverAuthorized(
    changeOrderId: string,
  ): Promise<void> {
    const instance = (
      await db
        .select({
          workflowDefinitionId: workflowInstances.workflowDefinitionId,
        })
        .from(workflowInstances)
        .where(eq(workflowInstances.itemId, changeOrderId))
        .orderBy(desc(workflowInstances.startedAt))
        .limit(1)
    )[0]
    const drivingLifecycleId = instance?.workflowDefinitionId
    if (!drivingLifecycleId) return

    const affectedItems =
      await ChangeOrderService.getAffectedItems(changeOrderId)

    // One read for every affected item rather than one per iteration. Kept in
    // the affected-items order so the item named in the error below is still
    // the first offending one.
    const affectedItemIds = affectedItems
      .map((a) => a.affectedItemId)
      .filter((id): id is string => Boolean(id))
    if (affectedItemIds.length === 0) return

    const itemsById = new Map(
      (
        await db
          .select({
            id: items.id,
            itemType: items.itemType,
            itemNumber: items.itemNumber,
          })
          .from(items)
          .where(inArray(items.id, affectedItemIds))
      ).map((row) => [row.id, row]),
    )

    const checkedTypes = new Set<string>()
    for (const affected of affectedItems) {
      if (!affected.affectedItemId) continue

      const item = itemsById.get(affected.affectedItemId)
      if (!item || checkedTypes.has(item.itemType)) continue
      checkedTypes.add(item.itemType)

      const lifecycle = await LifecycleService.getLifecycleForItemType(
        item.itemType,
      )
      if (!lifecycle) continue

      const allowed = await LifecycleService.canDriverActOnLifecycle(
        drivingLifecycleId,
        lifecycle.id,
      )
      if (!allowed) {
        throw new ValidationError(
          `Cannot release ${item.itemNumber}: this change order's workflow is not an authorized driver of the ${item.itemType} lifecycle ("${lifecycle.name}")`,
        )
      }
    }
  }

  /**
   * Refuse to release branch content that the change order does not list.
   *
   * The merge releases branch content (`branch_items.changeType`), while
   * reviewers approve the affected-items list. Nothing structurally tied the
   * two, so an item edited directly on an ECO branch - the item checkout
   * routes and the checkout dialog reach it without going through the change
   * order at all - would be revised and released without ever appearing in
   * the reviewed scope.
   *
   * Checkout now registers affected items as it goes, so this is the backstop
   * for content that predates that or arrived some other way. It is
   * deliberately one-directional: affected items with no branch content are
   * normal (obsolete, promote and release change state without branch
   * content), but branch content with no affected item is not.
   */
  private static async assertScopeMatchesBranchContent(
    changeOrderId: string,
  ): Promise<void> {
    const unlisted = await this.findUnlistedBranchContent(changeOrderId)
    if (unlisted.length === 0) return

    throw new ValidationError(
      `Cannot release: ${this.describeUnlistedBranchContent(unlisted)} ` +
        'Releasing would apply changes that were never reviewed. Add them to ' +
        'the change order, or discard the branch changes.',
      undefined,
      { operation: 'merge', resource: 'ChangeOrder' },
    )
  }

  /**
   * Branch content this change order does not list as an affected item.
   *
   * Shared by the release-time assertion above and the release preview, so
   * the panel a reviewer reads before approving reports exactly what the
   * merge will refuse. Discovering this only at release meant an ECO had
   * already been through review before anyone learned its scope was short.
   */
  private static async findUnlistedBranchContent(
    changeOrderId: string,
  ): Promise<Array<{ itemMasterId: string; identifier: string }>> {
    const ecoDesigns = await ChangeOrderService.getEcoDesigns(changeOrderId)
    const branchIds = ecoDesigns
      .map((d) => d.branchId)
      .filter((id): id is string => id !== null)
    if (branchIds.length === 0) return []

    const changedOnBranches = await db
      .select({
        itemMasterId: branchItems.itemMasterId,
        currentItemId: branchItems.currentItemId,
      })
      .from(branchItems)
      .where(
        and(
          inArray(branchItems.branchId, branchIds),
          isNotNull(branchItems.changeType),
        ),
      )
    if (changedOnBranches.length === 0) return []

    const affectedItems =
      await ChangeOrderService.getAffectedItems(changeOrderId)
    const listedMasterIds = new Set(
      affectedItems
        .map((a) => a.affectedItemMasterId)
        .filter((id): id is string => Boolean(id)),
    )

    const unlisted = changedOnBranches.filter(
      (c) => !listedMasterIds.has(c.itemMasterId),
    )
    if (unlisted.length === 0) return []

    // One read for the lot rather than one each.
    const itemIds = unlisted
      .map((row) => row.currentItemId)
      .filter((id): id is string => Boolean(id))
    const numbersById = new Map(
      itemIds.length > 0
        ? (
            await db
              .select({ id: items.id, itemNumber: items.itemNumber })
              .from(items)
              .where(inArray(items.id, itemIds))
          ).map((row) => [row.id, row.itemNumber])
        : [],
    )

    return unlisted.map((row) => ({
      itemMasterId: row.itemMasterId,
      identifier:
        (row.currentItemId ? numbersById.get(row.currentItemId) : null) ||
        row.itemMasterId,
    }))
  }

  /** One sentence naming at most ten of them, for an error or a preview. */
  private static describeUnlistedBranchContent(
    unlisted: Array<{ identifier: string }>,
  ): string {
    const named = unlisted.slice(0, 10)
    return (
      `${unlisted.length} item(s) changed on this change order's branches ` +
      `are not in its affected items list ` +
      `(${named.map((u) => u.identifier).join(', ')}` +
      `${unlisted.length > named.length ? ', …' : ''}).`
    )
  }

  /**
   * What a `promote` does to an item: the state it enters and the revision it
   * carries there, honouring the promote mapping's reset override, the target
   * phase's `resetRevisionOnEntry`, and that phase's revision scheme.
   *
   * Delegates to `LifecycleService.resolveActionTarget`, which is the single
   * authority — the same one the intake dialogs and the affected-items list
   * now predict from, so what a user is shown before approving is what the
   * merge does.
   */
  private static async resolvePromote(item: {
    itemType: string
    revision: string
  }): Promise<{
    toState: string
    revision: string
    assignedRevision: boolean
  } | null> {
    const target = await LifecycleService.resolveActionTarget(
      item.itemType,
      'promote',
      item.revision,
    )
    if (!target) return null

    return {
      toState: target.toState,
      revision: target.revision,
      assignedRevision: target.assignsRevision,
    }
  }

  /**
   * The released revision a `modified` branch item is based on, and the one
   * releasing it will assign.
   *
   * The merge and `previewMerge` both have to answer this and answered it
   * separately, so the preview was free to be wrong — and was. It bumped
   * whatever revision the branch row happened to carry, which for a
   * checked-out working copy is the branch placeholder (`-d370051d`): the
   * preview promised "A" for an item main already held at A and the release
   * then took to B. Main's current revision is the only correct base, because
   * another change order may have released a newer one since this branch was
   * cut.
   *
   * `baseRevision` is null when the master has no released row on main at
   * all — the caller decides what to show for "current"; `newRevision` still
   * mirrors what the merge would mint.
   */
  private static async resolveModifiedRevision(
    itemMasterId: string,
    branchRevision: string,
    mainBranchId: string,
    scheme: RevisionScheme | undefined,
    tx?: TransactionClient,
  ): Promise<{ baseRevision: string | null; newRevision: string }> {
    // Not a working copy: the legacy path releases the branch row itself, so
    // its own revision is what gets bumped.
    if (!RevisionService.isWorkingRevision(branchRevision)) {
      return {
        baseRevision: branchRevision,
        newRevision: RevisionService.getNextRevision(branchRevision, scheme),
      }
    }

    const run = tx ?? db
    const mainCurrentItem = await run
      .select({ item: items })
      .from(branchItems)
      .innerJoin(items, eq(branchItems.currentItemId, items.id))
      .where(
        and(
          eq(branchItems.branchId, mainBranchId),
          eq(branchItems.itemMasterId, itemMasterId),
        ),
      )
      .limit(1)
      .then((r) => r.at(0)?.item)

    const mainRevision = mainCurrentItem?.revision
    if (!mainRevision) {
      return {
        baseRevision: null,
        newRevision: RevisionService.getNextRevision(
          RevisionService.getInitialRevision(scheme),
          scheme,
        ),
      }
    }

    return {
      baseRevision: mainRevision,
      newRevision: RevisionService.getNextRevision(mainRevision, scheme),
    }
  }

  /**
   * The revision a `revise` bumps from when there is no branch content to
   * release — the counterpart to `resolveModifiedRevision` above.
   *
   * `change_order_affected_items.affected_item_id` pins the item *row* that
   * was current when the item was added to the change order, which can be
   * months old: another change order may have released the master since. The
   * three passes that act on affected items rather than branch content
   * (`applyAffectedItems`, `applyRemainingActions`, and the affected-items arm
   * of `previewMerge`) each bumped that pinned revision, so an ECO listing a
   * master pinned at A while main had reached B minted B a second time and hit
   * the `(itemNumber, revision, designId, itemType)` unique constraint. Pinned
   * further behind it minted a letter *below* main's current one, which
   * collides only where the letters in between still exist — and where they do
   * not, `ItemService.revise` made that lower letter current, walking the
   * master's revision backwards.
   *
   * These passes are also what makes the stale pin reachable: only the branch
   * merge and the branchless working-copy arm call `supersedePriorVersions`,
   * so a `revise` released through `ItemService.revise` leaves the row it
   * replaced in its old state. A prior revision still sitting in the released
   * state passes `canApplyAction`, and a second change order that pinned it
   * releases it again.
   *
   * `isCurrent` is what marks the released version of a master: every writer
   * maintains it (`supersedePriorVersions`, `ItemService.revise`, the branch
   * merge), a working copy is created with it false and only takes it at
   * release, and this pass's own "ensure it's tracked on the main branch" step
   * copies it *into* `branch_items` — so main's tracking row is derived from
   * this, never the other way round.
   *
   * That is why this asks the row and `resolveModifiedRevision` asks main's
   * `branch_items`: the branch path holds a branch row and needs main's
   * counterpart to compare it against, while these passes hold no branch row
   * and want only "the current version of this master". Asking directly is
   * also the fresher answer — an item that has never been through a release
   * has no main `branch_items` row at all. The two never answer for the same
   * master anyway: `applyRemainingActions` skips what the branch merge
   * handled, and the preview dedupes on `seenMasterIds`.
   *
   * Unlike `resolveModifiedRevision` there is no working-copy short-circuit:
   * that arm exists because a non-working branch row *is* the row being
   * released, and these passes have no branch row at all.
   *
   * Call it before anything that clears `isCurrent` for the master —
   * `supersedePriorVersions`, `ItemService.revise` — or it reads the state
   * this release is in the middle of writing. The pinned row is the last
   * resort, and is what all three sites used unconditionally before.
   */
  private static async resolveAffectedRevision(
    item: { masterId: string; revision: string },
    scheme: RevisionScheme | undefined,
    tx?: TransactionClient,
  ): Promise<{ baseRevision: string; newRevision: string }> {
    const currentRevision = await (tx ?? db)
      .select({ revision: items.revision })
      .from(items)
      .where(and(eq(items.masterId, item.masterId), eq(items.isCurrent, true)))
      .limit(1)
      .then((r) => r.at(0)?.revision)

    const baseRevision = currentRevision ?? item.revision
    return {
      baseRevision,
      newRevision: RevisionService.getNextRevision(baseRevision, scheme),
    }
  }

  /**
   * Retire the versions of a master that are currently in service, keeping one.
   *
   * Scoped to `isCurrent = true` rather than every row of the master. An
   * unscoped update rewrote historical Obsolete revisions back to Superseded,
   * and overwrote parallel ECOs' in-flight working copies — those are
   * `isCurrent = false` and must not be touched while they are still being
   * edited. It also has to cover whatever is current rather than just the
   * version a branch forked from: when another ECO released in between,
   * clearing only the fork point left two `isCurrent` rows for one master, and
   * every `isCurrent = true … limit(1)` reader then picked arbitrarily between
   * two released revisions.
   *
   * When the lifecycle names no superseded state the prior version keeps its
   * own state and merely stops being current. The branchless path used to force
   * the literal 'Superseded' here while the branch path did not, so the two
   * disagreed for any lifecycle that does not name one.
   */
  private static async supersedePriorVersions(
    itemMasterId: string,
    keepItemId: string,
    supersededState: string | null,
    tx: TransactionClient,
  ): Promise<void> {
    await tx
      .update(items)
      .set({
        isCurrent: false,
        ...(supersededState ? { state: supersededState } : {}),
      })
      .where(
        and(
          eq(items.masterId, itemMasterId),
          eq(items.isCurrent, true),
          ne(items.id, keepItemId),
        ),
      )
  }

  /**
   * Phase 1 — release each ECO branch's content to main.
   *
   * Returns how many branches actually merged, which decides what the later
   * phases still have to do. A branch with no changes is marked skipped rather
   * than failing the release, and one already merged by an earlier attempt is
   * counted without being merged again: the release is retryable by design, and
   * without that guard a retry after a later design failed re-merged the
   * earlier one and bumped its revisions a second time.
   */
  private static async mergeBranches(
    changeOrderId: string,
    userId: string,
    designsWithBranches: Array<EcoDesignRecord>,
    results: ChangeOrderMergeResult,
  ): Promise<number> {
    let branchesMerged = 0
    for (const ecoDesign of designsWithBranches) {
      if (!ecoDesign.branchId) continue

      // Already merged on an earlier attempt. The release is retryable by
      // design (a failure leaves the change order pre-final), and this loop
      // is not one transaction — so without this guard a retry after design B
      // failed re-merged design A and bumped its revisions a second time.
      if (ecoDesign.mergeStatus === 'merged') {
        serviceLogger.info(
          { changeOrderId, designId: ecoDesign.designId },
          'Skipping design already merged by an earlier release attempt',
        )
        branchesMerged++
        continue
      }

      // Auto-checkin all items on this branch before merge
      // This releases checkout locks since the ECO is being released
      await this.autoCheckinBranchItems(ecoDesign.branchId)

      // Validate merge before proceeding
      const validation = await this.validateMerge(ecoDesign.branchId)

      // Check if this is a "no changes" situation vs a real conflict.
      // Keyed on conflictType rather than the reason text, which is a
      // user-facing message and not a discriminator.
      const noChangesConflict = validation.conflicts.some(
        (c) => c.conflictType === 'no_changes',
      )
      const realConflicts = validation.conflicts.filter(
        (c) => c.conflictType !== 'no_changes',
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

      // mergeStatus is set inside mergeBranchToMain's transaction, so it
      // commits with the release it records

      results.designs.push({
        designId: ecoDesign.designId,
        designName: design?.name || 'Unknown',
        mergeResult,
      })

      // Tell any Manufacturing designs derived from this design that their
      // source moved. This is the only point that knows an engineering
      // change actually released, so it is where the notification belongs;
      // MBOM owners then accept or defer each change on their own schedule.
      if (mergeResult.changedItems.length > 0) {
        try {
          const notified = await MbomService.notifyDerivedMboms(
            ecoDesign.designId,
            mergeResult.mergeCommit.id,
            changeOrderId,
            mergeResult.changedItems,
          )
          if (notified > 0) {
            serviceLogger.info(
              { designId: ecoDesign.designId, notified, changeOrderId },
              'Notified derived MBOMs of upstream change',
            )
          }
        } catch (error) {
          // A derived-MBOM notification must never block the release it
          // describes — the change is already merged and valid.
          serviceLogger.warn(
            { err: error, designId: ecoDesign.designId, changeOrderId },
            'Failed to notify derived MBOMs of upstream change',
          )
        }
      }

      results.totalRevisionsAssigned += Object.keys(
        mergeResult.revisionsAssigned,
      ).length
      branchesMerged++
    }
    return branchesMerged
  }

  /**
   * Phase 2 — release the affected items directly, with no branch involved.
   *
   * Runs only when no branch merged: either the change order never had one, or
   * every branch it had turned out to hold no changes. Both cases leave the
   * affected-items list as the only record of what the change order does.
   */
  private static async applyAffectedItems(
    changeOrderId: string,
    userId: string,
    changeOrderNumber: string,
    ecoDesigns: Array<EcoDesignRecord>,
    results: ChangeOrderMergeResult,
  ): Promise<void> {
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
    // ECO release is the one writer allowed to set lifecycle-controlled
    // fields (state/revision/isCurrent) through ItemService.update
    //
    // It also skips the per-item design-access check: authorization for a
    // release is decided once, on the ECO, and a legitimate releaser may reach
    // only a subset of a multi-design ECO's designs (resolveEcoDesignScope),
    // so re-asking per item would fail releases that are entirely valid.
    const bypassOptions = {
      bypassBranchProtection: true,
      allowLifecycleFields: true,
      skipAccessCheck: true,
    }

    // Genuinely atomic: every nested service call below takes `tx` and runs
    // inside it, so a failure part-way rolls the whole pass back rather than
    // leaving the earlier items released. (It previously opened this
    // transaction and then called services on the global `db` handle, which
    // start their own — the outer transaction covered only the statements
    // written directly against `tx`.)
    //
    // SERIALIZABLE with the same retry as the branch merge, and for the same
    // reason. Every action below is a check-then-act — read the item's state
    // and revision, decide from them, write both back — and at READ COMMITTED
    // two change orders listing the same master each read the pre-release row
    // and each act on it: the same revision letter minted twice, or a
    // transition stamped onto a version the other has already superseded. A
    // change order cannot race *itself* — the workflow claim CAS serializes
    // repeat transitions of one instance — so the exposure is distinct change
    // orders sharing a master, exactly what the branch path was hardened
    // against, on items indistinguishable from the outside.
    const assignedRevisions = await withSerializableRetry(
      () => {
        // Every accumulator lives inside this closure, declared fresh per
        // attempt, exactly as the branch merge declares its own. A 40001
        // rolls the transaction back and re-runs the closure — a counter or
        // a released-items map declared outside it would carry the aborted
        // attempt's entries into the retry, reporting a revision assigned
        // once as assigned twice and naming rolled-back item ids in the
        // release commit.
        let assignedThisAttempt = 0

        // Track released items by design for creating release commits
        const releasedItemsByDesign = new Map<string, ReleasedItemsForDesign>()

        /**
         * Record an item this pass released, for its design's release commit.
         * Written six times inline before this, once per action branch, which
         * is how one of them came to test `item.designId && item.id` and the
         * next only `item.designId`.
         */
        const trackReleased = (
          designId: string | null | undefined,
          entry: ReleasedItem,
        ): void => {
          if (!designId) return
          const existing = releasedItemsByDesign.get(designId) ?? { items: [] }
          existing.items.push(entry)
          releasedItemsByDesign.set(designId, existing)
        }

        return db.transaction(
          async (tx) => {
            for (const affected of affectedItems) {
              if (!affected.affectedItemId) continue

              const item = await ItemService.findById(
                affected.affectedItemId,
                tx,
              )
              if (!item) continue

              const action = affected.changeAction
              if (!isKnownChangeAction(action)) {
                serviceLogger.warn(
                  { changeOrderId, action },
                  'Skipping affected item with a change action this build no longer knows',
                )
                continue
              }

              // For release/revise/obsolete actions, check if item is already in target state
              // This makes the release operation idempotent (safe to call multiple times)
              // NOTE: Even when skipping the state transition, we still need to create branchItems
              // (lifecycle effects from workflow transitions may have already updated the state)
              // The same five values the branch path resolves, from the same place,
              // so both paths release into identical states
              const states = await LifecycleService.resolveActionStates(
                item.itemType,
              )

              let skippedStateChange = false
              if (action === 'release') {
                if (item.state === states.releaseState) {
                  // Item already in target state (lifecycle effects set it during workflow transition)
                  // Still need to assign revision since lifecycle effects only set state, not revision
                  skippedStateChange = true

                  const needsRevision = RevisionService.isWorkingRevision(
                    item.revision,
                  )
                  const finalRevision = needsRevision
                    ? RevisionService.getInitialRevision(states.revisionScheme)
                    : item.revision

                  if (needsRevision) {
                    await ItemService.update(
                      affected.affectedItemId,
                      { revision: finalRevision },
                      userId,
                      {
                        bypassBranchProtection: true,
                        allowLifecycleFields: true,
                        skipAccessCheck: true,
                        tx,
                      },
                    )
                    assignedThisAttempt++
                  }

                  // Tracked even though the state was already set
                  trackReleased(item.designId, {
                    itemId: item.id,
                    itemNumber: item.itemNumber,
                    changeType: 'added',
                    newRevision: finalRevision,
                  })
                }
              }

              if (!skippedStateChange) {
                const validation = await LifecycleService.canApplyAction(
                  item.itemType,
                  item.state,
                  action,
                )
                if (!validation.valid) {
                  throw new ValidationError(
                    `Cannot apply "${action}" to ${item.itemNumber}: ${validation.error}`,
                  )
                }

                switch (action) {
                  case 'release': {
                    const targetState = requireActionState(
                      states.releaseState,
                      item.itemType,
                      'release',
                    )
                    const releaseScheme = states.revisionScheme
                    // Assign initial revision if item has no real revision yet
                    const needsRevision = RevisionService.isWorkingRevision(
                      item.revision,
                    )
                    const finalRevision = needsRevision
                      ? RevisionService.getInitialRevision(releaseScheme)
                      : item.revision

                    const updates: Record<string, unknown> = {}
                    if (item.state !== targetState) {
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
                        { ...bypassOptions, tx },
                      )
                      assignedThisAttempt++

                      trackReleased(item.designId, {
                        itemId: item.id,
                        itemNumber: item.itemNumber,
                        changeType: 'added',
                        newRevision: finalRevision,
                      })
                    }
                    break
                  }

                  case 'revise': {
                    const newVersionState = requireActionState(
                      states.reviseState,
                      item.itemType,
                      'revise',
                    )
                    const oldVersionState = states.supersededState

                    // Check for existing working copy (created when affected item was added)
                    let workingCopy: typeof items.$inferSelect | null = null

                    // First, check if workingCopyId was stored on the affected item record
                    if ((affected as any).workingCopyId) {
                      const found = await ItemService.findById(
                        (affected as any).workingCopyId,
                        tx,
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
                      // Calculate final revision - if placeholder (starts with
                      // "-"), the letter comes from main's current revision,
                      // not from `item`, which is the row pinned when this
                      // item was added to the change order.
                      //
                      // Resolved before `supersedePriorVersions` below, which
                      // clears `isCurrent` across the master - one of the
                      // bases `resolveAffectedRevision` reads.
                      const reviseScheme = states.revisionScheme
                      let finalRevision = workingCopy.revision
                      if (
                        RevisionService.isWorkingRevision(workingCopy.revision)
                      ) {
                        finalRevision = (
                          await this.resolveAffectedRevision(
                            item,
                            reviseScheme,
                            tx,
                          )
                        ).newRevision
                      }

                      // Working copy exists - transition it to new version state
                      await this.supersedePriorVersions(
                        item.masterId,
                        workingCopy.id,
                        oldVersionState,
                        tx,
                      )

                      // Now transition working copy with final revision and mark as current
                      await ItemService.update(
                        workingCopy.id,
                        {
                          revision: finalRevision,
                          state: newVersionState,
                          isCurrent: true,
                        },
                        userId,
                        { ...bypassOptions, tx },
                      )

                      assignedThisAttempt++

                      trackReleased(item.designId, {
                        itemId: workingCopy.id,
                        itemNumber: workingCopy.itemNumber,
                        changeType: 'modified',
                        newRevision: finalRevision,
                      })
                    } else {
                      // No working copy - fallback to old behavior (create revision at release time).
                      // Always computed here, never read from
                      // `affected.targetRevision`: that column is a prediction
                      // made when the item was added, and preferring it meant a
                      // stale (or, while the dialogs guessed client-side, an
                      // outright invalid) value became the released revision.
                      // `item.revision` is a prediction of the same vintage -
                      // the base comes from main's current revision instead.
                      const { newRevision: targetRevision } =
                        await this.resolveAffectedRevision(
                          item,
                          states.revisionScheme,
                          tx,
                        )
                      const newRev = await ItemService.revise(
                        affected.affectedItemId,
                        targetRevision,
                        userId,
                        tx,
                      )
                      if (newRev.id) {
                        await ItemService.update(
                          newRev.id,
                          { state: newVersionState },
                          userId,
                          { ...bypassOptions, tx },
                        )

                        trackReleased(item.designId, {
                          itemId: newRev.id,
                          itemNumber: newRev.itemNumber,
                          changeType: 'modified',
                          newRevision: targetRevision,
                        })
                      }
                      assignedThisAttempt++
                    }
                    break
                  }

                  case 'obsolete': {
                    await ItemService.update(
                      affected.affectedItemId,
                      {
                        state: requireActionState(
                          states.obsoleteState,
                          item.itemType,
                          'obsolete',
                        ),
                      },
                      userId,
                      { ...bypassOptions, tx },
                    )

                    trackReleased(item.designId, {
                      itemId: item.id,
                      itemNumber: item.itemNumber,
                      changeType: 'deleted',
                      newRevision: item.revision,
                    })
                    break
                  }

                  case 'promote': {
                    const promotion = await this.resolvePromote(item)

                    if (promotion) {
                      const promoteUpdates: Record<string, unknown> = {
                        state: promotion.toState,
                      }
                      if (promotion.revision !== item.revision) {
                        promoteUpdates.revision = promotion.revision
                      }

                      await ItemService.update(
                        affected.affectedItemId,
                        promoteUpdates,
                        userId,
                        { ...bypassOptions, tx },
                      )

                      if (promotion.assignedRevision) {
                        assignedThisAttempt++
                      }

                      trackReleased(item.designId, {
                        itemId: item.id,
                        itemNumber: item.itemNumber,
                        changeType: 'modified',
                        newRevision: promotion.revision,
                      })
                    }
                    break
                  }
                }
              } // end if (!skippedStateChange)

              // After processing each affected item, ensure it's tracked on the main branch
              // This is critical for the Design Structure view to work correctly
              if (item.designId && item.masterId) {
                const mainBranch = await BranchService.getMainBranch(
                  item.designId,
                )
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
                  message: `Released via ECO: ${changeOrderNumber}`,
                  changeOrderItemId: changeOrderId,
                  revisionsAssigned,
                  itemChanges: designData.items.map((item) => ({
                    itemId: item.itemId,
                    changeType: item.changeType,
                  })),
                },
                userId,
                tx,
              )
            }

            // Archive any ECO branches associated with this change order
            for (const ecoDesign of ecoDesigns) {
              if (ecoDesign.branchId) {
                await BranchService.archiveBranch(ecoDesign.branchId, tx)
              }
            }

            return assignedThisAttempt
          },
          { isolationLevel: 'serializable' },
        )
      },
      3,
      // The three signals the branch merge retries on, for the same reasons.
      // 40001 (serialization_failure) is SSI reporting that two releases read
      // and wrote overlapping rows; 40P01 (deadlock) is the same contention
      // arriving through the lock manager instead; and 23505 (unique
      // violation) is what a concurrent release looks like when it commits
      // between our snapshot and our write — the items identity index checks
      // committed data our snapshot cannot see, so it fires before SSI gets
      // the chance. A fresh attempt re-reads every affected item inside the
      // new snapshot, so an action the other release already performed is
      // skipped as idempotent (already in its target state) and a revision
      // re-resolves against what main now holds. A collision that is a
      // genuine data defect recurs identically and still surfaces once
      // retries exhaust, and anything else — a ValidationError from
      // `canApplyAction`, a NotFoundError — is rethrown untouched on the
      // first attempt.
      ['40001', '40P01', '23505'],
    )

    results.totalRevisionsAssigned += assignedRevisions
  }

  /**
   * Phase 3 — the affected-item actions the branch merge did not carry out.
   *
   * Runs only after a branch merged, and is not a fallback: a branch merge
   * releases branch *content*, creating the new version for every item the
   * branch changed. That covers 'revise' for items that actually have a working
   * copy on a merged branch, and nothing else. State-only actions ('release',
   * 'obsolete', 'promote') take the version that already exists and only change
   * its state — a branch merge neither performs those nor conflicts with them.
   * An item added to the change order as 'revise' but never checked out has no
   * branch content either.
   *
   * Gating this pass on an action allow-list silently dropped 'promote'
   * entirely, so an ECO that both edited a BOM on its branch and promoted a part
   * completed "successfully" having never promoted it. The rule is structural
   * instead: whatever the branch merge did not handle, this does.
   */
  private static async applyRemainingActions(
    changeOrderId: string,
    userId: string,
    designsWithBranches: Array<EcoDesignRecord>,
    results: ChangeOrderMergeResult,
  ): Promise<void> {
    const affectedItems =
      await ChangeOrderService.getAffectedItems(changeOrderId)

    // Masters whose content a merged branch already released
    const mergedBranchIds = designsWithBranches
      .filter((d) => d.branchId)
      .map((d) => d.branchId!)
    const handledMasterIds = new Set(
      mergedBranchIds.length > 0
        ? (
            await db
              .select({ itemMasterId: branchItems.itemMasterId })
              .from(branchItems)
              .where(
                and(
                  inArray(branchItems.branchId, mergedBranchIds),
                  isNotNull(branchItems.changeType),
                ),
              )
          ).map((r) => r.itemMasterId)
        : [],
    )

    // One transaction for the whole pass: it previously ran bare, so an
    // action that failed half way through left the ones before it applied
    // with no record that the pass was incomplete.
    //
    // SERIALIZABLE and retried, symmetric with the branch merge and with
    // applyAffectedItems: the same check-then-act shape, on items another
    // change order may be releasing at this very moment.
    const assignedRevisions = await withSerializableRetry(
      () => {
        // Per-attempt, for the reason spelled out in applyAffectedItems: the
        // retry re-runs this closure from the top, so a counter declared
        // outside it would add the aborted attempt's revisions to the
        // successful one's. `handledMasterIds` stays outside deliberately —
        // it records what the branch merge already committed, which no retry
        // of this pass can change.
        let assignedThisAttempt = 0

        return db.transaction(
          async (tx) => {
            for (const affected of affectedItems) {
              if (!affected.affectedItemId) continue

              const action = affected.changeAction

              // The branch merge owns items it actually released
              if (
                affected.affectedItemMasterId &&
                handledMasterIds.has(affected.affectedItemMasterId)
              ) {
                continue
              }

              const item = await ItemService.findById(
                affected.affectedItemId,
                tx,
              )
              if (!item) continue

              // Same validation the branchless path applies. Without it, an action
              // that became invalid after it was added (or was never validated at
              // intake) was applied here unchecked.
              const validation = await LifecycleService.canApplyAction(
                item.itemType,
                item.state,
                action,
              )
              if (!validation.valid) {
                // Already in the target state is not a failure - it makes a retry
                // after a partial release idempotent.
                const already = await LifecycleService.getTargetState(
                  item.itemType,
                  action,
                )
                if (already && item.state === already) continue
                throw new ValidationError(
                  `Cannot apply "${action}" to ${item.itemNumber}: ${validation.error}`,
                )
              }

              const states = await LifecycleService.resolveActionStates(
                item.itemType,
              )

              if (action === 'promote') {
                const promotion = await this.resolvePromote(item)
                if (!promotion) continue

                const promoteUpdates: Record<string, unknown> = {
                  state: promotion.toState,
                }
                if (promotion.revision !== item.revision) {
                  promoteUpdates.revision = promotion.revision
                }
                await ItemService.update(
                  affected.affectedItemId,
                  promoteUpdates,
                  userId,
                  {
                    bypassBranchProtection: true,
                    allowLifecycleFields: true,
                    skipAccessCheck: true,
                    tx,
                  },
                )
                if (promotion.assignedRevision) {
                  assignedThisAttempt++
                }
                continue
              }

              if (action === 'revise') {
                // Listed as a revision but with no branch content to release -
                // create the new version the way the branchless path does,
                // including basing the letter on main's current revision
                // rather than on the row pinned in the affected-items list.
                const { newRevision: targetRevision } =
                  await this.resolveAffectedRevision(
                    item,
                    states.revisionScheme,
                    tx,
                  )
                const newRev = await ItemService.revise(
                  affected.affectedItemId,
                  targetRevision,
                  userId,
                  tx,
                )
                if (newRev.id) {
                  await ItemService.update(
                    newRev.id,
                    {
                      state: requireActionState(
                        states.reviseState,
                        item.itemType,
                        'revise',
                      ),
                    },
                    userId,
                    {
                      bypassBranchProtection: true,
                      allowLifecycleFields: true,
                      skipAccessCheck: true,
                      tx,
                    },
                  )
                  if (states.supersededState) {
                    await ItemService.update(
                      affected.affectedItemId,
                      { state: states.supersededState },
                      userId,
                      {
                        bypassBranchProtection: true,
                        allowLifecycleFields: true,
                        skipAccessCheck: true,
                        tx,
                      },
                    )
                  }
                }
                assignedThisAttempt++
                continue
              }

              // release | obsolete - state-only
              const resolvedState = requireActionState(
                action === 'obsolete'
                  ? states.obsoleteState
                  : states.releaseState,
                item.itemType,
                action,
              )

              if (item.state === resolvedState) continue

              const updates: { state: string; revision?: string } = {
                state: resolvedState,
              }

              // Releasing a version that never carried one still needs a revision;
              // obsoleting keeps whatever revision the item already has.
              if (action === 'release') {
                const needsRevision = RevisionService.isWorkingRevision(
                  item.revision,
                )
                if (needsRevision) {
                  updates.revision = RevisionService.getInitialRevision(
                    states.revisionScheme,
                  )
                  assignedThisAttempt++
                }
              }

              await ItemService.update(
                affected.affectedItemId,
                updates,
                userId,
                {
                  bypassBranchProtection: true,
                  allowLifecycleFields: true,
                  skipAccessCheck: true,
                  tx,
                },
              )
            }

            return assignedThisAttempt
          },
          { isolationLevel: 'serializable' },
        )
      },
      3,
      // The same three codes as applyAffectedItems, retried for the same
      // reasons: 40001 and 40P01 are two faces of the same contention, and
      // 23505 is a concurrent release committing between our snapshot and
      // our write. A fresh attempt re-reads each item's state, so an action
      // the other release already applied is skipped rather than repeated.
      ['40001', '40P01', '23505'],
    )

    results.totalRevisionsAssigned += assignedRevisions
  }

  /**
   * Phase 4 — stamp a baseline tag on every affected design.
   *
   * A tag that fails to create must not fail the release it describes: the
   * merge has already committed, and a duplicate baseline name is the common
   * cause.
   */
  private static async createBaselineTags(
    changeOrderId: string,
    userId: string,
    changeOrderNumber: string,
    changeOrderData: ChangeOrder,
  ): Promise<void> {
    if (!changeOrderData.isBaseline || !changeOrderData.baselineName) return

    const baselineName = changeOrderData.baselineName
    const ecoDesignsForTags =
      await ChangeOrderService.getEcoDesigns(changeOrderId)

    for (const ecoDesign of ecoDesignsForTags) {
      try {
        await DesignService.createTag(
          ecoDesign.designId,
          {
            name: baselineName,
            description: `Baseline created by ECO release: ${changeOrderNumber}`,
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

  /**
   * Release a change order - merges all branches to main OR implements affected items
   * Supports two workflows:
   * 1. ECO-as-branch: Merge ECO branches to main with revision assignment
   * 2. Simple affected items: Directly implement the affected items
   *
   * Called via ChangeOrderService.close() from INSIDE the releasing workflow
   * transition, in its `beforeFinalize` hook — after guards, approvals and
   * before-actions have passed, but before any state write. The transition
   * only completes if this succeeds; a failure here leaves the change order
   * in its pre-final state and immediately retryable (see
   * ChangeOrderService.executeWorkflowTransition).
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
    // Note: No state validation here — state is the workflow's to manage.
    // This runs inside the transition's beforeFinalize hook, so the final
    // state is written only after this method has succeeded.

    // Drivers allow-list (WI-4.4): the ECO's Driving lifecycle must be
    // authorized by every Driven lifecycle it is about to act on. Checked
    // once up front so no merge path (branch or affected-items) can act
    // unauthorized. Without a workflow instance there is no Driving
    // lifecycle acting, so there is nothing to gate.
    await this.assertDriverAuthorized(changeOrderId)

    // What is about to release must be what was reviewed
    await this.assertScopeMatchesBranchContent(changeOrderId)

    const results: ChangeOrderMergeResult = {
      changeOrder: changeOrder as unknown as typeof items.$inferSelect,
      designs: [],
      totalRevisionsAssigned: 0,
    }

    // Every design this change order touches, and the subset with branches
    const ecoDesigns = await ChangeOrderService.getEcoDesigns(changeOrderId)
    const designsWithBranches = ecoDesigns.filter((d) => d.branchId)

    const branchesMerged = await this.mergeBranches(
      changeOrderId,
      userId,
      designsWithBranches,
      results,
    )

    if (branchesMerged === 0) {
      await this.applyAffectedItems(
        changeOrderId,
        userId,
        changeOrder.itemNumber,
        ecoDesigns,
        results,
      )
    } else {
      await this.applyRemainingActions(
        changeOrderId,
        userId,
        designsWithBranches,
        results,
      )
    }

    // The workflow, not this method, moves the change order to its final
    // state — the transition whose beforeFinalize hook invoked us (through
    // ChangeOrderService.close()) writes it once this returns successfully.

    await this.createBaselineTags(
      changeOrderId,
      userId,
      changeOrder.itemNumber,
      changeOrder as unknown as ChangeOrder,
    )

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

    // 4. Resolve the lifecycle states each item type releases into, before
    // opening the transaction. `resolveActionStates` is the one place those
    // five values and their fallbacks are worked out; the registry memoizes the
    // underlying definition, so asking per type costs one read each.
    const itemTypesOnBranch = new Set(
      (
        await db
          .select({ itemType: items.itemType })
          .from(items)
          .where(
            inArray(
              items.id,
              changedItems
                .map((bi) => bi.currentItemId)
                .filter((id): id is string => id !== null),
            ),
          )
      ).map((r) => r.itemType),
    )
    const lifecycleStateCache = new Map<string, ResolvedActionStates>()
    for (const itemType of itemTypesOnBranch) {
      lifecycleStateCache.set(
        itemType,
        await LifecycleService.resolveActionStates(itemType),
      )
    }

    // 5. The whole release of this design, as one serializable transaction:
    // item versions, BOM structure, cross-design references, the merge commit,
    // file promotion, branch archival, and the change order's record of it. It
    // used to stop after the item loop, so a failure creating the merge commit
    // left items released on main with no commit recording it and the design
    // still marked pending.
    const released = await withSerializableRetry(
      () => {
        // Every accumulator lives inside this closure, declared fresh per
        // attempt. A serialization failure (40001) rolls the transaction back
        // and re-runs the closure — accumulators declared outside it would
        // carry the aborted attempt's entries into the retry, double-counting
        // revisions and handing the post-commit dispatches (watermarks, WI
        // alerts, MBOM notifications) phantom item ids from rows that were
        // never committed.
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

        // Produced inside the transaction, consumed after it commits
        const upstreamItems: Array<UpstreamChangeItem> = []

        return db.transaction(
          async (tx) => {
            // Re-check for concurrent modifications inside the transaction,
            // against its own snapshot. validateMerge ran the same check
            // earlier, but outside the transaction its answer can go stale:
            // another change order can release this master between validation
            // and here — including before this snapshot even opens, in which
            // case there is no overlap for SERIALIZABLE to detect and the
            // stale merge would supersede the other release with old content.
            // On a retry this also re-runs against the fresh snapshot, so a
            // release that beat us during attempt one surfaces as a conflict
            // instead of being silently overwritten.
            const concurrentConflicts =
              await this.detectConcurrentModifications(
                changedItems,
                mainBranch.id,
                tx,
              )
            if (concurrentConflicts.length > 0) {
              // Not a 40001: the retry wrapper surfaces this to the caller
              // instead of retrying, which is correct — main has genuinely
              // moved, and no number of retries makes this branch's base fresh.
              throw new MergeConflictError(
                `Cannot merge: ${concurrentConflicts.map((c) => c.reason).join(', ')}`,
                {
                  changeOrderId,
                  branchId,
                  conflicts: concurrentConflicts,
                },
              )
            }

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

              // Pre-resolved above from this exact item set, so a miss means the
              // item's type changed under us — an invariant break, not something
              // to paper over with hardcoded state names.
              const lifecycleStates = lifecycleStateCache.get(
                currentItem.itemType,
              )
              if (!lifecycleStates) {
                throw new InternalError(
                  `No lifecycle states resolved for item type "${currentItem.itemType}" on branch ${branchId}`,
                  undefined,
                  { operation: 'mergeBranchToMain' },
                )
              }

              if (bi.changeType === 'added') {
                // New item - assign initial revision based on scheme
                const newRevision = RevisionService.getInitialRevision(
                  lifecycleStates.revisionScheme,
                )

                // Create new item version with assigned revision
                const releasedItem = takeFirst(
                  await tx
                    .insert(items)
                    .values({
                      ...currentItem,
                      id: undefined,
                      revision: newRevision,
                      // Free lifecycles define no release action: their items
                      // merge without a lifecycle stamp and keep their state
                      state: lifecycleStates.releaseState ?? currentItem.state,
                      isCurrent: true,
                      modifiedAt: new Date(),
                      modifiedBy: userId,
                    } as typeof items.$inferInsert)
                    .returning(),
                )

                await copyTypeSpecificData(
                  currentItem.itemType,
                  currentItem.id,
                  releasedItem.id,
                  tx,
                )

                // Files belong to an item version, and this release minted a new
                // row - without carrying them the part's CAD and attachments are
                // invisible on main, because listings resolve the item to the
                // released row and look files up by it. Released, so branchless.
                await FileService.copyFilesToItem({
                  sourceItemId: currentItem.id,
                  targetItemId: releasedItem.id,
                  branchId: null,
                  tx,
                })

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
                // Check if currentItem is already a working copy (unreleased
                // revision marker). If so, release it directly instead of
                // creating another revision. The predicate is shared with the
                // writers so a copy stamped 'DRAFT' by saveChanges/rebase is
                // not mistaken for a released revision.
                const isWorkingCopy = RevisionService.isWorkingRevision(
                  currentItem.revision,
                )

                let releasedItemId: string
                let finalRevision: string

                if (isWorkingCopy) {
                  // Working copy exists - transition it to Released.
                  // The revision comes from main's CURRENT item, not the base
                  // item, since another ECO may have released a newer revision
                  // since this branch was cut. `previewMerge` calls the same
                  // helper, so what it predicts is what this assigns.
                  finalRevision = (
                    await this.resolveModifiedRevision(
                      bi.itemMasterId,
                      currentItem.revision,
                      mainBranch.id,
                      lifecycleStates.revisionScheme,
                      tx,
                    )
                  ).newRevision

                  // Update working copy with final revision and revise state
                  await tx
                    .update(items)
                    .set({
                      revision: finalRevision,
                      state: lifecycleStates.reviseState ?? currentItem.state,
                      isCurrent: true,
                      modifiedAt: new Date(),
                      modifiedBy: userId,
                    })
                    .where(eq(items.id, currentItem.id))

                  // Working copy promoted in place: drop any uncommitted draft -
                  // only the committed manifest is what the release means
                  if (currentItem.itemType === 'Software') {
                    await tx
                      .update(software)
                      .set({ draftManifestId: null })
                      .where(eq(software.itemId, currentItem.id))
                  }

                  releasedItemId = currentItem.id
                } else {
                  // No working copy - create new revision (legacy fallback)
                  const newRevision = RevisionService.getNextRevision(
                    currentItem.revision,
                    lifecycleStates.revisionScheme,
                  )
                  const releasedItem = takeFirst(
                    await tx
                      .insert(items)
                      .values({
                        ...currentItem,
                        id: undefined,
                        revision: newRevision,
                        state: lifecycleStates.reviseState ?? currentItem.state,
                        isCurrent: true,
                        modifiedAt: new Date(),
                        modifiedBy: userId,
                      } as typeof items.$inferInsert)
                      .returning(),
                  )

                  await copyTypeSpecificData(
                    currentItem.itemType,
                    currentItem.id,
                    releasedItem.id,
                    tx,
                  )

                  // Same new-row problem as the added path: a revision created
                  // here would otherwise be released with no files at all.
                  await FileService.copyFilesToItem({
                    sourceItemId: currentItem.id,
                    targetItemId: releasedItem.id,
                    branchId: null,
                    tx,
                  })

                  releasedItemId = releasedItem.id
                  finalRevision = newRevision
                }

                await this.supersedePriorVersions(
                  bi.itemMasterId,
                  releasedItemId,
                  lifecycleStates.supersededState,
                  tx,
                )

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
                //
                // A 'deleted' branch row always carries a base, so there is no
                // reachable null case here and no else is written for one: the
                // sole writer of `baseItemId: null` is
                // `CheckoutService.createOnBranch`, and deleting what the
                // branch added retires that row outright — and soft-deletes
                // its working copy — rather than restamping it 'deleted'.
                if (bi.baseItemId) {
                  await tx
                    .update(items)
                    .set({
                      // No obsolete mapping (Free lifecycles): the deleted
                      // item keeps its state and is marked deleted only
                      ...(lifecycleStates.obsoleteState
                        ? { state: lifecycleStates.obsoleteState }
                        : {}),
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

              // The branch's own version of the item is the authority on its
              // structure: every step that mints a working copy carries the
              // item's relationships onto it (copyRelationshipsToItem), and the
              // copy is what the user edits on the ECO branch (adding,
              // re-quantifying or DELETING lines). Reading from baseItemId
              // instead would resurrect every line deleted on the branch — and
              // a copy whose every line was deleted releases an intentionally
              // emptied structure, not the base's.
              const sourceItemId = bi.currentItemId

              const parentRelationships = await tx
                .select()
                .from(itemRelationships)
                .where(eq(itemRelationships.sourceId, sourceItemId))

              // Replace the released item's structure with the branch's, so a
              // line deleted on the branch does not come back.
              if (releasedItemId !== sourceItemId) {
                await tx
                  .delete(itemRelationships)
                  .where(eq(itemRelationships.sourceId, releasedItemId))
              }

              // Resolve every target's masterId in one query rather than one
              // per relationship — this loop runs inside the serializable
              // transaction, and each round trip here widens the window in
              // which a concurrent release collides with this one.
              const unmappedTargetIds = [
                ...new Set(
                  parentRelationships
                    .map((rel) => rel.targetId)
                    .filter((id) => !itemIdMapping.has(id)),
                ),
              ]
              const targetMasterById = new Map(
                unmappedTargetIds.length > 0
                  ? (
                      await tx
                        .select({ id: items.id, masterId: items.masterId })
                        .from(items)
                        .where(inArray(items.id, unmappedTargetIds))
                    ).map((r) => [r.id, r.masterId])
                  : [],
              )

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
                  const targetMasterId = targetMasterById.get(rel.targetId)
                  if (
                    targetMasterId &&
                    masterIdToNewItemId.has(targetMasterId)
                  ) {
                    resolvedTargetId = masterIdToNewItemId.get(targetMasterId)!
                  }
                }

                if (releasedItemId === sourceItemId) {
                  // The working copy was released in place, so its rows already
                  // hang off the released item — only re-point a child that was
                  // revised in this same ECO.
                  if (resolvedTargetId !== rel.targetId) {
                    await tx
                      .update(itemRelationships)
                      .set({ targetId: resolvedTargetId })
                      .where(eq(itemRelationships.id, rel.id))
                  }
                } else {
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
            }
            // 5c. Merge cross-design references (promote added, remove deleted)
            await CrossDesignReferenceService.mergeReferencesOnRelease(
              branch.designId,
              branchId,
              tx,
            )

            // 6. Create merge commit
            const commit = await CommitService.createMergeCommit(
              {
                targetBranchId: mainBranch.id,
                sourceBranchId: branchId,
                message: `Merged ECO branch: ${branch.name}`,
                changeOrderItemId: changeOrderId,
                revisionsAssigned,
                itemChanges,
              },
              userId,
              tx,
            )

            // 7. Promote files from ECO branch to main (visible everywhere)
            const filesPromoted = await FileService.promoteFilesToMain(
              branchId,
              tx,
            )
            if (filesPromoted > 0) {
              serviceLogger.info(
                { filesPromoted },
                'Promoted files from ECO branch to main',
              )
            }

            // 8. Archive ECO branch
            await BranchService.archiveBranch(branchId, tx)

            // 9. Record the design's merge on the change order. This has to
            // commit with the release itself: the retry guard in merge() trusts
            // mergeStatus to know a design is done, so a release that landed its
            // items but not its status would be re-released — with fresh
            // revisions — on the next attempt.
            await tx
              .update(changeOrderDesigns)
              .set({
                mergeStatus: 'merged',
                mergedAt: new Date(),
                mergeCommitId: commit.id,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(changeOrderDesigns.changeOrderId, changeOrderId),
                  eq(changeOrderDesigns.designId, branch.designId),
                ),
              )

            // 10. Describe what this merge changed, for MBOMs derived from this
            // design. Resolved here because this is the only scope that still
            // knows both the released item and the revision it superseded.
            //
            // Two reads for the whole payload rather than two per change. This
            // runs inside the serializable transaction, so every round trip here
            // is time the release spends holding its locks.
            const releasedIds = itemChanges.map((c) => c.itemId)
            const previousIds = itemChanges
              .map((c) => c.previousItemId)
              .filter((id): id is string => Boolean(id))

            const releasedById = new Map(
              releasedIds.length > 0
                ? (
                    await tx
                      .select()
                      .from(items)
                      .where(inArray(items.id, releasedIds))
                  ).map((row) => [row.id, row])
                : [],
            )
            const previousRevisionById = new Map(
              previousIds.length > 0
                ? (
                    await tx
                      .select({ id: items.id, revision: items.revision })
                      .from(items)
                      .where(inArray(items.id, previousIds))
                  ).map((row) => [row.id, row.revision])
                : [],
            )

            for (const change of itemChanges) {
              const releasedRow = releasedById.get(change.itemId)
              if (!releasedRow) continue

              const previousRevision = change.previousItemId
                ? (previousRevisionById.get(change.previousItemId) ?? '')
                : ''

              upstreamItems.push({
                masterId: change.itemMasterId,
                itemNumber: releasedRow.itemNumber,
                name: releasedRow.name,
                itemType: releasedRow.itemType,
                previousRevision,
                newRevision: releasedRow.revision,
                changeType: change.changeType,
              })
            }

            return {
              commit,
              revisionsAssigned,
              itemsMerged,
              itemsAdded,
              itemsDeleted,
              itemChanges,
              upstreamItems,
            }
          },
          { isolationLevel: 'serializable' },
        )
      },
      3,
      // Retryable signals beyond the classic serialization failure:
      // 40P01 (deadlock) is SERIALIZABLE contention wearing different
      // clothes, and 23505 (unique violation) is what a concurrent release
      // looks like when it commits between our snapshot and our write — the
      // items identity index checks committed data our snapshot cannot see,
      // so it fires before SSI gets the chance. The fresh attempt re-reads
      // main: a content-conflicting release surfaces as MergeConflictError
      // from the in-transaction check above, a content-neutral one (revision
      // bump only) re-resolves cleanly to the next free letter. A 23505 that
      // is a genuine data defect recurs identically and still surfaces once
      // retries exhaust.
      ['40001', '40P01', '23505'],
    )

    // Outbound side effects, after the release has committed. A queue publish
    // cannot be rolled back, and holding a serializable transaction open across
    // it would extend the lock window over a network call.
    try {
      const changedPartIds = released.itemChanges
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

    // Mark the revisions this release superseded.
    //
    // A superseded PDF stays downloadable forever — that is the point of a
    // vault — so the only thing stopping someone building to it is that the
    // copy in their hand says nothing about being out of date. Stamping it is
    // what makes the paper self-describing.
    //
    // Dispatched rather than done inline: this rewrites every PDF attached to
    // every superseded revision, and a failure there must be retried on its
    // own rather than rolling back a release that has already happened.
    try {
      await this.submitSupersededWatermarkJobs(released.itemChanges, userId)
    } catch (error) {
      serviceLogger.warn({ error }, 'Failed to submit superseded watermark job')
    }

    // Post-release module hooks (e.g. an ERP connector syncing the released
    // design). Same contract as the dispatches above: the release has already
    // committed, so a hook failure is logged — and retried by whatever the
    // hook queued — never rolled back into the merge.
    for (const hook of ReleaseHookRegistry.all()) {
      try {
        await hook.afterRelease({
          changeOrderId,
          designId: branch.designId,
          userId,
          changedItems: released.upstreamItems,
          revisionsAssigned: released.revisionsAssigned,
        })
      } catch (error) {
        serviceLogger.warn(
          { error, hook: hook.name },
          'Release hook failed after merge',
        )
      }
    }

    return {
      mergeCommit: released.commit,
      revisionsAssigned: released.revisionsAssigned,
      itemsMerged: released.itemsMerged,
      itemsAdded: released.itemsAdded,
      itemsDeleted: released.itemsDeleted,
      changedItems: released.upstreamItems,
    }
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
   * Queue a "SUPERSEDED" stamp for the PDFs on every revision this release
   * replaced.
   *
   * One job per superseded revision, not one for the whole release: the stamp
   * carries the revision that replaced it, which differs per item, and a
   * per-item job means a document whose attachments fail to stamp can be
   * retried without re-stamping the rest.
   *
   * Files hang off an item *version* row, so the superseded revision still owns
   * its own attachments — the ones to mark are exactly the ones on
   * `previousItemId`, and the new revision's files are untouched.
   */
  private static async submitSupersededWatermarkJobs(
    itemChanges: Array<{
      itemId: string
      itemMasterId: string
      changeType: 'added' | 'modified' | 'deleted'
      previousItemId?: string
    }>,
    userId: string,
  ): Promise<void> {
    const superseded = itemChanges.filter(
      (change) => change.changeType === 'modified' && change.previousItemId,
    )
    if (superseded.length === 0) return

    const { JobService } = await import('@/lib/jobs')
    const { previewKindFor } = await import('@/lib/vault/preview')

    for (const change of superseded) {
      const previousItemId = change.previousItemId
      if (!previousItemId) continue

      const files = await FileService.listItemFiles(previousItemId)
      const pdfIds = files
        .filter(
          (file) =>
            !file.deletedAt &&
            file.isLatestVersion &&
            !file.isCheckedOut &&
            previewKindFor(file.originalFileName) === 'pdf',
        )
        .map((file) => file.id)

      if (pdfIds.length === 0) continue

      const released = await db
        .select({ itemNumber: items.itemNumber, revision: items.revision })
        .from(items)
        .where(eq(items.id, change.itemId))
        .limit(1)
        .then((rows) => rows.at(0))

      await JobService.submit(
        'document.watermark.apply',
        {
          fileIds: pdfIds,
          text: 'SUPERSEDED',
          subtext: released
            ? `Superseded by ${released.itemNumber} Rev ${released.revision}`
            : null,
          position: 'diagonal',
          color: '#dc2626',
          opacity: 0.25,
          reason: 'Superseded by ECO release',
          userId,
        },
        userId,
        { itemId: previousItemId },
      )
    }
  }

  /**
   * Whether two versions of an item differ in their type-specific data or
   * their BOM structure - the parts of an item that do not live on the
   * `items` row and were therefore invisible to the merge's conflict check.
   */
  private static async hasExtensionOrStructureChanges(
    itemType: string,
    baseItemId: string,
    otherItemId: string,
    tx?: TransactionClient,
  ): Promise<boolean> {
    const handler = getTypeHandler(itemType)
    if (handler) {
      const [baseExt, otherExt] = await Promise.all([
        handler.get(baseItemId, tx) as Promise<
          Record<string, unknown> | undefined
        >,
        handler.get(otherItemId, tx) as Promise<
          Record<string, unknown> | undefined
        >,
      ])

      const normalise = (row: Record<string, unknown> | undefined) => {
        if (!row) return {}
        const {
          itemId: _itemId,
          // Uncommitted editor state, never part of what was released
          draftManifestId: _draft,
          ...rest
        } = row
        return rest
      }

      const baseFields = normalise(baseExt)
      const otherFields = normalise(otherExt)
      for (const key of new Set([
        ...Object.keys(baseFields),
        ...Object.keys(otherFields),
      ])) {
        // An absent extension row and one whose columns are all null say the
        // same thing, so null and undefined compare equal here.
        const baseVal = baseFields[key] ?? null
        const otherVal = otherFields[key] ?? null
        if (JSON.stringify(baseVal) !== JSON.stringify(otherVal)) {
          return true
        }
      }
    }

    // BOM structure, through the comparator conflict detection also uses, so
    // both engines agree on what "the structure changed" means
    const [baseStructure, otherStructure] = await Promise.all([
      bomStructureOf(baseItemId, tx),
      bomStructureOf(otherItemId, tx),
    ])

    return baseStructure.signature !== otherStructure.signature
  }

  /**
   * Items on `main` that moved past a branch's base versions — the concurrent
   * modifications that make a merge unsafe to apply as-is.
   *
   * Compares each modified branch item's base (what main held when the branch
   * took its copy) against main's current version. A difference in revision or
   * metadata alone is not a conflict — releases mint those — so the comparison
   * skips those columns, then falls through to the extension table and BOM
   * structure, which is where most real edits live.
   *
   * Called twice with different stakes: `validateMerge` runs it outside any
   * transaction for fail-fast UX and the release preview, and
   * `mergeBranchToMain` re-runs it as the first statement inside its
   * serializable transaction — the only read whose answer cannot go stale
   * before the merge commits. Batched (one branch-items query, one items
   * query, regardless of item count) because the in-transaction call holds
   * the release's locks while it runs.
   */
  private static async detectConcurrentModifications(
    changedBranchItems: Array<typeof branchItems.$inferSelect>,
    mainBranchId: string,
    tx?: TransactionClient,
  ): Promise<Array<MergeConflict>> {
    const dbc = tx ?? db

    // Only items with a base can have diverged from it; added items have none.
    const withBase = changedBranchItems.filter(
      (bi): bi is typeof branchItems.$inferSelect & { baseItemId: string } =>
        bi.baseItemId !== null,
    )
    if (withBase.length === 0) return []

    const mainRows = await dbc
      .select()
      .from(branchItems)
      .where(
        and(
          eq(branchItems.branchId, mainBranchId),
          inArray(
            branchItems.itemMasterId,
            withBase.map((bi) => bi.itemMasterId),
          ),
        ),
      )
    const mainByMaster = new Map(mainRows.map((r) => [r.itemMasterId, r]))

    // Main moved iff its current version is no longer the branch's base
    const candidates = withBase.flatMap((bi) => {
      const main = mainByMaster.get(bi.itemMasterId)
      return main?.currentItemId && main.currentItemId !== bi.baseItemId
        ? [{ bi, mainCurrentId: main.currentItemId }]
        : []
    })
    if (candidates.length === 0) return []

    const itemIds = [
      ...new Set(candidates.flatMap((c) => [c.bi.baseItemId, c.mainCurrentId])),
    ]
    const itemById = new Map(
      (await dbc.select().from(items).where(inArray(items.id, itemIds))).map(
        (r) => [r.id, r],
      ),
    )

    // Fields a release rewrites on every version — a difference here says
    // "someone released", not "someone changed the item".
    const ignoreFields = new Set([
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
    ])

    const conflicts: Array<MergeConflict> = []
    for (const { bi, mainCurrentId } of candidates) {
      const baseItem = itemById.get(bi.baseItemId)
      const mainItem = itemById.get(mainCurrentId)
      if (!baseItem || !mainItem) continue

      let hasMeaningfulChanges = false
      for (const key of Object.keys(mainItem)) {
        if (ignoreFields.has(key)) continue
        const baseVal = (baseItem as Record<string, unknown>)[key]
        const mainVal = (mainItem as Record<string, unknown>)[key]
        if (JSON.stringify(baseVal) !== JSON.stringify(mainVal)) {
          hasMeaningfulChanges = true
          break
        }
      }

      // The items row is not the item. Part weight and material, software
      // manifests and the rest live on the extension table, and a BOM edit is
      // not on the item row at all - so comparing only `items` columns
      // declared "no meaningful change" for exactly the edits an ECO usually
      // makes. The merge then replaced main's structure with the branch's,
      // silently reverting whatever the other change order had released.
      if (!hasMeaningfulChanges) {
        hasMeaningfulChanges = await this.hasExtensionOrStructureChanges(
          mainItem.itemType,
          baseItem.id,
          mainItem.id,
          tx,
        )
      }

      if (hasMeaningfulChanges) {
        conflicts.push({
          itemId: bi.itemMasterId,
          itemNumber: baseItem.itemNumber,
          reason: `Item was modified on main since branch creation (main has ${mainItem.revision}, branch based on ${baseItem.revision})`,
          mainVersion: mainCurrentId,
          branchBase: bi.baseItemId,
          conflictType: 'concurrent_modification',
        })
      }
    }

    return conflicts
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

    // Held checkouts are a warning, not a blocker: `merge()` calls
    // `autoCheckinBranchItems` on the branch before validating it, so by the
    // time a real release reaches here there are none. Reporting them as
    // conflicts made the release preview say "cannot release" for an ECO whose
    // engineer simply still had an item open — which is every ECO, since saving
    // keeps the checkout.
    for (const { branchItem, item } of checkedOutItems) {
      warnings.push(
        `${item?.itemNumber || branchItem.itemMasterId} is still checked out; releasing will check it in`,
      )
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
    // someone else modified it while we were working on the ECO branch.
    //
    // This answer is advisory: nothing stops main moving between this check
    // and a release. `mergeBranchToMain` re-runs the same detection inside
    // its serializable transaction, which is the enforcement point.
    const mainBranch = await BranchService.getMainBranch(branch.designId)
    if (mainBranch) {
      conflicts.push(
        ...(await this.detectConcurrentModifications(
          changedItems.map((ci) => ci.branchItem),
          mainBranch.id,
        )),
      )
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

    // A change order that has finished has nothing left to preview, and
    // walking its branches anyway described the release it already did as a
    // release still to come. The branch rows survive the merge and their
    // current item IS the row now released on main, so the preview bumped
    // that revision a second time (B -> C) and `validateMerge` compared main
    // against the very row the merge had promoted onto it - reporting the
    // release as a concurrent modification of itself.
    //
    // Closed-ness and its reason come from the workflow instance, the same
    // source `canReachRelease` and `executeWorkflowTransition` read: isFinal
    // and finalKind, never a state name. 'Approved' is one workflow's label.
    const closure = await ChangeOrderService.getClosure(changeOrderId)
    const alreadyReleased =
      closure.finalKind === 'release' ||
      ecoDesigns.some((d) => d.mergeStatus === 'merged')

    if (closure.closed) {
      return {
        designs: [],
        totalItems: 0,
        canRelease: false,
        validationIssues: [
          alreadyReleased
            ? `${changeOrder.itemNumber} has already been released; nothing further will merge`
            : `${changeOrder.itemNumber} is closed in state "${changeOrder.state}"; nothing further will merge`,
        ],
        allConflicts: [],
        alreadyReleased,
      }
    }

    const designs: ReleasePreview['designs'] = []
    let totalItems = 0
    const validationIssues: Array<string> = []
    const allConflicts: Array<MergeConflict> = []
    // Masters a branch will release. The affected-items pass below skips
    // them, exactly as `applyRemainingActions` does - the two enumerate the
    // same item from opposite ends, and deduplicating by item id instead of
    // by master listed a checked-out item twice: once as the branch working
    // copy and once as the released row it is based on.
    const seenMasterIds = new Set<string>()
    // A design already merged still counts as a branch carrying changes, the
    // way `mergeBranches` counts one it skips.
    let mergedDesignCount = 0

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

      for (const { branchItem } of changedItems) {
        seenMasterIds.add(branchItem.itemMasterId)
      }

      // Mirrors the retry guard in `mergeBranches`: a design recorded merged
      // is not merged again, so a release that failed part way through must
      // not preview the designs it already released as another revision bump.
      if (ecoDesign.mergeStatus === 'merged') {
        mergedDesignCount++
        continue
      }

      const mainBranch = await BranchService.getMainBranch(ecoDesign.designId)
      const previewItems: Array<ReleasePreviewItem> = []

      for (const { branchItem, item } of changedItems) {
        if (!item) continue

        const previewScheme = await LifecycleService.getRevisionScheme(
          item.itemType,
        )
        let currentRevision = item.revision
        let newRevision: string
        if (branchItem.changeType === 'added') {
          newRevision = RevisionService.getInitialRevision(previewScheme)
        } else if (branchItem.changeType === 'modified' && mainBranch) {
          // The helper the merge itself uses, so the letter shown here is the
          // letter assigned: a checked-out working copy carries a branch
          // placeholder revision, not the released one it is based on.
          const resolved = await this.resolveModifiedRevision(
            branchItem.itemMasterId,
            item.revision,
            mainBranch.id,
            previewScheme,
          )
          currentRevision = resolved.baseRevision ?? item.revision
          newRevision = resolved.newRevision
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
          currentRevision,
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

    // The merge has two more paths this preview must mirror — without them
    // an initial-release ECO whose parts carry no branch content previews
    // as "0 items" and then releases them anyway:
    // - when no branch has changes, every state-changing affected item is
    //   applied directly (release/revise/obsolete/promote)
    // - when branches do merge, 'release' and 'obsolete' affected items are
    //   still applied afterward (the state-only pass)
    const branchesWithChanges =
      designs.filter((d) => d.items.length > 0).length + mergedDesignCount
    const affectedItems =
      await ChangeOrderService.getAffectedItems(changeOrderId)
    const designEntryById = new Map(designs.map((d) => [d.designId, d]))

    for (const affected of affectedItems) {
      const item = affected.affectedItemDetails
      if (!affected.affectedItemId || !item) continue

      const action = affected.changeAction
      if (!isKnownChangeAction(action)) continue
      if (
        branchesWithChanges > 0 &&
        action !== 'release' &&
        action !== 'obsolete'
      ) {
        continue
      }
      // By master, not by item id: the branch holds a different row of the
      // same item, and matching on ids reported both.
      const masterId = affected.affectedItemMasterId ?? item.masterId
      if (seenMasterIds.has(masterId)) continue

      const validation = await LifecycleService.canApplyAction(
        item.itemType,
        item.state,
        action,
      )
      const targetState = await LifecycleService.getTargetState(
        item.itemType,
        action,
      )
      const alreadyInTarget = targetState !== null && item.state === targetState

      if (!validation.valid && !alreadyInTarget) {
        validationIssues.push(`${item.itemNumber}: ${validation.error}`)
        continue
      }

      const scheme = await LifecycleService.getRevisionScheme(item.itemType)
      const needsRevision = RevisionService.isWorkingRevision(item.revision)

      let currentRevision = item.revision
      let newRevision = item.revision
      if (action === 'release') {
        newRevision = needsRevision
          ? RevisionService.getInitialRevision(scheme)
          : item.revision
      } else if (action === 'revise') {
        // Always computed, never read from `affected.targetRevision` — the
        // merge pointedly ignores that column (a prediction stamped at
        // add-time, stale the moment another release moves the item), so a
        // preview that preferred it promised letters the release would not
        // assign. `item.revision` is a prediction of the same vintage, so the
        // base comes from the helper the merge's own affected-items passes
        // use — reporting main's current revision as "current" the way the
        // branch arm above does, rather than the row pinned at add-time.
        const resolved = await this.resolveAffectedRevision(item, scheme)
        currentRevision = resolved.baseRevision
        newRevision = resolved.newRevision
      } else if (action === 'promote') {
        // The same authority the merge uses. When it resolves to nothing the
        // merge skips the item entirely, so the preview lists nothing too.
        const promotion = await this.resolvePromote(item)
        if (!promotion) continue
        newRevision = promotion.revision
      }

      // Nothing observable would change — mirrors the merge's idempotent skip
      if (alreadyInTarget && newRevision === item.revision) continue

      seenMasterIds.add(masterId)
      const previewItem: ReleasePreviewItem = {
        itemId: item.id,
        itemNumber: item.itemNumber,
        currentRevision,
        newRevision,
        changeType: 'modified',
      }

      const designKey = item.designId ?? 'no-design'
      const entry = designEntryById.get(designKey)
      if (entry) {
        entry.items.push(previewItem)
      } else {
        const design = item.designId
          ? await DesignService.getById(item.designId)
          : null
        const created = {
          designId: designKey,
          designName: design?.name ?? 'No design',
          items: [previewItem],
          conflicts: [] as Array<MergeConflict>,
        }
        designEntryById.set(designKey, created)
        designs.push(created)
      }
      totalItems++
    }

    // The same check `merge()` makes, reported instead of thrown. It is the
    // one blocker a reviewer could otherwise not see until the release button
    // failed, after the ECO had been approved.
    const unlisted = await this.findUnlistedBranchContent(changeOrderId)
    if (unlisted.length > 0) {
      validationIssues.push(
        `${this.describeUnlistedBranchContent(unlisted)} Add them to the ` +
          'change order, or discard the branch changes.',
      )
    }

    // Can release if a releasing transition is reachable AND there are no
    // blocking conflicts. Reachability comes from the workflow structure rather
    // than from comparing the item's state to the literal 'Approved' — that is
    // one workflow's choice of name, and flexible instances legitimately use
    // others, so the preview reported "cannot release" for every change order
    // whose approval state was called anything else.
    const blockingConflicts = allConflicts.filter(
      (c) => c.conflictType !== 'no_changes',
    )
    const canRelease =
      (await ChangeOrderService.canReachRelease(changeOrderId)) &&
      blockingConflicts.length === 0 &&
      unlisted.length === 0

    return {
      designs,
      totalItems,
      canRelease,
      validationIssues,
      allConflicts,
      alreadyReleased,
    }
  }
}
