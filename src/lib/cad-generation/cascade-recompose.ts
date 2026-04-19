/**
 * Cascade Recomposition
 *
 * When a part is regenerated, all ancestor assemblies become stale
 * and must be recomposed bottom-up. This module identifies affected
 * assemblies and triggers recomposition.
 */

import type { BomNodeDraft, StageEvent } from '@/lib/design-engine/types'

/**
 * Find all ancestor assembly nodes that contain a given part.
 * Returns them in bottom-up order (immediate parent first, root last).
 */
export function findAffectedAssemblies(
  changedPartTempId: string,
  rootNode: BomNodeDraft,
): Array<string> {
  const affected: Array<string> = []

  function search(node: BomNodeDraft, ancestors: Array<string>): boolean {
    if (node.tempId === changedPartTempId) {
      // Found the changed part — all ancestors are affected
      affected.push(...ancestors.reverse())
      return true
    }

    for (const child of node.children) {
      if (search(child, [...ancestors, node.tempId])) {
        return true
      }
    }

    return false
  }

  search(rootNode, [])
  return affected
}

/**
 * Mark all affected assemblies as stale (needing recomposition).
 */
export function markAssembliesStale(
  rootNode: BomNodeDraft,
  affectedTempIds: Array<string>,
): void {
  function walk(node: BomNodeDraft): void {
    if (affectedTempIds.includes(node.tempId)) {
      if (node.assemblyComposition) {
        node.assemblyComposition = {
          ...node.assemblyComposition,
          status: 'pending',
          assemblyStepFileKey: undefined,
        }
      }
    }

    for (const child of node.children) {
      walk(child)
    }
  }

  walk(rootNode)
}

/**
 * Generate events for stale assembly notification.
 */
export async function* notifyStaleAssemblies(
  rootNode: BomNodeDraft,
  affectedTempIds: Array<string>,
): AsyncGenerator<StageEvent> {
  for (const tempId of affectedTempIds) {
    const node = findNodeByTempId(rootNode, tempId)
    if (node) {
      yield {
        type: 'llm_text',
        text: `Assembly "${node.name}" marked for recomposition due to child part change.`,
      }
    }
  }
}

function findNodeByTempId(
  root: BomNodeDraft,
  tempId: string,
): BomNodeDraft | null {
  if (root.tempId === tempId) return root

  for (const child of root.children) {
    const found = findNodeByTempId(child, tempId)
    if (found) return found
  }

  return null
}
