// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { ZodError } from 'zod'
import { db } from '../../db'
import { designs, items } from '../../db/schema'
import { NumberingService } from '../numbering'
import { ItemTypeRegistry } from '../registry'
import { getTypeHandler } from '../type-handlers'
import '../type-handlers/init'
import {
  BranchProtectionError,
  InternalError,
  NotFoundError,
  ValidationError,
} from '../../errors'
import { CommitService } from '../../services/CommitService'
import {
  computeFieldChanges,
  computeInitialFieldValues,
} from '../../services/CheckoutService'
import { BranchService } from '../../services/BranchService'
import { UsageService } from '../../services/UsageService'
import { notDeleted } from '../../db/filters'
import { ItemVersioningFacade } from './ItemVersioningFacade'
import { ItemSearchService } from './ItemSearchService'
import { ItemRelationshipService } from './ItemRelationshipService'
import type { TransactionClient } from '../../db'
import type { commits, itemRelationships } from '../../db/schema'
import type {
  ItemFilters,
  VersionContext,
} from '../../services/VersionResolver'
import type { ItemHistoryEntry } from '../../services/CommitService'
import type { BaseItem } from '../types/base'
import type { SearchCriteria, SearchResult } from './ItemSearchService'
import { itemLogger } from '@/lib/logging/logger'

export type { SearchCriteria, SearchResult } from './ItemSearchService'

/**
 * Service layer for item operations
 * Provides CRUD operations and business logic for all item types
 */
export class ItemService {
  /**
   * Create a new item
   *
   * In pre-release phase: Items can be created directly on main branch
   * In post-release phase: Items must be created on a workspace or ECO branch using createOnBranch()
   *
   * @param options.bypassBranchProtection - Skip branch protection check (for ECO operations or tests)
   */
  static async create<T extends BaseItem>(
    type: string,
    data: T,
    userId: string,
    options?: { bypassBranchProtection?: boolean },
  ): Promise<T> {
    const typeConfig = ItemTypeRegistry.getType(type)
    if (!typeConfig) {
      throw new NotFoundError('Item type', type, { operation: 'create' })
    }

    // Merge itemType into data before validation
    const dataWithType = { ...data, itemType: type }

    // Validate data against schema
    let validatedData: T
    try {
      validatedData = typeConfig.schema.parse(dataWithType) as T
    } catch (error) {
      if (error instanceof ZodError) {
        throw ValidationError.fromZodError(error, {
          operation: 'create',
          resource: type,
        })
      }
      throw error
    }

    // Handle item number generation
    if (!validatedData.itemNumber) {
      // Auto-generate item number
      let designCode: string | null = null
      if (validatedData.designId) {
        const design = await db.query.designs.findFirst({
          where: eq(designs.id, validatedData.designId),
          columns: { code: true },
        })
        designCode = design?.code ?? null
      }

      validatedData.itemNumber = await NumberingService.generate(type, {
        designId: validatedData.designId,
        designCode,
        fields: validatedData as unknown as Record<string, unknown>,
      })
    } else {
      // Manual entry - validate if allowed
      if (!NumberingService.allowsManualEntry(type)) {
        throw new ValidationError(
          `Manual item numbers are not allowed for ${type}`,
          undefined,
          { operation: 'create', resource: type },
        )
      }
      if (
        !NumberingService.validateManualNumber(type, validatedData.itemNumber)
      ) {
        throw new ValidationError(
          `Item number '${validatedData.itemNumber}' does not match the required format`,
          undefined,
          { operation: 'create', resource: type },
        )
      }
    }

    // Check branch protection if item is associated with a design
    // Skip this check if:
    // - bypassBranchProtection is true (for ECO operations or tests)
    // - Item is a ChangeOrder (workflow control objects are exempt from branch protection)
    const isChangeOrder = type === 'ChangeOrder'
    if (
      validatedData.designId &&
      !options?.bypassBranchProtection &&
      !isChangeOrder
    ) {
      const canEdit = await this.canEditDirectly(validatedData.designId)
      if (!canEdit.allowed) {
        throw new BranchProtectionError(
          `Cannot create ${type} directly on main branch: ${canEdit.reason}`,
          { operation: 'create', designId: validatedData.designId },
        )
      }
    }

    // Generate master ID for first revision
    const masterId = randomUUID()

    // Auto-assign sysmlType based on whether this is a usage or definition
    // If usageOf is set, this is a usage; otherwise it's a definition
    const isUsage = !!(validatedData as unknown as { usageOf?: string }).usageOf
    const sysmlType = UsageService.getSysmlType(type, isUsage)

    // Wrap all database operations in a transaction for atomicity
    return db.transaction(async (tx) => {
      // Insert base item
      const [item] = await tx
        .insert(items)
        .values({
          masterId,
          designId: validatedData.designId,
          itemNumber: validatedData.itemNumber!,
          revision: validatedData.revision,
          itemType: type,
          name: validatedData.name,
          state: validatedData.state || typeConfig.defaultState,
          attributes: (
            validatedData as unknown as { attributes?: Record<string, unknown> }
          ).attributes,
          isCurrent: true,
          sysmlType: sysmlType,
          usageOf: (validatedData as unknown as { usageOf?: string }).usageOf,
          createdBy: userId,
          modifiedBy: userId,
        })
        .returning()

      // Insert type-specific data
      await this.insertTypeSpecificData(type, item.id, validatedData, tx)

      // Create commit for history tracking if item has a designId
      // (items without designId are not tracked in version history)
      // Note: ChangeOrders are created WITHOUT designId - they're design-agnostic.
      if (item.designId && !isChangeOrder) {
        try {
          const fieldChanges = computeInitialFieldValues(
            { ...validatedData, state: item.state } as unknown as Record<
              string,
              unknown
            >,
            type,
          )

          const mainBranch = await BranchService.getMainBranch(item.designId)
          const targetBranchId = mainBranch?.id ?? null

          if (targetBranchId) {
            const commit = await CommitService.create(
              {
                branchId: targetBranchId,
                message: `${type} ${validatedData.itemNumber || 'item'} created`,
                itemChanges: [
                  {
                    itemId: item.id,
                    changeType: 'added',
                    fieldChanges,
                  },
                ],
              },
              userId,
              tx,
            )

            await tx
              .update(items)
              .set({ commitId: commit.id })
              .where(eq(items.id, item.id))
          }
        } catch (error) {
          // Log but don't fail - commit tracking is optional during pre-release
          itemLogger.warn(
            { err: error, itemId: item.id },
            'Failed to create commit for item',
          )
        }
      }

      return {
        ...validatedData,
        id: item.id,
        masterId: item.masterId,
        designId: item.designId,
        state: item.state,
        createdAt: item.createdAt,
        createdBy: item.createdBy,
        modifiedAt: item.modifiedAt,
        modifiedBy: item.modifiedBy,
      } as T
    })
  }

