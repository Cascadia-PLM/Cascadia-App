import { ZodError } from 'zod'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { branchItems, branches, designs } from '../../db/schema'
import { NotFoundError, ValidationError } from '../../errors'
import { VersionResolver } from '../../services/VersionResolver'
import { CommitService } from '../../services/CommitService'
import { CheckoutService } from '../../services/CheckoutService'
import { BranchService } from '../../services/BranchService'
import { NumberingService } from '../numbering'
import { ItemTypeRegistry } from '../registry'
import type { commits } from '../../db/schema'
import type {
  ItemFilters,
  VersionContext,
} from '../../services/VersionResolver'
import type { ItemHistoryEntry } from '../../services/CommitService'
import type { BaseItem } from '../types/base'

/**
 * Facade for versioning-related item operations.
 *
 * Extracted from ItemService to keep versioning logic separate from
 * core CRUD. ItemService delegates to these methods and re-exports
 * the same public API so callers are unaffected.
 */
export class ItemVersioningFacade {
  // ============================================================================
  // Versioning Methods
  // ============================================================================

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
   * Get version history for an item
   * @param itemMasterId - The master ID of the item
   * @param designId - The design ID
   * @param options.untilCommitId - Optional commit ID to limit history to (for viewing at a specific version)
   * @param options.branchId - Optional branch ID to filter commits by (only show commits on this branch)
   */
  static async getHistory(
    itemMasterId: string,
    designId: string,
    options?: {
      untilCommitId?: string
      branchId?: string
    },
  ): Promise<Array<ItemHistoryEntry>> {
    return CommitService.getItemCommits(itemMasterId, designId, options)
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
    const { BranchService: BranchSvc } =
      await import('../../services/BranchService')
    const branch = await BranchSvc.getById(branchId)
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
        state: validatedData.state || typeConfig.defaultState,
        attributes: (validatedData as unknown as Record<string, unknown>)
          .attributes as Record<string, unknown> | undefined,
      },
      branchId,
      commitMessage,
      userId,
    )

    // Insert type-specific data
    await ItemService.insertTypeSpecificData(
      type,
      result.item.id,
      validatedData,
    )

    // Fetch complete item with type-specific data
    const completeItem = await ItemService.findById(result.item.id)

    return {
      item: completeItem!,
      commit: result.commit,
    }
  }

  /**
   * Delete an item on a branch (soft delete, delegated to CheckoutService)
   */
  static async deleteOnBranch(
    itemMasterId: string,
    branchId: string,
    commitMessage: string,
    userId: string,
  ): Promise<typeof commits.$inferSelect> {
    return CheckoutService.deleteOnBranch(
      itemMasterId,
      branchId,
      commitMessage,
      userId,
    )
  }

  // ============================================================================
  // Branch Protection Methods
  // ============================================================================

  /**
   * Check if direct editing is allowed for a design.
   *
   * In pre-release phase: Direct editing on main branch is allowed
   * In post-release phase: Main branch is protected, must use ECO/workspace branches
   *
   * @param designId - The design to check
   * @returns Whether direct editing is allowed and the reason if not
   */
  static async canEditDirectly(designId: string): Promise<{
    allowed: boolean
    reason?: string
    requiresCheckout: boolean
  }> {
    const isProtected = await BranchService.isMainBranchProtected(designId)

    if (isProtected) {
      return {
        allowed: false,
        reason:
          'Design has released items. Use an ECO or workspace branch to make changes.',
        requiresCheckout: true,
      }
    }

    return {
      allowed: true,
      requiresCheckout: false,
    }
  }

  /**
   * Get branch information for an item if it's tracked on a non-main branch.
   * Returns null if the item is not on any ECO/workspace branch.
   *
   * @param itemId - The item ID to check
   * @returns Branch info or null if not on a branch
   */
  static async getItemBranchInfo(itemId: string): Promise<{
    branchId: string
    branchName: string
    branchType: string
    isLocked: boolean
  } | null> {
    // Check if this item is tracked on any branch via branchItems
    const result = await db
      .select({
        branchId: branches.id,
        branchName: branches.name,
        branchType: branches.branchType,
        isLocked: branches.isLocked,
      })
      .from(branchItems)
      .innerJoin(branches, eq(branchItems.branchId, branches.id))
      .where(eq(branchItems.currentItemId, itemId))
      .limit(1)

    const branchInfo = result.at(0)
    if (!branchInfo) {
      return null
    }

    // Only return info for ECO and workspace branches (main branch items are not tracked in branchItems)
    if (
      branchInfo.branchType === 'eco' ||
      branchInfo.branchType === 'workspace'
    ) {
      return {
        branchId: branchInfo.branchId,
        branchName: branchInfo.branchName,
        branchType: branchInfo.branchType,
        isLocked: branchInfo.isLocked ?? false,
      }
    }

    return null
  }

  /**
   * Check if an item requires checkout before editing.
   *
   * Items in Released or Approved state require checkout to an ECO/workspace branch.
   * Items in Draft or InReview state can be edited directly (if product allows it).
   *
   * @param item - The item to check
   * @returns Whether checkout is required
   */
  static requiresCheckout(item: BaseItem): boolean {
    if (!item.state) return false
    const lockedStates = ['Approved', 'Released']
    return lockedStates.includes(item.state)
  }

  /**
   * Check if an item can be edited directly (without checkout).
   *
   * @param item - The item to check
   * @returns Whether direct editing is allowed
   */
  static canEditItemDirectly(item: BaseItem): boolean {
    if (!item.state) return false
    const editableStates = ['Draft', 'InReview']
    return editableStates.includes(item.state)
  }
}
