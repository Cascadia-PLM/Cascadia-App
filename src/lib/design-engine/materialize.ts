// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

/**
 * Materialization Service
 *
 * Converts the session's reviewed artifacts (requirements + BOM draft) into
 * real PLM data. The contract is computed by plan() and shared between
 * preview() and execute(), so what the user is told will happen is exactly
 * what happens:
 *
 * - No target design: a new design is created in the session's program, then
 *   requirements, parts, and BOM relationships are created on its main branch
 *   in the 'Draft' lifecycle state. No ECO is involved — pre-release designs
 *   are directly editable, and revision letters are assigned later when the
 *   design is first released through an ECO.
 * - Existing pre-release design: same as above, minus the design creation.
 * - Existing design with released items: an ECO is created and the new items
 *   are added to its branch (as 'added' working copies, and registered on the
 *   ECO with the 'release' change action). They are released with revision
 *   letters when the ECO is reviewed, approved, and merged to main.
 */

import { DesignSessionService } from './session-service'
import type { BaseItem } from '@/lib/items/types/base'
import type { DesignSession } from './session-service'
import type {
  BomNodeDraft,
  MaterializationPlan,
  MaterializationPreview,
  MaterializationResult,
} from './types'
import { ItemService } from '@/lib/items/services/ItemService'
import { DesignService } from '@/lib/services/DesignService'
import { ProgramService } from '@/lib/services/ProgramService'
import { BranchService } from '@/lib/services/BranchService'
import { CatalogService } from '@/lib/services/CatalogService'
import { ChangeOrderService } from '@/lib/items/services/ChangeOrderService'
import { ValidationError } from '@/lib/errors'
import { serviceLogger } from '@/lib/logging/logger'

export class MaterializationService {
  /**
   * Determine what materialization will do for this session.
   *
   * preview() displays this plan and execute() follows it — keep all
   * mode/target decisions here so the two cannot drift apart.
   */
  static async plan(session: DesignSession): Promise<MaterializationPlan> {
    const program = await ProgramService.getById(session.programId)
    const programName = program?.name ?? null

    if (!session.designId) {
      return {
        mode: 'create_design',
        supported: true,
        programId: session.programId,
        programName,
        targetDesignId: null,
        targetDesignName: null,
        newDesignName: session.title ?? 'Collaborative Design',
        initialState: 'Draft',
        targetBranch: 'main',
      }
    }

    const design = await DesignService.getById(session.designId)
    const targetDesignName = design?.name ?? design?.code ?? null
    const isProtected = await BranchService.isMainBranchProtected(
      session.designId,
    )

    if (isProtected) {
      return {
        mode: 'eco_required',
        supported: true,
        programId: session.programId,
        programName,
        targetDesignId: session.designId,
        targetDesignName,
        ecoName: `ECO for ${session.title ?? 'Collaborative Design'}`,
        initialState: 'Draft',
        targetBranch: 'main',
      }
    }

    return {
      mode: 'add_to_design',
      supported: true,
      programId: session.programId,
      programName,
      targetDesignId: session.designId,
      targetDesignName,
      initialState: 'Draft',
      targetBranch: 'main',
    }
  }

  /**
   * Generate a preview of what materialization will create.
   */
  static async preview(
    session: DesignSession,
  ): Promise<MaterializationPreview> {
    const plan = await this.plan(session)

    const artifacts = session.artifacts
    if (!artifacts?.bom) {
      return {
        plan,
        newPartsCount: 0,
        reusedPartsCount: 0,
        newRequirementsCount: 0,
        bomRelationshipsCount: 0,
        items: [],
      }
    }

    const bom = artifacts.bom

    // Count parts
    let newParts = 0
    let reusedParts = 0
    let bomRelationships = 0
    const items: MaterializationPreview['items'] = []

    function walkNode(node: BomNodeDraft) {
      if (node.isNew) {
        newParts++
      } else {
        reusedParts++
      }

      items.push({
        tempId: node.tempId,
        name: node.name,
        itemType: 'Part',
        isNew: node.isNew,
        existingItemNumber: node.existingItemNumber,
      })

      bomRelationships += node.children.length

      for (const child of node.children) {
        walkNode(child)
      }
    }

    walkNode(bom.rootAssembly)

    // Count requirements to create
    const newRequirementsCount = artifacts.requirements.length

    // Add requirements to items list
    for (const req of artifacts.requirements) {
      items.push({
        tempId: req.tempId,
        name: req.name,
        itemType: 'Requirement',
        isNew: true,
      })
    }

    return {
      plan,
      newPartsCount: newParts,
      reusedPartsCount: reusedParts,
      newRequirementsCount,
      bomRelationshipsCount: bomRelationships,
      items,
    }
  }