  /**
   * Update an existing item
   *
   * In pre-release phase: Items can be updated directly
   * In post-release phase: Items on protected main branch cannot be updated directly
   *   - Must checkout to ECO/workspace branch first using CheckoutService
   *   - Exception: ECO release operations can bypass this with bypassBranchProtection option
   *
   * @param options.skipCommit - Skip creating a commit for this update (for bulk operations)
   */
  static async update<T extends BaseItem>(
    id: string,
    data: Partial<T>,
    userId: string,
    options?: { bypassBranchProtection?: boolean; skipCommit?: boolean },
  ): Promise<T> {
    // Get current item with type-specific data (for computing field changes)
    const oldItem = await this.findById(id)

    if (!oldItem) {
      throw new NotFoundError('Item', id, { operation: 'update' })
    }

    // Check branch protection if item is associated with a design
    // Skip this check if:
    // - bypassBranchProtection is true (for ECO releases or tests)
    // - Item is a ChangeOrder (workflow control objects are exempt from branch protection)
    // - Item is on an ECO/workspace branch (working copies are editable)
    const isChangeOrder = oldItem.itemType === 'ChangeOrder'
    let branchInfo: {
      branchId: string
      branchName: string
      isLocked: boolean
    } | null = null

    if (
      oldItem.designId &&
      !options?.bypassBranchProtection &&
      !isChangeOrder
    ) {
      // First check if this item is on an ECO or workspace branch (working copy)
      branchInfo = await this.getItemBranchInfo(id)

      if (branchInfo) {
        // Item is on a non-main branch - check if the branch allows editing
        if (branchInfo.isLocked) {
          throw new BranchProtectionError(
            `Cannot update item: Branch "${branchInfo.branchName}" is locked (ECO submitted for approval)`,
            { operation: 'update', itemId: id, branchId: branchInfo.branchId },
          )
        }
        // ECO and workspace branches allow direct editing (unless locked)
        // Skip the canEditDirectly check since we're on an editable branch
      } else {
        // Item is NOT on an ECO/workspace branch - check main branch protection
        const canEdit = await this.canEditDirectly(oldItem.designId)
        if (!canEdit.allowed) {
          throw new BranchProtectionError(
            `Cannot update item directly: ${canEdit.reason}`,
            { operation: 'update', itemId: id, designId: oldItem.designId },
          )
        }
      }
    }

    const typeConfig = ItemTypeRegistry.getType(oldItem.itemType)
    if (!typeConfig) {
      throw new NotFoundError('Item type', oldItem.itemType, {
        operation: 'update',
      })
    }

    // Wrap all database operations in a transaction for atomicity
    return db.transaction(async (tx) => {
      // Update base item - only update fields that are provided
      const updateData: any = {
        modifiedBy: userId,
        modifiedAt: new Date(),
      }

      if (data.name !== undefined) updateData.name = data.name
      if (data.state !== undefined) updateData.state = data.state
      if (data.designId !== undefined) updateData.designId = data.designId
      if ((data as any).revision !== undefined)
        updateData.revision = (data as any).revision
      if ((data as any).isCurrent !== undefined)
        updateData.isCurrent = (data as any).isCurrent
      if (
        (data as unknown as { attributes?: Record<string, unknown> })
          .attributes !== undefined
      ) {
        updateData.attributes = (
          data as unknown as { attributes?: Record<string, unknown> }
        ).attributes
      }

      await tx.update(items).set(updateData).where(eq(items.id, id))

      // Update type-specific data
      await this.updateTypeSpecificData(oldItem.itemType, id, data, tx)

      // Fetch complete item with type-specific data
      // Must use tx to see uncommitted changes within this transaction
      const completeItem = await this.findById(id, tx)

      if (!completeItem) {
        throw new InternalError('Failed to fetch updated item', undefined, {
          operation: 'update',
          itemId: id,
        })
      }

      // Create commit for history tracking if item has a designId and skipCommit is not set
      if (oldItem.designId && !options?.skipCommit) {
        try {
          const fieldChanges = computeFieldChanges(
            oldItem as unknown as Record<string, unknown>,
            completeItem as unknown as Record<string, unknown>,
            oldItem.itemType,
          )

          if (fieldChanges.length > 0) {
            let branchId: string | null = null

            if (branchInfo) {
              branchId = branchInfo.branchId
            } else {
              const mainBranch = await BranchService.getMainBranch(
                oldItem.designId,
              )
              branchId = mainBranch?.id || null
            }

            if (branchId) {
              const commit = await CommitService.create(
                {
                  branchId,
                  message: `${oldItem.itemType} ${oldItem.itemNumber || 'item'} updated`,
                  itemChanges: [
                    {
                      itemId: id,
                      changeType: 'modified',
                      fieldChanges,
                    },
                  ],
                },
                userId,
                tx,
              )

              await tx
                .update(items)
                .set({ commitId: commit.id })
                .where(eq(items.id, id))
            }
          }
        } catch (error) {
          itemLogger.warn(
            { err: error, itemId: id },
            'Failed to create commit for item update',
          )
        }
      }

      return completeItem as T
    })
  }

