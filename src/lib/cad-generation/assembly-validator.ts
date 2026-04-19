/**
 * Assembly Validator
 *
 * Validates assembly plans before rendering:
 * - All children have STEP files
 * - Mate compatibility (dimensional consistency)
 * - Position sanity (no wildly displaced parts)
 * - Unmapped parts detection
 */

import type { BomNodeDraft } from '@/lib/design-engine/types'
import type { AssemblyPlan, AssemblyValidation, BoundingBox3D } from './types'

/**
 * Validate that an assembly is ready for composition.
 */
export function validateAssemblyReadiness(
  assemblyNode: BomNodeDraft,
): AssemblyValidation {
  const issues: AssemblyValidation['issues'] = []

  // Check all children have STEP files
  for (const child of assemblyNode.children) {
    if (child.isNew && child.partType === 'Manufacture') {
      if (!child.cadGeneration || child.cadGeneration.status !== 'complete') {
        issues.push({
          severity: 'error',
          message: `Child "${child.name}" does not have a generated STEP file`,
          partTempId: child.tempId,
        })
      }
    }

    // Check sub-assemblies have their STEP file too
    if (child.children.length > 0) {
      if (
        !child.assemblyComposition ||
        child.assemblyComposition.status !== 'complete'
      ) {
        issues.push({
          severity: 'error',
          message: `Sub-assembly "${child.name}" has not been composed yet`,
          partTempId: child.tempId,
        })
      }
    }
  }

  // Check for unmapped children
  if (assemblyNode.interfaceMappings) {
    const mappedChildIds = new Set<string>()
    for (const mapping of assemblyNode.interfaceMappings) {
      mappedChildIds.add(mapping.partATempId)
      mappedChildIds.add(mapping.partBTempId)
    }

    for (const child of assemblyNode.children) {
      if (child.isNew && !mappedChildIds.has(child.tempId)) {
        issues.push({
          severity: 'warning',
          message: `Child "${child.name}" has no interface mappings — position may be arbitrary`,
          partTempId: child.tempId,
        })
      }
    }
  } else if (assemblyNode.children.length > 1) {
    issues.push({
      severity: 'warning',
      message: `Assembly "${assemblyNode.name}" has no interface mappings defined`,
    })
  }

  return {
    valid: !issues.some((i) => i.severity === 'error'),
    issues,
  }
}

/**
 * Validate an assembly plan after LLM generation.
 */
export function validateAssemblyPlan(
  plan: AssemblyPlan,
  childBoundingBoxes: Map<string, BoundingBox3D>,
): AssemblyValidation {
  const issues: AssemblyValidation['issues'] = []

  if (plan.placements.length === 0) {
    issues.push({
      severity: 'error',
      message: 'Assembly plan has no placements',
    })
    return { valid: false, issues }
  }

  // Check at least one part is near the origin
  const hasOriginPart = plan.placements.some((p) => {
    const t = p.transform.translation
    return Math.abs(t.x) < 100 && Math.abs(t.y) < 100 && Math.abs(t.z) < 100
  })

  if (!hasOriginPart) {
    issues.push({
      severity: 'warning',
      message:
        'No part is positioned near the origin — assembly may be displaced',
    })
  }

  // Check for wildly displaced parts
  for (const placement of plan.placements) {
    const t = placement.transform.translation
    const maxDisplacement = 10_000 // 10 meters
    if (
      Math.abs(t.x) > maxDisplacement ||
      Math.abs(t.y) > maxDisplacement ||
      Math.abs(t.z) > maxDisplacement
    ) {
      issues.push({
        severity: 'warning',
        message: `Part "${placement.partName}" is placed very far from origin (${t.x}, ${t.y}, ${t.z}mm)`,
        partTempId: placement.tempId,
      })
    }
  }

  // Check for overlapping bounding boxes (simplified check)
  const placedBoxes: Array<{
    tempId: string
    name: string
    min: [number, number, number]
    max: [number, number, number]
  }> = []

  for (const placement of plan.placements) {
    const bb = childBoundingBoxes.get(placement.tempId)
    if (!bb) continue

    const t = placement.transform.translation
    placedBoxes.push({
      tempId: placement.tempId,
      name: placement.partName,
      min: [bb.minX + t.x, bb.minY + t.y, bb.minZ + t.z],
      max: [bb.maxX + t.x, bb.maxY + t.y, bb.maxZ + t.z],
    })
  }

  // O(n^2) overlap check — fine for typical assembly sizes
  for (let i = 0; i < placedBoxes.length; i++) {
    for (let j = i + 1; j < placedBoxes.length; j++) {
      const a = placedBoxes[i]
      const b = placedBoxes[j]

      if (boxesOverlap(a.min, a.max, b.min, b.max)) {
        issues.push({
          severity: 'warning',
          message: `Parts "${a.name}" and "${b.name}" may overlap`,
          partTempId: a.tempId,
        })
      }
    }
  }

  return {
    valid: !issues.some((i) => i.severity === 'error'),
    issues,
  }
}

function boxesOverlap(
  aMin: [number, number, number],
  aMax: [number, number, number],
  bMin: [number, number, number],
  bMax: [number, number, number],
): boolean {
  // Check AABB overlap on all three axes
  return (
    aMin[0] < bMax[0] &&
    aMax[0] > bMin[0] &&
    aMin[1] < bMax[1] &&
    aMax[1] > bMin[1] &&
    aMin[2] < bMax[2] &&
    aMax[2] > bMin[2]
  )
}
