// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db'
import { DESIGN_CREATED, publishDomainEvent } from '../events'
import {
  branches,
  commits,
  designs,
  itemRelationships,
  itemVersions,
  items,
  upstreamChanges,
} from '../db/schema'
import { notDeleted } from '../db/filters'
import { NotFoundError, ValidationError } from '../errors'
import {
  formatOptionText,
  makeCodeSchema,
  optionConditionKey,
} from '../types/variants'
import { DesignService } from './DesignService'
import { BranchService } from './BranchService'
import { UsageService } from './UsageService'
import { VersionResolver } from './VersionResolver'
import { LifecycleService } from './LifecycleService'
import type { UpstreamChangeItem } from '../db/schema'
import type { DesignConfiguration } from '../db/schema/designs'
import { takeFirst } from '@/lib/db/take-first'
import { serviceLogger } from '@/lib/logging/logger'

/**
 * Relationship type for linking MBOM items back to their EBOM source
 */
export const EBOM_SOURCE_RELATIONSHIP = 'EBOM_SOURCE'

/**
 * Schema for creating an MBOM from an EBOM
 */
export const createMbomSchema = z.object({
  sourceDesignId: z.string().uuid(),
  /** Root Part whose BOM subtree is materialised. */
  rootItemId: z.string().uuid().optional(),
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
  /**
   * Product variants: derive the MBOM as one configuration of a part. BOM
   * lines the selections do not admit are left out; the rest are copied as
   * fixed lines. Give `makeCode` to use a named make on the root part, or
   * `selections` directly (per-order configure-to-order).
   */
  configuration: z
    .object({
      rootItemId: z.string().uuid(),
      makeCode: makeCodeSchema.optional(),
      selections: z.record(z.string(), z.string()).optional(),
    })
    .refine((c) => c.makeCode !== undefined || c.selections !== undefined, {
      message: 'A configuration needs a makeCode or selections',
    })
    .optional(),
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
  /** BOM lines the configuration did not admit; 0 without a configuration. */
  linesFiltered: number
  /**
   * Work instruction attachments inherited from the EBOM. These rows are
   * the traveler baseline — `WorkOrderInstructionService.populate` walks the
   * MBOM and instantiates every work instruction attached to every part — so
   * a zero here on an EBOM that carries flagged attachments means the work
   * orders will be missing procedures. Inheritance is best-effort (a failure
   * is logged, never rethrown), which is exactly why the count is reported.
   */
  instructionsInherited: number
}

export interface UpstreamChangeResult {
  id: string
  sourceDesignId: string
  sourceDesignName: string
  sourceDesignCode: string
  sourceEcoNumber: string | null
  /**
   * `stillSelected` is set only on an MBOM derived with a configuration: does
   * the configuration, resolved against the source as it is now, include
   * this item? A change to a line the make never used needs no MCO.
   */
  changedItems: Array<UpstreamChangeItem & { stillSelected?: boolean }>
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

    // Product variants: settle the configuration before any row is written.
    // A root is needed only when structure is copied (or explicitly selected).
    // Preserve the existing ability to derive an empty MBOM from an empty
    // Engineering design and to create one without copying its structure.
    let sourceRootItemId: string | undefined
    let configuration: DesignConfiguration | null = null
    const mustResolveRoot =
      validated.copyBomStructure ||
      validated.rootItemId !== undefined ||
      validated.configuration !== undefined

    if (mustResolveRoot) {
      const sourceMainBranch = await BranchService.getMainBranch(
        validated.sourceDesignId,
      )
      if (!sourceMainBranch) {
        throw new ValidationError('The source design has no main branch')
      }
      const sourceBranchItems = (
        await VersionResolver.getBranchItems(sourceMainBranch.id)
      ).items
      const declaredRootItemId =
        validated.rootItemId ?? validated.configuration?.rootItemId
      let sourceRoot = declaredRootItemId
        ? sourceBranchItems.find((item) => item.id === declaredRootItemId)
        : undefined
      if (!sourceRoot && declaredRootItemId) {
        const { ItemService } = await import('../items/services/ItemService')
        const requested = await ItemService.findById(declaredRootItemId)
        sourceRoot = requested?.masterId
          ? sourceBranchItems.find(
              (item) => item.masterId === requested.masterId,
            )
          : undefined
      }
      if (!sourceRoot) {
        const nestedTargets =
          sourceBranchItems.length > 0
            ? await db
                .select({ masterId: items.masterId })
                .from(itemRelationships)
                .innerJoin(items, eq(items.id, itemRelationships.targetId))
                .where(
                  and(
                    inArray(
                      itemRelationships.sourceId,
                      sourceBranchItems.map((item) => item.id),
                    ),
                    eq(itemRelationships.relationshipType, 'BOM'),
                  ),
                )
            : []
        const nestedMasterIds = new Set(
          nestedTargets.map((target) => target.masterId),
        )
        const roots = sourceBranchItems.filter(
          (item) =>
            item.itemType === 'Part' &&
            item.inDesignStructure &&
            !nestedMasterIds.has(item.masterId),
        )
        if (roots.length === 1) {
          sourceRoot = roots[0]!
        } else if (
          roots.length > 1 ||
          sourceBranchItems.length > 0 ||
          declaredRootItemId
        ) {
          throw new ValidationError(
            roots.length === 0
              ? 'The source design has no root Part'
              : 'Select the root Part to release; the source design has multiple roots',
            undefined,
            { field: 'rootItemId' },
          )
        }
      }
      if (
        sourceRoot &&
        (sourceRoot.itemType !== 'Part' ||
          sourceRoot.designId !== validated.sourceDesignId)
      ) {
        throw new ValidationError(
          'The MBOM root must be a Part in the source design',
          undefined,
          { field: 'rootItemId' },
        )
      }
      sourceRootItemId = sourceRoot?.id

      if (validated.configuration) {
        if (!sourceRoot || !sourceRootItemId) {
          throw new ValidationError('The source design has no root Part')
        }
        const { VariantService } = await import('./VariantService')
        const { ItemService } = await import('../items/services/ItemService')
        const { rootItemId, makeCode } = validated.configuration
        const configurationRoot = await ItemService.findById(rootItemId)
        if (configurationRoot?.masterId !== sourceRoot.masterId) {
          throw new ValidationError(
            'The configuration root must match the selected MBOM root',
            undefined,
            { field: 'configuration.rootItemId' },
          )
        }
        const namedSelections = makeCode
          ? await VariantService.selectionsForMake(sourceRootItemId, makeCode)
          : undefined
        if (
          namedSelections &&
          validated.configuration.selections &&
          (Object.keys(namedSelections).length !==
            Object.keys(validated.configuration.selections).length ||
            Object.entries(namedSelections).some(
              ([family, value]) =>
                validated.configuration?.selections?.[family] !== value,
            ))
        ) {
          throw new ValidationError(
            `Selections do not match execution ${makeCode}`,
            [
              {
                field: 'configuration.selections',
                message: `Selections do not match execution ${makeCode}`,
                code: 'MAKE_SELECTIONS_MISMATCH',
              },
            ],
          )
        }
        const selections =
          namedSelections ?? validated.configuration.selections!
        const resolved = await VariantService.resolve(
          sourceRootItemId,
          selections,
          { rootMakeCode: makeCode },
        )
        if (!resolved.validation.valid || resolved.findings.length > 0) {
          const nestedErrors = resolved.findings.map((finding) => ({
            field: 'configuration',
            message: `${finding.itemNumber}: ${finding.message}`,
            code: 'INVALID_NESTED_CONFIGURATION',
          }))
          throw new ValidationError(
            resolved.validation.errors[0]?.message ??
              nestedErrors[0]?.message ??
              'Invalid configuration',
            [
              ...resolved.validation.errors.map((e) => ({
                field: e.family
                  ? `configuration.selections.${e.family}`
                  : 'configuration.selections',
                message: e.message,
                code: 'INVALID_CONFIGURATION',
              })),
              ...nestedErrors,
            ],
            { field: 'configuration' },
          )
        }
        configuration = {
          rootItemId: sourceRootItemId,
          makeCode: makeCode ?? null,
          selections,
        }
      }
    }

    // Create the Manufacturing design with transaction
    return db.transaction(async (tx) => {
      // 1. Create Manufacturing design
      const mbomDesign = takeFirst(
        await tx
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
            configuration,
            createdBy: userId,
          })
          .returning(),
      )

      // 2. Create the main branch first, head unset — commits.branch_id is a
      // real FK now, so the old placeholder-then-fixup order cannot insert.
      const mainBranch = takeFirst(
        await tx
          .insert(branches)
          .values({
            designId: mbomDesign.id,
            name: 'main',
            branchType: 'main',
            createdBy: userId,
          })
          .returning(),
      )

      // 3. Create the initial commit on the real branch
      const initialCommit = takeFirst(
        await tx
          .insert(commits)
          .values({
            designId: mbomDesign.id,
            branchId: mainBranch.id,
            message: `Initial MBOM created from ${sourceDesign.code}`,
            createdBy: userId,
          })
          .returning(),
      )

      // 4. Point the branch at its initial commit
      await tx
        .update(branches)
        .set({ headCommitId: initialCommit.id, baseCommitId: initialCommit.id })
        .where(eq(branches.id, mainBranch.id))
      mainBranch.headCommitId = initialCommit.id
      mainBranch.baseCommitId = initialCommit.id

      // 5. Update design with default branch
      await tx
        .update(designs)
        .set({ defaultBranchId: mainBranch.id })
        .where(eq(designs.id, mbomDesign.id))

      // The design is announced like any other, in `DesignService.create`'s
      // shape and the transaction that creates it. It was silent, so the first
      // `design.released` for a Manufacturing design named one no consumer had
      // been told about. The items copied into it below stay silent: the
      // volume path `item.updated` describes.
      await publishDomainEvent(tx, DESIGN_CREATED, {
        actorId: userId,
        subject: { id: mbomDesign.id },
        context: {
          programId: mbomDesign.programId ?? undefined,
          designId: mbomDesign.id,
        },
        payload: {
          designId: mbomDesign.id,
          programId: mbomDesign.programId,
          name: mbomDesign.name,
          code: mbomDesign.code,
          designType: mbomDesign.designType,
          parentDesignId: mbomDesign.parentDesignId,
          cloneSourceDesignId: mbomDesign.cloneSourceDesignId,
          mainBranchId: mainBranch.id,
          initialCommitId: initialCommit.id,
        },
      })

      let itemsCopied = 0
      let relationshipsCopied = 0
      let sourceLinks = 0
      let linesFiltered = 0
      let instructionsInherited = 0

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
          sourceRootItemId,
          configuration,
        )
        itemsCopied = copyResult.itemsCopied
        relationshipsCopied = copyResult.relationshipsCopied
        sourceLinks = copyResult.sourceLinks
        linesFiltered = copyResult.linesFiltered

        // 7. Inherit work instruction attachments from EBOM to MBOM
        if (copyResult.itemIdMap.size > 0) {
          try {
            const { WorkInstructionInheritanceService } =
              await import('./WorkInstructionInheritanceService')
            const inheritResult =
              await WorkInstructionInheritanceService.inheritAttachments(
                tx,
                validated.sourceDesignId,
                mbomDesign.id,
                copyResult.itemIdMap,
                userId,
              )
            instructionsInherited = inheritResult.inherited
          } catch (error) {
            // WI inheritance failure should not block MBOM creation — but it
            // must not be silent either: these attachments are the traveler
            // baseline, so losing them ships an MBOM whose work orders are
            // missing procedures.
            serviceLogger.warn(
              {
                err: error,
                sourceDesignId: validated.sourceDesignId,
                targetDesignId: mbomDesign.id,
              },
              'Work instruction inheritance failed; MBOM created without inherited attachments',
            )
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
        linesFiltered,
        instructionsInherited,
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
    sourceRootItemId?: string,
    configuration: DesignConfiguration | null = null,
  ): Promise<{
    itemsCopied: number
    relationshipsCopied: number
    sourceLinks: number
    linesFiltered: number
    itemIdMap: Map<string, string>
  }> {
    // Get the main branch for the source design
    const sourceMainBranch = await BranchService.getMainBranch(sourceDesignId)
    if (!sourceMainBranch) {
      return {
        itemsCopied: 0,
        relationshipsCopied: 0,
        sourceLinks: 0,
        linesFiltered: 0,
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
        linesFiltered: 0,
        itemIdMap: new Map(),
      }
    }

    if (!sourceRootItemId) {
      throw new ValidationError('The source design has no root Part')
    }

    const sourceItemById = new Map(
      allSourceItems.map((item) => [item.id, item]),
    )
    let rootItem = sourceItemById.get(sourceRootItemId)
    if (!rootItem) {
      const { ItemService } = await import('../items/services/ItemService')
      const requestedRoot = await ItemService.findById(sourceRootItemId)
      rootItem = requestedRoot?.masterId
        ? allSourceItems.find(
            (item) => item.masterId === requestedRoot.masterId,
          )
        : undefined
    }
    if (!rootItem) {
      throw new ValidationError('The selected root is not on the source branch')
    }

    // Read only the current source rows. Historical versions are not a second
    // structure and must never be folded into the MBOM.
    const candidateRelationships = await tx
      .select()
      .from(itemRelationships)
      .where(
        and(
          inArray(
            itemRelationships.sourceId,
            allSourceItems.map((item) => item.id),
          ),
          eq(itemRelationships.relationshipType, 'BOM'),
        ),
      )

    const targetIds = [
      ...new Set(candidateRelationships.map((rel) => rel.targetId)),
    ]
    const targetVersions =
      targetIds.length > 0
        ? await tx
            .select({ id: items.id, masterId: items.masterId })
            .from(items)
            .where(inArray(items.id, targetIds))
        : []
    const masterByItemId = new Map([
      ...allSourceItems.map((item) => [item.id, item.masterId] as const),
      ...targetVersions.map((item) => [item.id, item.masterId] as const),
    ])
    const currentByMaster = new Map(
      allSourceItems.map((item) => [item.masterId, item] as const),
    )

    const includedMasterIds = new Set<string>([rootItem.masterId])
    const selectedRelationshipIds = new Set<string>()
    let linesFiltered = 0
    if (configuration) {
      const { VariantService } = await import('./VariantService')
      const resolved = await VariantService.resolve(
        rootItem.id,
        configuration.selections,
        { rootMakeCode: configuration.makeCode ?? undefined },
      )
      if (!resolved.validation.valid || resolved.findings.length > 0) {
        throw new ValidationError('The configuration can no longer be resolved')
      }
      const collect = (nodes: typeof resolved.children) => {
        for (const node of nodes) {
          selectedRelationshipIds.add(node.relationshipId)
          if (node.designId === sourceDesignId)
            includedMasterIds.add(node.masterId)
          collect(node.children)
        }
      }
      collect(resolved.children)
      linesFiltered = resolved.droppedLines
    } else {
      const relationshipsBySource = new Map<
        string,
        Array<(typeof candidateRelationships)[number]>
      >()
      for (const rel of candidateRelationships) {
        const list = relationshipsBySource.get(rel.sourceId) ?? []
        list.push(rel)
        relationshipsBySource.set(rel.sourceId, list)
      }
      const walk = (sourceId: string, visited: Set<string>) => {
        for (const rel of relationshipsBySource.get(sourceId) ?? []) {
          selectedRelationshipIds.add(rel.id)
          const targetMasterId = masterByItemId.get(rel.targetId)
          const currentTarget = targetMasterId
            ? currentByMaster.get(targetMasterId)
            : undefined
          if (!currentTarget || visited.has(currentTarget.masterId)) continue
          includedMasterIds.add(currentTarget.masterId)
          walk(currentTarget.id, new Set([...visited, currentTarget.masterId]))
        }
      }
      walk(rootItem.id, new Set([rootItem.masterId]))
    }

    const sourceItems = allSourceItems.filter((item) =>
      includedMasterIds.has(item.masterId),
    )

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
      const newUsage = takeFirst(
        await tx
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
            // MBOM usages start at the lifecycle's initial state
            state: await LifecycleService.getInitialStateId(
              sourceItem.itemType,
            ),
            isCurrent: true,
            inDesignStructure: sourceItem.inDesignStructure,
            attributes: sourceItem.attributes,
            metamodel: sourceItem.metamodel ?? 'cascadia',
            sysmlType: sysmlType, // Auto-assigned based on item type

            // Audit
            createdBy: userId,
            modifiedBy: userId,
          })
          .returning(),
      )

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
    const itemIdToMasterId = masterByItemId

    // Build masterId -> new usage ID mapping
    const masterIdToNewUsageId = new Map<string, string>()
    for (const sourceItem of sourceItems) {
      const newUsageId = itemIdMap.get(sourceItem.id)
      if (newUsageId) {
        masterIdToNewUsageId.set(sourceItem.masterId, newUsageId)
      }
    }

    const sourceRelationships = candidateRelationships.filter((rel) =>
      selectedRelationshipIds.has(rel.id),
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

      // Product variants: a configured derivation keeps only the lines the
      // selections admit, and copies them as fixed lines. The condition that
      // admitted a line is kept as a derivation note. Without a
      // configuration the 150 % BOM is copied as it is, conditions included.
      const copiedOption = configuration ? null : rel.option
      const derivationNotes =
        configuration && rel.option
          ? `Selected by ${formatOptionText(rel.option)}`
          : null

      // Check if we've already copied this relationship (from a different version)
      // For external targets (library items), use the original targetId for dedup
      const relKey = [
        sourceMasterId,
        targetMasterId || rel.targetId,
        rel.relationshipType,
        optionConditionKey(copiedOption),
        rel.targetMakeCode ?? '',
      ].join('\u0000')
      if (copiedRelationships.has(relKey)) {
        continue
      }
      copiedRelationships.add(relKey)

      const newSourceId = masterIdToNewUsageId.get(sourceMasterId)

      if (!newSourceId) continue

      const newTargetId = targetMasterId
        ? masterIdToNewUsageId.get(targetMasterId)
        : undefined
      if (newTargetId) {
        // Target is within the selected source subtree - remap to its usage.
        await tx.insert(itemRelationships).values({
          sourceId: newSourceId,
          targetId: newTargetId,
          relationshipType: 'BOM',
          quantity: rel.quantity,
          referenceDesignator: rel.referenceDesignator,
          findNumber: rel.findNumber,
          metadata: rel.metadata,
          option: copiedOption,
          targetMakeCode: rel.targetMakeCode,
          derivationNotes,
          isComposite: rel.isComposite,
          isDirected: rel.isDirected,
          multiplicityLower: rel.multiplicityLower,
          multiplicityUpper: rel.multiplicityUpper,
          usageAttributes: rel.usageAttributes,
          createdBy: userId,
          modifiedBy: userId,
        })
        relationshipsCopied++
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
          option: copiedOption,
          targetMakeCode: rel.targetMakeCode,
          derivationNotes,
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
      linesFiltered,
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
          notDeleted(),
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
    const selectedMasters =
      pendingChanges.length > 0
        ? await this.currentlySelectedMasters(mbomDesignId)
        : null

    for (const change of pendingChanges) {
      // Get source design info
      const sourceDesign = await DesignService.getById(change.sourceDesignId)
      if (!sourceDesign) continue

      // Get ECO item number if applicable
      let sourceEcoNumber: string | null = null
      if (change.sourceEcoId) {
        const [changeOrder] = await db
          .select({ itemNumber: items.itemNumber })
          .from(items)
          .where(eq(items.id, change.sourceEcoId))
          .limit(1)
        sourceEcoNumber = changeOrder?.itemNumber ?? null
      }

      results.push({
        id: change.id,
        sourceDesignId: change.sourceDesignId,
        sourceDesignName: sourceDesign.name,
        sourceDesignCode: sourceDesign.code,
        sourceEcoNumber,
        changedItems: selectedMasters
          ? change.changedItems.map((item) => ({
              ...item,
              stillSelected: selectedMasters.has(item.masterId),
            }))
          : change.changedItems,
        status: change.status,
        createdAt: change.createdAt,
      })
    }

    return results
  }

  /**
   * Product variants: the master ids a configured MBOM's configuration
   * selects when resolved against the source design as it is now (the root
   * included). Null for an unconfigured MBOM, or when the root is gone.
   */
  private static async currentlySelectedMasters(
    mbomDesignId: string,
  ): Promise<Set<string> | null> {
    const mbom = await DesignService.getById(mbomDesignId)
    if (!mbom?.configuration || !mbom.sourceDesignId) return null
    const configuration = mbom.configuration

    const { ItemService } = await import('../items/services/ItemService')
    const root = await ItemService.findById(configuration.rootItemId)
    if (!root?.masterId) return null
    const current = await VersionResolver.getReleasedVersion(
      root.masterId,
      mbom.sourceDesignId,
    )
    if (!current) return null

    const { VariantService } = await import('./VariantService')
    const resolved = await VariantService.resolve(
      current.id,
      configuration.selections,
    )
    const masters = new Set<string>([root.masterId])
    const collect = (nodes: typeof resolved.children) => {
      for (const node of nodes) {
        masters.add(node.masterId)
        collect(node.children)
      }
    }
    collect(resolved.children)
    return masters
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