  /**
   * Delete an item
   */
  static async delete(id: string): Promise<void> {
    await db.delete(items).where(eq(items.id, id))
  }

  /**
   * Create a new revision of an item
   */
  static async revise(
    id: string,
    newRevision: string,
    userId: string,
  ): Promise<BaseItem> {
    // Wrap all revision operations in a transaction for atomicity
    return db.transaction(async (tx) => {
      // Get current item
      const result = await tx
        .select()
        .from(items)
        .where(eq(items.id, id))
        .limit(1)
      const currentItem = result.at(0)

      if (!currentItem) {
        throw new NotFoundError('Item', id, { operation: 'revise' })
      }

      // Mark current item as not current
      await tx
        .update(items)
        .set({ isCurrent: false })
        .where(eq(items.masterId, currentItem.masterId))

      // Get type-specific data
      const typeSpecificData = await this.getTypeSpecificData(
        currentItem.itemType,
        id,
      )

      // Create new revision
      const [newItem] = await tx
        .insert(items)
        .values({
          masterId: currentItem.masterId,
          itemNumber: currentItem.itemNumber,
          revision: newRevision,
          itemType: currentItem.itemType,
          name: currentItem.name,
          state: 'Draft',
          isCurrent: true,
          attributes: currentItem.attributes || {},
          sysmlType: currentItem.sysmlType,
          metamodel: currentItem.metamodel,
          usageOf: currentItem.usageOf,
          createdBy: userId,
          modifiedBy: userId,
        })
        .returning()

      // Copy type-specific data
      if (typeSpecificData) {
        await this.insertTypeSpecificData(
          currentItem.itemType,
          newItem.id,
          typeSpecificData,
          tx,
        )
      }

      return {
        ...newItem,
        name: newItem.name,
        isCurrent: newItem.isCurrent ?? undefined,
        lockedBy: newItem.lockedBy ?? undefined,
        lockedAt: newItem.lockedAt ?? undefined,
      } as BaseItem
    })
  }

