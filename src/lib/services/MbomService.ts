// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db'
import {
  branches,
  commits,
  designs,
  itemRelationships,
  itemVersions,
  items,
  upstreamChanges,
} from '../db/schema'
import { NotFoundError, ValidationError } from '../errors'
import { DesignService } from './DesignService'
import { BranchService } from './BranchService'
import { UsageService } from './UsageService'
import { VersionResolver } from './VersionResolver'
import type { UpstreamChangeItem } from '../db/schema'

/**
 * Relationship type for linking MBOM items back to their EBOM source
 */
export const EBOM_SOURCE_RELATIONSHIP = 'EBOM_SOURCE'

/**
 * Schema for creating an MBOM from an EBOM
 */
export const createMbomSchema = z.object({
  sourceDesignId: z.string().uuid(),
  name: z.string().min(1, 'Name is required').max(200),
  code: z
    .string()
    .min(1, 'Code is required')
    .max(50)
    .regex(/^[A-Z0-9-]+$/, 'Code must be uppercase alphanumeric with hyphens'),
  description: z.string().optional(),
  sourceTagId: z.string().uuid().optional(),
  copyBomStructure: z.boolean().default(true),
  linkToSource: z.boolean().default(true),
  renumberItems: z.boolean().default(true),
})

export type CreateMbomInput = z.infer<typeof createMbomSchema>

/**
 * Schema for reviewing upstream changes
 */
export const reviewUpstreamChangeSchema = z.object({
  action: z.enum(['accept', 'reject', 'defer']),
  notes: z.string().optional(),
  createMco: z.boolean().optional(),
})

export type ReviewUpstreamChangeInput = z.infer<
  typeof reviewUpstreamChangeSchema
>

export interface MbomCreationResult {
  design: typeof designs.$inferSelect
  mainBranch: typeof branches.$inferSelect
  initialCommit: typeof commits.$inferSelect
  itemsCopied: number
  relationshipsCopied: number
  sourceLinks: number
}

export interface UpstreamChangeResult {
  id: string
  sourceDesignId: string
  sourceDesignName: string
  sourceDesignCode: string
  sourceEcoNumber: string | null
  changedItems: Array<UpstreamChangeItem>
  status: string
  createdAt: Date
}

/**
 * Service for managing Manufacturing BOMs (MBOMs) and their derivation from Engineering BOMs (EBOMs)
 */