  /**
   * Execute materialization following the plan: create the design if needed,
   * then create all requirements, parts, and BOM relationships in 'Draft'
   * state on the target design's main branch.
   */
  static async execute(
    session: DesignSession,
    userId: string,
  ): Promise<MaterializationResult> {
    const artifacts = session.artifacts
    if (!artifacts?.bom) {
      throw new ValidationError('No BOM to materialize')
    }

    const plan = await this.plan(session)
    if (!plan.supported) {
      throw new ValidationError(
        plan.blockedReason ??
          'Materialization is not supported for this target design',
      )
    }

    const bom = artifacts.bom
    const tempIdToItemId = new Map<string, string>()
    const tempIdToItemNumber = new Map<string, string>()
    const createdItems: MaterializationResult['createdItems'] = []
    let bomRelationshipsCreated = 0

    // Step 1: Resolve or create the target design
    let resolvedDesignId = plan.targetDesignId
    let designName = plan.targetDesignName
    if (!resolvedDesignId) {
      // Generate a unique uppercase alphanumeric code
      const codeTimestamp = Date.now().toString(36).toUpperCase()
      const design = await DesignService.create(
        {
          name: plan.newDesignName ?? 'Collaborative Design',
          code: `CD-${codeTimestamp}`,
          programId: session.programId,
          designType: 'Engineering',
        },
        userId,
      )
      resolvedDesignId = design.id ?? null
      designName = design.name ?? null
    }
    if (!resolvedDesignId) {
      throw new ValidationError('Failed to create design for materialization')
    }
    const designId = resolvedDesignId

    // Step 1b: For a released (branch-protected) design, create an ECO and a
    // branch to hold the new items. They are created on that branch as 'added'
    // working copies and released with revision letters when the ECO merges.
    let ecoId: string | undefined
    let ecoNumber: string | undefined
    let ecoBranchId: string | null = null
    if (plan.mode === 'eco_required') {
      const eco = await ItemService.create(
        'ChangeOrder',
        {
          name: plan.ecoName ?? `ECO for ${session.title ?? 'Design Session'}`,
          revision: '-',
          itemType: 'ChangeOrder',
          changeType: 'ECO',
          priority: 'medium',
          reasonForChange: `Materialized from collaborative design session ${session.id}`,
          designId,
        } as BaseItem,
        userId,
        { bypassBranchProtection: true },
      )
      ecoId = eco.id ?? undefined
      ecoNumber = eco.itemNumber ?? undefined
      if (!ecoId) {
        throw new ValidationError('Failed to create ECO for materialization')
      }

      // Start the ECO workflow (Draft) and create its branch for this design.
      await ChangeOrderService.autoStartWorkflow(ecoId, 'ECO', userId)
      await ChangeOrderService.addDesignToEco(ecoId, designId, userId)

      const ecoDesigns = await ChangeOrderService.getEcoDesigns(ecoId)
      ecoBranchId =
        ecoDesigns.find((d) => d.designId === designId)?.branchId ?? null
      if (!ecoBranchId) {
        throw new ValidationError(
          'Failed to create ECO branch for materialization',
        )
      }
    }

    // Create a requirement or part, either directly on main (create/add modes)
    // or on the ECO branch (eco_required). On the ECO branch the item is an
    // 'added' working copy; it is also registered on the ECO with the 'release'
    // change action so it appears in the Affected Items tab for review.
    const createItem = async (
      type: 'Requirement' | 'Part',
      data: BaseItem,
    ): Promise<BaseItem> => {
      if (ecoBranchId) {
        const { item } = await ItemService.createOnBranch(
          type,
          data,
          ecoBranchId,
          `Materialized ${type} ${data.name ?? ''}`.trim(),
          userId,
        )
        // Register on the ECO so the item shows in its Affected Items tab.
        // Best-effort: this is display metadata only — the item is already an
        // 'added' working copy on the branch and is released at merge whether or
        // not it is registered. Skip (with a warning) for item types whose
        // lifecycle doesn't define a 'release' action, rather than aborting.
        if (ecoId && item.id) {
          try {
            await ChangeOrderService.addAffectedItem(
              ecoId,
              {
                affectedItemId: item.id,
                changeAction: 'release',
                currentState: item.state ?? 'Draft',
                currentRevision: item.revision,
              },
              userId,
            )
          } catch (err) {
            serviceLogger.warn(
              { ecoId, itemId: item.id, itemType: type, err },
              'Could not register materialized item on ECO affected items; item remains on the ECO branch and will release at merge',
            )
          }
        }
        return item
      }
      return ItemService.create(type, data, userId)
    }

    // Step 2: Create requirements in Draft state (on main, or on the ECO branch)
    // Map design engine enums → PLM Requirement schema enums
    const priorityMap: Record<string, string> = {
      critical: 'MustHave',
      high: 'ShouldHave',
      medium: 'CouldHave',
      low: 'WontHave',
    }
    const typeMap: Record<string, string> = {
      Functional: 'Functional',
      Performance: 'Performance',
      Interface: 'Non-Functional',
      Constraint: 'Non-Functional',
      Other: 'Business',
    }

    for (const req of artifacts.requirements) {
      const item = await createItem('Requirement', {
        name: req.name,
        revision: '-',
        itemType: 'Requirement',
        state: plan.initialState,
        description: req.description,
        type: typeMap[req.requirementType] ?? 'Functional',
        priority: priorityMap[req.priority] ?? 'CouldHave',
        verificationMethod: req.verificationMethod,
        designId,
      } as BaseItem)

      const itemId = item.id ?? ''
      const itemNumber = item.itemNumber ?? ''
      tempIdToItemId.set(req.tempId, itemId)
      tempIdToItemNumber.set(req.tempId, itemNumber)

      createdItems.push({
        tempId: req.tempId,
        itemId,
        itemNumber,
        itemType: 'Requirement',
        name: req.name,
      })
    }

    // Step 3: Create parts depth-first (leaves before parents for BOM relationships)
    async function createPartNode(
      node: BomNodeDraft,
      parentNode?: BomNodeDraft,
    ): Promise<string> {
      // Create children first
      const childItemIds: Array<{
        itemId: string
        quantity: number
        findNumber?: number
      }> = []

      for (const child of node.children) {
        const childId = await createPartNode(child, node)
        childItemIds.push({
          itemId: childId,
          quantity: child.quantity,
          findNumber: child.findNumber,
        })
      }

      // Create or use existing item
      let itemId: string

      if (node.isNew) {
        // Snapshot catalog specs into item attributes if catalogComponentId is present
        let attributes: Record<string, unknown> = {}
        let cost: number | undefined

        if (node.catalogComponentId) {
          try {
            const catalogEntry = await CatalogService.getById(
              node.catalogComponentId,
            )
            attributes = {
              catalogSnapshot: {
                catalogComponentId: catalogEntry.id,
                name: catalogEntry.name,
                dimensions: catalogEntry.dimensions,
                mountingFeatures: catalogEntry.mountingFeatures,
                electrical: catalogEntry.electrical,
                specs: catalogEntry.specs,
                suppliers: catalogEntry.suppliers,
                designNotes: catalogEntry.designNotes,
                selectedStockSize: node.selectedStockSize,
                snapshotDate: new Date().toISOString(),
              },
            }
            // Extract cost from first supplier
            const primarySupplier = catalogEntry.suppliers[0]
            if (primarySupplier?.approximatePrice) {
              cost = primarySupplier.approximatePrice
            }
          } catch {
            // Catalog entry may have been deleted — proceed without snapshot
          }
        }

        // Store mechanism metadata if this node is part of a mechanism template
        if (parentNode?.mechanismTemplate) {
          const roleMapping = parentNode.mechanismTemplate.partMapping.find(
            (m) => m.tempId === node.tempId,
          )
          if (roleMapping) {
            attributes.mechanismMetadata = {
              mechanismType: parentNode.mechanismTemplate.mechanismType,
              role: roleMapping.role,
              parameters: parentNode.mechanismTemplate.parameters,
              parentAssemblyTempId: parentNode.tempId,
            }
          }
        }

        const item = await createItem('Part', {
          name: node.name,
          revision: '-',
          itemType: 'Part',
          state: plan.initialState,
          partType: node.partType,
          material: node.material,
          designId,
          ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
          ...(cost !== undefined ? { cost } : {}),
        } as BaseItem)

        itemId = item.id ?? ''
        const itemNumber = item.itemNumber ?? ''
        tempIdToItemId.set(node.tempId, itemId)
        tempIdToItemNumber.set(node.tempId, itemNumber)

        createdItems.push({
          tempId: node.tempId,
          itemId,
          itemNumber,
          itemType: 'Part',
          name: node.name,
        })
      } else {
        // Use existing item
        itemId = node.existingItemId ?? node.tempId
        tempIdToItemId.set(node.tempId, itemId)
      }

      // Create BOM relationships
      for (const child of childItemIds) {
        await ItemService.addRelationship(itemId, child.itemId, 'BOM', userId, {
          quantity: String(child.quantity),
          findNumber: child.findNumber,
        })
        bomRelationshipsCreated++
      }

      return itemId
    }

    await createPartNode(bom.rootAssembly)

    // Step 4: Update session and save materialization result to artifacts
    await DesignSessionService.setMaterializedDesign(session.id, designId)

    const result: MaterializationResult = {
      mode: plan.mode,
      designId,
      designName,
      initialState: plan.initialState,
      ...(ecoId ? { ecoId } : {}),
      ...(ecoNumber ? { ecoNumber } : {}),
      createdItems,
      bomRelationshipsCreated,
    }

    // Save result into artifacts for downstream CAD generation stage
    if (session.artifacts) {
      const updatedArtifacts = {
        ...session.artifacts,
        materializationResult: result,
      }
      await DesignSessionService.updateArtifacts(session.id, updatedArtifacts)
    }

    return result
  }
}