  /**
   * Find an item by ID
   */
  static async findById(
    id: string,
    tx?: TransactionClient,
  ): Promise<BaseItem | null> {
    const run = tx ?? db
    const result = await run
      .select()
      .from(items)
      .where(and(eq(items.id, id), notDeleted()))
      .limit(1)
    const item = result.at(0)

    if (!item) {
      return null
    }

    const typeSpecificData = await this.getTypeSpecificData(
      item.itemType,
      id,
      tx,
    )

    return {
      ...item,
      ...typeSpecificData,
    }
  }

  /**
   * Find an item by number and optionally revision
   */
  static async findByNumber(
    itemNumber: string,
    revision?: string,
  ): Promise<BaseItem | null> {
    const query = revision
      ? and(
          eq(items.itemNumber, itemNumber),
          eq(items.revision, revision),
          notDeleted(),
        )
      : and(
          eq(items.itemNumber, itemNumber),
          eq(items.isCurrent, true),
          notDeleted(),
        )

    const result = await db.select().from(items).where(query).limit(1)
    const item = result.at(0)

    if (!item) {
      return null
    }

    const typeSpecificData = await this.getTypeSpecificData(
      item.itemType,
      item.id,
    )

    return {
      ...item,
      ...typeSpecificData,
    }
  }

  /**
   * Search items
   *
   * By default, only returns current items (isCurrent=true) to avoid showing
   * both master items and working copies. Set currentOnly=false to include all.
   *
   * Use definitionsOnly=true for global pages (/parts, /documents) to show only
   * definitions (canonical items) and exclude usages. Combine with includeUsageCount=true
   * to show how many designs use each definition.
   *
   * Supports server-side sorting, column filters, and global search for efficient
   * pagination over large datasets.
   */
  static async search<T = any>(
    type: string,
    criteria: SearchCriteria,
  ): Promise<SearchResult<T>> {
    return ItemSearchService.search<T>(type, criteria)
  }

  /**
   * Search for items by item number or name
   * @delegate ItemSearchService.searchByItemNumber
   */
  static async searchByItemNumber(
    query: string,
    options?: {
      limit?: number
      itemTypes?: Array<string>
      currentOnly?: boolean
      designIds?: Array<string>
    },
  ): Promise<Array<BaseItem>> {
    return ItemSearchService.searchByItemNumber(query, options)
  }

  /**
   * Get items related to a specific item
   * @delegate ItemRelationshipService.getRelated
   */
  static async getRelated(
    id: string,
    relationshipType?: string,
  ): Promise<Array<BaseItem>> {
    return ItemRelationshipService.getRelated(id, relationshipType)
  }

  /**
   * Get relationships with full details (including relationship metadata)
   * @delegate ItemRelationshipService.getRelationshipsWithDetails
   */
  static async getRelationshipsWithDetails(
    id: string,
    relationshipType?: string,
  ) {
    return ItemRelationshipService.getRelationshipsWithDetails(
      id,
      relationshipType,
    )
  }

  /**
   * Add a relationship between items
   * @delegate ItemRelationshipService.addRelationship
   */
  static async addRelationship(
    sourceId: string,
    targetId: string,
    relationshipType: string,
    userId: string,
    data?: {
      quantity?: string
      referenceDesignator?: string
      findNumber?: number
    },
  ): Promise<typeof itemRelationships.$inferSelect> {
    return ItemRelationshipService.addRelationship(
      sourceId,
      targetId,
      relationshipType,
      userId,
      data,
    )
  }

  /**
   * Remove a relationship between items
   * @delegate ItemRelationshipService.removeRelationship
   */
  static async removeRelationship(
    relationshipId: string,
    userId?: string,
  ): Promise<void> {
    return ItemRelationshipService.removeRelationship(relationshipId, userId)
  }

  /**
   * Update a relationship's properties (quantity, referenceDesignator, findNumber)
   * @delegate ItemRelationshipService.updateRelationship
   */
  static async updateRelationship(
    relationshipId: string,
    userId: string,
    data: {
      quantity?: string | null
      referenceDesignator?: string | null
      findNumber?: number | null
    },
  ): Promise<typeof itemRelationships.$inferSelect> {
    return ItemRelationshipService.updateRelationship(
      relationshipId,
      userId,
      data,
    )
  }

