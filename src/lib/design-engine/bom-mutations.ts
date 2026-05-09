/**
 * Pure helpers for editing the BOM draft tree during the review stage.
 *
 * All functions return a NEW BomDraft — the input is never mutated. After any
 * structural change, call `recomputeBomDerivedFields` to keep the
 * `requirementsCoverage` and `uncoveredRequirements` maps consistent.
 */

import type { BomDraft, BomNodeDraft } from './types'

function mapNode(
  node: BomNodeDraft,
  fn: (n: BomNodeDraft) => BomNodeDraft,
): BomNodeDraft {
  const mappedChildren = node.children.map((c) => mapNode(c, fn))
  const next = { ...node, children: mappedChildren }
  return fn(next)
}

export function updateBomNode(
  bom: BomDraft,
  tempId: string,
  patch: Partial<BomNodeDraft>,
): BomDraft {
  const root = mapNode(bom.rootAssembly, (n) =>
    n.tempId === tempId ? { ...n, ...patch, children: n.children } : n,
  )
  return { ...bom, rootAssembly: root }
}

/**
 * Remove a node from the tree. Children are re-parented to the deleted node's
 * parent (per the agreed UX). The root assembly cannot be removed and a
 * console warning is emitted in that case; the original BOM is returned.
 */
export function removeBomNode(bom: BomDraft, tempId: string): BomDraft {
  if (bom.rootAssembly.tempId === tempId) {
    console.warn('removeBomNode: refusing to remove the root assembly')
    return bom
  }

  function visit(node: BomNodeDraft): BomNodeDraft {
    const nextChildren: Array<BomNodeDraft> = []
    for (const child of node.children) {
      if (child.tempId === tempId) {
        // Re-parent the deleted node's children to this node.
        for (const grand of child.children) {
          nextChildren.push(visit(grand))
        }
      } else {
        nextChildren.push(visit(child))
      }
    }
    return { ...node, children: nextChildren }
  }

  return { ...bom, rootAssembly: visit(bom.rootAssembly) }
}

export function addBomNodeChild(
  bom: BomDraft,
  parentTempId: string,
  data: Partial<BomNodeDraft>,
): BomDraft {
  const newNode: BomNodeDraft = {
    tempId: data.tempId ?? crypto.randomUUID(),
    name: data.name ?? 'New Item',
    isNew: data.isNew ?? true,
    quantity: data.quantity ?? 1,
    children: data.children ?? [],
    requirementTempIds: data.requirementTempIds ?? [],
    rationale: data.rationale ?? '',
    confidence: data.confidence ?? 1,
    partType: data.partType ?? 'Manufacture',
    material: data.material,
    existingItemId: data.existingItemId,
    existingItemNumber: data.existingItemNumber,
    findNumber: data.findNumber,
    parametricSpec: data.parametricSpec,
    interfaces: data.interfaces,
    interfaceMappings: data.interfaceMappings,
    cadGeneration: data.cadGeneration,
    assemblyComposition: data.assemblyComposition,
    catalogComponentId: data.catalogComponentId,
    requiresManualSourcing: data.requiresManualSourcing,
    selectedStockSize: data.selectedStockSize,
    assignedToolId: data.assignedToolId,
    manufacturingConstraints: data.manufacturingConstraints,
    cadGenerationHint: data.cadGenerationHint,
    mechanismTemplate: data.mechanismTemplate,
  }

  const root = mapNode(bom.rootAssembly, (n) =>
    n.tempId === parentTempId
      ? { ...n, children: [...n.children, newNode] }
      : n,
  )
  return { ...bom, rootAssembly: root }
}

/**
 * Walks every node in the tree and rebuilds `requirementsCoverage` and
 * `uncoveredRequirements` from each node's `requirementTempIds`. Pass the full
 * list of requirement IDs currently in `artifacts.requirements`.
 */
export function recomputeBomDerivedFields(
  bom: BomDraft,
  requirementIds: ReadonlyArray<string>,
): BomDraft {
  const coverage: Record<string, Array<string>> = {}

  function walk(node: BomNodeDraft) {
    for (const reqId of node.requirementTempIds) {
      if (!coverage[reqId]) coverage[reqId] = []
      coverage[reqId].push(node.tempId)
    }
    for (const child of node.children) walk(child)
  }
  walk(bom.rootAssembly)

  const uncoveredRequirements = requirementIds.filter((id) => !coverage[id])

  return {
    ...bom,
    requirementsCoverage: coverage,
    uncoveredRequirements,
  }
}
