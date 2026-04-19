import { and, eq, inArray } from 'drizzle-orm'
import { db } from '@/lib/db'
import { items, workInstructionPartAttachments } from '@/lib/db/schema'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export class WorkInstructionInheritanceService {
  /**
   * Inherit work instruction attachments from EBOM parts to MBOM parts.
   * Called during MBOM creation from EBOM (MbomService.createFromEbom).
   *
   * Only copies attachments where `inheritToMBOM` is true.
   *
   * @param tx - Database transaction
   * @param sourceDesignId - Source EBOM design ID
   * @param targetDesignId - Target MBOM design ID
   * @param itemIdMap - Map of source EBOM item IDs → new MBOM item IDs
   * @param userId - User performing the operation
   */
  static async inheritAttachments(
    tx: Transaction,
    _sourceDesignId: string,
    _targetDesignId: string,
    itemIdMap: Map<string, string>,
    userId: string,
  ): Promise<{ inherited: number }> {
    const sourceItemIds = Array.from(itemIdMap.keys())

    if (sourceItemIds.length === 0) {
      return { inherited: 0 }
    }

    // Find all WI attachments for source EBOM parts where inheritToMBOM is true
    const sourceAttachments = await tx
      .select()
      .from(workInstructionPartAttachments)
      .where(
        and(
          inArray(workInstructionPartAttachments.partId, sourceItemIds),
          eq(workInstructionPartAttachments.inheritToMBOM, true),
        ),
      )

    if (sourceAttachments.length === 0) {
      return { inherited: 0 }
    }

    let inherited = 0

    for (const attachment of sourceAttachments) {
      const targetPartId = itemIdMap.get(attachment.partId)
      if (!targetPartId) continue

      // Create inherited attachment on the MBOM part
      await tx
        .insert(workInstructionPartAttachments)
        .values({
          workInstructionId: attachment.workInstructionId,
          partId: targetPartId,
          inheritToMBOM: false, // Inherited attachments don't cascade further
          inheritedFromId: attachment.id, // Track provenance
          createdBy: userId,
        })
        .onConflictDoNothing() // Skip if WI already attached to this MBOM part

      inherited++
    }

    return { inherited }
  }

  /**
   * Sync inherited attachments for an existing MBOM design.
   * Called when user wants to re-sync after new WIs are added to EBOM parts.
   *
   * Finds any new `inheritToMBOM` attachments on EBOM parts that don't yet
   * have corresponding inherited attachments on MBOM parts.
   */
  static async syncInheritedAttachments(
    sourceDesignId: string,
    targetDesignId: string,
    userId: string,
  ): Promise<{ synced: number }> {
    // Get all items in both designs to build the mapping
    const [sourceItems, targetItems] = await Promise.all([
      db
        .select({ id: items.id, itemNumber: items.itemNumber })
        .from(items)
        .where(eq(items.designId, sourceDesignId)),
      db
        .select({
          id: items.id,
          itemNumber: items.itemNumber,
          usageOf: items.usageOf,
        })
        .from(items)
        .where(eq(items.designId, targetDesignId)),
    ])

    // Build mapping: EBOM item ID → MBOM item ID (via itemNumber or usageOf)
    const itemIdMap = new Map<string, string>()
    for (const sourceItem of sourceItems) {
      // Find MBOM item that references this source item (via usageOf)
      const mbomItem = targetItems.find(
        (t) =>
          t.usageOf === sourceItem.id || t.itemNumber === sourceItem.itemNumber,
      )
      if (mbomItem) {
        itemIdMap.set(sourceItem.id, mbomItem.id)
      }
    }

    if (itemIdMap.size === 0) {
      return { synced: 0 }
    }

    return db.transaction(async (tx) => {
      const result = await this.inheritAttachments(
        tx,
        sourceDesignId,
        targetDesignId,
        itemIdMap,
        userId,
      )
      return { synced: result.inherited }
    })
  }
}