  /**
   * Get unique relationship types for an item
   * @delegate ItemRelationshipService.getRelationshipTypes
   */
  static async getRelationshipTypes(id: string): Promise<Array<string>> {
    return ItemRelationshipService.getRelationshipTypes(id)
  }

  // Private helper methods

  /** @internal Used by ItemVersioningFacade */
  static async insertTypeSpecificData(
    type: string,
    itemId: string,
    data: any,
    tx?: TransactionClient,
  ): Promise<void> {
    const handler = getTypeHandler(type)
    if (!handler) {
      throw new InternalError(`No type handler registered for "${type}"`)
    }
    await handler.insert(itemId, data, tx)
  }

  /** @internal Used by ItemVersioningFacade */
  static async getTypeSpecificData(
    type: string,
    itemId: string,
    tx?: TransactionClient,
  ): Promise<any> {
    const handler = getTypeHandler(type)
    if (!handler) return null
    return handler.get(itemId, tx)
  }

  private static async updateTypeSpecificData(
    type: string,
    itemId: string,
    data: any,
    tx?: TransactionClient,
  ): Promise<void> {
    const handler = getTypeHandler(type)
    if (!handler) return
    await handler.update(itemId, data, tx)
  }

  // ============================================================================
  // Versioning Methods — delegated to ItemVersioningFacade
  // ============================================================================

  /** @see ItemVersioningFacade.getAtContext */
  static async getAtContext(
    itemMasterId: string,
    designId: string,
    context: VersionContext,
  ): Promise<BaseItem | null> {
    return ItemVersioningFacade.getAtContext(itemMasterId, designId, context)
  }

  /** @see ItemVersioningFacade.listAtContext */
  static async listAtContext(
    designId: string,
    context: VersionContext,
    filters?: ItemFilters,
  ): Promise<{ items: Array<BaseItem>; total: number }> {
    return ItemVersioningFacade.listAtContext(designId, context, filters)
  }

  /** @see ItemVersioningFacade.getHistory */
  static async getHistory(
    itemMasterId: string,
    designId: string,
    options?: {
      untilCommitId?: string
      branchId?: string
    },
  ): Promise<Array<ItemHistoryEntry>> {
    return ItemVersioningFacade.getHistory(itemMasterId, designId, options)
  }

  /** @see ItemVersioningFacade.diff */
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
    return ItemVersioningFacade.diff(itemId1, itemId2)
  }

  /** @see ItemVersioningFacade.createOnBranch */
  static async createOnBranch(
    type: string,
    data: BaseItem,
    branchId: string,
    commitMessage: string,
    userId: string,
  ): Promise<{ item: BaseItem; commit: typeof commits.$inferSelect }> {
    return ItemVersioningFacade.createOnBranch(
      type,
      data,
      branchId,
      commitMessage,
      userId,
    )
  }

  /** @see ItemVersioningFacade.deleteOnBranch */
  static async deleteOnBranch(
    itemMasterId: string,
    branchId: string,
    commitMessage: string,
    userId: string,
  ): Promise<typeof commits.$inferSelect> {
    return ItemVersioningFacade.deleteOnBranch(
      itemMasterId,
      branchId,
      commitMessage,
      userId,
    )
  }

  // ============================================================================
  // Branch Protection Methods — delegated to ItemVersioningFacade
  // ============================================================================

  /** @see ItemVersioningFacade.canEditDirectly */
  static async canEditDirectly(designId: string): Promise<{
    allowed: boolean
    reason?: string
    requiresCheckout: boolean
  }> {
    return ItemVersioningFacade.canEditDirectly(designId)
  }

  /** @see ItemVersioningFacade.getItemBranchInfo */
  static async getItemBranchInfo(itemId: string): Promise<{
    branchId: string
    branchName: string
    branchType: string
    isLocked: boolean
  } | null> {
    return ItemVersioningFacade.getItemBranchInfo(itemId)
  }

  /** @see ItemVersioningFacade.requiresCheckout */
  static requiresCheckout(item: BaseItem): boolean {
    return ItemVersioningFacade.requiresCheckout(item)
  }

  /** @see ItemVersioningFacade.canEditItemDirectly */
  static canEditItemDirectly(item: BaseItem): boolean {
    return ItemVersioningFacade.canEditItemDirectly(item)
  }
}
