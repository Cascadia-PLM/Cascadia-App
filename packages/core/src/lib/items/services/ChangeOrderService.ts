// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import { db, withTx } from '../../db'
import {
  branchItems,
  branches,
  changeOrderAffectedItems,
  changeOrderDesigns,
  changeOrderImpactReports,
  changeOrderImpactedItems,
  changeOrderRisks,
  changeOrders,
  designs,
  items,
  workflowInstances,
} from '../../db/schema'
import { ecoAccessScopeCondition, notDeleted } from '../../db/filters'
import { BranchService } from '../../services/BranchService'
import { CheckoutService } from '../../services/CheckoutService'
import { CommitService } from '../../services/CommitService'
import { DesignService } from '../../services/DesignService'
import { ChangeOrderMergeService } from '../../services/ChangeOrderMergeService'
import { LifecycleService } from '../../services/LifecycleService'
import { RevisionService } from '../../services/RevisionService'
import { FileService } from '../../vault/services/FileService'
import {
  ConflictError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from '../../errors'
import {
  asPostgresError,
  constraintOf,
  isUniqueViolation,
} from '../../errors/pg'
import { CHANGE_ACTION_LABELS } from '../types/change-order'
import { copyTypeSpecificData } from '../type-handlers/copy'
import { ItemService } from './ItemService'
import { ItemRelationshipService } from './ItemRelationshipService'
import type { TransactionClient } from '../../db'
import type {
  AffectedItem,
  ChangeAction,
  ChangeActionOptions,
  ChangeOrderType,
  ImpactReport,
  Risk,
} from '../types/change-order'
import type { BaseItem } from '../types/base'
import type { FinalKind, TransitionResult } from '../../workflows/types'

// Lazy-cached dynamic imports to avoid circular dependencies
// (same pattern as src/lib/items/registry.ts)
import type { WorkflowService as WorkflowServiceType } from '../../workflows/WorkflowService'
import type { ConflictDetectionService as ConflictDetectionServiceType } from '../../services/ConflictDetectionService'
import type { ItemTypeRegistry as ItemTypeRegistryType } from '../registry'
import type { requireEcoAccess as requireEcoAccessType } from '../../auth/access'
import { takeFirst } from '@/lib/db/take-first'

/**
 * The arbiter for `uq_coai_change_order_master` — the partial unique index
 * that makes "one scope row per master per change order" a database fact
 * rather than three separate read-then-write guards.
 *
 * The predicate has to travel with the target. Postgres infers a *partial*
 * unique index only from an `ON CONFLICT` clause carrying an index predicate
 * that implies the index's own; hand it the columns alone and it matches no
 * index and raises 42P10, turning a race that used to duplicate a row into
 * one that 500s. Keep this in step with the `.where()` on the index in
 * `schema/items.ts`.
 */
const AFFECTED_ITEM_MASTER_CONFLICT = {
  target: [
    changeOrderAffectedItems.changeOrderId,
    changeOrderAffectedItems.affectedItemMasterId,
  ],
  where: isNotNull(changeOrderAffectedItems.affectedItemMasterId),
}

export interface AffectedItemInput {
  affectedItemId?: string | null
  affectedItemMasterId?: string | null
  changeAction: ChangeAction
  /**
   * Fallback snapshot for inputs that name no existing item (`newItemData`).
   * When `affectedItemId` resolves, the item's real state/revision win.
   */
  currentState?: string | null
  currentRevision?: string | null
  replacementItemId?: string | null
  newItemData?: Record<string, any> | null
  newItemType?: string | null
  changeDescription?: string | null
}

export interface ValidationResult {
  valid: boolean
  severity: 'error' | 'warning' | 'info'
  message: string
  affectedItems?: Array<string>
  suggestion?: string
}

let _WorkflowService: typeof WorkflowServiceType | null = null
async function getWorkflowService() {
  if (!_WorkflowService) {
    const module = await import('../../workflows/WorkflowService')
    _WorkflowService = module.WorkflowService
  }
  return _WorkflowService
}

/**
 * Lazily imported for the same reason as the services above: access.ts pulls
 * in FileService statically, and loading that eagerly here would close a
 * require cycle through the item services.
 */
let _requireEcoAccess: typeof requireEcoAccessType | null = null
async function getRequireEcoAccess() {
  if (!_requireEcoAccess) {
    const module = await import('../../auth/access')
    _requireEcoAccess = module.requireEcoAccess
  }
  return _requireEcoAccess
}

let _ConflictDetectionService: typeof ConflictDetectionServiceType | null = null
async function getConflictDetectionService() {
  if (!_ConflictDetectionService) {
    const module = await import('../../services/ConflictDetectionService')
    _ConflictDetectionService = module.ConflictDetectionService
  }
  return _ConflictDetectionService
}

let _ItemTypeRegistry: typeof ItemTypeRegistryType | null = null
async function getItemTypeRegistry() {
  if (!_ItemTypeRegistry) {
    const module = await import('../registry')
    _ItemTypeRegistry = module.ItemTypeRegistry
  }
  return _ItemTypeRegistry
}

/**
 * Service layer for change order operations
 * Handles lifecycle management, affected items, and workflow transitions
 */
export class ChangeOrderService {
  /**
   * Create a change order against one or more designs.
   *
   * A change order must touch at least one design, and this is where that
   * becomes true rather than merely intended. It is not a tidiness rule: the
   * designs are what place an ECO inside a program, so one with none sits
   * outside every boundary — which is how every ECO in the instance came to
   * be visible to every user, and how the `canCreateEco` and `canApproveEco`
   * member flags came to gate nothing.
   *
   * The designs are equal and unordered; the first is not special. Nothing is
   * written to `items.designId`, which stays NULL on change orders precisely
   * so that no design can read as the primary one.
   *
   * Linking is part of the creation, not a follow-up. Both call sites that
   * used to link afterwards did so best-effort — one logged a warning and
   * carried on, the other swallowed rejections from `Promise.allSettled` —
   * so a failure there left exactly the design-less ECO this refuses to make.
   * If a link fails, the change order is removed and the error raised.
   */
  static async create(
    data: Partial<BaseItem> & Record<string, unknown>,
    designIds: Array<string>,
    userId: string,
    options?: { bypassBranchProtection?: boolean },
  ): Promise<BaseItem> {
    const uniqueDesignIds = [...new Set(designIds)]
    if (uniqueDesignIds.length === 0) {
      throw new ValidationError(
        'A change order must be created against at least one design',
      )
    }

    // `designId` is dropped rather than honoured, whatever the caller sent. A
    // change order's designs are the link rows below; a column holding one of
    // them would be a primary design by another name, and the access checks
    // that used to read it treated a NULL as "no program" and waved the ECO
    // through.
    //
    // Cast through `unknown`: callers hand this a request body Zod has already
    // shaped, and `ItemService.create` validates against the type registry.
    const { designId: _ignored, ...withoutDesign } = data
    const changeOrder = await ItemService.create(
      'ChangeOrder',
      withoutDesign as unknown as BaseItem,
      userId,
      options,
    )

    if (!changeOrder.id) {
      throw new ValidationError('Failed to create change order')
    }

    try {
      for (const designId of uniqueDesignIds) {
        await this.addDesignToEco(changeOrder.id, designId, userId)
      }
    } catch (error) {
      await ItemService.delete(changeOrder.id, userId).catch(() => {
        // The link failure is the error worth reporting; a cleanup that also
        // fails must not mask it.
      })
      throw error
    }

    return changeOrder
  }

  /**
   * The row already recording this item on the change order, if any.
   *
   * Keyed on masterId rather than on the item version's id. The same logical
   * item can be referenced by more than one `items.id` — its released version
   * and a branch working copy are different rows — so an id-keyed lookup
   * reports "not present" for an item that is.
   *
   * One row per item per change order is the invariant: two rows for the same
   * item (say 'revise' and 'obsolete') each validate on their own, and the
   * merge processes them in unspecified table order, so the released state
   * depended on which came back first. The invariant is now held by
   * `uq_coai_change_order_master`, the partial unique index on
   * (change_order_id, affected_item_master_id); this lookup is what turns a
   * hit into an answer each caller can use, not what makes it true.
   *
   * `addAffectedItem` treats a hit as an error and `addAffectedItemsBatch`
   * treats it as already-done — the same question with two policies, which is
   * why the lookup lives here instead of being written twice. It used to be
   * written twice, and the two disagreed: the batch keyed on `affectedItemId`,
   * so an item already present under a different version id slipped past its
   * check and made `addAffectedItem` throw, failing the whole batch the check
   * existed to let it skip.
   */
  private static async findExistingAffectedItem(
    changeOrderId: string,
    itemMasterId: string,
    tx?: TransactionClient,
  ): Promise<AffectedItem | null> {
    const existing = await (tx ?? db)
      .select()
      .from(changeOrderAffectedItems)
      .where(
        and(
          eq(changeOrderAffectedItems.changeOrderId, changeOrderId),
          eq(changeOrderAffectedItems.affectedItemMasterId, itemMasterId),
        ),
      )
      .limit(1)
      .then((r) => r.at(0))

    return (existing as AffectedItem | undefined) ?? null
  }

  /**
   * Add an affected item to a change order.
   * If the item belongs to a design, automatically creates the ECO-Design association.
   * For 'revise' actions on Released items, creates a working copy on the ECO branch.
   *
   * @throws Error if scope is locked (ECO has left initial state)
   */
  static async addAffectedItem(
    changeOrderId: string,
    item: AffectedItemInput,
    userId: string,
    outerTx?: TransactionClient,
  ): Promise<AffectedItem> {
    // Check if scope is locked (ECO has left initial state)
    const WorkflowService = await getWorkflowService()
    const workflowInstance =
      await WorkflowService.getInstanceByItemId(changeOrderId)
    if (workflowInstance?.scopeLocked) {
      throw new ValidationError(
        'Cannot add affected items: ECO scope is locked after leaving Draft state',
      )
    }

    // Everything from here writes (design association, ECO branch, working
    // copy, the affected-item row itself) — one transaction, so a failure
    // part-way leaves nothing behind. Reads of pre-existing state
    // (ItemService.findById, lifecycle config) stay on the pool; reads that
    // must see this transaction's own writes take `tx`.
    return withTx(outerTx, async (tx) => {
      let workingCopyId: string | null = null
      let ecoDesign: typeof changeOrderDesigns.$inferSelect | null = null
      let affectedItem: Awaited<ReturnType<typeof ItemService.findById>> = null
      // Target state and revision are resolved from the item's lifecycle below,
      // never taken from the caller. They used to be accepted from the request
      // body, which is how a browser-side revision guess ('[' for an item at
      // revision Z) reached the database and, on the revise-without-a-working-
      // copy release path, became the released revision.
      let targetState: string | null = null
      let targetRevision: string | null = null

      // If we have an affectedItemId, check if the item belongs to a design
      // and auto-create the changeOrderDesigns record
      if (item.affectedItemId) {
        affectedItem = await ItemService.findById(item.affectedItemId)

        if (affectedItem?.masterId) {
          const duplicate = await this.findExistingAffectedItem(
            changeOrderId,
            affectedItem.masterId,
            tx,
          )
          if (duplicate) {
            throw new ValidationError(
              `${affectedItem.itemNumber} is already an affected item of this change order. Remove it first to change its action.`,
            )
          }
        }

        // Validate that the change action is valid for this item's current
        // state, and that this ECO's Driving lifecycle is an authorized driver
        // of the item's lifecycle (WI-4.4)
        if (affectedItem) {
          const validation = await LifecycleService.canApplyAction(
            affectedItem.itemType,
            affectedItem.state,
            item.changeAction,
            {
              drivingLifecycleId:
                workflowInstance?.workflowDefinitionId ?? undefined,
            },
          )
          if (!validation.valid) {
            throw new ValidationError(
              `Cannot apply "${item.changeAction}" action to ${affectedItem.itemNumber}: ${validation.error}`,
            )
          }
        }

        if (affectedItem?.designId) {
          ecoDesign = await this.ensureDesignAssociation(
            changeOrderId,
            affectedItem.designId,
            userId,
            tx,
          )
          // Auto-associate all other designs containing usage copies of this
          // part — but NOT for a `release`. Releasing a definition must not pull
          // designs that merely hold usage copies of it into the release ECO:
          // they would be associated (an ECO branch created on each) and the
          // ECO's baseline stamped onto them, even though they have no affected
          // items in this ECO. Revise/obsolete/promote still propagate.
          if (affectedItem.id && item.changeAction !== 'release') {
            await this.associateRelatedDesigns(
              changeOrderId,
              {
                id: affectedItem.id,
                designId: affectedItem.designId ?? null,
                usageOf: affectedItem.usageOf ?? null,
              },
              userId,
              tx,
            )
          }
        }
      }

      // One resolver for every action's target state and revision, so the
      // Affected Items list predicts what the merge will do rather than what a
      // dialog guessed.
      if (affectedItem) {
        const target = await LifecycleService.resolveActionTarget(
          affectedItem.itemType,
          item.changeAction,
          affectedItem.revision,
        )
        if (target) {
          targetState = target.toState
          targetRevision = target.assignsRevision ? target.revision : null
        }
      }

      // For 'revise', create the working copy the engineer will edit. Gated on
      // the lifecycle's own revise mapping rather than the literal 'Released',
      // so a lifecycle whose released state is named differently still gets one
      // (without it the change order silently fell through to the merge's
      // legacy no-working-copy path).
      if (
        item.changeAction === 'revise' &&
        affectedItem &&
        ecoDesign?.branchId &&
        !RevisionService.isWorkingRevision(affectedItem.revision)
      ) {
        // Check if working copy already exists on this branch (idempotency)
        const existingWorkingCopy = await this.findExistingWorkingCopy(
          affectedItem.masterId,
          ecoDesign.branchId,
          tx,
        )

        if (existingWorkingCopy) {
          // Reuse existing working copy
          workingCopyId = existingWorkingCopy.id
        } else {
          // Create new working copy
          // Cast to items.$inferSelect since we know the item exists with required fields
          const { workingCopy } = await this.createRevisionWorkingCopy(
            affectedItem as typeof items.$inferSelect,
            ecoDesign.branchId,
            userId,
            tx,
          )
          workingCopyId = workingCopy.id
        }
      }

      try {
        const affectedItemRecord = takeFirst(
          await tx
            .insert(changeOrderAffectedItems)
            .values({
              changeOrderId,
              affectedItemId: item.affectedItemId || null,
              affectedItemMasterId:
                item.affectedItemMasterId || (affectedItem?.masterId ?? null),
              changeAction: item.changeAction,
              // Snapshot the item's real state at add-time rather than trusting
              // the caller's copy of it
              currentState: affectedItem?.state ?? item.currentState ?? null,
              currentRevision:
                affectedItem?.revision ?? item.currentRevision ?? null,
              targetState,
              targetRevision,
              replacementItemId: item.replacementItemId || null,
              newItemData: item.newItemData || null,
              newItemType: item.newItemType || null,
              changeDescription: item.changeDescription || null,
              workingCopyId,
              createdBy: userId,
            })
            .returning(),
        )

        return affectedItemRecord as AffectedItem
      } catch (error) {
        // The `findExistingAffectedItem` check above is a fast path with a
        // sentence a user can act on, not a guarantee: another request — a
        // second Add dialog, a checkout of the same item onto this ECO — can
        // land its row between that read and this insert. Losing that race is
        // the same condition the check reports, so it gets the same answer
        // rather than a 500 naming `uq_coai_change_order_master`.
        //
        // No `onConflictDoNothing` here, unlike the two registration paths:
        // this one owes its caller the row it created, and doing nothing
        // returns none.
        const pgError = asPostgresError(error)
        if (
          isUniqueViolation(error) &&
          pgError !== null &&
          constraintOf(pgError) === 'uq_coai_change_order_master'
        ) {
          throw new ValidationError(
            `${affectedItem?.itemNumber ?? 'That item'} is already an affected item of this change order. Remove it first to change its action.`,
          )
        }
        throw error
      }
    })
  }

  /**
   * Add several affected items, skipping any already on the change order.
   *
   * Used for parent propagation, where the parents of a nested item are added
   * alongside it and some are routinely already present — hence skip-and-return
   * rather than the error `addAffectedItem` raises for the same condition.
   *
   * **Atomic.** One transaction wraps the whole batch, threaded through every
   * write on the way down — `ensureDesignAssociation`,
   * `BranchService.getOrCreateEcoBranch`, `CommitService.create`,
   * `createRevisionWorkingCopy` — so a failure part-way leaves nothing added.
   * (An earlier version opened `db.transaction` and ignored the handle, which
   * wrapped nothing in production while looking atomic under test; the harness
   * cannot tell those apart, so atomicity here is reviewed by reading the call
   * chain — see `withTx`.) In-transaction reads matter as much as the writes:
   * the duplicate check and the association/branch existence checks run on the
   * transaction so later items see what earlier items created a moment ago.
   */
  static async addAffectedItemsBatch(
    changeOrderId: string,
    itemsToAdd: Array<AffectedItemInput>,
    userId: string,
    outerTx?: TransactionClient,
  ): Promise<Array<AffectedItem>> {
    return withTx(outerTx, async (tx) => {
      const results: Array<AffectedItem> = []

      for (const item of itemsToAdd) {
        // Resolve the master the same way `addAffectedItem` does, so both agree
        // on what "already present" means.
        const itemMasterId =
          item.affectedItemMasterId ??
          (item.affectedItemId
            ? ((await ItemService.findById(item.affectedItemId))?.masterId ??
              null)
            : null)

        if (itemMasterId) {
          const existing = await this.findExistingAffectedItem(
            changeOrderId,
            itemMasterId,
            tx,
          )
          if (existing) {
            results.push(existing)
            continue
          }
        }

        results.push(
          await this.addAffectedItem(changeOrderId, item, userId, tx),
        )
      }

      return results
    })
  }

  /**
   * Ensure a design is associated with an ECO (idempotent).
   * Creates the changeOrderDesigns record and ECO branch if they don't exist.
   * Also creates a "ChangeOrder created" commit when the design is first linked.
   */
  private static async ensureDesignAssociation(
    changeOrderId: string,
    designId: string,
    userId: string,
    tx?: TransactionClient,
  ): Promise<typeof changeOrderDesigns.$inferSelect> {
    // Check if association already exists. On a caller's transaction the read
    // must go through it, so an association inserted earlier in the same batch
    // is seen rather than re-created.
    const existing = await (tx ?? db)
      .select()
      .from(changeOrderDesigns)
      .where(
        and(
          eq(changeOrderDesigns.changeOrderId, changeOrderId),
          eq(changeOrderDesigns.designId, designId),
        ),
      )
      .limit(1)

    const existingAssociation = existing[0]
    if (existingAssociation) {
      return existingAssociation
    }

    // Get or create ECO branch for this design (idempotent)
    const { branch, created } = await BranchService.getOrCreateEcoBranch(
      designId,
      changeOrderId,
      userId,
      tx,
    )

    // Create "ChangeOrder created" commit when design is first linked
    // This makes the ECO visible in the program graph view for this design
    if (created) {
      const changeOrder = await ItemService.findById(changeOrderId)
      if (changeOrder) {
        await CommitService.create(
          {
            branchId: branch.id,
            message: `ChangeOrder ${changeOrder.itemNumber} created`,
            itemChanges: [], // No item changes, just branch/ECO registration
          },
          userId,
          tx,
        )
      }
    }

    // Create the changeOrderDesigns record
    const ecoDesign = takeFirst(
      await (tx ?? db)
        .insert(changeOrderDesigns)
        .values({
          changeOrderId,
          designId,
          branchId: branch.id,
          mergeStatus: 'pending',
        })
        .returning(),
    )

    return ecoDesign
  }

  /**
   * Auto-associate all designs containing usage copies of the given item.
   * This ensures cross-design references are visible in the ECO's Affected Items tab.
   */
  private static async associateRelatedDesigns(
    changeOrderId: string,
    affectedItem: {
      id: string
      designId: string | null
      usageOf: string | null
    },
    userId: string,
    tx?: TransactionClient,
  ): Promise<void> {
    // Determine the definition item ID:
    // Usage copy (has usageOf) → definition is usageOf
    // Definition (no usageOf) → definition is its own id
    const definitionId = affectedItem.usageOf ?? affectedItem.id

    // Find all distinct designs containing items linked to this definition
    const relatedDesigns = await (tx ?? db)
      .selectDistinct({ designId: items.designId })
      .from(items)
      .where(
        and(
          or(eq(items.usageOf, definitionId), eq(items.id, definitionId)),
          isNotNull(items.designId),
          affectedItem.designId
            ? sql`${items.designId} != ${affectedItem.designId}`
            : sql`true`,
          eq(items.isCurrent, true),
          notDeleted(),
        ),
      )

    for (const row of relatedDesigns) {
      if (row.designId) {
        await this.ensureDesignAssociation(
          changeOrderId,
          row.designId,
          userId,
          tx,
        )
      }
    }
  }

  /**
   * Create a working copy of a Released item for revision on an ECO branch.
   * This allows users to edit the item during the ECO lifecycle.
   *
   * Working copies use a branch-specific placeholder revision (e.g., "-abc12345").
   * The actual revision letter is assigned at merge time (ECO release) to support
   * concurrent ECOs modifying the same item on different branches.
   */
  static async createRevisionWorkingCopy(
    sourceItem: typeof items.$inferSelect,
    branchId: string,
    userId: string,
    outerTx?: TransactionClient,
  ): Promise<{
    workingCopy: typeof items.$inferSelect
    branchItem: typeof branchItems.$inferSelect
  }> {
    // Initial state comes from the lifecycle (no fallback: every type has one)
    const initialState = await LifecycleService.getInitialStateId(
      sourceItem.itemType,
    )

    // Use branch-specific placeholder revision to allow multiple ECOs to have
    // working copies of the same item (unique constraint is on item_number + revision)
    // Format: "-{first8CharsOfBranchId}" e.g., "-abc12345"
    const placeholderRevision = `-${branchId.substring(0, 8)}`

    // One transaction for the whole operation: the working copy, its
    // type-specific rows, relationships, files, branch tracking and commit
    // either all exist or none do. CommitService.create accepts the
    // transaction and nests as a savepoint, so the historical reason this was
    // split into a transaction for item creation plus a free-standing commit
    // no longer holds.
    return withTx(outerTx, async (tx) => {
      // 1. Create the working copy with initial state and placeholder revision
      const workingCopyData = {
        masterId: sourceItem.masterId, // Same master - it's a new revision of the same logical item
        designId: sourceItem.designId,
        itemNumber: sourceItem.itemNumber,
        revision: placeholderRevision,
        itemType: sourceItem.itemType,
        name: sourceItem.name,
        state: initialState, // Working copy starts in configured initial state
        isCurrent: false, // Not current until released - original stays current
        attributes: sourceItem.attributes || {},
        // SysML metadata - preserve from source item
        sysmlType: sourceItem.sysmlType,
        metamodel: sourceItem.metamodel,
        usageOf: sourceItem.usageOf,
        createdBy: userId,
        modifiedBy: userId,
      }

      const wc = takeFirst(
        await tx.insert(items).values(workingCopyData).returning(),
      )

      // 2. Copy type-specific data (parts table, documents table, etc.)
      await copyTypeSpecificData(sourceItem.itemType, sourceItem.id, wc.id, tx)

      // 3. Copy the item's outgoing relationships (BOM lines, document links)
      //    onto the working copy. Without this the branch copy of an assembly
      //    has an empty structure: you cannot see its children on the ECO
      //    branch, let alone re-quantify or DELETE a line there. With it, the
      //    working copy carries the real structure and is the thing the merge
      //    releases, so edits made on the branch are what ship.
      await ItemRelationshipService.copyRelationshipsToItem({
        sourceItemId: sourceItem.id,
        targetItemId: wc.id,
        userId,
        tx,
      })

      // 3b. Carry the item's files onto the working copy, for the same reason
      //     its structure is carried: the working copy is what the branch
      //     shows and what the merge releases. Without this the engineer opens
      //     the part on the ECO branch to find no CAD and no attachments, and
      //     releasing the copy in place publishes a revision that has none.
      await FileService.copyFilesToItem({
        sourceItemId: sourceItem.id,
        targetItemId: wc.id,
        branchId,
        tx,
      })

      // 4. Create (or repoint) the branchItem entry tracking this on the
      // branch. A plain checkout may have created the row already, pointing
      // at the shared released version — upsert so it now tracks the working
      // copy while preserving any held checkout lock.
      const bi = takeFirst(
        await tx
          .insert(branchItems)
          .values({
            branchId,
            itemMasterId: sourceItem.masterId,
            currentItemId: wc.id,
            baseItemId: sourceItem.id, // The Released version we're revising from
            changeType: 'modified',
          })
          .onConflictDoUpdate({
            target: [branchItems.branchId, branchItems.itemMasterId],
            set: {
              currentItemId: wc.id,
              baseItemId: sourceItem.id,
              changeType: 'modified',
            },
          })
          .returning(),
      )

      // 5. Create commit for history tracking, in the same transaction
      const commit = await CommitService.create(
        {
          branchId,
          message: `Started revision of ${sourceItem.itemType} ${sourceItem.itemNumber} (from ${sourceItem.revision})`,
          itemChanges: [
            {
              itemId: wc.id,
              changeType: 'modified',
              previousItemId: sourceItem.id,
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
        .where(eq(items.id, wc.id))

      return { workingCopy: wc, branchItem: bi }
    })
  }

  /**
   * Find an existing working copy for an item on a branch (for idempotency).
   */
  private static async findExistingWorkingCopy(
    itemMasterId: string,
    branchId: string,
    tx?: TransactionClient,
  ): Promise<typeof items.$inferSelect | null> {
    const result = await (tx ?? db)
      .select({ item: items })
      .from(branchItems)
      .innerJoin(items, eq(branchItems.currentItemId, items.id))
      .where(
        and(
          eq(branchItems.branchId, branchId),
          eq(branchItems.itemMasterId, itemMasterId),
          eq(branchItems.changeType, 'modified'),
        ),
      )
      .limit(1)

    return result.at(0)?.item || null
  }

  /**
   * Which change action an item's current state implies.
   *
   * A state already carrying a released version is a revision; anything the
   * lifecycle lets us release for the first time is a release. Resolved from
   * the lifecycle's own mappings rather than by comparing against the literal
   * 'Released', so a lifecycle whose released state is named differently
   * still routes correctly.
   *
   * Returns null when neither action is configured for that state - the
   * caller decides whether that is an error.
   */
  static async inferChangeAction(
    itemType: string,
    state: string | null | undefined,
  ): Promise<'revise' | 'release' | null> {
    // A stateless item can take no action; there is no assumed default state
    if (state == null) return null
    const validActions = await LifecycleService.getValidActions(itemType, state)
    if (validActions.includes('revise')) return 'revise'
    if (validActions.includes('release')) return 'release'
    return null
  }

  /**
   * What adding each of these items to this change order would do.
   *
   * The dialogs used to answer this themselves, from a hardcoded list of the
   * seeded state names and a client-side revision increment. That made
   * `promote` unreachable, showed an empty action list for any lifecycle whose
   * released state is named something else, and mispredicted every revision
   * outside single-letter alpha. Everything here is resolved from the item's
   * own lifecycle, so the dialog shows what the server will actually do.
   *
   * `targetRevision` is a prediction — see
   * `LifecycleService.resolveActionTarget`. `blockedReason` is set when the
   * item cannot be added at all, so the dialog can say why instead of
   * offering an action that will be rejected.
   */
  static async getChangeActionOptions(
    changeOrderId: string,
    itemIds: Array<string>,
  ): Promise<Array<ChangeActionOptions>> {
    const WorkflowService = await getWorkflowService()
    const workflowInstance =
      await WorkflowService.getInstanceByItemId(changeOrderId)
    const drivingLifecycleId = workflowInstance?.workflowDefinitionId

    const alreadyListed = new Set(
      (
        await db
          .select({ masterId: changeOrderAffectedItems.affectedItemMasterId })
          .from(changeOrderAffectedItems)
          .where(eq(changeOrderAffectedItems.changeOrderId, changeOrderId))
      )
        .map((r) => r.masterId)
        .filter((id): id is string => id !== null),
    )

    const results: Array<ChangeActionOptions> = []

    for (const itemId of itemIds) {
      const item = await ItemService.findById(itemId)
      if (!item) continue

      const base = {
        itemId,
        itemNumber: item.itemNumber,
        currentState: item.state,
        currentRevision: item.revision,
      }

      if (alreadyListed.has(item.masterId)) {
        results.push({
          ...base,
          actions: [],
          defaultAction: null,
          blockedReason: 'Already an affected item of this change order',
        })
        continue
      }

      const validActions = await LifecycleService.getValidActions(
        item.itemType,
        item.state,
      )

      const actions: ChangeActionOptions['actions'] = []
      for (const action of validActions) {
        // The drivers allow-list can rule an action out even when the state
        // allows it; ask the same validator the write path will use
        const validation = await LifecycleService.canApplyAction(
          item.itemType,
          item.state,
          action,
          { drivingLifecycleId: drivingLifecycleId ?? undefined },
        )
        if (!validation.valid) continue

        const target = await LifecycleService.resolveActionTarget(
          item.itemType,
          action,
          item.revision,
        )

        actions.push({
          action,
          label: CHANGE_ACTION_LABELS[action],
          targetState: target?.toState ?? null,
          targetRevision: target?.revision ?? null,
        })
      }

      results.push({
        ...base,
        actions,
        defaultAction: actions.at(0)?.action ?? null,
        blockedReason:
          actions.length === 0
            ? `No change action is configured for ${item.itemType} items in "${item.state}" state`
            : undefined,
      })
    }

    return results
  }

  /**
   * Record branch content on the change order that owns the branch.
   *
   * The merge releases branch content, not this table, so a branch change
   * with no affected-item row releases without ever appearing in the scope
   * reviewers approved. Checkout, create-on-branch and delete-on-branch all
   * reach ECO branches directly (the item routes, the checkout dialog, the
   * AI tools), so they register here rather than relying on callers to
   * remember.
   *
   * Idempotent, and a no-op for branches that are not ECO branches.
   */
  static async registerBranchChange(
    branchId: string,
    itemMasterId: string,
    itemId: string | null,
    userId: string,
    tx?: TransactionClient,
  ): Promise<void> {
    const client = tx ?? db
    // Resolved through the caller's transaction, not the pool. Three write
    // paths enter here from inside an open transaction —
    // `createRevisionWorkingCopy`, `createOnBranch`, `deleteOnBranch`, plus
    // `adoptWorkspaceIntoEco` once per adopted row — and a pool-bound read
    // made every one of them need a SECOND connection while the first was
    // still held. N concurrent writers then want 2N connections and each can
    // sit on one while queueing for another, which is a livelock on a bounded
    // pool rather than a queue. `branches` is never written by any of these
    // transactions, so reading it through `tx` returns the same row and
    // changes nothing visible; `CommitService.create` already resolves the
    // branch this way.
    const branch = await BranchService.getById(branchId, tx)
    if (!branch || branch.branchType !== 'eco' || !branch.changeOrderItemId) {
      return
    }
    const changeOrderId = branch.changeOrderItemId

    const existing = await client
      .select({ id: changeOrderAffectedItems.id })
      .from(changeOrderAffectedItems)
      .where(
        and(
          eq(changeOrderAffectedItems.changeOrderId, changeOrderId),
          eq(changeOrderAffectedItems.affectedItemMasterId, itemMasterId),
        ),
      )
      .limit(1)
      .then((r) => r.at(0))

    if (existing) return

    const item = itemId ? await ItemService.findById(itemId, tx) : null
    if (!item) return

    // What the branch says about this master decides how the change order
    // records it, because the branch is what merges. Content the branch
    // created is a first release whatever state it is in: `mergeBranchToMain`
    // gives every 'added' row the scheme's initial revision and the
    // lifecycle's release state without consulting the release mapping's
    // `fromState`. Reading the action from the item's state instead recorded
    // nothing at all for every type whose release starts somewhere other than
    // the initial state — Requirement releases from Approved, and 34 newly
    // authored requirements silently stayed out of scope until the merge
    // refused to release, naming items it had never been given the chance to
    // list. Existing items brought onto the branch keep the state-based
    // inference: a checkout of a Released item is a revision.
    const branchChangeType = await client
      .select({ changeType: branchItems.changeType })
      .from(branchItems)
      .where(
        and(
          eq(branchItems.branchId, branchId),
          eq(branchItems.itemMasterId, itemMasterId),
        ),
      )
      .limit(1)
      .then((r) => r.at(0)?.changeType)

    const isNewOnBranch = branchChangeType === 'added'
    // A master the branch records as deleted is retired by the merge, so the
    // scope row that describes it is `obsolete`. Recorded unconditionally,
    // with no check that the item's lifecycle configures an obsolete action:
    // the merge's branch path is what actually applies the deletion and it
    // handles the unmapped case on purpose ("Free lifecycles: the deleted
    // item keeps its state and is marked deleted only"), and
    // `applyRemainingActions` skips every master the merged branch already
    // handled — so this row is scope paperwork the reviewers read, not an
    // instruction anything executes. Skipping it would leave branch content
    // the affected-items list does not show, which `findUnlistedBranchContent`
    // reports and `assertScopeMatchesBranchContent` refuses at release, with
    // no in-app way out.
    const isDeletedOnBranch = branchChangeType === 'deleted'
    // The two `LifecycleService` reads below (`inferChangeAction` here,
    // `getRevisionScheme` for `targetRevision`) stay on the pool, on purpose.
    // Both resolve through `ItemTypeRegistry.getLifecycleForType`, which
    // memoises per item type for the life of the process and is invalidated
    // by every path that can change a definition — so they touch a connection
    // only on a cold cache, at most once per item type per process. Neither
    // runs on the delete path at all (a 'deleted' branch row short-circuits
    // to 'obsolete' and leaves `targetRevision` undefined), and the create
    // path's entry already warms the same cache entry via
    // `getInitialStateId` before its transaction opens. Threading `tx` down
    // instead would feed a process-wide cache from an uncommitted read: a
    // transaction that later rolls back could leave a value nothing ever
    // committed cached for every subsequent caller. Closing the cold-cache
    // window belongs in a startup warm of the lifecycle cache, not here.
    const changeAction = isNewOnBranch
      ? 'release'
      : isDeletedOnBranch
        ? 'obsolete'
        : await this.inferChangeAction(item.itemType, item.state)
    if (!changeAction) return

    // The revision the merge will assign, so the affected-items list predicts
    // what release does rather than leaving it blank.
    const targetRevision = isNewOnBranch
      ? RevisionService.getInitialRevision(
          await LifecycleService.getRevisionScheme(item.itemType),
        )
      : undefined

    // The `existing` read above short-circuits the common case; this absorbs
    // the race it cannot. Eight callers checking the same item out of the same
    // ECO all read "not registered" and all arrive here, and the scope row
    // they each want is identical — so the loser wanting nothing to happen is
    // exactly what happened. Idempotent is this method's contract, and a
    // conflict is the strongest evidence it was already met.
    await client
      .insert(changeOrderAffectedItems)
      .values({
        changeOrderId,
        affectedItemId: item.id,
        affectedItemMasterId: itemMasterId,
        changeAction,
        currentState: item.state,
        currentRevision: item.revision,
        targetRevision,
        isDirectlyAffected: true,
        createdBy: userId,
      })
      .onConflictDoNothing(AFFECTED_ITEM_MASTER_CONFLICT)
  }

  /**
   * Drop a master from the change order's scope when the branch stops
   * carrying it.
   *
   * The mirror of `registerBranchChange`, and it exists for the same reason:
   * the affected-items list and the branch content have to say the same
   * thing. Deleting an item that was *created* on the branch removes the
   * branch row outright — the item exists nowhere else — so a scope row left
   * behind describes a release of something that no longer exists, and the
   * branchless merge path would go on to apply it.
   *
   * Deliberately narrow: the row goes only when *no* branch of this change
   * order carries the master any more. An item still present on a second
   * design's branch is still in scope, and one with released content behind
   * it was never this path's to remove — `removeAffectedItem` is the
   * deliberate, guarded way to shrink a change order.
   */
  static async unregisterBranchChange(
    branchId: string,
    itemMasterId: string,
    tx?: TransactionClient,
  ): Promise<void> {
    const client = tx ?? db
    // Through the caller's transaction, for the reason `registerBranchChange`
    // gives: `deleteOnBranch` calls this from inside its transaction on the
    // branch-added path, and a pool read here would make that transaction
    // hold two connections at once.
    const branch = await BranchService.getById(branchId, tx)
    if (!branch || branch.branchType !== 'eco' || !branch.changeOrderItemId) {
      return
    }
    const changeOrderId = branch.changeOrderItemId

    const stillOnABranch = await client
      .select({ id: branchItems.id })
      .from(branchItems)
      .innerJoin(branches, eq(branchItems.branchId, branches.id))
      .where(
        and(
          eq(branches.changeOrderItemId, changeOrderId),
          eq(branches.branchType, 'eco'),
          eq(branchItems.itemMasterId, itemMasterId),
        ),
      )
      .limit(1)
      .then((r) => r.at(0))

    if (stillOnABranch) return

    await client
      .delete(changeOrderAffectedItems)
      .where(
        and(
          eq(changeOrderAffectedItems.changeOrderId, changeOrderId),
          eq(changeOrderAffectedItems.affectedItemMasterId, itemMasterId),
        ),
      )
  }

  /**
   * Remove an affected item from a change order.
   *
   * Scoped to the owning change order: an affected-item row id alone is not
   * authority to delete it, and the caller must name the ECO it belongs to.
   *
   * Removing the paperwork does not remove the change. The merge releases
   * branch content (`branch_items.changeType`), not this table, so deleting
   * the row while a working copy still carries branch changes would shrink
   * what reviewers see while the item still releases with a new revision.
   * That divergence is refused; discarding the branch change is explicit.
   */
  static async removeAffectedItem(
    changeOrderId: string,
    affectedItemId: string,
    options?: { discardBranchChanges?: boolean },
  ): Promise<void> {
    const affected = await db
      .select()
      .from(changeOrderAffectedItems)
      .where(
        and(
          eq(changeOrderAffectedItems.id, affectedItemId),
          eq(changeOrderAffectedItems.changeOrderId, changeOrderId),
        ),
      )
      .limit(1)
      .then((r) => r.at(0))

    if (!affected) {
      throw new NotFoundError('Affected item', affectedItemId, {
        operation: 'removeAffectedItem',
      })
    }

    const WorkflowService = await getWorkflowService()
    const workflowInstance =
      await WorkflowService.getInstanceByItemId(changeOrderId)
    if (workflowInstance?.scopeLocked) {
      throw new ValidationError(
        'Cannot remove affected items: ECO scope is locked after leaving the initial state',
      )
    }
    if (workflowInstance?.completedAt) {
      throw new ValidationError(
        'Cannot remove affected items: ECO workflow has been completed',
      )
    }

    // Branch content for this master, across every branch this ECO owns
    const ecoBranchIds = (await this.getEcoDesigns(changeOrderId))
      .map((d) => d.branchId)
      .filter((id): id is string => id !== null)

    const branchChanges =
      affected.affectedItemMasterId && ecoBranchIds.length > 0
        ? await db
            .select()
            .from(branchItems)
            .where(
              and(
                inArray(branchItems.branchId, ecoBranchIds),
                eq(branchItems.itemMasterId, affected.affectedItemMasterId),
                isNotNull(branchItems.changeType),
              ),
            )
        : []

    if (branchChanges.length > 0 && !options?.discardBranchChanges) {
      throw new ValidationError(
        'This item has unreleased changes on the ECO branch. Removing it from the ' +
          'affected items list alone would leave those changes to release anyway. ' +
          'Discard the branch changes explicitly to remove it.',
        undefined,
        { operation: 'removeAffectedItem', itemId: affectedItemId },
      )
    }

    await db.transaction(async (tx) => {
      for (const branchChange of branchChanges) {
        if (branchChange.changeType === 'added') {
          // Nothing on main to fall back to - drop the tracking row outright
          await tx
            .delete(branchItems)
            .where(eq(branchItems.id, branchChange.id))
        } else {
          // Reset to the version the branch forked from
          await tx
            .update(branchItems)
            .set({
              currentItemId: branchChange.baseItemId,
              changeType: null,
              checkedOutBy: null,
              checkedOutAt: null,
            })
            .where(eq(branchItems.id, branchChange.id))
        }
      }

      await tx
        .delete(changeOrderAffectedItems)
        .where(eq(changeOrderAffectedItems.id, affectedItemId))
    })
  }

  /**
   * Get all affected items for a change order (with item details)
   */
  static async getAffectedItems(
    changeOrderId: string,
  ): Promise<
    Array<AffectedItem & { affectedItemDetails?: typeof items.$inferSelect }>
  > {
    const results = await db
      .select({
        affectedItem: changeOrderAffectedItems,
        itemDetails: items,
      })
      .from(changeOrderAffectedItems)
      .leftJoin(items, eq(changeOrderAffectedItems.affectedItemId, items.id))
      .where(eq(changeOrderAffectedItems.changeOrderId, changeOrderId))

    return results.map(({ affectedItem, itemDetails }) => ({
      ...affectedItem,
      affectedItemDetails: itemDetails || undefined,
    })) as Array<
      AffectedItem & { affectedItemDetails?: typeof items.$inferSelect }
    >
  }

  /**
   * The affected items a given caller may see, plus whether any were withheld.
   *
   * `getAffectedItems` above is the engine's view and stays complete — the
   * merge, impact assessment and structure services all have to act on every
   * item regardless of who triggered them. This is the presentation view, and
   * it is the only one an API response should ever be built from.
   *
   * Withheld items collapse into a single anonymous flag rather than
   * surviving as redacted rows. One bucket, not N placeholders: the row count
   * would size the restricted set, and naming the design or program behind it
   * discloses something the caller may equally not be entitled to know. A
   * caller who did not expect the boundary asks their manager for access to
   * whatever else this ECO touches.
   *
   * Filtering them out silently is the one thing this must not do. A user who
   * sees three of seven items and is told nothing will submit or approve
   * believing they reviewed the change — which is exactly the decision this
   * flag exists to inform.
   *
   * Items belonging to no design stay visible: they sit outside every
   * program, so there is no boundary to place them on.
   */
  static async getAffectedItemsForViewer(
    changeOrderId: string,
    accessDesignIds: Array<string> | null,
  ): Promise<{
    affectedItems: Array<
      AffectedItem & { affectedItemDetails?: typeof items.$inferSelect }
    >
    hasRestricted: boolean
  }> {
    const all = await this.getAffectedItems(changeOrderId)
    if (accessDesignIds === null) {
      return { affectedItems: all, hasRestricted: false }
    }

    const allowed = new Set(accessDesignIds)
    const affectedItems = all.filter((a) => {
      const designId = a.affectedItemDetails?.designId
      return !designId || allowed.has(designId)
    })

    return {
      affectedItems,
      hasRestricted: affectedItems.length < all.length,
    }
  }

  /**
   * The ECO's designs as a given caller may see them.
   *
   * Redacting the affected items alone would be pointless while this endpoint
   * still returned every linked design's name and code — one request would
   * undo the other.
   */
  static async getEcoDesignsForViewer(
    changeOrderId: string,
    accessDesignIds: Array<string> | null,
  ) {
    const all = await this.getEcoDesigns(changeOrderId)
    if (accessDesignIds === null) {
      return { designs: all, hasRestricted: false }
    }

    const allowed = new Set(accessDesignIds)
    const visible = all.filter((d) => allowed.has(d.designId))
    return { designs: visible, hasRestricted: visible.length < all.length }
  }

  /**
   * How many items a change order affects, split by the design each belongs to.
   *
   * Pure, over rows the caller already has: `getEcoSummary` needs every design's
   * count and the ECO structure view needs one design's, and both were working
   * it out separately — the structure view with its own `COUNT`-shaped query
   * over rows it had already loaded for other reasons.
   *
   * Counts are derived rather than read from a stored `itemsAffected` column.
   * That column was only ever incremented, so removing an affected item left
   * the "N items affected" figure permanently too high and a failed add
   * inflated it too.
   *
   * Items belonging to no design are reported separately: they still count
   * towards a change order's total, but they belong to no design's row.
   */
  static countAffectedItemsByDesign(
    affectedItems: Array<{
      affectedItemDetails?: { designId: string | null } | undefined
    }>,
  ): { byDesign: Map<string, number>; withoutDesign: number } {
    const byDesign = new Map<string, number>()
    let withoutDesign = 0

    for (const affected of affectedItems) {
      const designId = affected.affectedItemDetails?.designId
      if (designId) {
        byDesign.set(designId, (byDesign.get(designId) ?? 0) + 1)
      } else {
        withoutDesign++
      }
    }

    return { byDesign, withoutDesign }
  }

  /**
   * Get all impacted items (discovered by impact analysis)
   */
  static async getImpactedItems(changeOrderId: string, impactType?: string) {
    const conditions = [
      eq(changeOrderImpactedItems.changeOrderId, changeOrderId),
    ]

    if (impactType) {
      conditions.push(eq(changeOrderImpactedItems.impactType, impactType))
    }

    return await db
      .select()
      .from(changeOrderImpactedItems)
      .where(and(...conditions))
  }

  /**
   * Get all risks for a change order
   */
  static async getRisks(changeOrderId: string): Promise<Array<Risk>> {
    const risks = await db
      .select()
      .from(changeOrderRisks)
      .where(eq(changeOrderRisks.changeOrderId, changeOrderId))

    return risks as Array<Risk>
  }

  /**
   * Acknowledge a risk
   */
  /**
   * Acknowledge a risk. Scoped to the owning change order - a risk id alone
   * is not authority to clear it.
   */
  static async acknowledgeRiskForChangeOrder(
    changeOrderId: string,
    riskId: string,
    userId: string,
  ): Promise<void> {
    const risk = await db
      .select({ id: changeOrderRisks.id })
      .from(changeOrderRisks)
      .where(
        and(
          eq(changeOrderRisks.id, riskId),
          eq(changeOrderRisks.changeOrderId, changeOrderId),
        ),
      )
      .limit(1)
      .then((r) => r.at(0))

    if (!risk) {
      throw new NotFoundError('Risk', riskId, { operation: 'acknowledgeRisk' })
    }

    await db
      .update(changeOrderRisks)
      .set({
        acknowledgedBy: userId,
        acknowledgedAt: new Date(),
      })
      .where(eq(changeOrderRisks.id, riskId))
  }

  /**
   * The business gates that must hold before a change order releases:
   * critical risks acknowledged, and no blocking conflicts.
   *
   * These lived only in `approve()`, which nothing in production calls - the
   * live path is the workflow transition endpoint - so neither gate ran on a
   * real release. Both are enforced from `executeWorkflowTransition` now,
   * immediately before a release claim is taken.
   */
  static async assertReleaseGates(changeOrderId: string): Promise<void> {
    // Check if critical risks are acknowledged
    const risks = await this.getRisks(changeOrderId)
    const unacknowledgedCritical = risks.filter(
      (r) =>
        r.severity === 'critical' &&
        r.requiresAcknowledgement &&
        !r.acknowledgedBy,
    )

    if (unacknowledgedCritical.length > 0) {
      throw new ValidationError(
        `Cannot release: ${unacknowledgedCritical.length} critical risk(s) require acknowledgement`,
        undefined,
        {
          code: 'UNACKNOWLEDGED_CRITICAL_RISKS',
          risks: unacknowledgedCritical.map((r) => ({
            category: r.category,
            description: r.description,
          })),
        },
      )
    }

    // Check for blocking merge conflicts
    const ConflictDetectionService = await getConflictDetectionService()
    const conflicts =
      await ConflictDetectionService.detectConflictsForEco(changeOrderId)

    if (conflicts.hasBlockingConflicts) {
      const blockingConflicts = conflicts.conflicts.filter(
        (c) => c.severity === 'error',
      )
      throw new ValidationError(
        `Cannot release: ${blockingConflicts.length} blocking conflict(s) detected. Resolve conflicts first.`,
        undefined,
        {
          code: 'BLOCKING_CONFLICTS',
          conflicts: blockingConflicts.map((c) => ({
            itemNumber: c.itemNumber,
            conflictType: c.conflictType,
            description:
              c.resolutionNotes ||
              `${c.conflictType} conflict on ${c.itemNumber}`,
          })),
        },
      )
    }
  }

  /**
   * Close/Release a change order after it has been transitioned to a final state.
   * This method handles the release logic (merge branches, assign revisions) and
   * updates the closedAt timestamp.
   *
   * IMPORTANT: The workflow transition to the final state (e.g., Approved) must happen
   * BEFORE calling this method. This method only handles the release mechanics.
   */
  static async close(changeOrderId: string, userId: string) {
    const changeOrder = await ItemService.findById(changeOrderId)
    if (!changeOrder) {
      throw new Error('Change order not found')
    }

    // Merge the change order (process affected items, merge branches, etc.)
    const mergeResult = await ChangeOrderMergeService.merge(
      changeOrderId,
      userId,
    )

    // Update change order metadata
    await db
      .update(changeOrders)
      .set({ closedAt: new Date() })
      .where(eq(changeOrders.itemId, changeOrderId))

    return mergeResult
  }

  /**
   * Cancel a change order with full cleanup.
   * Unlike close(), this does NOT merge branches to main.
   * Releases all checkout locks, archives ECO branches, and sets closedAt.
   *
   * Called when transitioning to a cancellation final state (Cancelled/Rejected).
   */
  static async cancel(changeOrderId: string, _userId: string) {
    const changeOrder = await ItemService.findById(changeOrderId)
    if (!changeOrder) {
      throw new Error('Change order not found')
    }

    const ecoDesigns = await this.getEcoDesigns(changeOrderId)

    for (const ecoDesign of ecoDesigns) {
      if (!ecoDesign.branchId) continue

      // Release all checkout locks on the branch
      await ChangeOrderMergeService.autoCheckinBranchItems(ecoDesign.branchId)

      // Archive the branch
      await BranchService.archiveBranch(ecoDesign.branchId)
    }

    // Set closedAt timestamp
    await db
      .update(changeOrders)
      .set({ closedAt: new Date() })
      .where(eq(changeOrders.itemId, changeOrderId))
  }

  /**
   * Get impact report for a change order
   */
  static async getImpactReport(
    changeOrderId: string,
  ): Promise<ImpactReport | null> {
    const result = await db
      .select()
      .from(changeOrderImpactReports)
      .where(eq(changeOrderImpactReports.changeOrderId, changeOrderId))
      .limit(1)

    const report = result.at(0)
    return report ? (report as ImpactReport) : null
  }

  // ============================================
  // Workflow Integration Methods
  // ============================================

  /**
   * Start a workflow for a change order
   */
  static async startWorkflow(
    changeOrderId: string,
    workflowDefinitionId: string,
    userId: string,
  ) {
    const WorkflowService = await getWorkflowService()

    // Start the workflow instance
    const instance = await WorkflowService.startInstance(
      workflowDefinitionId,
      changeOrderId,
      { actorId: userId },
    )

    return instance
  }

  /**
   * Whether a releasing transition is available from the change order's
   * current workflow state.
   *
   * The release-readiness signal, in place of comparing the item's state to the
   * literal 'Approved'. That name belongs to the default workflow, not to
   * change orders: a workflow that calls its approval state anything else — or
   * a flexible instance with user-added states — reported "cannot release"
   * forever. `finalKind` is the same property the release path itself keys on.
   */
  static async canReachRelease(changeOrderId: string): Promise<boolean> {
    const WorkflowService = await getWorkflowService()
    const instance = await WorkflowService.getInstanceByItemId(changeOrderId)
    if (!instance || instance.completedAt) return false

    const structure = await WorkflowService.getEffectiveStructure(instance.id)
    return structure.transitions.some((t) => {
      if (t.fromStateId !== instance.currentState) return false
      const target = structure.states.find((s) => s.id === t.toStateId)
      return target?.finalKind === 'release'
    })
  }

  /**
   * Whether the change order's workflow has finished, and what finishing
   * meant — from the state's `finalKind`, never from its name.
   *
   * The counterpart to `canReachRelease`, read from the same place: the
   * instance's effective structure. Asking the item type's lifecycle instead
   * would answer about a different workflow, since a flexible instance may
   * carry states the type-level definition never declared — the same reason
   * `executeWorkflowTransition` decides release-vs-cancel from the structure.
   *
   * A change order with no workflow instance is not closed: nothing has
   * finished because nothing was ever running.
   */
  static async getClosure(changeOrderId: string): Promise<{
    closed: boolean
    finalKind: FinalKind | null
  }> {
    const WorkflowService = await getWorkflowService()
    const instance = await WorkflowService.getInstanceByItemId(changeOrderId)
    if (!instance) return { closed: false, finalKind: null }

    const structure = await WorkflowService.getEffectiveStructure(instance.id)
    const current = structure.states.find((s) => s.id === instance.currentState)

    return {
      closed: current?.isFinal === true || Boolean(instance.completedAt),
      finalKind: current?.isFinal === true ? (current.finalKind ?? null) : null,
    }
  }

  /**
   * Get workflow instance for a change order
   */
  static async getWorkflowInstance(changeOrderId: string) {
    const WorkflowService = await getWorkflowService()
    return WorkflowService.getInstanceByItemId(changeOrderId)
  }

  /**
   * Refuse to *advance* a change order the caller can only see part of.
   *
   * Reach on a change order is not one rule, it is three, and they widen for
   * reading and narrow for acting:
   *
   * - **Read** it: reaching *any* linked design is enough. The designs out of
   *   reach are redacted (`resolveEcoDesignScope`), which is what lets a member
   *   of one program review the half that is theirs.
   * - **Vote** on it: membership with `canApproveEco` in *every* linked
   *   program (`requireEcoApprovalAccess` in the change-orders route module).
   * - **Advance** it — submit, release, cancel: reach to every linked design,
   *   which is this.
   *
   * Advancing is grouped with voting rather than with reading because of what
   * a final transition does, not what it is called. A release merges every
   * linked design's branch and stamps permanent revision letters across all of
   * them — and does so with per-item access checks deliberately disabled
   * (`skipAccessCheck` in ChangeOrderMergeService), on the strength of exactly
   * this gate. A cancel archives every linked branch, discarding in-flight
   * work in a program the caller cannot open. Neither is undoable. Submit is
   * included because it locks the ECO's scope, and because it is the cheap,
   * reversible end of the same rule — rework back to an initial state clears
   * the lock again.
   *
   * The approval vote is not a backstop for any of this: `approvalRequirement`
   * defaults to zero wherever a transition declares none, and workflows are
   * user-authored, so a releasing transition that requires no votes at all is
   * a legal configuration. This is the only gate on that path.
   *
   * `hasRestricted` is already false whenever the caller has cross-program
   * authority, so that bypass needs no branch here.
   */
  private static assertWholeEcoReach(
    scope: { hasRestricted: boolean },
    action: 'submit' | 'advance',
  ): void {
    if (scope.hasRestricted) {
      throw new PermissionDeniedError('the whole change order', action)
    }
  }

  /**
   * Execute a change-order workflow transition with correct final-state
   * semantics. This is THE entry point for CO transitions — the API route,
   * the AI tools, and submit/approve/reject all funnel through here so a
   * transition into a final state always runs its release/cancel mechanics.
   *
   * Final-state semantics come from the state's explicit finalKind — never
   * from its name:
   * - 'release': merge branches / implement affected items, assign revisions
   * - 'cancel':  archive branches without merging
   *
   * Ordering guarantee: the release/cancel work runs BEFORE the workflow
   * reaches the final state, under an exclusive claim that blocks concurrent
   * transitions. If the work fails, the claim is released and the ECO stays
   * in its pre-final state, fully retryable. The workflow can only become
   * Approved/completed if the merge actually happened.
   *
   * Also stamps the change order's own milestones — `submittedAt` on the first
   * transition out of the initial state, `approvedAt`/`approvedBy` when a
   * releasing transition succeeds. Both are shown on the detail page and the
   * design's ECO list, and both used to be written only by the `submit()` and
   * `approve()` wrappers, which nothing called.
   */
  static async executeWorkflowTransition(
    changeOrderId: string,
    toStateId: string,
    userId: string,
    comments?: string,
  ): Promise<{
    result: TransitionResult
    mergeResult?: Awaited<ReturnType<typeof ChangeOrderMergeService.merge>>
    cancelled?: boolean
  }> {
    // Program-membership gate, here rather than only on the route, because the
    // doc comment above is the reason: this is THE entry point, shared by the
    // API route, the AI tools and submit/approve/reject. A route-only check
    // would leave every other caller ungated — and a releasing transition is
    // the single most consequential thing a change order does.
    const requireEcoAccess = await getRequireEcoAccess()
    const scope = await requireEcoAccess(userId, changeOrderId)

    const WorkflowService = await getWorkflowService()

    const instance = await WorkflowService.getInstanceByItemId(changeOrderId)
    if (!instance) {
      throw new NotFoundError('Workflow', changeOrderId, {
        detail: 'No workflow found for this change order',
      })
    }

    const structure = await WorkflowService.getEffectiveStructure(instance.id)
    const targetState = structure.states.find((s) => s.id === toStateId)
    const leavingInitialState =
      structure.states.find((s) => s.id === instance.currentState)
        ?.isInitial === true

    // Non-final transitions need no release orchestration
    if (targetState?.isFinal !== true) {
      // …but leaving the initial state is still an advancing transition. See
      // `assertWholeEcoReach` below: submit locks the ECO's scope, and the
      // scope this caller would lock is not the scope they were shown.
      if (leavingInitialState) {
        this.assertWholeEcoReach(scope, 'submit')
      }
      const result = await WorkflowService.transition(
        instance.id,
        toStateId,
        userId,
        comments,
      )
      if (result.success && leavingInitialState) {
        await this.stampSubmitted(changeOrderId)
      }
      return { result }
    }

    // Ending a change order — released or cancelled — reaches every design it
    // links, so the caller has to. Checked before the finalKind validation
    // below so a partial reader is refused on access rather than being told
    // about the workflow's configuration.
    this.assertWholeEcoReach(scope, 'advance')

    // Fail closed: a final state without explicit semantics cannot complete
    const finalKind = targetState.finalKind
    if (finalKind !== 'release' && finalKind !== 'cancel') {
      throw new ValidationError(
        `Final state "${targetState.name}" does not declare finalKind ('release' or 'cancel'). ` +
          'Edit the workflow to set it — release-vs-cancel is never inferred from the state name.',
      )
    }

    // Business gates before anything irreversible: unacknowledged critical
    // risks and blocking conflicts stop a release. Checked before the claim
    // so a refusal leaves no claim to release. Cancelling skips them - it
    // merges nothing, and an ECO being abandoned because of its conflicts
    // must not be trapped by them.
    if (finalKind === 'release') {
      await this.assertReleaseGates(changeOrderId)
    }

    // Take the exclusive release claim (compare-and-swap) so concurrent
    // transitions and double-fired releases are impossible
    const claim = await WorkflowService.claimRelease(
      instance.id,
      instance.currentState,
    )
    if (!claim.claimed) {
      throw new ConflictError(
        claim.error || 'Could not claim workflow for release',
      )
    }

    let mergeResult:
      Awaited<ReturnType<typeof ChangeOrderMergeService.merge>> | undefined
    try {
      const result = await WorkflowService.transition(
        instance.id,
        toStateId,
        userId,
        comments,
        {
          ownedClaim: true,
          // Runs after guards/approvals/before-actions pass and before any
          // state write — the workflow only completes if this succeeded
          beforeFinalize: async () => {
            if (finalKind === 'release') {
              mergeResult = await this.close(changeOrderId, userId)
            } else {
              await this.cancel(changeOrderId, userId)
            }
          },
        },
      )

      if (!result.success) {
        // Validation failed before beforeFinalize ran — nothing was merged.
        // Release the claim and surface the reason.
        await WorkflowService.releaseClaim(instance.id)
        return { result }
      }

      if (leavingInitialState) {
        await this.stampSubmitted(changeOrderId)
      }
      if (finalKind === 'release') {
        await db
          .update(changeOrders)
          .set({ approvedAt: new Date(), approvedBy: userId })
          .where(eq(changeOrders.itemId, changeOrderId))
      }

      return { result, mergeResult, cancelled: finalKind === 'cancel' }
    } catch (error) {
      // close()/cancel() failed before any state write: release the claim so
      // the ECO stays in its pre-final state and is immediately retryable
      await WorkflowService.releaseClaim(instance.id)
      throw error
    }
  }

  /**
   * Record when a change order first left its initial state. Only ever set
   * once, so a rework round-trip through Draft keeps the original date.
   */
  private static async stampSubmitted(changeOrderId: string): Promise<void> {
    await db
      .update(changeOrders)
      .set({ submittedAt: new Date() })
      .where(
        and(
          eq(changeOrders.itemId, changeOrderId),
          isNull(changeOrders.submittedAt),
        ),
      )
  }

  /**
   * Transition a change order's workflow.
   *
   * Thin result-object wrapper around executeWorkflowTransition() for
   * callers that expect { success, error } rather than thrown errors
   * (the AI tools and the route).
   */
  static async transitionWorkflow(
    changeOrderId: string,
    toStateId: string,
    userId: string,
    comments?: string,
  ): Promise<TransitionResult> {
    try {
      const { result } = await this.executeWorkflowTransition(
        changeOrderId,
        toStateId,
        userId,
        comments,
      )
      return result
    } catch (error) {
      // A missing workflow is a caller error, not a failed transition — and
      // neither is a refusal. Collapsing PermissionDeniedError into
      // `{ success: false }` would report "Transition failed" to a caller who
      // is actually being told they may not touch this change order, and
      // would cost the route its 403.
      if (error instanceof NotFoundError) throw error
      if (error instanceof PermissionDeniedError) throw error
      return {
        success: false,
        fromState: '',
        toState: toStateId,
        error: error instanceof Error ? error.message : 'Transition failed',
      }
    }
  }

  /**
   * Get workflow history for a change order
   */
  static async getWorkflowHistory(changeOrderId: string) {
    const WorkflowService = await getWorkflowService()

    const instance = await WorkflowService.getInstanceByItemId(changeOrderId)
    if (!instance) {
      return []
    }

    return WorkflowService.getHistory(instance.id)
  }

  /**
   * Auto-start a workflow for a change order based on its changeType.
   * Looks up the default workflow from ChangeOrder's RuntimeItemTypeConfig.
   * Throws an error if no workflow is configured for the change type.
   *
   * @param changeOrderId - The ID of the change order item
   * @param changeType - The type of change order (ECO, ECN, Deviation, MCO)
   * @param userId - The ID of the user creating the change order
   * @returns The created workflow instance
   * @throws Error if no workflow is configured for the change type
   */
  static async autoStartWorkflow(
    changeOrderId: string,
    // The full set from `changeOrderTypeSchema`, which includes XCO — the
    // literal union here omitted it while the form, the admin config and the
    // runtime config all offer it
    changeType: ChangeOrderType,
    userId: string,
  ) {
    const ItemTypeRegistry = await getItemTypeRegistry()

    // Get ChangeOrder runtime config
    const config = ItemTypeRegistry.getRuntimeConfig('ChangeOrder')

    if (!config?.workflowsByChangeType) {
      throw new Error(
        `No workflow configuration found for ChangeOrder. Configure workflows in Admin > Item Types > ChangeOrder.`,
      )
    }

    const workflowId = config.workflowsByChangeType[changeType]
    if (!workflowId) {
      throw new Error(
        `No workflow configured for change type '${changeType}'. Configure workflows in Admin > Item Types > ChangeOrder.`,
      )
    }

    // Start the workflow
    return this.startWorkflow(changeOrderId, workflowId, userId)
  }

  /**
   * Get change orders that can still accept new items (scope not locked).
   * An ECO is editable when:
   * - It has no workflow instance (newly created), OR
   * - Its workflow instance has scopeLocked = false AND completedAt IS NULL
   * Also filters by designId if provided (via changeOrderDesigns association).
   *
   * `accessDesignIds` is the caller's reach, and it is **required** rather
   * than optional for the reason `PhysicalPartService.search` makes the same
   * argument required: for as long as it was absent this method took no user
   * at all, so the ECO picker behind it answered with every editable change
   * order on the instance — id, number, name and state — to anyone holding
   * `change_orders:read`, which every built-in role carries. Its sibling
   * `ItemService.search` has been bounded since AUTH-1; this list was simply
   * missed. Requiring the argument costs the single production caller one
   * line and makes any future caller state its scope rather than inherit
   * "everything" by omitting it.
   *
   * `null` is cross-program authority, matching
   * `AccessControlService.getAccessibleDesignIds`. An empty array is **not**
   * null: it says the caller reaches no design, and the guard below is on
   * truthiness for exactly that reason — `inArray(col, [])` compiles to
   * `false`, so `[]` correctly yields nothing, while a `.length > 0` guard
   * would skip the predicate and hand the whole table to the caller with the
   * least reach of all.
   *
   * The predicate is `ecoAccessScopeCondition`, the same expression
   * `accessScopeCondition` scopes `GET /api/v1/items` and
   * `GET /api/v1/change-orders` on, and the one-query twin of
   * `requireEcoAccess`. Reusing it is what keeps this list from answering the
   * ECO boundary question a second, drifting way — including its deliberate
   * treatment of a link-less ECO, which stays visible to cross-program
   * authority alone so the row can be repaired.
   */
  static async getEditableChangeOrders(options: {
    accessDesignIds: Array<string> | null
    designId?: string
    limit?: number
  }): Promise<
    Array<{
      id: string
      itemNumber: string
      name: string
      state: string
      changeType: string
    }>
  > {
    const conditions = [
      eq(items.itemType, 'ChangeOrder'),
      notDeleted(),
      eq(items.isCurrent, true),
      // Either no workflow instance, or scope is not locked and workflow is not completed
      or(
        isNull(workflowInstances.id),
        and(
          eq(workflowInstances.scopeLocked, false),
          isNull(workflowInstances.completedAt),
        ),
      ),
    ]

    if (options.accessDesignIds) {
      conditions.push(ecoAccessScopeCondition(options.accessDesignIds))
    }

    // Build the base query with LEFT JOIN on workflowInstances
    let query = db
      .select({
        id: items.id,
        itemNumber: items.itemNumber,
        name: items.name,
        state: items.state,
        changeType: changeOrders.changeType,
      })
      .from(items)
      .innerJoin(changeOrders, eq(items.id, changeOrders.itemId))
      .leftJoin(workflowInstances, eq(items.id, workflowInstances.itemId))

    // If filtering by designId, join through changeOrderDesigns
    if (options.designId) {
      query = query.innerJoin(
        changeOrderDesigns,
        eq(items.id, changeOrderDesigns.changeOrderId),
      )
      conditions.push(eq(changeOrderDesigns.designId, options.designId))
    }

    const results = await query
      .where(and(...conditions))
      .limit(options.limit ?? 50)

    return results.map((r) => ({
      id: r.id,
      itemNumber: r.itemNumber,
      name: r.name ?? '',
      state: r.state,
      changeType: r.changeType,
    }))
  }

  // ============================================
  // Phase 3: ECO-as-Branch Methods
  // ============================================

  /**
   * Checkout an item to an ECO. Creates ECO branch on design if needed.
   * This is the main entry point for "I want to edit this item under this ECO"
   *
   * @throws Error if scope is locked (ECO has left initial state)
   */
  static async checkoutItemToEco(
    changeOrderId: string,
    itemId: string,
    userId: string,
  ): Promise<{
    branchItem: typeof branchItems.$inferSelect
    branch: typeof branches.$inferSelect
  }> {
    // Check if scope is locked (ECO has left initial state)
    const WorkflowService = await getWorkflowService()
    const workflowInstance =
      await WorkflowService.getInstanceByItemId(changeOrderId)
    if (workflowInstance?.scopeLocked) {
      throw new ValidationError(
        'Cannot checkout items: ECO scope is locked after leaving Draft state',
      )
    }
    if (workflowInstance?.completedAt) {
      throw new ValidationError(
        'Cannot checkout items: ECO workflow has been completed',
      )
    }

    // 1. Verify the change order exists and is a ChangeOrder
    const changeOrder = await ItemService.findById(changeOrderId)
    if (!changeOrder) {
      throw new Error('Change order not found')
    }
    if (changeOrder.itemType !== 'ChangeOrder') {
      throw new Error('Item is not a change order')
    }

    // 2. Get the item and validate it has a designId
    const item = await ItemService.findById(itemId)
    if (!item) {
      throw new Error('Item not found')
    }
    if (!item.designId) {
      throw new Error(
        'Item is not associated with a design. Cannot checkout to ECO.',
      )
    }

    // 2b. The action this checkout implies, and whether the lifecycle allows
    // it. This path used to infer from the literal 'Released' and skip
    // validation entirely, so an item in a state with no configured action
    // (Obsolete, say) was recorded as a 'release' and only failed much later,
    // at merge, after the ECO had been through review.
    const inferredAction = await this.inferChangeAction(
      item.itemType,
      item.state,
    )
    if (!inferredAction) {
      throw new ValidationError(
        `Cannot add ${item.itemNumber} to this change order: no release or revise action is configured for ${item.itemType} items in "${item.state}" state`,
      )
    }
    const actionValidation = await LifecycleService.canApplyAction(
      item.itemType,
      item.state,
      inferredAction,
      { drivingLifecycleId: workflowInstance?.workflowDefinitionId },
    )
    if (!actionValidation.valid) {
      throw new ValidationError(
        `Cannot add ${item.itemNumber} to this change order: ${actionValidation.error}`,
      )
    }

    // 3. Get or create changeOrderDesign record
    let ecoDesign = await db
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

    // 4. Get or create ECO branch for this design
    const { branch, created } = await BranchService.getOrCreateEcoBranch(
      item.designId,
      changeOrderId,
      userId,
    )

    // 5. Create or update changeOrderDesign record
    if (!ecoDesign) {
      const newEcoDesign = takeFirst(
        await db
          .insert(changeOrderDesigns)
          .values({
            changeOrderId,
            designId: item.designId,
            branchId: branch.id,
            mergeStatus: 'pending',
          })
          .returning(),
      )
      ecoDesign = newEcoDesign
    } else if (!ecoDesign.branchId && created) {
      // Update the branchId if it was just created
      await db
        .update(changeOrderDesigns)
        .set({ branchId: branch.id, updatedAt: new Date() })
        .where(eq(changeOrderDesigns.id, ecoDesign.id))
    }

    // 6. For Released items on ECO branches, create a working copy for revision
    // This is different from a simple checkout - we're preparing for a revision
    let branchItem: typeof branchItems.$inferSelect
    let workingCopyId: string | null = null

    if (inferredAction === 'revise') {
      // Check if working copy already exists
      const existingWorkingCopy = await this.findExistingWorkingCopy(
        item.masterId,
        branch.id,
      )

      if (existingWorkingCopy) {
        // Reuse existing working copy
        workingCopyId = existingWorkingCopy.id
        // Get the branchItem
        const [existingBranchItem] = await db
          .select()
          .from(branchItems)
          .where(
            and(
              eq(branchItems.branchId, branch.id),
              eq(branchItems.itemMasterId, item.masterId),
            ),
          )
          .limit(1)
        if (!existingBranchItem) {
          throw new Error(
            `Working copy ${existingWorkingCopy.id} exists on branch ${branch.id} but has no branchItem entry for master ${item.masterId}`,
          )
        }
        branchItem = existingBranchItem
      } else {
        // Create working copy with proper branchItem
        // Revision assignment happens at merge time (ECO release)
        // Cast to items.$inferSelect since we know the item exists with required fields
        const result = await this.createRevisionWorkingCopy(
          item as typeof items.$inferSelect,
          branch.id,
          userId,
        )
        branchItem = result.branchItem
        workingCopyId = result.workingCopy.id
      }

      // "Checkout to ECO" is an edit intent: acquire the edit lock on the
      // working copy so this user can modify it (throws ResourceLockedError
      // if another user already holds it). Working copies created by scope
      // management (addAffectedItem) stay unlocked until someone edits.
      branchItem = await CheckoutService.checkout(
        { itemMasterId: item.masterId, branchId: branch.id },
        userId,
      )
    } else {
      // For non-released items, use standard checkout
      branchItem = await CheckoutService.checkout(
        {
          itemMasterId: item.masterId,
          branchId: branch.id,
        },
        userId,
      )
    }

    // 7. Add to changeOrderAffectedItems if not already there
    const existingAffected = await db
      .select()
      .from(changeOrderAffectedItems)
      .where(
        and(
          eq(changeOrderAffectedItems.changeOrderId, changeOrderId),
          eq(changeOrderAffectedItems.affectedItemMasterId, item.masterId),
        ),
      )
      .limit(1)

    if (!existingAffected.at(0)) {
      // A first release starts at the scheme's initial revision; the old
      // hardcoded 'A' was wrong for numeric and prefixed schemes. A revision
      // gets its number at merge, from main's current version.
      const targetRevision =
        inferredAction === 'release'
          ? RevisionService.getInitialRevision(
              await LifecycleService.getRevisionScheme(item.itemType),
            )
          : undefined

      // Nothing on this path runs in a transaction — the read above and this
      // write are separate statements on the pool — so the conflict clause is
      // the only thing standing between two concurrent checkouts of the same
      // item and two scope rows for it. Same reasoning as
      // `registerBranchChange`: the row the loser wanted is the row that is
      // there, and this step is "add if not already there".
      await db
        .insert(changeOrderAffectedItems)
        .values({
          changeOrderId,
          affectedItemId: itemId,
          affectedItemMasterId: item.masterId,
          changeAction: inferredAction,
          currentState: item.state,
          currentRevision: item.revision,
          targetRevision,
          workingCopyId,
          isDirectlyAffected: true,
          createdBy: userId,
        })
        .onConflictDoNothing(AFFECTED_ITEM_MASTER_CONFLICT)
    }

    return { branchItem, branch }
  }

  /**
   * Adopt a workspace branch's content into this change order.
   *
   * Workspace drafts live outside the ECO pipeline: no merge ever reads a
   * workspace branch, and an item created on one has no released version for
   * the ECO checkout path to start from — `checkoutItemToEco` throws
   * NotFound for exactly the items a workspace exists to draft. Adoption
   * therefore moves the branch rows themselves: each workspace branch item
   * is re-homed onto the ECO branch, after which the ordinary merge
   * machinery (scope assertion, branch merge, revision assignment, main
   * bookkeeping) sees the workspace's work exactly as if it had been done
   * on the ECO branch. Content is never copied, so nothing is lost in the
   * transfer and the emptied workspace can be deleted safely.
   *
   * A master already on the ECO branch or in its affected-item scope is
   * skipped, not merged — reconciling two working copies of one item is
   * conflict resolution, which adoption does not attempt.
   */
  static async adoptWorkspaceItems(
    changeOrderId: string,
    workspaceBranchId: string,
    userId: string,
  ): Promise<{ itemsAdopted: number; itemsSkipped: number }> {
    // Same scope gates as checkoutItemToEco: adoption grows the reviewed set
    const WorkflowService = await getWorkflowService()
    const workflowInstance =
      await WorkflowService.getInstanceByItemId(changeOrderId)
    if (workflowInstance?.scopeLocked) {
      throw new ValidationError(
        'Cannot adopt workspace items: ECO scope is locked after leaving Draft state',
      )
    }
    if (workflowInstance?.completedAt) {
      throw new ValidationError(
        'Cannot adopt workspace items: ECO workflow has been completed',
      )
    }

    const changeOrder = await ItemService.findById(changeOrderId)
    if (!changeOrder) {
      throw new NotFoundError('Change Order', changeOrderId, {
        operation: 'adoptWorkspaceItems',
      })
    }
    if (changeOrder.itemType !== 'ChangeOrder') {
      throw new ValidationError('Item is not a change order')
    }

    const workspace = await BranchService.getById(workspaceBranchId)
    if (!workspace) {
      throw new NotFoundError('Workspace', workspaceBranchId, {
        operation: 'adoptWorkspaceItems',
      })
    }
    if (workspace.branchType !== 'workspace') {
      throw new ValidationError(
        'Items can only be adopted from a workspace branch',
      )
    }

    const workspaceRows = await db
      .select()
      .from(branchItems)
      .where(eq(branchItems.branchId, workspaceBranchId))

    if (workspaceRows.length === 0) {
      throw new ValidationError('Workspace has no items to adopt')
    }

    // ECO branch and design association, created the same way (and in the
    // same non-transactional position) as checkoutItemToEco: a branch left
    // behind by a later failure is a normal, reusable state.
    const { branch: ecoBranch, created } =
      await BranchService.getOrCreateEcoBranch(
        workspace.designId,
        changeOrderId,
        userId,
      )

    const ecoDesign = await db
      .select()
      .from(changeOrderDesigns)
      .where(
        and(
          eq(changeOrderDesigns.changeOrderId, changeOrderId),
          eq(changeOrderDesigns.designId, workspace.designId),
        ),
      )
      .limit(1)
      .then((r) => r.at(0))

    if (!ecoDesign) {
      await db.insert(changeOrderDesigns).values({
        changeOrderId,
        designId: workspace.designId,
        branchId: ecoBranch.id,
        mergeStatus: 'pending',
      })
    } else if (!ecoDesign.branchId && created) {
      await db
        .update(changeOrderDesigns)
        .set({ branchId: ecoBranch.id, updatedAt: new Date() })
        .where(eq(changeOrderDesigns.id, ecoDesign.id))
    }

    // Masters the change order already carries, either as ECO branch content
    // or as reviewed scope — those are skipped, never overwritten
    // (branch_items is unique per (branchId, itemMasterId)).
    const ecoBranchMasters = new Set(
      (
        await db
          .select({ itemMasterId: branchItems.itemMasterId })
          .from(branchItems)
          .where(eq(branchItems.branchId, ecoBranch.id))
      ).map((r) => r.itemMasterId),
    )
    const scopeMasters = new Set(
      (
        await db
          .select({
            affectedItemMasterId: changeOrderAffectedItems.affectedItemMasterId,
          })
          .from(changeOrderAffectedItems)
          .where(eq(changeOrderAffectedItems.changeOrderId, changeOrderId))
      )
        .map((r) => r.affectedItemMasterId)
        .filter((id): id is string => id !== null),
    )

    let itemsAdopted = 0
    let itemsSkipped = 0

    await db.transaction(async (tx) => {
      const adoptedChanges: Array<{
        itemId: string
        changeType: 'added' | 'modified' | 'deleted'
      }> = []

      for (const row of workspaceRows) {
        if (
          ecoBranchMasters.has(row.itemMasterId) ||
          scopeMasters.has(row.itemMasterId)
        ) {
          itemsSkipped++
          continue
        }

        await tx
          .update(branchItems)
          .set({ branchId: ecoBranch.id })
          .where(eq(branchItems.id, row.id))

        // Register on the reviewed scope the same way the organic ECO paths
        // do. For an item the workspace created, the draft itself is what is
        // under review; for a modification or deletion, the base released
        // version is (matching what a checkout would have registered).
        const registerItemId =
          row.changeType === 'added'
            ? row.currentItemId
            : (row.baseItemId ?? row.currentItemId)
        await this.registerBranchChange(
          ecoBranch.id,
          row.itemMasterId,
          registerItemId,
          userId,
          tx,
        )

        itemsAdopted++
        if (row.changeType && row.currentItemId) {
          adoptedChanges.push({
            itemId: row.currentItemId,
            changeType: row.changeType as 'added' | 'modified' | 'deleted',
          })
        }
      }

      // Record the adoption in the ECO branch's history, so the commit graph
      // explains where this content came from.
      if (adoptedChanges.length > 0) {
        await CommitService.create(
          {
            branchId: ecoBranch.id,
            message: `Adopted ${adoptedChanges.length} item${adoptedChanges.length === 1 ? '' : 's'} from ${workspace.name}`,
            changeOrderItemId: changeOrderId,
            itemChanges: adoptedChanges,
          },
          userId,
          tx,
        )
      }
    })

    return { itemsAdopted, itemsSkipped }
  }

  /**
   * Get ECO summary across all designs
   */
  static async getEcoSummary(
    changeOrderId: string,
    accessDesignIds: Array<string> | null,
  ): Promise<EcoSummary> {
    const changeOrder = await ItemService.findById(changeOrderId)
    if (!changeOrder) {
      throw new Error('Change order not found')
    }

    // Get all designs affected by this ECO
    const allEcoDesigns = await db
      .select({
        ecoDesign: changeOrderDesigns,
        design: {
          id: designs.id,
          name: designs.name,
          code: designs.code,
        },
      })
      .from(changeOrderDesigns)
      .leftJoin(designs, eq(changeOrderDesigns.designId, designs.id))
      .where(eq(changeOrderDesigns.changeOrderId, changeOrderId))

    // Designs the caller cannot read drop out entirely rather than appearing
    // as rows with their names and five counts blanked. What survives is the
    // single flag below.
    const allowed = accessDesignIds === null ? null : new Set(accessDesignIds)
    const ecoDesigns =
      allowed === null
        ? allEcoDesigns
        : allEcoDesigns.filter((d) => allowed.has(d.ecoDesign.designId))

    const designSummaries: Array<EcoDesignSummary> = []
    let totalItemsAffected = 0
    let canSubmit = true

    // Visible items only, and therefore visible totals only. Reporting the
    // true total next to a shortened list would hand back the size of the
    // restricted set by subtraction, which is the number `hasRestricted`
    // exists to withhold.
    const { affectedItems, hasRestricted: hasRestrictedItems } =
      await this.getAffectedItemsForViewer(changeOrderId, accessDesignIds)
    const {
      byDesign: affectedCountByDesign,
      withoutDesign: itemsWithNoDesign,
    } = this.countAffectedItemsByDesign(affectedItems)

    const hasRestricted =
      hasRestrictedItems || ecoDesigns.length < allEcoDesigns.length

    // Branches and their contents, read once for every design rather than three
    // queries per design. The change-type tally and the checked-out check are
    // two questions about the same rows, so they read them together.
    const branchIds = ecoDesigns
      .map((d) => d.ecoDesign.branchId)
      .filter((id): id is string => id !== null)

    const branchesById = new Map(
      branchIds.length > 0
        ? (
            await db
              .select()
              .from(branches)
              .where(inArray(branches.id, branchIds))
          ).map((row) => [row.id, row])
        : [],
    )

    const branchItemRows =
      branchIds.length > 0
        ? await db
            .select({
              branchId: branchItems.branchId,
              changeType: branchItems.changeType,
              checkedOutBy: branchItems.checkedOutBy,
            })
            .from(branchItems)
            .where(inArray(branchItems.branchId, branchIds))
        : []

    const branchStats = new Map<
      string,
      {
        modified: number
        added: number
        deleted: number
        checkedOut: number
      }
    >()
    for (const row of branchItemRows) {
      const stats = branchStats.get(row.branchId) ?? {
        modified: 0,
        added: 0,
        deleted: 0,
        checkedOut: 0,
      }
      if (row.changeType === 'modified') stats.modified++
      else if (row.changeType === 'added') stats.added++
      else if (row.changeType === 'deleted') stats.deleted++
      if (row.checkedOutBy !== null) stats.checkedOut++
      branchStats.set(row.branchId, stats)
    }

    for (const { ecoDesign, design } of ecoDesigns) {
      const itemsAffected = affectedCountByDesign.get(ecoDesign.designId) ?? 0
      totalItemsAffected += itemsAffected

      const designCode = design?.code || 'Unknown'
      const designName = design?.name || design?.code || 'Unknown'

      if (!ecoDesign.branchId) {
        designSummaries.push({
          designId: ecoDesign.designId,
          designCode,
          designName,
          branch: null,
          itemsAffected,
          itemsModified: 0,
          itemsAdded: 0,
          itemsDeleted: 0,
          hasCheckedOutItems: false,
        })
        continue
      }

      const stats = branchStats.get(ecoDesign.branchId) ?? {
        modified: 0,
        added: 0,
        deleted: 0,
        checkedOut: 0,
      }

      // A held checkout means the branch still has work in flight
      if (stats.checkedOut > 0) {
        canSubmit = false
      }

      designSummaries.push({
        designId: ecoDesign.designId,
        designCode,
        designName,
        branch: branchesById.get(ecoDesign.branchId) ?? null,
        itemsAffected,
        itemsModified: stats.modified,
        itemsAdded: stats.added,
        itemsDeleted: stats.deleted,
        hasCheckedOutItems: stats.checkedOut > 0,
      })
    }

    // Items an ECO lists that belong to no design still count towards its total
    totalItemsAffected += itemsWithNoDesign

    const canRelease = await this.canReachRelease(changeOrderId)

    return {
      changeOrder: changeOrder as unknown as typeof items.$inferSelect,
      designs: designSummaries,
      totalItemsAffected,
      // Nothing this caller may act on can be submitted or released by them
      // alone while part of the ECO is outside their reach. These two are the
      // hint; `assertWholeEcoReach`, called from executeWorkflowTransition, is
      // the gate that enforces it. (This used to point at a `canAdvance`
      // helper that was never written, which is how the hint and the server
      // came to disagree.)
      canSubmit: canSubmit && !hasRestricted,
      canRelease: canRelease && !hasRestricted,
      hasRestricted,
    }
  }

  /**
   * Get all designs affected by this ECO
   */
  static async getEcoDesigns(changeOrderId: string) {
    const rows = await db
      .select({
        id: changeOrderDesigns.id,
        changeOrderId: changeOrderDesigns.changeOrderId,
        designId: changeOrderDesigns.designId,
        branchId: changeOrderDesigns.branchId,
        mergeStatus: changeOrderDesigns.mergeStatus,
        designName: designs.name,
        designCode: designs.code,
        designType: designs.designType,
      })
      .from(changeOrderDesigns)
      .innerJoin(designs, eq(changeOrderDesigns.designId, designs.id))
      .where(eq(changeOrderDesigns.changeOrderId, changeOrderId))

    return rows
  }

  /**
   * The masters whose release this change order's branches own.
   *
   * The merge has two ways to change an item: merging a branch, which
   * releases whatever content the branch carries, and applying the affected
   * item's change action directly, for scope with no branch content behind
   * it. Only the second consults the lifecycle's `fromState` — so anything
   * predicting a release has to know which set an item is in, or it reports
   * a mapping violation for an item the mapping will never be asked about
   * (a requirement authored on the branch in Draft, say).
   */
  static async getMastersWithBranchContent(
    changeOrderId: string,
  ): Promise<Set<string>> {
    const branchIds = (await this.getEcoDesigns(changeOrderId))
      .map((d) => d.branchId)
      .filter((id): id is string => id !== null)
    if (branchIds.length === 0) return new Set()

    const rows = await db
      .select({ itemMasterId: branchItems.itemMasterId })
      .from(branchItems)
      .where(
        and(
          inArray(branchItems.branchId, branchIds),
          isNotNull(branchItems.changeType),
        ),
      )

    return new Set(rows.map((r) => r.itemMasterId))
  }

  /**
   * Add a design to an ECO and create the ECO branch immediately
   */
  static async addDesignToEco(
    changeOrderId: string,
    designId: string,
    userId: string,
  ): Promise<typeof changeOrderDesigns.$inferSelect> {
    // Verify change order exists
    const changeOrder = await ItemService.findById(changeOrderId)
    if (!changeOrder) {
      throw new Error('Change order not found')
    }

    // Check if scope is locked (ECO has left initial state)
    const WorkflowService = await getWorkflowService()
    const workflowInstance =
      await WorkflowService.getInstanceByItemId(changeOrderId)
    if (workflowInstance?.scopeLocked) {
      throw new ValidationError(
        'Cannot add designs: ECO scope is locked after leaving Draft state',
      )
    }
    if (workflowInstance?.completedAt) {
      throw new ValidationError(
        'Cannot add designs: ECO workflow has been completed',
      )
    }

    // Verify design exists
    const design = await DesignService.getById(designId)
    if (!design) {
      throw new Error('Design not found')
    }

    // Check if already added
    const existing = await db
      .select()
      .from(changeOrderDesigns)
      .where(
        and(
          eq(changeOrderDesigns.changeOrderId, changeOrderId),
          eq(changeOrderDesigns.designId, designId),
        ),
      )
      .limit(1)

    const existingAssociation = existing[0]
    if (existingAssociation) {
      return existingAssociation
    }

    // Create the ECO branch immediately so it shows up in branch selectors
    const { branch, created } = await BranchService.getOrCreateEcoBranch(
      designId,
      changeOrderId,
      userId,
    )

    // Create "ChangeOrder created" commit when design is first linked
    // This makes the ECO visible in the program graph view for this design
    if (created) {
      await CommitService.create(
        {
          branchId: branch.id,
          message: `ChangeOrder ${changeOrder.itemNumber} created`,
          itemChanges: [], // No item changes, just branch/ECO registration
        },
        userId,
      )
    }

    // Create the association with the branch ID
    const ecoDesign = takeFirst(
      await db
        .insert(changeOrderDesigns)
        .values({
          changeOrderId,
          designId,
          branchId: branch.id,
          mergeStatus: 'pending',
        })
        .returning(),
    )

    return ecoDesign
  }

  // ============================================
  // Lifecycle Integration
  // ============================================

  /**
   * Get valid change actions for an item based on its current state.
   * Used by UI to show only applicable actions when adding affected items.
   *
   * @param itemId - The item to check
   * @returns Array of valid change actions for this item
   */
  static async getValidActionsForItem(
    itemId: string,
  ): Promise<Array<ChangeAction>> {
    const item = await ItemService.findById(itemId)
    if (!item) {
      return []
    }

    return LifecycleService.getValidActions(item.itemType, item.state)
  }
}

// ============================================
// Phase 3: ECO-as-Branch Types
// ============================================

export interface EcoDesignSummary {
  designId: string
  designCode: string
  designName: string
  branch: typeof branches.$inferSelect | null
  itemsAffected: number
  itemsModified: number
  itemsAdded: number
  itemsDeleted: number
  hasCheckedOutItems: boolean
}

export interface EcoSummary {
  changeOrder: typeof items.$inferSelect
  designs: Array<EcoDesignSummary>
  /** Visible to this caller, not the ECO's true size — see `hasRestricted`. */
  totalItemsAffected: number
  canSubmit: boolean
  canRelease: boolean
  /**
   * Part of this change order lies outside the caller's programs. Deliberately
   * a boolean: a count would size what it is withholding.
   */
  hasRestricted: boolean
}
