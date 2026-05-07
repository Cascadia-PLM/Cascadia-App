// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

/**
 * Materialization Service
 *
 * Converts the BOM draft into real PLM data: creates parts, requirements,
 * BOM relationships, and optionally an ECO for branch-protected designs.
 */

import { DesignSessionService } from './session-service'
import type { BaseItem } from '@/lib/items/types/base'
import type { DesignSession } from './session-service'
import type {
  BomNodeDraft,
  MaterializationPreview,
  MaterializationResult,
} from './types'
import { ItemService } from '@/lib/items/services/ItemService'
import { DesignService } from '@/lib/services/DesignService'
import { BranchService } from '@/lib/services/BranchService'
import { ChangeOrderService } from '@/lib/items/services/ChangeOrderService'
import { CatalogService } from '@/lib/services/CatalogService'

export class MaterializationService {
  /**
   * Generate a preview of what materialization will create.
   */
  static async preview(
    session: DesignSession,
  ): Promise<MaterializationPreview> {
    const artifacts = session.artifacts
    if (!artifacts?.bom) {
      return {
        newPartsCount: 0,
        reusedPartsCount: 0,
        newRequirementsCount: 0,
        bomRelationshipsCount: 0,
        requiresEco: false,
        targetDesignId: session.designId,
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

    // Check if ECO is required
    let requiresEco = false
    if (session.designId) {
      requiresEco = await BranchService.isMainBranchProtected(session.designId)
    }

    return {
      newPartsCount: newParts,
      reusedPartsCount: reusedParts,
      newRequirementsCount,
      bomRelationshipsCount: bomRelationships,
      requiresEco,
      targetDesignId: session.designId,
      items,
    }
  }

  /**
   * Execute materialization: create all items, relationships, and ECO.
   */
  static async execute(
    session: DesignSession,
    userId: string,
  ): Promise<MaterializationResult> {
    const artifacts = session.artifacts
    if (!artifacts?.bom) {
      throw new Error('No BOM to materialize')
    }

    const bom = artifacts.bom
    const tempIdToItemId = new Map<string, string>()
    const tempIdToItemNumber = new Map<string, string>()
    const createdItems: MaterializationResult['createdItems'] = []
    let bomRelationshipsCreated = 0

    // Step 1: Resolve or create design
    let designId = session.designId
    if (!designId) {
      // Generate a unique uppercase alphanumeric code
      const codeTimestamp = Date.now().toString(36).toUpperCase()
      const design = await DesignService.create(
        {
          name: session.title ?? 'Collaborative Design',
          code: `CD-${codeTimestamp}`,
          programId: session.programId,
          designType: 'Engineering',
        },
        userId,
      )
      designId = design.id
    }

    // Step 2: Check branch protection and create ECO if needed
    let ecoId: string | undefined
    let ecoNumber: string | undefined
    const requiresEco = await BranchService.isMainBranchProtected(designId)

    if (requiresEco) {
      const eco = await ItemService.create(
        'ChangeOrder',
        {
          name: `ECO for ${session.title ?? 'Design Session'}`,
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

      if (ecoId) {
        await ChangeOrderService.autoStartWorkflow(ecoId, 'ECO', userId)
        await ChangeOrderService.addDesignToEco(ecoId, designId, userId)
      }
    }

    // Step 3: Create requirements
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
      const item = await ItemService.create(
        'Requirement',
        {
          name: req.name,
          revision: '-',
          itemType: 'Requirement',
          description: req.description,
          type: typeMap[req.requirementType] ?? 'Functional',
          priority: priorityMap[req.priority] ?? 'CouldHave',
          verificationMethod: req.verificationMethod,
          designId,
        } as BaseItem,
        userId,
        { bypassBranchProtection: requiresEco },
      )

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

    // Step 4: Create parts depth-first (leaves before parents for BOM relationships)
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

        const item = await ItemService.create(
          'Part',
          {
            name: node.name,
            revision: '-',
            itemType: 'Part',
            partType: node.partType,
            material: node.material,
            designId,
            ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
            ...(cost !== undefined ? { cost } : {}),
          } as BaseItem,
          userId,
          { bypassBranchProtection: requiresEco },
        )

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

    // Step 5: Update session and save materialization result to artifacts
    await DesignSessionService.setMaterializedDesign(session.id, designId)

    const result: MaterializationResult = {
      designId,
      ecoId,
      ecoNumber,
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
