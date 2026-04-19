/**
 * Interface Propagation
 *
 * When a sub-assembly is composed, determines which child interfaces
 * are NOT consumed by internal mappings. These "exposed" interfaces
 * are propagated up to the parent assembly level.
 */

import type { BomNodeDraft, InterfaceIntent } from '@/lib/design-engine/types'
import type { BoundingBox3D } from './types'

export interface ExposedInterface {
  originalPartTempId: string
  originalInterfaceId: string
  interface: InterfaceIntent
  /** Transform offset from sub-assembly origin (for parent positioning) */
  offsetFromOrigin?: { x: number; y: number; z: number }
}

/**
 * Compute which interfaces from child parts are exposed (not consumed
 * by internal interface mappings) and can be used by the parent assembly.
 */
export function computeExposedInterfaces(
  assemblyNode: BomNodeDraft,
): Array<ExposedInterface> {
  const consumed = new Set<string>() // "partTempId:interfaceId"

  // Mark all interfaces used in internal mappings as consumed
  if (assemblyNode.interfaceMappings) {
    for (const mapping of assemblyNode.interfaceMappings) {
      consumed.add(`${mapping.partATempId}:${mapping.interfaceAId}`)
      consumed.add(`${mapping.partBTempId}:${mapping.interfaceBId}`)
    }
  }

  // Collect non-consumed interfaces from children
  const exposed: Array<ExposedInterface> = []

  for (const child of assemblyNode.children) {
    if (!child.interfaces) continue

    for (const iface of child.interfaces) {
      const key = `${child.tempId}:${iface.id}`
      if (!consumed.has(key)) {
        exposed.push({
          originalPartTempId: child.tempId,
          originalInterfaceId: iface.id,
          interface: iface,
        })
      }
    }
  }

  return exposed
}

/**
 * Get the effective bounding box of a composed sub-assembly.
 * Falls back to aggregating child bounding boxes if the assembly
 * doesn't have its own.
 */
export function getAssemblyBoundingBox(
  node: BomNodeDraft,
): BoundingBox3D | undefined {
  // If the assembly has been composed and has its own bounding box
  if (node.cadGeneration?.boundingBox) {
    return node.cadGeneration.boundingBox
  }

  // Aggregate from children
  let hasAny = false
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity

  for (const child of node.children) {
    const bb = child.cadGeneration?.boundingBox
    if (!bb) continue

    hasAny = true
    minX = Math.min(minX, bb.minX)
    minY = Math.min(minY, bb.minY)
    minZ = Math.min(minZ, bb.minZ)
    maxX = Math.max(maxX, bb.maxX)
    maxY = Math.max(maxY, bb.maxY)
    maxZ = Math.max(maxZ, bb.maxZ)
  }

  if (!hasAny) return undefined

  return { minX, minY, minZ, maxX, maxY, maxZ }
}
