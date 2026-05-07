import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { JobContext, JobHandler } from '../types'
import type {
  CloneDesignPayload,
  CloneDesignResult,
} from '../definitions/design/types'
import { db } from '@/lib/db'
import {
  documents,
  itemRelationships,
  items,
  parts,
  requirements,
} from '@/lib/db/schema/items'
import { vaultFiles } from '@/lib/db/schema/vault'
import { branchItems } from '@/lib/db/schema/versioning'
import { designCrossReferences } from '@/lib/db/schema/crossReferences'
import { DesignService } from '@/lib/services/DesignService'
import { BranchService } from '@/lib/services/BranchService'
import { CommitService } from '@/lib/services/CommitService'
import { UsageService } from '@/lib/services/UsageService'
import { VersionResolver } from '@/lib/services/VersionResolver'

const BATCH_SIZE = 50

/**
 * Clone Design Handler (Usage-Based Model)
 *
 * Creates a new design by creating "usage" items that reference original "definition" items.
 * This follows the SysML v2 definition/usage pattern where:
 * - Definitions are canonical items (typically in Library)
 * - Usages reference definitions and can have local overrides
 *
 * When cloning Design B to create Design C:
 * - For each item in B, create a new usage in C
 * - The usage's `usageOf` points to the DEFINITION (not B's usage)
 * - Field values are copied inline from B (including B's modifications)
 * - All items start at Rev - and Draft state
 * - BOM relationships are copied with remapped IDs
 */
export const cloneDesignHandler: JobHandler<
  CloneDesignPayload,
  CloneDesignResult
