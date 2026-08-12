// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import { db } from '../../db'
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
  itemRelationships,
  items,
  workflowInstances,
} from '../../db/schema'
import { BranchService } from '../../services/BranchService'
import { CheckoutService } from '../../services/CheckoutService'
import { CommitService } from '../../services/CommitService'
import { DesignService } from '../../services/DesignService'
import { ChangeOrderMergeService } from '../../services/ChangeOrderMergeService'
import { LifecycleService } from '../../services/LifecycleService'
import { RevisionService } from '../../services/RevisionService'
import { FileService } from '../../vault/services/FileService'
import { ConflictError, NotFoundError, ValidationError } from '../../errors'
import { CHANGE_ACTION_LABELS } from '../types/change-order'
import { copyTypeSpecificData } from '../type-handlers/copy'
import { ItemService } from './ItemService'
import type {
  AffectedItem,
  ChangeAction,
  ChangeActionOptions,
  ChangeOrderType,
  ImpactReport,
  Risk,
} from '../types/change-order'
import type { TransitionResult } from '../../workflows/types'

// Lazy-cached dynamic imports to avoid circular dependencies
// (same pattern as src/lib/items/registry.ts)
import type { WorkflowService as WorkflowServiceType } from '../../workflows/WorkflowService'
import type { ConflictDetectionService as ConflictDetectionServiceType } from '../../services/ConflictDetectionService'
import type { ItemTypeRegistry as ItemTypeRegistryType } from '../registry'
import { takeFirst } from '@/lib/db/take-first'

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
   * depended on which came back first.
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
  ): Promise<AffectedItem | null> {
    const existing = await db
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
          affectedItem.state || 'Draft',
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
        )
        workingCopyId = workingCopy.id
      }
    }

    const affectedItemRecord = takeFirst(
      await db
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
  }

  /**
   * Add several affected items, skipping any already on the change order.
   *
   * Used for parent propagation, where the parents of a nested item are added
   * alongside it and some are routinely already present — hence skip-and-return
   * rather than the error `addAffectedItem` raises for the same condition.
   *
   * **Not atomic, and no longer pretending to be.** This used to open
   * `db.transaction(async () => …)` and ignore the transaction handle it was
   * given, so every call inside ran on the global `db` — a different pooled
   * connection — and the transaction wrapped nothing but its own BEGIN and
   * COMMIT. Under test it looked atomic, because the harness points `db` at the
   * test's transaction, which is the worst version of the situation: the
   * guarantee held everywhere except production. Making it real means threading
   * a transaction through `BranchService.getOrCreateEcoBranch`,
   * `CommitService.create` and `createRevisionWorkingCopy`, which is its own
   * change; until then a failure part-way leaves the earlier items added.
   */
  static async addAffectedItemsBatch(
    changeOrderId: string,
    itemsToAdd: Array<AffectedItemInput>,
    userId: string,
  ): Promise<Array<AffectedItem>> {
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
        )
        if (existing) {
          results.push(existing)
          continue
        }
      }

      results.push(await this.addAffectedItem(changeOrderId, item, userId))
    }

    return results
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
  ): Promise<typeof changeOrderDesigns.$inferSelect> {
    // Check if association already exists
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

    // Get or create ECO branch for this design (idempotent)
    const { branch, created } = await BranchService.getOrCreateEcoBranch(
      designId,
      changeOrderId,
      userId,
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
        )
      }
    }

    // Create the changeOrderDesigns record
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
  ): Promise<void> {
    // Determine the definition item ID:
    // Usage copy (has usageOf) → definition is usageOf
    // Definition (no usageOf) → definition is its own id
    const definitionId = affectedItem.usageOf ?? affectedItem.id

    // Find all distinct designs containing items linked to this definition
    const relatedDesigns = await db
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
          eq(items.isDeleted, false),
        ),
      )

    for (const row of relatedDesigns) {
      if (row.designId) {
        await this.ensureDesignAssociation(changeOrderId, row.designId, userId)
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
  ): Promise<{
    workingCopy: typeof items.$inferSelect
    branchItem: typeof branchItems.$inferSelect
  }> {
    // Get initial state ID from lifecycle config, fallback to 'Draft'
    const initialState = await LifecycleService.getInitialStateId(
      sourceItem.itemType,
    )

    // Use branch-specific placeholder revision to allow multiple ECOs to have
    // working copies of the same item (unique constraint is on item_number + revision)
    // Format: "-{first8CharsOfBranchId}" e.g., "-abc12345"
    const placeholderRevision = `-${branchId.substring(0, 8)}`

    // Note: Not using db.transaction() for the whole operation because CommitService.create()
    // has its own transaction, and nested transactions cause issues with test isolation.
    // We use a transaction for item creation only.

    const { workingCopy, branchItem } = await db.transaction(async (tx) => {
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
      const sourceRelationships = await tx
        .select()
        .from(itemRelationships)
        .where(eq(itemRelationships.sourceId, sourceItem.id))

      if (sourceRelationships.length > 0) {
        await tx
          .insert(itemRelationships)
          .values(
            sourceRelationships.map((rel) => ({
              sourceId: wc.id,
              targetId: rel.targetId,
              relationshipType: rel.relationshipType,
              quantity: rel.quantity,
              referenceDesignator: rel.referenceDesignator,
              findNumber: rel.findNumber,
              metadata: rel.metadata,
              createdBy: userId,
            })),
          )
          .onConflictDoNothing()
      }

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

      return { workingCopy: wc, branchItem: bi }
    })

    // 4. Create commit for history tracking (has its own transaction)
    const commit = await CommitService.create(
      {
        branchId,
        message: `Started revision of ${sourceItem.itemType} ${sourceItem.itemNumber} (from ${sourceItem.revision})`,
        itemChanges: [
          {
            itemId: workingCopy.id,
            changeType: 'modified',
            previousItemId: sourceItem.id,
          },
        ],
      },
      userId,
    )

    // 5. Update item with commitId
    await db
      .update(items)
      .set({ commitId: commit.id })
      .where(eq(items.id, workingCopy.id))

    return { workingCopy, branchItem }
  }

  /**
   * Find an existing working copy for an item on a branch (for idempotency).
   */
  private static async findExistingWorkingCopy(
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
    const validActions = await LifecycleService.getValidActions(
      itemType,
      state || 'Draft',
    )
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
  ): Promise<void> {
    const branch = await BranchService.getById(branchId)
    if (!branch || branch.branchType !== 'eco' || !branch.changeOrderItemId) {
      return
    }
    const changeOrderId = branch.changeOrderItemId

    const existing = await db
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

    const item = itemId ? await ItemService.findById(itemId) : null
    if (!item) return

    const changeAction = await this.inferChangeAction(item.itemType, item.state)
    if (!changeAction) return

    await db.insert(changeOrderAffectedItems).values({
      changeOrderId,
      affectedItemId: item.id,
      affectedItemMasterId: itemMasterId,
      changeAction,
      currentState: item.state,
      currentRevision: item.revision,
      isDirectlyAffected: true,
      createdBy: userId,
    })
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
   * Get workflow instance for a change order
   */
  static async getWorkflowInstance(changeOrderId: string) {
    const WorkflowService = await getWorkflowService()
    return WorkflowService.getInstanceByItemId(changeOrderId)
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
      // A missing workflow is a caller error, not a failed transition
      if (error instanceof NotFoundError) throw error
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
   */
  static async getEditableChangeOrders(options?: {
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
      eq(items.isDeleted, false),
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
    if (options?.designId) {
      query = query.innerJoin(
        changeOrderDesigns,
        eq(items.id, changeOrderDesigns.changeOrderId),
      )
      conditions.push(eq(changeOrderDesigns.designId, options.designId))
    }

    const results = await query
      .where(and(...conditions))
      .limit(options?.limit ?? 50)

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
      item.state || 'Draft',
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

      await db.insert(changeOrderAffectedItems).values({
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
    }

    return { branchItem, branch }
  }

  /**
   * Get ECO summary across all designs
   */
  static async getEcoSummary(changeOrderId: string): Promise<EcoSummary> {
    const changeOrder = await ItemService.findById(changeOrderId)
    if (!changeOrder) {
      throw new Error('Change order not found')
    }

    // Get all designs affected by this ECO
    const ecoDesigns = await db
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

    const designSummaries: Array<EcoDesignSummary> = []
    let totalItemsAffected = 0
    let canSubmit = true

    const affectedItems = await this.getAffectedItems(changeOrderId)
    const {
      byDesign: affectedCountByDesign,
      withoutDesign: itemsWithNoDesign,
    } = this.countAffectedItemsByDesign(affectedItems)

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
      canSubmit,
      canRelease,
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

    return LifecycleService.getValidActions(
      item.itemType,
      item.state || 'Draft',
    )
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
  totalItemsAffected: number
  canSubmit: boolean
  canRelease: boolean
}