export class MbomService {
  /**
   * Create a Manufacturing design from an Engineering design.
   * Copies the BOM structure and creates EBOM_SOURCE relationships for traceability.
   */
  static async createFromEbom(
    data: CreateMbomInput,
    userId: string,
  ): Promise<MbomCreationResult> {
    const validated = createMbomSchema.parse(data)

    // Get source design and validate it's an Engineering type
    const sourceDesign = await DesignService.getById(validated.sourceDesignId)
    if (!sourceDesign) {
      throw new NotFoundError('Design', validated.sourceDesignId, {
        operation: 'createFromEbom',
      })
    }

    // Validate source is Engineering type
    if (sourceDesign.designType !== 'Engineering') {
      throw new ValidationError(
        'Source design must be an Engineering design',
        undefined,
        { field: 'sourceDesignId' },
      )
    }

    // Resolve source commit from tag or current HEAD
    let sourceCommitId: string | null = null
    if (validated.sourceTagId) {
      const tag = await DesignService.getTag(validated.sourceTagId)
      if (!tag) {
        throw new NotFoundError('Tag', validated.sourceTagId, {
          operation: 'createFromEbom',
        })
      }
      if (tag.designId !== validated.sourceDesignId) {
        throw new ValidationError(
          'Tag does not belong to the source design',
          undefined,
          { field: 'sourceTagId' },
        )
      }
      sourceCommitId = tag.commitId
    } else {
      // Use current HEAD of main branch
      const mainBranch = await DesignService.getDefaultBranch(
        validated.sourceDesignId,
      )
      if (mainBranch) {
        sourceCommitId = mainBranch.headCommitId
      }
    }

    // Check for duplicate code
    const existingDesign = await DesignService.getByCode(validated.code)
    if (existingDesign) {
      throw new ValidationError('Design code already exists', undefined, {
        field: 'code',
      })
    }

    // Create the Manufacturing design with transaction
    return db.transaction(async (tx) => {
      // 1. Create Manufacturing design
      const [mbomDesign] = await tx
        .insert(designs)
        .values({
          programId: sourceDesign.programId,
          name: validated.name,
          code: validated.code,
          description: validated.description,
          designType: 'Manufacturing',
          sourceDesignId: validated.sourceDesignId,
          sourceTagId: validated.sourceTagId ?? null,
          sourceCommitId: sourceCommitId,
          createdBy: userId,
        })
        .returning()

      // 2. Create initial commit (with temporary branchId)
      const [initialCommit] = await tx
        .insert(commits)
        .values({
          designId: mbomDesign.id,
          branchId: mbomDesign.id, // Temporary - will update after branch creation
          message: `Initial MBOM created from ${sourceDesign.code}`,
          createdBy: userId,
        })
        .returning()

      // 3. Create main branch
      const [mainBranch] = await tx
        .insert(branches)
        .values({
          designId: mbomDesign.id,
          name: 'main',
          branchType: 'main',
          headCommitId: initialCommit.id,
          baseCommitId: initialCommit.id,
          createdBy: userId,
        })
        .returning()

      // 4. Update commit with correct branchId
      await tx
        .update(commits)
        .set({ branchId: mainBranch.id })
        .where(eq(commits.id, initialCommit.id))

      // 5. Update design with default branch
      await tx
        .update(designs)
        .set({ defaultBranchId: mainBranch.id })
        .where(eq(designs.id, mbomDesign.id))

      let itemsCopied = 0
      let relationshipsCopied = 0
      let sourceLinks = 0

      // 6. Create MBOM usages from EBOM definitions if requested
      if (validated.copyBomStructure) {
        const copyResult = await this.copyEbomStructureInternal(
          tx,
          validated.sourceDesignId,
          mbomDesign.id,
          mainBranch.id,
          initialCommit.id,
          validated.linkToSource,
          sourceDesign.code,
          validated.code,
          validated.renumberItems,
          userId,
        )
        itemsCopied = copyResult.itemsCopied
        relationshipsCopied = copyResult.relationshipsCopied
        sourceLinks = copyResult.sourceLinks

        // 7. Inherit work instruction attachments from EBOM to MBOM
        if (copyResult.itemIdMap.size > 0) {
          try {
            const { WorkInstructionInheritanceService } =
              await import('./WorkInstructionInheritanceService')
            await WorkInstructionInheritanceService.inheritAttachments(
              tx,
              validated.sourceDesignId,
              mbomDesign.id,
              copyResult.itemIdMap,
              userId,
            )
          } catch {
            // WI inheritance failure should not block MBOM creation
          }
        }
      }

      return {
        design: mbomDesign,
        mainBranch,
        initialCommit: { ...initialCommit, branchId: mainBranch.id },
        itemsCopied,
        relationshipsCopied,
        sourceLinks,
      }
    })
  }

  /**
   * Replace a design code suffix in an item number.
   * e.g., renumberItemNumber('XYZ-HULL-2738', 'HULL-2738', 'M-HULL-2738') → 'XYZ-M-HULL-2738'
   */
  private static renumberItemNumber(
    itemNumber: string,
    sourceCode: string,
    targetCode: string,
  ): string {
    const sourceSuffix = `-${sourceCode}`
    if (itemNumber.endsWith(sourceSuffix)) {
      return `${itemNumber.slice(0, -sourceSuffix.length)}-${targetCode}`
    }
    return itemNumber
  }

