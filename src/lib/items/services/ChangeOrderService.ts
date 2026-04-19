// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

import { and, eq, isNotNull, isNull, or, sql } from 'drizzle-orm'
import { db } from '../../db'
import {
  branchItems,
  changeOrderAffectedItems,
  changeOrderDesigns,
  changeOrderImpactReports,
  changeOrderImpactedItems,
  changeOrderRisks,
  changeOrders,
  designs,
  documents,
  items,
  parts,
  requirements,
  workflowInstances,
} from '../../db/schema'
import { BranchService } from '../../services/BranchService'
import { CheckoutService } from '../../services/CheckoutService'
import { CommitService } from '../../services/CommitService'
import { DesignService } from '../../services/DesignService'
import { ChangeOrderMergeService } from '../../services/ChangeOrderMergeService'
import { LifecycleService } from '../../services/LifecycleService'
import { RevisionService } from '../../services/RevisionService'
import { ValidationError } from '../../errors'
import { ItemService } from './ItemService'
import type { branches } from '../../db/schema'
import type {
  AffectedItem,
  ChangeAction,
  ImpactReport,
  Risk,
} from '../types/change-order'

// Lazy-cached dynamic imports to avoid circular dependencies
// (same pattern as src/lib/items/registry.ts)
import type { WorkflowService as WorkflowServiceType } from '../../workflows/WorkflowService'
import type { ConflictDetectionService as ConflictDetectionServiceType } from '../../services/ConflictDetectionService'
import type { ItemTypeRegistry as ItemTypeRegistryType } from '../registry'

export interface AffectedItemInput {
  affectedItemId?: string | null
  affectedItemMasterId?: string | null
  changeAction: ChangeAction
  currentState?: string | null
  currentRevision?: string | null
  targetState?: string | null
  targetRevision?: string | null
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
    let targetRevision = item.targetRevision || null

