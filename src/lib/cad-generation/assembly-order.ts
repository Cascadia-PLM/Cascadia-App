/**
 * Assembly Order
 *
 * Computes bottom-up traversal order for multi-level assembly composition.
 * Leaf parts first, then sub-assemblies, then root assembly.
 */

import type { BomNodeDraft } from '@/lib/design-engine/types'

/**
 * Compute assembly processing order via post-order traversal.
 * Returns only assembly nodes (nodes with children), leaves first.
 */
export function computeAssemblyOrder(
  rootNode: BomNodeDraft,
): Array<BomNodeDraft> {
  const order: Array<BomNodeDraft> = []

  function postOrder(node: BomNodeDraft): void {
    // Process children first (bottom-up)
    for (const child of node.children) {
      postOrder(child)
    }

    // Only include assembly nodes (those with children)
    if (node.children.length > 0) {
      order.push(node)
    }
  }

  postOrder(rootNode)
  return order
}

/**
 * Check if an assembly is ready for composition
 * (all child parts/sub-assemblies that need geometry have it).
 */
export function isAssemblyReady(node: BomNodeDraft): boolean {
  for (const child of node.children) {
    // Leaf parts need CAD generation complete
    if (child.children.length === 0) {
      if (
        child.isNew &&
        child.partType === 'Manufacture' &&
        child.cadGeneration?.status !== 'complete'
      ) {
        return false
      }
    } else {
      // Sub-assemblies need assembly composition complete
      if (child.assemblyComposition?.status !== 'complete') {
        return false
      }
    }
  }
  return true
}

/**
 * Get the names of children that are blocking assembly readiness.
 */
export function getUnreadyChildren(node: BomNodeDraft): Array<string> {
  const unready: Array<string> = []
  for (const child of node.children) {
    if (child.children.length === 0) {
      if (
        child.isNew &&
        child.partType === 'Manufacture' &&
        child.cadGeneration?.status !== 'complete'
      ) {
        const status = child.cadGeneration?.status ?? 'no CAD generated'
        unready.push(`${child.name} (${status})`)
      }
    } else {
      if (child.assemblyComposition?.status !== 'complete') {
        const status = child.assemblyComposition?.status ?? 'not composed'
        unready.push(`${child.name} (${status})`)
      }
    }
  }
  return unready
}

/**
 * Check whether an assembly has any children with STEP geometry.
 * Assemblies with zero geometry children (e.g. all Purchase parts)
 * cannot be physically composed.
 */
export function hasComposableGeometry(node: BomNodeDraft): boolean {
  return node.children.some((child) => {
    if (child.children.length === 0) {
      return !!child.cadGeneration?.stepFileKey
    } else {
      return !!child.assemblyComposition?.assemblyStepFileKey
    }
  })
}