> = {
  type: 'design.clone',

  async execute(
    payload: CloneDesignPayload,
    context: JobContext,
  ): Promise<CloneDesignResult> {
    const {
      sourceDesignId,
      targetCode,
      targetName,
      targetDescription,
      targetProgramId,
      userId,
      suffixItemNumbers,
    } = payload

    // =========================================================================
    // 1. Validate source design
    // =========================================================================
    await context.updateProgress(5, 'Validating source design...')
    await context.log.info('Starting design clone (usage-based)', {
      sourceDesignId,
      targetCode,
    })

    const sourceDesign = await DesignService.getById(sourceDesignId)
    if (!sourceDesign) {
      throw new Error(`Source design not found: ${sourceDesignId}`)
    }

    const mainBranch = await BranchService.getMainBranch(sourceDesignId)
    if (!mainBranch) {
      throw new Error(`No main branch found for design: ${sourceDesignId}`)
    }

    // =========================================================================
    // 2. Get all current items from source main branch
    // =========================================================================
    await context.updateProgress(10, 'Loading source items...')

    const sourceItems = await getItemsOnBranch(mainBranch.id)
    const totalItems = sourceItems.length

    await context.log.info(`Found ${totalItems} items to clone`)

    // Validate that resulting item numbers won't exceed column length
    const sourceCodeSuffix = `-${sourceDesign.code}`
    const targetSuffix = `-${targetCode}`
    const tooLong = sourceItems.filter((item) => {
      if (item.itemNumber.endsWith(sourceCodeSuffix)) {
        // Replacement: remove old suffix, add new one
        const resultLength =
          item.itemNumber.length - sourceCodeSuffix.length + targetSuffix.length
        return resultLength > 100
      }
      if (suffixItemNumbers) {
        return item.itemNumber.length + targetSuffix.length > 100
      }
      return false
    })
    if (tooLong.length > 0) {
      throw new Error(
        `${tooLong.length} item number(s) would exceed 100 characters after suffix substitution (e.g., "${tooLong[0].itemNumber}")`,
      )
    }

    if (context.signal.aborted) throw new Error('Job cancelled')

    // =========================================================================
    // 3. Create target design
    // =========================================================================
    await context.updateProgress(15, 'Creating target design...')

    const targetDesign = await DesignService.create(
      {
        programId: targetProgramId ?? sourceDesign.programId,
        name: targetName,
        code: targetCode,
        description: targetDescription ?? `Cloned from ${sourceDesign.code}`,
        designType: 'Engineering',
        cloneSourceDesignId: sourceDesignId,
      },
      userId,
    )

    const targetMainBranch = await BranchService.getMainBranch(targetDesign.id)
    if (!targetMainBranch) {
      throw new Error('Failed to create main branch for target design')
    }

    await context.log.info('Created target design', {
      designId: targetDesign.id,
      code: targetDesign.code,
    })

    // =========================================================================
    // 4. Create usage items in batches
    // =========================================================================
    const itemIdMap = new Map<string, string>() // sourceItemId -> targetUsageId
    let usagesCreated = 0
    let filesReferenced = 0

    for (let i = 0; i < sourceItems.length; i += BATCH_SIZE) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- aborted may change between batches
      if (context.signal.aborted) throw new Error('Job cancelled')

      const batch = sourceItems.slice(i, i + BATCH_SIZE)

      await db.transaction(async (tx) => {
        for (const sourceItem of batch) {
          // Use UsageService to resolve the canonical definition
          // - If source is already a usage, this follows the chain to the definition
          // - If source is a definition, it returns the source itself
          const definitionId = sourceItem.usageOf ?? sourceItem.id

          // Auto-assign sysmlType based on whether this is a usage
          // Since we're always creating usages here, always pass true
          const sysmlType = UsageService.getSysmlType(sourceItem.itemType, true)

          // Create new usage item
          const newMasterId = crypto.randomUUID()
          const [newUsage] = await tx
            .insert(items)
            .values({
              // New identity
              masterId: newMasterId,
              designId: targetDesign.id,

              // Usage reference - this is the key for traceability!
              usageOf: definitionId,

              // Copy field values from source (including any modifications)
              itemNumber: applyItemNumberSuffix(
                sourceItem.itemNumber,
                sourceDesign.code,
                targetCode,
                suffixItemNumbers,
              ),
              revision: '-', // Fresh start
              itemType: sourceItem.itemType,
              name: sourceItem.name,
              state: 'Draft', // Fresh start
              isCurrent: true,
              attributes: sourceItem.attributes,
              sysmlType: sysmlType, // Auto-assigned based on item type
              metamodel: sourceItem.metamodel ?? 'cascadia',
              inDesignStructure: sourceItem.inDesignStructure,

              // Audit
              createdBy: userId,
              modifiedBy: userId,
            })
            .returning()

          itemIdMap.set(sourceItem.id, newUsage.id)

          // Copy type-specific data inline (these are the "overrides" on the usage)
          // Note: Using inline copy to preserve source modifications and handle
          // clone-specific field copying (all fields copied, not just inherited)
          await copyTypeSpecificData(tx, sourceItem, newUsage.id)

          // Copy file references (not actual files - they reference same vault files)
          const sourceFiles = await tx
            .select()
            .from(vaultFiles)
            .where(eq(vaultFiles.itemId, sourceItem.id))

          for (const file of sourceFiles) {
            // Skip deleted files
            if (file.deletedAt) continue

            await tx.insert(vaultFiles).values({
              itemId: newUsage.id,
              fileName: file.fileName,
              originalFileName: file.originalFileName,
              mimeType: file.mimeType,
              fileSize: file.fileSize,
              storagePath: file.storagePath, // Same vault file
              storageType: file.storageType,
              fileHash: file.fileHash,
              fileVersion: 1, // Start fresh version numbering
              isLatestVersion: true,
              uploadedBy: userId,
              fileCategory: file.fileCategory,
              isPrimaryModel: file.isPrimaryModel,
              cadMetadata: file.cadMetadata,
              metadata: file.metadata,
            })
            filesReferenced++
          }

          // Track on new design's main branch
          await tx.insert(branchItems).values({
            branchId: targetMainBranch.id,
            itemMasterId: newUsage.masterId,
            currentItemId: newUsage.id,
            baseItemId: newUsage.id,
            changeType: null,
          })
        }
      })

      usagesCreated += batch.length
      const percent =
        15 + Math.floor((usagesCreated / Math.max(totalItems, 1)) * 60) // 15-75%
      await context.updateProgress(
        percent,
        `Created ${usagesCreated} of ${totalItems} usages...`,
      )
    }

    await context.log.info(`Created ${usagesCreated} usage items`)

    // =========================================================================
    // 5. Create initial commit to record all cloned items
    // =========================================================================
    await context.updateProgress(76, 'Creating initial commit...')

    // Build item changes for the commit (all items are 'added')
    const itemChanges = Array.from(itemIdMap.values()).map((newItemId) => ({
      itemId: newItemId,
      changeType: 'added' as const,
    }))

    if (itemChanges.length > 0) {
      await CommitService.create(
        {
          branchId: targetMainBranch.id,
          message: `Cloned ${itemChanges.length} items from ${sourceDesign.code}`,
          itemChanges,
        },
        userId,
      )
      await context.log.info(
        `Created commit with ${itemChanges.length} cloned items`,
      )
    }

    // =========================================================================
    // 6. Copy BOM relationships (remapping IDs to new usages)
    // =========================================================================
    await context.updateProgress(80, 'Copying relationships...')

    let relationshipsCopied = 0

    // Build masterId -> new usage ID mapping
    // We need this because relationships may point to older item versions (before ECO revisions)
    const masterIdToNewUsageId = new Map<string, string>()
    for (const sourceItem of sourceItems) {
      const newUsageId = itemIdMap.get(sourceItem.id)
      if (newUsageId) {
        masterIdToNewUsageId.set(sourceItem.masterId, newUsageId)
      }
    }

    // Get all masterIds from source items
    const sourceMasterIds = sourceItems.map((item) => item.masterId)

    if (sourceMasterIds.length > 0) {
      // Find ALL item version IDs for these masters (including old revisions)
      const allItemVersions = await db
        .select({
          id: items.id,
          masterId: items.masterId,
          itemNumber: items.itemNumber,
        })
        .from(items)
        .where(inArray(items.masterId, sourceMasterIds))

      const allSourceItemIds = allItemVersions.map((v) => v.id)

      await context.log.info(
        `Found ${allItemVersions.length} item versions for ${sourceMasterIds.length} masters`,
      )

      // Build itemId -> masterId mapping for all versions
      const itemIdToMasterId = new Map<string, string>()
      for (const v of allItemVersions) {
        itemIdToMasterId.set(v.id, v.masterId)
      }

      // Get all relationships where source is any version of our items
      const sourceRelationships = await db
        .select()
        .from(itemRelationships)
        .where(inArray(itemRelationships.sourceId, allSourceItemIds))

      await context.log.info(
        `Found ${sourceRelationships.length} relationships to copy`,
      )

      // Build itemNumber lookup for logging
      const masterIdToItemNumber = new Map<string, string>()
      for (const v of allItemVersions) {
        if (!masterIdToItemNumber.has(v.masterId)) {
          masterIdToItemNumber.set(v.masterId, v.itemNumber)
        }
      }

      // Track which relationships we've already copied (by masterId pair) to avoid duplicates
      const copiedRelationships = new Set<string>()
      let skippedNoSource = 0
      let skippedNoTarget = 0
      let skippedDuplicate = 0

      for (const rel of sourceRelationships) {
        // Skip DerivedFrom - we use usageOf for traceability now
        if (rel.relationshipType === 'DerivedFrom') continue

        // Map item IDs to masterIds, then to new usage IDs
        const sourceMasterId = itemIdToMasterId.get(rel.sourceId)
        const targetMasterId = itemIdToMasterId.get(rel.targetId)

        if (!sourceMasterId) {
          skippedNoSource++
          continue
        }

        // Check if we've already copied this relationship (from a different version)
        const relKey = `${sourceMasterId}:${targetMasterId || rel.targetId}:${rel.relationshipType}`
        if (copiedRelationships.has(relKey)) {
          skippedDuplicate++
          continue
        }
        copiedRelationships.add(relKey)

        const newSourceId = masterIdToNewUsageId.get(sourceMasterId)
        const newTargetId = targetMasterId
          ? masterIdToNewUsageId.get(targetMasterId)
          : null

        if (!newTargetId && targetMasterId) {
          // Target is in our item set but we don't have a mapping - shouldn't happen
          const sourceNum =
            masterIdToItemNumber.get(sourceMasterId) || 'unknown'
          const targetNum =
            masterIdToItemNumber.get(targetMasterId) || 'unknown'
          await context.log.warn(
            `Missing target mapping for ${sourceNum} -> ${targetNum}`,
          )
          skippedNoTarget++
          continue
        }

        if (newSourceId && newTargetId) {
          // Both ends are in our set - remap to new usage IDs
          await db.insert(itemRelationships).values({
            sourceId: newSourceId,
            targetId: newTargetId,
            relationshipType: rel.relationshipType,
            quantity: rel.quantity,
            findNumber: rel.findNumber,
            referenceDesignator: rel.referenceDesignator,
            metadata: rel.metadata,
            isComposite: rel.isComposite,
            isDirected: rel.isDirected,
            multiplicityLower: rel.multiplicityLower,
            multiplicityUpper: rel.multiplicityUpper,
            usageAttributes: rel.usageAttributes,
            createdBy: userId,
            modifiedBy: userId,
          })
          relationshipsCopied++
        } else if (newSourceId && !targetMasterId) {
          // Target is outside our item set (e.g., library item from another design)
          // Preserve the relationship pointing to the original external item
          await db.insert(itemRelationships).values({
            sourceId: newSourceId,
            targetId: rel.targetId, // Original external item
            relationshipType: rel.relationshipType,
            quantity: rel.quantity,
            findNumber: rel.findNumber,
            referenceDesignator: rel.referenceDesignator,
            metadata: rel.metadata,
            isComposite: rel.isComposite,
            isDirected: rel.isDirected,
            multiplicityLower: rel.multiplicityLower,
            multiplicityUpper: rel.multiplicityUpper,
            usageAttributes: rel.usageAttributes,
            createdBy: userId,
            modifiedBy: userId,
          })
          relationshipsCopied++
        }
      }

      await context.log.info(
        `Copied ${relationshipsCopied} relationships (skipped: ${skippedNoSource} no source, ${skippedNoTarget} no target, ${skippedDuplicate} duplicates)`,
      )
    }

    // =========================================================================
    // 7. Copy cross-design references (baseline only)
    // =========================================================================
    await context.updateProgress(90, 'Copying cross-design references...')

    let crossReferencesCopied = 0

    const sourceCrossRefs = await db
      .select()
      .from(designCrossReferences)
      .where(
        and(
          eq(designCrossReferences.referencingDesignId, sourceDesignId),
          isNull(designCrossReferences.branchId),
        ),
      )

    if (sourceCrossRefs.length > 0) {
      for (const ref of sourceCrossRefs) {
        await db.insert(designCrossReferences).values({
          referencingDesignId: targetDesign.id,
          referencedItemId: ref.referencedItemId,
          sourceDesignId: ref.sourceDesignId,
          inDesignStructure: ref.inDesignStructure,
          notes: ref.notes,
          createdBy: userId,
          modifiedBy: userId,
        })
        crossReferencesCopied++
      }

      await context.log.info(
        `Copied ${crossReferencesCopied} cross-design references`,
      )
    }

    // =========================================================================
    // 8. Done
    // =========================================================================
    await context.updateProgress(100, 'Complete')

    return {
      designId: targetDesign.id,
      designCode: targetDesign.code,
      itemsCloned: usagesCreated,
      relationshipsCloned: relationshipsCopied,
      derivedFromCreated: 0, // No longer using DerivedFrom, usageOf provides traceability
      filesReferenced,
      crossReferencesCopied,
    }
  },
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get all items on a branch using proper version resolution.
 *
 * This uses VersionResolver.getBranchItems which:
 * - For main branch: returns items from commit history (released items)
 * - For ECO branches: merges released items with branch modifications
 *
 * This is important because branchItems table only tracks active modifications,
 * not all items that exist on a branch (especially for main).
 */
