// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { ZodError } from 'zod'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { designs } from '../../db/schema'
import { NotFoundError, ValidationError } from '../../errors'
import { VersionResolver } from '../../services/VersionResolver'
import { CheckoutService } from '../../services/CheckoutService'
import { BranchService } from '../../services/BranchService'
import { LifecycleService } from '../../services/LifecycleService'
import { NumberingService } from '../numbering'
import { ItemTypeRegistry } from '../registry'
import type { commits } from '../../db/schema'
import type {
  ItemFilters,
  VersionContext,
} from '../../services/VersionResolver'
import type { BaseItem } from '../types/base'

/**
 * Reading and writing items at a point in version history: resolve an item (or
 * a list) at a branch/commit/tag, diff two versions, create one on a branch.
 *
 * Extracted from ItemService to keep versioning logic separate from core CRUD.
 * Permission to edit is a different question and lives in `ItemEditPolicy`;
 * pure forwards to `CommitService`/`CheckoutService` live on `ItemService`
 * directly, so this file holds only versioning operations with logic of their
 * own.
 *
 * Despite the name this is not a facade over `ItemService` — it calls back into
 * it (`getTypeSpecificData`, `findById`, `insertTypeSpecificData`) through
 * `await import()`, because `ItemService` imports this module statically. The
 * dynamic imports are what break that cycle; do not make them static.
 *
 * **Internal to `ItemService`.** Nothing else references this class and it is
 * not re-exported from any barrel — `ItemService` re-exports the same public
 * API, and every one of the call sites in the codebase goes through it, which
 * is what `docs/architecture` and CLAUDE.md's service table both point callers
 * at. Keep it that way: importing this directly would give the same operations
 * two entry points and turn a private split into a public one.
 */
export class ItemVersioningFacade {
  /**
   * Get an item at a specific version context (branch, commit, or tag)
   */
  static async getAtContext(
    itemMasterId: string,
    designId: string,
    context: VersionContext,
  ): Promise<BaseItem | null> {
    const { ItemService } = await import('./ItemService')

    const item = await VersionResolver.getItemAtContext(
      itemMasterId,
      designId,
      context,
    )
    if (!item) {
      return null
    }

    const typeSpecificData = await ItemService.getTypeSpecificData(
      item.itemType,
      item.id,
    )
    return { ...item, ...typeSpecificData }
  }

  /**
   * Get items at a specific version context (list view)
   */
  static async listAtContext(
    designId: string,
    context: VersionContext,
    filters?: ItemFilters,
  ): Promise<{ items: Array<BaseItem>; total: number }> {
    const { ItemService } = await import('./ItemService')

    const result = await VersionResolver.getItemsAtContext(
      designId,
      context,
      filters,
    )

    // Enrich with type-specific data
    const enrichedItems = await Promise.all(
      result.items.map(async (item) => {
        const typeSpecificData = await ItemService.getTypeSpecificData(
          item.itemType,
          item.id,
        )
        return { ...item, ...typeSpecificData }
      }),
    )

    return { items: enrichedItems, total: result.total }
  }

  /**
   * Compare two versions of an item
   */
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
    const { ItemService } = await import('./ItemService')

    const [item1, item2] = await Promise.all([
      ItemService.findById(itemId1),
      ItemService.findById(itemId2),
    ])

    if (!item1 || !item2) {
      throw new NotFoundError('Item', item1 ? itemId2 : itemId1, {
        operation: 'diff',
      })
    }

    // Compare fields
    const fields: Array<{
      field: string
      oldValue: unknown
      newValue: unknown
    }> = []
    const allKeys = new Set([...Object.keys(item1), ...Object.keys(item2)])

    // Exclude metadata fields from diff
    const excludeFields = [
      'id',
      'createdAt',
      'createdBy',
      'modifiedAt',
      'modifiedBy',
      'commitId',
    ]

    for (const key of allKeys) {
      if (excludeFields.includes(key)) continue

      const val1 = (item1 as unknown as Record<string, unknown>)[key]
      const val2 = (item2 as unknown as Record<string, unknown>)[key]

      if (JSON.stringify(val1) !== JSON.stringify(val2)) {
        fields.push({
          field: key,
          oldValue: val1,
          newValue: val2,
        })
      }
    }

    return { fields }
  }

  /**
   * Create a new item on a branch (delegated to CheckoutService)
   */
  static async createOnBranch(
    type: string,
    data: BaseItem,
    branchId: string,
    commitMessage: string,
    userId: string,
  ): Promise<{ item: BaseItem; commit: typeof commits.$inferSelect }> {
    const { ItemService } = await import('./ItemService')

    const typeConfig = ItemTypeRegistry.getType(type)
    if (!typeConfig) {
      throw new NotFoundError('Item type', type, {
        operation: 'createOnBranch',
      })
    }

    // Merge itemType into data before validation
    const dataWithType = { ...data, itemType: type }

    // Validate data against schema
    let validatedData: BaseItem
    try {
      validatedData = typeConfig.schema.parse(dataWithType)
    } catch (error) {
      if (error instanceof ZodError) {
        throw ValidationError.fromZodError(error, {
          operation: 'createOnBranch',
          resource: type,
        })
      }
      throw error
    }

    // Get the branch to get designId
    const branch = await BranchService.getById(branchId)
    if (!branch) {
      throw new NotFoundError('Branch', branchId, {
        operation: 'createOnBranch',
      })
    }

    // Handle item number generation
    if (!validatedData.itemNumber) {
      // Auto-generate item number
      const design = await db.query.designs.findFirst({
        where: eq(designs.id, branch.designId),
        columns: { code: true },
      })

      validatedData.itemNumber = await NumberingService.generate(type, {
        designId: branch.designId,
        designCode: design?.code ?? null,
        fields: validatedData as unknown as Record<string, unknown>,
      })
    } else {
      // Manual entry - validate if allowed
      if (!NumberingService.allowsManualEntry(type)) {
        throw new ValidationError(
          `Manual item numbers are not allowed for ${type}`,
          undefined,
          { operation: 'createOnBranch', resource: type },
        )
      }
      if (
        !NumberingService.validateManualNumber(type, validatedData.itemNumber)
      ) {
        throw new ValidationError(
          `Item number '${validatedData.itemNumber}' does not match the required format`,
          undefined,
          { operation: 'createOnBranch', resource: type },
        )
      }
    }

    // Create item via CheckoutService
    const result = await CheckoutService.createOnBranch(
      {
        designId: branch.designId,
        itemNumber: validatedData.itemNumber,
        itemType: type,
        name: validatedData.name,
        state: validatedData.state
          ? (await LifecycleService.validateStateForType(
              type,
              validatedData.state,
            ),
            validatedData.state)
          : await LifecycleService.getInitialStateId(type),
        attributes: validatedData.attributes,
      },
      branchId,
      commitMessage,
      userId,
      // The type-specific row is written inside the create's own transaction.
      // Running it after — on the pool, as this did — meant a handler that
      // throws (a `parentRequirementId` naming nothing, an `outputPartId`
      // that is not a Part) left the base row, its branch tracking, the
      // commit and the change order's scope row all committed with no
      // extension row behind them, which `findById` then resolves silently as
      // a fieldless item. `ItemService.create` has always done it this way on
      // the main path; only the branch path split.
      async (tx, itemId) => {
        await ItemService.insertTypeSpecificData(
          type,
          itemId,
          validatedData,
          tx,
          {
            userId,
          },
        )
      },
    )

    // Fetch complete item with type-specific data
    const completeItem = await ItemService.findById(result.item.id)

    return {
      item: completeItem!,
      commit: result.commit,
    }
  }
}
