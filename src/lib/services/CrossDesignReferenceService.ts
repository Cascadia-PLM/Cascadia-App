import { and, eq, inArray, isNull, ne, or } from 'drizzle-orm'
import { db } from '../db'
import { designCrossReferences } from '../db/schema/crossReferences'
import { items } from '../db/schema/items'
import { designs } from '../db/schema/designs'
import { NotFoundError, ValidationError } from '../errors'

/**
 * Transaction client type for database operations
 */
type TransactionClient = Parameters<Parameters<typeof db.transaction>[0]>[0]

export interface CreateReferenceInput {
  referencingDesignId: string
  referencedItemId: string
  branchId?: string | null
  notes?: string
}

export interface CrossDesignReference {
  id: string
  referencingDesignId: string
  referencedItemId: string
  sourceDesignId: string
  branchId: string | null
  changeType: string | null
  inDesignStructure: boolean | null
  notes: string | null
  createdAt: Date
  // Joined metadata (nullable because of LEFT JOIN)
  itemNumber: string | null
  itemName: string | null
  itemRevision: string | null
  itemState: string | null
  itemType: string | null
  sourceDesignCode: string | null
  sourceDesignName: string | null
}

export class CrossDesignReferenceService {
  /**
   * Create a cross-design reference.
   * If branchId is provided, marks as 'added' on that branch.
   * Otherwise creates on main (branchId=null, changeType=null).
   */
  static async createReference(
    input: CreateReferenceInput,
    userId: string,
    tx?: TransactionClient,
  ): Promise<typeof designCrossReferences.$inferSelect> {
    const dbClient = tx || db

    // Validate the referenced item exists
    const item = await dbClient
      .select({
        id: items.id,
        designId: items.designId,
      })
      .from(items)
      .where(eq(items.id, input.referencedItemId))
      .limit(1)
      .then((r) => r.at(0))

    if (!item) {
      throw new NotFoundError('Item', input.referencedItemId)
    }

    if (!item.designId) {
      throw new ValidationError('Referenced item does not belong to any design')
    }

    // Cannot reference items in the same design
    if (item.designId === input.referencingDesignId) {
      throw new ValidationError(
        'Cannot create a cross-design reference to an item in the same design',
      )
    }

    const [ref] = await dbClient
      .insert(designCrossReferences)
      .values({
        referencingDesignId: input.referencingDesignId,
        referencedItemId: input.referencedItemId,
        sourceDesignId: item.designId,
        branchId: input.branchId || null,
        changeType: input.branchId ? 'added' : null,
        notes: input.notes || null,
        createdBy: userId,
        modifiedBy: userId,
      })
      .returning()

    return ref
  }

  /**
   * Remove a cross-design reference.
   * On a branch: marks as 'deleted'.
   * On main (no branch): physically deletes.
   */
  static async removeReference(
    refId: string,
    branchId: string | null,
    userId: string,
    tx?: TransactionClient,
  ): Promise<void> {
    const dbClient = tx || db

    const ref = await dbClient
      .select()
      .from(designCrossReferences)
      .where(eq(designCrossReferences.id, refId))
      .limit(1)
      .then((r) => r.at(0))

    if (!ref) {
      throw new NotFoundError('CrossDesignReference', refId)
    }

    if (branchId) {
      // On a branch: if the ref was 'added' on this same branch, just delete it
      if (ref.branchId === branchId && ref.changeType === 'added') {
        await dbClient
          .delete(designCrossReferences)
          .where(eq(designCrossReferences.id, refId))
      } else {
        // Baseline ref being removed on a branch — insert a 'deleted' marker.
        // onConflictDoNothing() makes this idempotent: if the 'deleted' marker
        // already exists (e.g., removeReference called twice for the same ref
        // on the same branch), the second insert is silently ignored.
        // This is safe — the ref is already marked deleted.
        await dbClient
          .insert(designCrossReferences)
          .values({
            referencingDesignId: ref.referencingDesignId,
            referencedItemId: ref.referencedItemId,
            sourceDesignId: ref.sourceDesignId,
            branchId,
            changeType: 'deleted',
            modifiedBy: userId,
            createdBy: userId,
          })
          .onConflictDoNothing()
      }
    } else {
      // On main: physically delete
      await dbClient
        .delete(designCrossReferences)
        .where(eq(designCrossReferences.id, refId))
    }
  }