  /**
   * Internal method to create MBOM usages from EBOM definitions.
   *
   * Uses the SysML v2 Usage/Definition pattern:
   * - EBOM items are definitions (or usages of library definitions)
   * - MBOM items are usages that reference those definitions via `usageOf`
   * - This provides traceability without duplicating data
   * - Same item numbers are used (uniqueness comes from design scope + usageOf)
   */
  private static async copyEbomStructureInternal(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    sourceDesignId: string,
    targetDesignId: string,
    _targetBranchId: string,
    targetCommitId: string,
    createSourceLinks: boolean,
    sourceDesignCode: string,
    targetDesignCode: string,
    renumberItems: boolean,
    userId: string,
  ): Promise<{
    itemsCopied: number
    relationshipsCopied: number
    sourceLinks: number
    itemIdMap: Map<string, string>
  }> {
    // Get the main branch for the source design
    const sourceMainBranch = await BranchService.getMainBranch(sourceDesignId)
    if (!sourceMainBranch) {
      return {
        itemsCopied: 0,
        relationshipsCopied: 0,
        sourceLinks: 0,
        itemIdMap: new Map(),
      }
    }

    // Get all items on the source branch using proper version resolution
    // This uses VersionResolver.getBranchItems which:
    // - For main branch: returns items from commit history (released items)
    // - For ECO branches: merges released items with branch modifications
    const result = await VersionResolver.getBranchItems(sourceMainBranch.id)
    const allSourceItems = result.items

    if (allSourceItems.length === 0) {
      return {
        itemsCopied: 0,
        relationshipsCopied: 0,
        sourceLinks: 0,
        itemIdMap: new Map(),
      }
    }

    // Deduplicate by itemNumber - take only one version per unique part
    // This handles cases where multiple revisions exist with isCurrent=true
    const sourceItemsByNumber = new Map<string, (typeof allSourceItems)[0]>()
    for (const item of allSourceItems) {
      const existing = sourceItemsByNumber.get(item.itemNumber)
      if (!existing || item.revision > existing.revision) {
        // Keep the highest revision
        sourceItemsByNumber.set(item.itemNumber, item)
      }
    }
    const sourceItems = Array.from(sourceItemsByNumber.values())

    // Map old item IDs to new item IDs
    const itemIdMap = new Map<string, string>()
    let sourceLinks = 0

    // Create usages for each source item
    for (const sourceItem of sourceItems) {
      // Determine the definition to reference:
      // - If source is already a usage, reference its definition
      // - If source is a definition, reference the source itself
      const definitionId = sourceItem.usageOf ?? sourceItem.id

      // Auto-assign sysmlType based on item type (always usage since we're creating MBOM usages)
      const sysmlType = UsageService.getSysmlType(sourceItem.itemType, true)

      // Create new usage item in MBOM that references the EBOM definition
      const [newUsage] = await tx
        .insert(items)
        .values({
          // New identity for this usage
          masterId: crypto.randomUUID(),
          designId: targetDesignId,
          commitId: targetCommitId,

          // Usage reference - this is the key for traceability!
          usageOf: definitionId,

          // Copy field values from source, optionally renumbering the design code suffix
          itemNumber: renumberItems
            ? this.renumberItemNumber(
                sourceItem.itemNumber,
                sourceDesignCode,
                targetDesignCode,
              )
            : sourceItem.itemNumber,
          revision: '-', // Fresh start for MBOM usage
          itemType: sourceItem.itemType,
          name: sourceItem.name,
          state: 'Draft', // Start as Draft in MBOM
          isCurrent: true,
          inDesignStructure: sourceItem.inDesignStructure,
          attributes: sourceItem.attributes,
          metamodel: sourceItem.metamodel ?? 'cascadia',
          sysmlType: sysmlType, // Auto-assigned based on item type

          // Audit
          createdBy: userId,
          modifiedBy: userId,
        })
        .returning()

      itemIdMap.set(sourceItem.id, newUsage.id)

      // Optionally create EBOM_SOURCE relationship for explicit cross-domain tracking
      // This supplements the usageOf for domain-specific queries
      if (createSourceLinks) {
        await tx.insert(itemRelationships).values({
          sourceId: definitionId, // Link from definition
          targetId: newUsage.id, // To usage
          relationshipType: EBOM_SOURCE_RELATIONSHIP,
          sourceDesignId: sourceDesignId,
          targetDesignId: targetDesignId,
          sourceDomain: 'engineering',
          targetDomain: 'manufacturing',
          derivationMethod: 'direct',
          createdBy: userId,
          modifiedBy: userId,
        })
        sourceLinks++
      }
    }

    // Create itemVersions entries so items are visible via VersionResolver
    // This is required for getReleasedItems/getItemsAtCommit to find these items
    const newItemIds = Array.from(itemIdMap.values())
    if (newItemIds.length > 0) {
      await tx.insert(itemVersions).values(
        newItemIds.map((itemId) => ({
          commitId: targetCommitId,
          itemId: itemId,
          changeType: 'added' as const,
        })),
      )
    }

    // Get and copy BOM relationships (these define the MBOM structure)
    // Build masterId -> new usage ID mapping (like clone handler does)
    // This handles items that may have multiple versions
    const sourceMasterIds = sourceItems.map((item) => item.masterId)

    // Find ALL item version IDs for these masters (including old revisions)
    // This ensures we capture relationships that may reference older versions
    const allItemVersions = await tx
      .select({
        id: items.id,
        masterId: items.masterId,
      })
      .from(items)
      .where(inArray(items.masterId, sourceMasterIds))

    const allSourceItemIds = allItemVersions.map((v) => v.id)

    // Build itemId -> masterId mapping for all versions
    const itemIdToMasterId = new Map<string, string>()
    for (const v of allItemVersions) {
      itemIdToMasterId.set(v.id, v.masterId)
    }

    // Build masterId -> new usage ID mapping
    const masterIdToNewUsageId = new Map<string, string>()
    for (const sourceItem of sourceItems) {
      const newUsageId = itemIdMap.get(sourceItem.id)
      if (newUsageId) {
        masterIdToNewUsageId.set(sourceItem.masterId, newUsageId)
      }
    }

    // Get all BOM relationships where source is any version of our items
    const sourceRelationships = await tx
      .select()
      .from(itemRelationships)
      .where(
        and(
          inArray(itemRelationships.sourceId, allSourceItemIds),
          eq(itemRelationships.relationshipType, 'BOM'),
        ),
      )

    // Track which relationships we've already copied (by masterId pair) to avoid duplicates
    const copiedRelationships = new Set<string>()
    let relationshipsCopied = 0

    for (const rel of sourceRelationships) {
      // Map item IDs to masterIds, then to new usage IDs
      const sourceMasterId = itemIdToMasterId.get(rel.sourceId)
      const targetMasterId = itemIdToMasterId.get(rel.targetId)

      if (!sourceMasterId) {
        continue
      }

      // Check if we've already copied this relationship (from a different version)
      // For external targets (library items), use the original targetId for dedup
      const relKey = `${sourceMasterId}:${targetMasterId || rel.targetId}`
      if (copiedRelationships.has(relKey)) {
        continue
      }
      copiedRelationships.add(relKey)

      const newSourceId = masterIdToNewUsageId.get(sourceMasterId)

      if (!newSourceId) continue

      if (targetMasterId) {
        // Target is within our item set - remap to new usage ID
        const newTargetId = masterIdToNewUsageId.get(targetMasterId)
        if (newTargetId) {
          await tx.insert(itemRelationships).values({
            sourceId: newSourceId,
            targetId: newTargetId,
            relationshipType: 'BOM',
            quantity: rel.quantity,
            referenceDesignator: rel.referenceDesignator,
            findNumber: rel.findNumber,
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
      } else {
        // Target is outside our item set (e.g., library item from another design)
        // Preserve the relationship pointing to the original external item
        await tx.insert(itemRelationships).values({
          sourceId: newSourceId,
          targetId: rel.targetId, // Original external item
          relationshipType: 'BOM',
          quantity: rel.quantity,
          referenceDesignator: rel.referenceDesignator,
          findNumber: rel.findNumber,
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

    return {
      itemsCopied: itemIdMap.size,
      relationshipsCopied,
      sourceLinks,
      itemIdMap,
    }
  }

  /**
   * Check for upstream changes in the source EBOM since this MBOM was derived.
   * Returns a list of items that have changed in the source design.
   */
  static async checkUpstreamChanges(
    mbomDesignId: string,
  ): Promise<Array<UpstreamChangeItem>> {
    // Get the MBOM design
    const mbomDesign = await DesignService.getById(mbomDesignId)
    if (!mbomDesign) {
      throw new NotFoundError('Design', mbomDesignId, {
        operation: 'checkUpstreamChanges',
      })
    }

    if (mbomDesign.designType !== 'Manufacturing') {
      throw new ValidationError(
        'Design is not a Manufacturing design',
        undefined,
        { field: 'designId' },
      )
    }

    if (!mbomDesign.sourceDesignId) {
      return [] // No source design linked
    }

    // Get current items from source design
    const sourceMainBranch = await DesignService.getDefaultBranch(
      mbomDesign.sourceDesignId,
    )
    if (!sourceMainBranch) {
      return []
    }

    const currentSourceCommitId = sourceMainBranch.headCommitId
    const derivationCommitId = mbomDesign.sourceCommitId

    // If no derivation commit recorded or commits are the same, no changes
    if (!derivationCommitId || currentSourceCommitId === derivationCommitId) {
      return []
    }

    // Get EBOM_SOURCE relationships to find linked items
    const ebomSourceLinks = await db
      .select({
        sourceItemId: itemRelationships.sourceId,
        mbomItemId: itemRelationships.targetId,
      })
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.targetDesignId, mbomDesignId),
          eq(itemRelationships.relationshipType, EBOM_SOURCE_RELATIONSHIP),
        ),
      )

    if (ebomSourceLinks.length === 0) {
      return []
    }

    // Get current versions of source items
    const currentSourceItems = await db
      .select()
      .from(items)
      .where(
        and(
          eq(items.designId, mbomDesign.sourceDesignId),
          eq(items.isCurrent, true),
          eq(items.isDeleted, false),
        ),
      )

    // Get items at derivation point - simplified check using revision comparison
    // This identifies items where the current revision differs from what was captured
    const changedItems: Array<UpstreamChangeItem> = []

    // Build a map of source items by master ID
    const currentItemsByMaster = new Map<
      string,
      (typeof currentSourceItems)[0]
    >()
    for (const item of currentSourceItems) {
      currentItemsByMaster.set(item.masterId, item)
    }

    // Check for changes in linked items
    for (const link of ebomSourceLinks) {
      const sourceItem = currentSourceItems.find(
        (item) => item.id === link.sourceItemId,
      )
      if (sourceItem) {
        const currentVersion = currentItemsByMaster.get(sourceItem.masterId)
        if (currentVersion && currentVersion.id !== link.sourceItemId) {
          // Item has been revised
          changedItems.push({
            masterId: sourceItem.masterId,
            itemNumber: sourceItem.itemNumber,
            name: sourceItem.name,
            itemType: sourceItem.itemType,
            previousRevision: sourceItem.revision,
            newRevision: currentVersion.revision,
            changeType: 'modified',
          })
        }
      }
    }

    return changedItems
  }

  /**
   * Get all pending upstream changes for an MBOM
   */
  static async getPendingUpstreamChanges(
    mbomDesignId: string,
  ): Promise<Array<UpstreamChangeResult>> {
    const pendingChanges = await db
      .select({
        id: upstreamChanges.id,
        sourceDesignId: upstreamChanges.sourceDesignId,
        changedItems: upstreamChanges.changedItems,
        status: upstreamChanges.status,
        createdAt: upstreamChanges.createdAt,
        sourceEcoId: upstreamChanges.sourceEcoId,
      })
      .from(upstreamChanges)
      .where(
        and(
          eq(upstreamChanges.targetDesignId, mbomDesignId),
          eq(upstreamChanges.status, 'pending'),
        ),
      )

    const results: Array<UpstreamChangeResult> = []

    for (const change of pendingChanges) {
      // Get source design info
      const sourceDesign = await DesignService.getById(change.sourceDesignId)
      if (!sourceDesign) continue

      // Get ECO item number if applicable
      let sourceEcoNumber: string | null = null
      if (change.sourceEcoId) {
        const [eco] = await db
          .select({ itemNumber: items.itemNumber })
          .from(items)
          .where(eq(items.id, change.sourceEcoId))
          .limit(1)
        sourceEcoNumber = eco?.itemNumber ?? null
      }

      results.push({
        id: change.id,
        sourceDesignId: change.sourceDesignId,
        sourceDesignName: sourceDesign.name,
        sourceDesignCode: sourceDesign.code,
        sourceEcoNumber,
        changedItems: change.changedItems,
        status: change.status,
        createdAt: change.createdAt,
      })
    }

    return results
  }

  /**
   * Review an upstream change notification
   */
  static async reviewUpstreamChange(
    changeId: string,
    data: ReviewUpstreamChangeInput,
    userId: string,
  ): Promise<{ success: boolean; status: string }> {
    const validated = reviewUpstreamChangeSchema.parse(data)

    const [change] = await db
      .select()
      .from(upstreamChanges)
      .where(eq(upstreamChanges.id, changeId))
      .limit(1)

    if (!change) {
      throw new NotFoundError('UpstreamChange', changeId, {
        operation: 'reviewUpstreamChange',
      })
    }

    let newStatus: string
    switch (validated.action) {
      case 'accept':
        newStatus = 'accepted'
        break
      case 'reject':
        newStatus = 'rejected'
        break
      case 'defer':
        newStatus = 'deferred'
        break
      default:
        newStatus = 'reviewed'
    }

    await db
      .update(upstreamChanges)
      .set({
        status: newStatus,
        reviewedBy: userId,
        reviewedAt: new Date(),
        reviewNotes: validated.notes,
      })
      .where(eq(upstreamChanges.id, changeId))

    return { success: true, status: newStatus }
  }

  /**
   * Create upstream change notification when an ECO is released on a source EBOM.
   * Called from ChangeOrderMergeService hook.
   */
  static async notifyDerivedMboms(
    sourceDesignId: string,
    sourceCommitId: string,
    sourceEcoId: string,
    changedItems: Array<UpstreamChangeItem>,
  ): Promise<number> {
    // Find all MBOMs derived from this source
    const derivedMboms = await db
      .select({ id: designs.id })
      .from(designs)
      .where(
        and(
          eq(designs.sourceDesignId, sourceDesignId),
          eq(designs.designType, 'Manufacturing'),
          eq(designs.isArchived, false),
        ),
      )

    if (derivedMboms.length === 0) {
      return 0
    }

    // Create upstream change notification for each derived MBOM
    for (const mbom of derivedMboms) {
      await db.insert(upstreamChanges).values({
        targetDesignId: mbom.id,
        sourceDesignId: sourceDesignId,
        sourceCommitId: sourceCommitId,
        sourceEcoId: sourceEcoId,
        changedItems: changedItems,
        status: 'pending',
      })
    }

    return derivedMboms.length
  }

  /**
   * Get list of designs that are derived from a source design
   */
  static async getDerivedDesigns(sourceDesignId: string) {
    return db
      .select()
      .from(designs)
      .where(
        and(
          eq(designs.sourceDesignId, sourceDesignId),
          eq(designs.isArchived, false),
        ),
      )
  }

  /**
   * Check if a design is a Manufacturing design
   */
  static async isManufacturingDesign(designId: string): Promise<boolean> {
    const design = await DesignService.getById(designId)
    return design?.designType === 'Manufacturing'
  }

  /**
   * Check if a design is an Engineering design
   */
  static async isEngineeringDesign(designId: string): Promise<boolean> {
    const design = await DesignService.getById(designId)
    return design?.designType === 'Engineering'
  }
}