    // If we have an affectedItemId, check if the item belongs to a design
    // and auto-create the changeOrderDesigns record
    if (item.affectedItemId) {
      affectedItem = await ItemService.findById(item.affectedItemId)

      // Validate that the change action is valid for this item's current state
      if (affectedItem) {
        const validation = await LifecycleService.canApplyAction(
          affectedItem.itemType,
          affectedItem.state || 'Draft',
          item.changeAction,
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
        // Auto-associate all other designs containing usage copies of this part
        if (affectedItem.id) {
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

    // For 'promote' action, calculate target revision based on phase scheme
    if (item.changeAction === 'promote' && affectedItem) {
      const lifecycle = await LifecycleService.getLifecycleForItemType(
        affectedItem.itemType,
      )
      if (lifecycle) {
        const promoteMapping = lifecycle.changeActionMappings.promote
        if (promoteMapping) {
          const toPhase = LifecycleService.getPhaseForState(
            lifecycle,
            promoteMapping.toState,
          )
          const shouldReset =
            promoteMapping.resetRevision ?? toPhase?.resetRevisionOnEntry
          const targetScheme = LifecycleService.getRevisionSchemeForState(
            lifecycle,
            promoteMapping.toState,
          )

          if (shouldReset) {
            targetRevision = RevisionService.getInitialRevision(targetScheme)
          } else if (promoteMapping.assignsRevision) {
            targetRevision = RevisionService.getNextRevision(
              affectedItem.revision,
              targetScheme,
            )
          }
        }
      }
    }

    // For 'revise' action on Released items with a design, create a working copy
    if (
      item.changeAction === 'revise' &&
      affectedItem &&
      affectedItem.state === 'Released' &&
      ecoDesign?.branchId
    ) {
      // Calculate target revision if not provided
      const reviseScheme = await LifecycleService.getRevisionScheme(
        affectedItem.itemType,
      )
      targetRevision =
        item.targetRevision ||
        RevisionService.getNextRevision(affectedItem.revision, reviseScheme)

      // Check if working copy already exists on this branch (idempotency)
      const existingWorkingCopy = await this.findExistingWorkingCopy(
        affectedItem.masterId!,
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

    const [affectedItemRecord] = await db
      .insert(changeOrderAffectedItems)
      .values({
        changeOrderId,
        affectedItemId: item.affectedItemId || null,
        affectedItemMasterId:
          item.affectedItemMasterId || (affectedItem?.masterId ?? null),
        changeAction: item.changeAction,
        currentState: item.currentState || null,
        currentRevision: item.currentRevision || null,
        targetState: item.targetState || null,
        targetRevision,
        replacementItemId: item.replacementItemId || null,
        newItemData: item.newItemData || null,
        newItemType: item.newItemType || null,
        changeDescription: item.changeDescription || null,
        workingCopyId,
        createdBy: userId,
      })
      .returning()

    return affectedItemRecord as AffectedItem
  }

  /**
   * Add multiple affected items to a change order in a batch.
   * Used for parent propagation when adding nested items.
   */
  static async addAffectedItemsBatch(
    changeOrderId: string,
    itemsToAdd: Array<AffectedItemInput>,
    userId: string,
  ): Promise<Array<AffectedItem>> {
    // Wrap the entire batch in a transaction for all-or-nothing semantics
    return db.transaction(async () => {
      const results: Array<AffectedItem> = []

      for (const item of itemsToAdd) {
        // Check if item is already in the ECO
        if (item.affectedItemId) {
          const existing = await db
            .select()
            .from(changeOrderAffectedItems)
            .where(
              and(
                eq(changeOrderAffectedItems.changeOrderId, changeOrderId),
                eq(
                  changeOrderAffectedItems.affectedItemId,
                  item.affectedItemId,
                ),
              ),
            )
            .limit(1)

          if (existing.length > 0) {
            results.push(existing[0] as AffectedItem)
            continue
          }
        }

        const affectedItem = await this.addAffectedItem(
          changeOrderId,
          item,
          userId,
        )
        results.push(affectedItem)
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
    options?: { skipCount?: boolean },
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

    if (existing.at(0)) {
      // Update itemsAffected count (skip for cross-design associations)
      if (!options?.skipCount) {
        await db
          .update(changeOrderDesigns)
          .set({
            itemsAffected: sql`${changeOrderDesigns.itemsAffected} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(changeOrderDesigns.id, existing[0].id))
      }
      return existing[0]
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
    const [ecoDesign] = await db
      .insert(changeOrderDesigns)
      .values({
        changeOrderId,
        designId,
        branchId: branch.id,
        mergeStatus: 'pending',
        itemsAffected: options?.skipCount ? 0 : 1,
      })
      .returning()

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
        await this.ensureDesignAssociation(
          changeOrderId,
          row.designId,
          userId,
          { skipCount: true },
        )
      }
    }
  }

  /**
   * Copy type-specific data from one item to another within a transaction.
   * Used when creating revision working copies.
   */
  private static async copyTypeSpecificDataTx(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    itemType: string,
    sourceId: string,
    targetId: string,
  ): Promise<void> {
    switch (itemType) {
      case 'Part': {
        const [sourcePart] = await tx
          .select()
          .from(parts)
          .where(eq(parts.itemId, sourceId))
          .limit(1)
        if (sourcePart) {
          await tx
            .insert(parts)
            .values({
              itemId: targetId,
              description: sourcePart.description,
              partType: sourcePart.partType,
              material: sourcePart.material,
              weight: sourcePart.weight,
              weightUnit: sourcePart.weightUnit,
              cost: sourcePart.cost,
              costCurrency: sourcePart.costCurrency,
              leadTimeDays: sourcePart.leadTimeDays,
              quantityOnHand: sourcePart.quantityOnHand,
              reorderPoint: sourcePart.reorderPoint,
              location: sourcePart.location,
            })
            .onConflictDoNothing()
        }
        break
      }
      case 'Document': {
        const [sourceDoc] = await tx
          .select()
          .from(documents)
          .where(eq(documents.itemId, sourceId))
          .limit(1)
        if (sourceDoc) {
          await tx
            .insert(documents)
            .values({
              itemId: targetId,
              description: sourceDoc.description,
              fileId: sourceDoc.fileId,
              fileName: sourceDoc.fileName,
              fileSize: sourceDoc.fileSize,
              mimeType: sourceDoc.mimeType,
              storagePath: sourceDoc.storagePath,
            })
            .onConflictDoNothing()
        }
        break
      }
      case 'Requirement': {
        const [sourceReq] = await tx
          .select()
          .from(requirements)
          .where(eq(requirements.itemId, sourceId))
          .limit(1)
        if (sourceReq) {
          await tx
            .insert(requirements)
            .values({
              itemId: targetId,
              description: sourceReq.description,
              type: sourceReq.type,
              priority: sourceReq.priority,
              status: sourceReq.status,
              acceptanceCriteria: sourceReq.acceptanceCriteria,
              source: sourceReq.source,
              category: sourceReq.category,
            })
            .onConflictDoNothing()
        }
        break
      }
      // Tasks and ChangeOrders typically aren't revised via this flow
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
  private static async createRevisionWorkingCopy(
    sourceItem: typeof items.$inferSelect,
    branchId: string,
    userId: string,
  ): Promise<{
    workingCopy: typeof items.$inferSelect
    branchItem: typeof branchItems.$inferSelect
  }> {
    // Get initial state from lifecycle config, fallback to 'Draft'
    const initialState = await LifecycleService.getInitialState(
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

      const [wc] = await tx.insert(items).values(workingCopyData).returning()

      // 2. Copy type-specific data (parts table, documents table, etc.)
      await this.copyTypeSpecificDataTx(
        tx,
        sourceItem.itemType,
        sourceItem.id,
        wc.id,
      )

      // 3. Create branchItem entry to track this on the ECO branch
      const [bi] = await tx
        .insert(branchItems)
        .values({
          branchId,
          itemMasterId: sourceItem.masterId,
          currentItemId: wc.id,
          baseItemId: sourceItem.id, // The Released version we're revising from
          changeType: 'modified',
        })
        .returning()

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
   * Remove an affected item from a change order
   */
  static async removeAffectedItem(affectedItemId: string): Promise<void> {
    await db
      .delete(changeOrderAffectedItems)
      .where(eq(changeOrderAffectedItems.id, affectedItemId))
  }

  /**
   * Update an affected item
   */
  static async updateAffectedItem(
    affectedItemId: string,
    updates: Partial<AffectedItemInput>,
  ): Promise<AffectedItem> {
    const [updated] = await db
      .update(changeOrderAffectedItems)
      .set(updates)
      .where(eq(changeOrderAffectedItems.id, affectedItemId))
      .returning()

    return updated as AffectedItem
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
  static async acknowledgeRisk(riskId: string, userId: string): Promise<void> {
    await db
      .update(changeOrderRisks)
      .set({
        acknowledgedBy: userId,
        acknowledgedAt: new Date(),
      })
      .where(eq(changeOrderRisks.id, riskId))
  }

  /**
   * Validate a release action
   */
  static async validateRelease(itemId: string): Promise<ValidationResult> {
    const item = await ItemService.findById(itemId)

    if (!item) {
      return {
        valid: false,
        severity: 'error',
        message: 'Item not found',
      }
    }

    // Check if already released
    if (item.state === 'Released') {
      return {
        valid: false,
        severity: 'error',
        message: 'Item is already released. Use "revise" action instead.',
      }
    }

    // Check if item has BOM and all children are released
    if (item.itemType === 'Part') {
      const bomChildren = await ItemService.getRelated(itemId, 'BOM')
      const unreleased = bomChildren.filter((c) => c.state !== 'Released')

      if (unreleased.length > 0) {
        return {
          valid: false,
          severity: 'warning',
          message: `${unreleased.length} BOM components are not released`,
          affectedItems: unreleased
            .map((u) => u.itemNumber)
            .filter((n): n is string => n !== undefined),
          suggestion: 'Add these items to change order with "release" action',
        }
      }
    }

    // Check for required documents
    const docs = await ItemService.getRelated(itemId, 'Document')
    if (docs.length === 0) {
      return {
        valid: true,
        severity: 'warning',
        message:
          'No documents attached - consider adding drawings/specs before release',
      }
    }

    return { valid: true, severity: 'info', message: 'Ready to release' }
  }

  /**
   * Validate an obsolescence action
   */
  static async validateObsolescence(
    itemId: string,
    replacementId?: string,
  ): Promise<ValidationResult> {
    // Get where-used information using recursive query
    const whereUsed = await db.execute(sql`
      WITH RECURSIVE where_used AS (
        SELECT
          r.source_id as parent_id,
          i.item_number,
          i.state,
          1 as depth
        FROM item_relationships r
        JOIN items i ON i.id = r.source_id
        WHERE r.target_id = ${itemId}
          AND r.relationship_type = 'BOM'
          AND i.is_current = true

        UNION ALL

        SELECT
          r.source_id,
          i.item_number,
          i.state,
          wu.depth + 1
        FROM item_relationships r
        JOIN items i ON i.id = r.source_id
        JOIN where_used wu ON wu.parent_id = r.target_id
        WHERE wu.depth < 10
          AND r.relationship_type = 'BOM'
          AND i.is_current = true
      )
      SELECT * FROM where_used WHERE state = 'Released'
    `)

    const activeUsage = whereUsed

    if (activeUsage.length > 0 && !replacementId) {
      return {
        valid: false,
        severity: 'error',
        message: `Cannot obsolete: item is used in ${activeUsage.length} released assemblies without replacement`,
        affectedItems: activeUsage.map((a: any) => a.item_number),
      }
    }

    return {
      valid: true,
      severity: replacementId ? 'info' : 'warning',
      message: replacementId
        ? `Will replace with ${replacementId} in ${activeUsage.length} assemblies`
        : `Item not currently used in released assemblies, safe to obsolete`,
    }
  }

  /**
   * Submit a change order for review (move from Draft to InReview via workflow)
   * Uses the workflow system to ensure proper state transitions and guard evaluation
   *
   * Note: The simplified ECO workflow goes directly from Draft → InReview (no Submitted state)
   */
  static async submit(changeOrderId: string, userId: string): Promise<void> {
    // Check if there are affected items
    const affectedItems = await this.getAffectedItems(changeOrderId)
    if (affectedItems.length === 0) {
      throw new Error('Cannot submit change order without affected items')
    }

    // Transition via workflow (validates guards and records history)
    // Goes directly to InReview in simplified workflow
    const result = await this.transitionWorkflow(
      changeOrderId,
      'InReview',
      userId,
    )
    if (!result.success) {
      throw new Error(result.error || 'Failed to submit change order')
    }

    // Update change order metadata
    await db
      .update(changeOrders)
      .set({ submittedAt: new Date() })
      .where(eq(changeOrders.itemId, changeOrderId))
  }

  /**
   * Approve a change order via workflow
   * Transitions to 'Approved' state and records approval metadata
   */
  static async approve(
    changeOrderId: string,
    userId: string,
    comments?: string,
  ): Promise<{ changeOrder: any }> {
    // Check if critical risks are acknowledged
    const risks = await this.getRisks(changeOrderId)
    const unacknowledgedCritical = risks.filter(
      (r) =>
        r.severity === 'critical' &&
        r.requiresAcknowledgement &&
        !r.acknowledgedBy,
    )

    if (unacknowledgedCritical.length > 0) {
      throw new Error(
        `Cannot approve: ${unacknowledgedCritical.length} critical risks require acknowledgement`,
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
        `Cannot approve: ${blockingConflicts.length} blocking conflict(s) detected. Resolve conflicts before approval.`,
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

    // Transition via workflow (validates guards, records history, executes lifecycle effects)
    const result = await this.transitionWorkflow(
      changeOrderId,
      'Approved',
      userId,
      comments,
    )
    if (!result.success) {
      throw new Error(result.error || 'Failed to approve change order')
    }

    // Update change order metadata
    await db
      .update(changeOrders)
      .set({
        approvedAt: new Date(),
        approvedBy: userId,
      })
      .where(eq(changeOrders.itemId, changeOrderId))

    // NOTE: Release is now a separate step, handled by the 'Release' transition

    const changeOrder = await ItemService.findById(changeOrderId)
    return { changeOrder }
  }

  /**
   * Reject a change order via workflow
   * Transitions to 'Rejected' state with optional reason
   */
  static async reject(
    changeOrderId: string,
    userId: string,
    reason?: string,
  ): Promise<void> {
    // Transition via workflow (validates guards and records history with reason)
    const result = await this.transitionWorkflow(
      changeOrderId,
      'Rejected',
      userId,
      reason,
    )
    if (!result.success) {
      throw new Error(result.error || 'Failed to reject change order')
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
   * Get workflow instance for a change order
   */
  static async getWorkflowInstance(changeOrderId: string) {
    const WorkflowService = await getWorkflowService()
    return WorkflowService.getInstanceByItemId(changeOrderId)
  }

  /**
   * Transition a change order's workflow
   */
  static async transitionWorkflow(
    changeOrderId: string,
    toStateId: string,
    userId: string,
    comments?: string,
  ) {
    const WorkflowService = await getWorkflowService()

    // Get the workflow instance
    const instance = await WorkflowService.getInstanceByItemId(changeOrderId)
    if (!instance) {
      throw new Error('No workflow found for this change order')
    }

    // Execute the transition
    const result = await WorkflowService.transition(
      instance.id,
      toStateId,
      userId,
      comments,
    )

    return result
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
    changeType: 'ECO' | 'ECN' | 'Deviation' | 'MCO',
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
      ) as typeof query
      conditions.push(eq(changeOrderDesigns.designId, options.designId))
    }

    const results = await query
      .where(and(...conditions))
      .limit(options?.limit ?? 50)

    return results.map((r) => ({
      id: r.id,
      itemNumber: r.itemNumber,
      name: r.name ?? '',
      state: r.state ?? 'Draft',
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
      const [newEcoDesign] = await db
        .insert(changeOrderDesigns)
        .values({
          changeOrderId,
          designId: item.designId,
          branchId: branch.id,
          mergeStatus: 'pending',
          itemsAffected: 1,
        })
        .returning()
      ecoDesign = newEcoDesign
    } else if (!ecoDesign.branchId && created) {
      // Update the branchId if it was just created
      await db
        .update(changeOrderDesigns)
        .set({
          branchId: branch.id,
          itemsAffected: (ecoDesign.itemsAffected || 0) + 1,
          updatedAt: new Date(),
        })
        .where(eq(changeOrderDesigns.id, ecoDesign.id))
    }

    // 6. For Released items on ECO branches, create a working copy for revision
    // This is different from a simple checkout - we're preparing for a revision
    let branchItem: typeof branchItems.$inferSelect
    let workingCopyId: string | null = null

    if (item.state === 'Released') {
      // Check if working copy already exists
      const existingWorkingCopy = await this.findExistingWorkingCopy(
        item.masterId!,
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
              eq(branchItems.itemMasterId, item.masterId!),
            ),
          )
          .limit(1)
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
    } else {
      // For non-released items, use standard checkout
      branchItem = await CheckoutService.checkout(
        {
          itemMasterId: item.masterId!,
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
          eq(changeOrderAffectedItems.affectedItemMasterId, item.masterId!),
        ),
      )
      .limit(1)

    if (!existingAffected.at(0)) {
      await db.insert(changeOrderAffectedItems).values({
        changeOrderId,
        affectedItemId: itemId,
        affectedItemMasterId: item.masterId!,
        changeAction: item.state === 'Released' ? 'revise' : 'release',
        currentState: item.state,
        currentRevision: item.revision,
        targetRevision: item.state === 'Released' ? undefined : 'A',
        workingCopyId,
        isDirectlyAffected: true,
        createdBy: userId,
      })

      // Update itemsAffected count
      await db
        .update(changeOrderDesigns)
        .set({
          itemsAffected: sql`${changeOrderDesigns.itemsAffected} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(changeOrderDesigns.id, ecoDesign.id))
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

    for (const { ecoDesign, design } of ecoDesigns) {
      if (!ecoDesign.branchId) {
        designSummaries.push({
          designId: ecoDesign.designId,
          designCode: design?.code || 'Unknown',
          designName: design?.name || design?.code || 'Unknown',
          branch: null,
          itemsAffected: ecoDesign.itemsAffected || 0,
          itemsModified: 0,
          itemsAdded: 0,
          itemsDeleted: 0,
          hasCheckedOutItems: false,
        })
        totalItemsAffected += ecoDesign.itemsAffected || 0
        continue
      }

      // Get branch details
      const branch = await BranchService.getById(ecoDesign.branchId)

      // Count changes on this branch
      const branchItemCounts = await db
        .select({
          changeType: branchItems.changeType,
        })
        .from(branchItems)
        .where(eq(branchItems.branchId, ecoDesign.branchId))

      let itemsModified = 0
      let itemsAdded = 0
      let itemsDeleted = 0
      for (const bi of branchItemCounts) {
        if (bi.changeType === 'modified') itemsModified++
        else if (bi.changeType === 'added') itemsAdded++
        else if (bi.changeType === 'deleted') itemsDeleted++
      }

      // Check for checked out items (items that are not checked in)
      const checkedOutItems = await db
        .select()
        .from(branchItems)
        .where(
          and(
            eq(branchItems.branchId, ecoDesign.branchId),
            isNotNull(branchItems.checkedOutBy),
          ),
        )

      if (checkedOutItems.length > 0) {
        canSubmit = false
      }

      designSummaries.push({
        designId: ecoDesign.designId,
        designCode: design?.code || 'Unknown',
        designName: design?.name || design?.code || 'Unknown',
        branch,
        itemsAffected: ecoDesign.itemsAffected || 0,
        itemsModified,
        itemsAdded,
        itemsDeleted,
        hasCheckedOutItems: checkedOutItems.length > 0,
      })

      totalItemsAffected += ecoDesign.itemsAffected || 0
    }

    const canRelease = changeOrder.state === 'Approved'

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

    if (existing.at(0)) {
      return existing[0]
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
    const [ecoDesign] = await db
      .insert(changeOrderDesigns)
      .values({
        changeOrderId,
        designId,
        branchId: branch.id,
        mergeStatus: 'pending',
        itemsAffected: 0,
      })
      .returning()

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