async function getItemsOnBranch(branchId: string) {
  const result = await VersionResolver.getBranchItems(branchId)
  return result.items
}

type TransactionClient = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Copy type-specific data from source item to target usage.
 * These values are stored inline on the usage (the "overrides").
 */
async function copyTypeSpecificData(
  tx: TransactionClient,
  sourceItem: typeof items.$inferSelect,
  targetItemId: string,
) {
  switch (sourceItem.itemType) {
    case 'Part': {
      const [sourcePart] = await tx
        .select()
        .from(parts)
        .where(eq(parts.itemId, sourceItem.id))
      if (sourcePart) {
        await tx.insert(parts).values({
          itemId: targetItemId,
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
          lastInventoryCheck: sourcePart.lastInventoryCheck,
        })
      }
      break
    }
    case 'Document': {
      const [sourceDoc] = await tx
        .select()
        .from(documents)
        .where(eq(documents.itemId, sourceItem.id))
      if (sourceDoc) {
        await tx.insert(documents).values({
          itemId: targetItemId,
          description: sourceDoc.description,
          fileId: sourceDoc.fileId,
          fileName: sourceDoc.fileName,
          fileSize: sourceDoc.fileSize,
          mimeType: sourceDoc.mimeType,
          storagePath: sourceDoc.storagePath,
        })
      }
      break
    }
    case 'Requirement': {
      const [sourceReq] = await tx
        .select()
        .from(requirements)
        .where(eq(requirements.itemId, sourceItem.id))
      if (sourceReq) {
        await tx.insert(requirements).values({
          itemId: targetItemId,
          description: sourceReq.description,
          type: sourceReq.type,
          priority: sourceReq.priority,
          status: sourceReq.status,
          acceptanceCriteria: sourceReq.acceptanceCriteria,
          source: sourceReq.source,
          category: sourceReq.category,
        })
      }
      break
    }
    // Tasks and ChangeOrders are typically not cloned with designs
  }
}

/**
 * Apply the target design code as a suffix to an item number.
 *
 * If the item number already ends with `-{sourceCode}` (from a previous clone),
 * that suffix is replaced with `-{targetCode}` to avoid double-suffixing.
 * Otherwise, `-{targetCode}` is appended only when `suffixItemNumbers` is true.
 */
function applyItemNumberSuffix(
  itemNumber: string,
  sourceCode: string,
  targetCode: string,
  suffixItemNumbers?: boolean,
): string {
  const sourceSuffix = `-${sourceCode}`
  if (itemNumber.endsWith(sourceSuffix)) {
    return `${itemNumber.slice(0, -sourceSuffix.length)}-${targetCode}`
  }
  if (!suffixItemNumbers) return itemNumber
  return `${itemNumber}-${targetCode}`
}
