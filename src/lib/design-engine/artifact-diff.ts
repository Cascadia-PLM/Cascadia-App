/**
 * Pure diff computation between two artifact states, keyed by tempId.
 *
 * Used by the review panels to show what changed since the last confirmed
 * snapshot of the same gate (i.e. after a reopen/re-run). No database
 * imports — this module is imported by client code.
 */

import type { BomDraft, BomNodeDraft, RequirementDraft } from './types'

export type DiffStatus = 'added' | 'removed' | 'modified' | 'unchanged'

export interface FieldChange {
  fieldName: string
  oldValue: unknown
  newValue: unknown
}

export interface ItemDiff {
  status: DiffStatus
  fieldChanges: Array<FieldChange>
  /** BOM only: the node moved to a different parent */
  reparented?: boolean
}

export interface RequirementsDiff {
  byTempId: Map<string, ItemDiff>
  removed: Array<RequirementDraft>
  /** True when at least one item is added/removed/modified */
  hasChanges: boolean
}

export interface BomDiffRemovedNode {
  tempId: string
  name: string
  parentName?: string
}

export interface BomDiff {
  byTempId: Map<string, ItemDiff>
  removed: Array<BomDiffRemovedNode>
  hasChanges: boolean
}

// Review metadata and generation state are excluded from comparison — they
// change constantly without representing a content difference the reviewer
// cares about.
const REQUIREMENT_DIFF_FIELDS: Array<keyof RequirementDraft> = [
  'name',
  'description',
  'requirementType',
  'priority',
  'verificationMethod',
  'rationale',
]

function compareFields<T>(
  base: T,
  current: T,
  fields: Array<keyof T>,
): Array<FieldChange> {
  const changes: Array<FieldChange> = []
  for (const field of fields) {
    const oldValue = base[field]
    const newValue = current[field]
    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
      changes.push({ fieldName: String(field), oldValue, newValue })
    }
  }
  return changes
}

export function diffRequirements(
  base: Array<RequirementDraft>,
  current: Array<RequirementDraft>,
): RequirementsDiff {
  const byTempId = new Map<string, ItemDiff>()
  const baseById = new Map(base.map((r) => [r.tempId, r]))
  const currentIds = new Set(current.map((r) => r.tempId))
  let hasChanges = false

  for (const req of current) {
    const baseReq = baseById.get(req.tempId)
    if (!baseReq) {
      byTempId.set(req.tempId, { status: 'added', fieldChanges: [] })
      hasChanges = true
      continue
    }
    const fieldChanges = compareFields(baseReq, req, REQUIREMENT_DIFF_FIELDS)
    if (fieldChanges.length > 0) {
      byTempId.set(req.tempId, { status: 'modified', fieldChanges })
      hasChanges = true
    } else {
      byTempId.set(req.tempId, { status: 'unchanged', fieldChanges: [] })
    }
  }

  const removed = base.filter((r) => !currentIds.has(r.tempId))
  if (removed.length > 0) hasChanges = true

  return { byTempId, removed, hasChanges }
}

interface FlatNode {
  node: BomNodeDraft
  parentTempId: string | null
  parentName: string | null
}

function flattenBom(root: BomNodeDraft): Map<string, FlatNode> {
  const map = new Map<string, FlatNode>()
  const walk = (node: BomNodeDraft, parent: BomNodeDraft | null) => {
    map.set(node.tempId, {
      node,
      parentTempId: parent?.tempId ?? null,
      parentName: parent?.name ?? null,
    })
    for (const child of node.children) walk(child, node)
  }
  walk(root, null)
  return map
}

/**
 * Curated comparison of a BOM node's content. Children are compared
 * structurally by the tree walk (added/removed/reparented), not as a field.
 */
function compareBomNodes(
  base: BomNodeDraft,
  current: BomNodeDraft,
): Array<FieldChange> {
  const simpleFields: Array<keyof BomNodeDraft> = [
    'name',
    'quantity',
    'partType',
    'material',
    'findNumber',
    'parametricSpec',
    'selectedStockSize',
    'cadGenerationHint',
  ]
  const changes = compareFields(base, current, simpleFields)

  const baseInterfaces = base.interfaces?.length ?? 0
  const currentInterfaces = current.interfaces?.length ?? 0
  if (baseInterfaces !== currentInterfaces) {
    changes.push({
      fieldName: 'interfaces',
      oldValue: baseInterfaces,
      newValue: currentInterfaces,
    })
  }

  const baseMappings = base.interfaceMappings?.length ?? 0
  const currentMappings = current.interfaceMappings?.length ?? 0
  if (baseMappings !== currentMappings) {
    changes.push({
      fieldName: 'interfaceMappings',
      oldValue: baseMappings,
      newValue: currentMappings,
    })
  }

  const baseProcess = base.manufacturingConstraints?.process
  const currentProcess = current.manufacturingConstraints?.process
  if (baseProcess !== currentProcess) {
    changes.push({
      fieldName: 'manufacturingProcess',
      oldValue: baseProcess,
      newValue: currentProcess,
    })
  }

  return changes
}

export function diffBom(
  base: BomDraft | null,
  current: BomDraft | null,
): BomDiff {
  const byTempId = new Map<string, ItemDiff>()
  const removed: Array<BomDiffRemovedNode> = []

  if (!current) {
    if (base) {
      for (const flat of flattenBom(base.rootAssembly).values()) {
        removed.push({
          tempId: flat.node.tempId,
          name: flat.node.name,
          parentName: flat.parentName ?? undefined,
        })
      }
    }
    return { byTempId, removed, hasChanges: removed.length > 0 }
  }

  const currentFlat = flattenBom(current.rootAssembly)
  const baseFlat = base ? flattenBom(base.rootAssembly) : new Map<string, FlatNode>()
  let hasChanges = false

  for (const [tempId, flat] of currentFlat) {
    const baseNode = baseFlat.get(tempId)
    if (!baseNode) {
      byTempId.set(tempId, { status: 'added', fieldChanges: [] })
      hasChanges = true
      continue
    }
    const fieldChanges = compareBomNodes(baseNode.node, flat.node)
    const reparented = baseNode.parentTempId !== flat.parentTempId
    if (fieldChanges.length > 0 || reparented) {
      byTempId.set(tempId, { status: 'modified', fieldChanges, reparented })
      hasChanges = true
    } else {
      byTempId.set(tempId, { status: 'unchanged', fieldChanges: [] })
    }
  }

  for (const [tempId, flat] of baseFlat) {
    if (!currentFlat.has(tempId)) {
      removed.push({
        tempId,
        name: flat.node.name,
        parentName: flat.parentName ?? undefined,
      })
      hasChanges = true
    }
  }

  return { byTempId, removed, hasChanges }
}