  /**
   * Get all cross-design references for a design, branch-aware.
   * Returns refs on main + refs added on branch, minus refs deleted on branch.
   */
  static async getReferencesForDesign(
    designId: string,
    branchId?: string | null,
  ): Promise<Array<CrossDesignReference>> {
    // Get all baseline refs (on main) + branch-specific refs
    const conditions = [eq(designCrossReferences.referencingDesignId, designId)]

    if (branchId) {
      // Baseline (branchId IS NULL) OR on this branch
      conditions.push(
        or(
          isNull(designCrossReferences.branchId),
          eq(designCrossReferences.branchId, branchId),
        )!,
      )
    } else {
      // Only baseline refs
      conditions.push(isNull(designCrossReferences.branchId))
    }

    const refs = await db
      .select({
        id: designCrossReferences.id,
        referencingDesignId: designCrossReferences.referencingDesignId,
        referencedItemId: designCrossReferences.referencedItemId,
        sourceDesignId: designCrossReferences.sourceDesignId,
        branchId: designCrossReferences.branchId,
        changeType: designCrossReferences.changeType,
        inDesignStructure: designCrossReferences.inDesignStructure,
        notes: designCrossReferences.notes,
        createdAt: designCrossReferences.createdAt,
        // Join item metadata
        itemNumber: items.itemNumber,
        itemName: items.name,
        itemRevision: items.revision,
        itemState: items.state,
        itemType: items.itemType,
        // Join source design metadata
        sourceDesignCode: designs.code,
        sourceDesignName: designs.name,
      })
      .from(designCrossReferences)
      .leftJoin(items, eq(designCrossReferences.referencedItemId, items.id))
      .leftJoin(designs, eq(designCrossReferences.sourceDesignId, designs.id))
      .where(and(...conditions))

    if (!branchId) {
      return refs
    }

    // Branch-aware: filter out baseline refs that have a 'deleted' marker on this branch
    const deletedItemIds = new Set(
      refs
        .filter((r) => r.branchId === branchId && r.changeType === 'deleted')
        .map((r) => r.referencedItemId),
    )

    return refs.filter((r) => {
      // Exclude the 'deleted' marker rows themselves
      if (r.changeType === 'deleted') return false
      // Exclude baseline refs that were deleted on this branch
      if (r.branchId === null && deletedItemIds.has(r.referencedItemId))
        return false
      return true
    })
  }

  /**
   * Convert a cross-design reference to a usage-copy.
   *
   * When branchId is null (pre-release, viewing main): physically deletes the reference.
   * When branchId is set (ECO/workspace branch): creates a 'deleted' marker.
   *
   * This removes the reference and returns metadata needed for the caller
   * to invoke the existing usage-copy creation flow.
   */
  static async pullInReference(
    refId: string,
    branchId: string | null,
    userId: string,
  ): Promise<{
    referencedItemId: string
    referencingDesignId: string
    sourceDesignId: string
  } | null> {
    const ref = await db
      .select()
      .from(designCrossReferences)
      .where(eq(designCrossReferences.id, refId))
      .limit(1)
      .then((r) => r.at(0))

    if (!ref) {
      // Already removed (e.g. by a prior batch chain) — idempotent
      return null
    }

    // Remove the reference (branch-aware)
    await this.removeReference(refId, branchId, userId)

    return {
      referencedItemId: ref.referencedItemId,
      referencingDesignId: ref.referencingDesignId,
      sourceDesignId: ref.sourceDesignId,
    }
  }

  /**
   * Find all cross-design references pointing at specific items,
   * excluding references from certain designs (typically the ECO's own designs).
   */
  static async getReferencesToItems(
    itemIds: Array<string>,
    excludeDesignIds: Array<string>,
  ): Promise<
    Array<{
      referencingDesignId: string
      referencedItemId: string
      designCode: string
      designName: string
    }>
  > {
    if (itemIds.length === 0) return []

    const conditions = [
      inArray(designCrossReferences.referencedItemId, itemIds),
    ]

    if (excludeDesignIds.length > 0) {
      conditions.push(
        ...excludeDesignIds.map((id) =>
          ne(designCrossReferences.referencingDesignId, id),
        ),
      )
    }

    // Exclude deleted references
    conditions.push(
      or(
        isNull(designCrossReferences.changeType),
        ne(designCrossReferences.changeType, 'deleted'),
      )!,
    )

    const refs = await db
      .select({
        referencingDesignId: designCrossReferences.referencingDesignId,
        referencedItemId: designCrossReferences.referencedItemId,
        designCode: designs.code,
        designName: designs.name,
      })
      .from(designCrossReferences)
      .innerJoin(
        designs,
        eq(designCrossReferences.referencingDesignId, designs.id),
      )
      .where(and(...conditions))

    return refs.map((r) => ({
      referencingDesignId: r.referencingDesignId,
      referencedItemId: r.referencedItemId,
      designCode: r.designCode,
      designName: r.designName,
    }))
  }

  /**
   * Merge cross-design references when an ECO is released.
   * Called during ChangeOrderMergeService.mergeBranchToMain().
   *
   * - 'added' rows: promote to main (set branchId=null, changeType=null)
   * - 'deleted' rows: physically delete both the marker and the baseline row
   */
  static async mergeReferencesOnRelease(
    designId: string,
    branchId: string,
    tx?: TransactionClient,
  ): Promise<void> {
    const dbClient = tx || db

    // Get all branch-specific references for this design
    const branchRefs = await dbClient
      .select()
      .from(designCrossReferences)
      .where(
        and(
          eq(designCrossReferences.referencingDesignId, designId),
          eq(designCrossReferences.branchId, branchId),
        ),
      )

    for (const ref of branchRefs) {
      if (ref.changeType === 'added') {
        // Promote to main: set branchId=null, changeType=null
        await dbClient
          .update(designCrossReferences)
          .set({
            branchId: null,
            changeType: null,
          })
          .where(eq(designCrossReferences.id, ref.id))
      } else if (ref.changeType === 'deleted') {
        // Remove the 'deleted' marker
        await dbClient
          .delete(designCrossReferences)
          .where(eq(designCrossReferences.id, ref.id))

        // Also remove the baseline row it was masking
        await dbClient
          .delete(designCrossReferences)
          .where(
            and(
              eq(
                designCrossReferences.referencingDesignId,
                ref.referencingDesignId,
              ),
              eq(designCrossReferences.referencedItemId, ref.referencedItemId),
              isNull(designCrossReferences.branchId),
            ),
          )
      }
    }
  }
}
