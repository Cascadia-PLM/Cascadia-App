/**
 * BOM Draft Validator
 *
 * Validates the BOM draft structure for correctness before materialization.
 */

import {
  getMechanismRoles,
  validateMechanismParameters,
} from './mechanism-schemas'
import type { BomNodeDraft, DesignArtifacts, ValidationIssue } from '../types'

export function validateBomDraft(
  artifacts: DesignArtifacts,
): Array<ValidationIssue> {
  const issues: Array<ValidationIssue> = []

  if (!artifacts.bom) {
    issues.push({
      severity: 'error',
      message: 'No BOM structure defined',
    })
    return issues
  }

  const bom = artifacts.bom

  // Check root assembly exists
  if (!bom.rootAssembly.name) {
    issues.push({
      severity: 'error',
      message: 'Root assembly has no name',
      path: 'rootAssembly',
    })
  }

  // Check for circular references
  const visited = new Set<string>()
  function checkCircular(
    node: BomNodeDraft,
    path: string,
    ancestors: Set<string>,
    parentNode?: BomNodeDraft,
  ) {
    if (ancestors.has(node.tempId)) {
      issues.push({
        severity: 'error',
        message: `Circular reference detected at ${path}`,
        path,
      })
      return
    }

    if (visited.has(node.tempId)) return
    visited.add(node.tempId)

    const newAncestors = new Set(ancestors)
    newAncestors.add(node.tempId)

    // Validate node
    if (node.quantity <= 0) {
      issues.push({
        severity: 'error',
        message: `Quantity must be > 0 at ${path}`,
        path,
      })
    }

    // Check unique find numbers within parent
    const findNumbers = new Map<number, string>()
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i]
      if (child.findNumber !== undefined) {
        if (findNumbers.has(child.findNumber)) {
          issues.push({
            severity: 'warning',
            message: `Duplicate find number ${child.findNumber} in ${node.name}`,
            path: `${path}.children[${i}]`,
          })
        } else {
          findNumbers.set(child.findNumber, child.tempId)
        }
      }

      checkCircular(child, `${path}.children[${i}]`, newAncestors, node)
    }

    // Warn on Phantom/assembly nodes with no children (incomplete decomposition)
    if (
      node.partType === 'Phantom' &&
      node.children.length === 0 &&
      path !== 'rootAssembly'
    ) {
      issues.push({
        severity: 'warning',
        message: `Assembly "${node.name}" may be incompletely decomposed (no children)`,
        path,
      })
    }

    // Validate parametric spec parameters are positive numbers
    if (node.parametricSpec) {
      for (const [key, val] of Object.entries(node.parametricSpec.parameters)) {
        if (typeof val !== 'number' || val <= 0) {
          issues.push({
            severity: 'error',
            message: `Parametric spec on "${node.name}": parameter "${key}" must be a positive number`,
            path: `${path}.parametricSpec`,
          })
        }
      }
    }

    // Validate mechanism template on assembly nodes
    if (node.mechanismTemplate) {
      const mt = node.mechanismTemplate

      // Validate parameters
      const paramResult = validateMechanismParameters(
        mt.mechanismType,
        mt.parameters,
      )
      if (!paramResult.valid) {
        issues.push({
          severity: 'error',
          message: `Mechanism template on "${node.name}": ${paramResult.error}`,
          path: `${path}.mechanismTemplate`,
        })
      }

      // Validate roles match mechanism type
      const expectedRoles = getMechanismRoles(mt.mechanismType)
      if (expectedRoles) {
        const providedRoles = mt.partMapping.map((m) => m.role).sort()
        const expected = [...expectedRoles].sort()
        if (
          providedRoles.length !== expected.length ||
          !providedRoles.every((r, i) => r === expected[i])
        ) {
          issues.push({
            severity: 'error',
            message: `Mechanism "${mt.mechanismType}" on "${node.name}" requires roles [${expected.join(', ')}], got [${providedRoles.join(', ')}]`,
            path: `${path}.mechanismTemplate`,
          })
        }
      }

      // Validate partMapping references direct children
      const childTempIds = new Set(node.children.map((c) => c.tempId))
      for (const mapping of mt.partMapping) {
        if (!childTempIds.has(mapping.tempId)) {
          issues.push({
            severity: 'error',
            message: `Mechanism mapping role "${mapping.role}" references tempId ${mapping.tempId} which is not a direct child of "${node.name}"`,
            path: `${path}.mechanismTemplate`,
          })
        }
      }

      // Warn if mapped children also have parametricSpec (geometry conflict)
      for (const mapping of mt.partMapping) {
        const child = node.children.find((c) => c.tempId === mapping.tempId)
        if (child?.parametricSpec) {
          issues.push({
            severity: 'warning',
            message: `Part "${child.name}" (role: ${mapping.role}) has parametricSpec set but is covered by mechanism template — parametricSpec will be ignored`,
            path: `${path}.mechanismTemplate`,
          })
        }
      }
    }

    // Warn on Manufacture parts with no interfaces and no parametric spec defined
    // (skip for parts covered by a mechanism template — their geometry comes from the mechanism)
    const isMechanismCovered =
      parentNode?.mechanismTemplate?.partMapping.some(
        (m) => m.tempId === node.tempId,
      ) ?? false
    if (
      node.isNew &&
      node.partType === 'Manufacture' &&
      (!node.interfaces || node.interfaces.length === 0) &&
      !node.parametricSpec &&
      !isMechanismCovered
    ) {
      issues.push({
        severity: 'warning',
        message: `Manufacture part "${node.name}" has no interfaces or parametric spec defined (needed for CAD generation)`,
        path,
      })
    }

    // Warn on Purchase parts requiring manual sourcing
    if (
      node.isNew &&
      node.partType === 'Purchase' &&
      node.requiresManualSourcing
    ) {
      issues.push({
        severity: 'warning',
        message: `Purchase part "${node.name}" requires manual sourcing — no catalog match found`,
        path,
      })
    }

    // Validate proposed parts have required fields
    if (node.isNew && !node.name) {
      issues.push({
        severity: 'error',
        message: `New part at ${path} has no name`,
        path,
      })
    }

    // Validate interface dimensions are positive numbers
    if (node.interfaces) {
      for (const iface of node.interfaces) {
        for (const [key, val] of Object.entries(
          iface.geometry.nominalDimensions,
        )) {
          if (typeof val !== 'number' || val <= 0) {
            issues.push({
              severity: 'error',
              message: `Interface "${iface.id}" on ${node.name}: dimension "${key}" must be a positive number`,
              path: `${path}.interfaces`,
            })
          }
        }
      }
    }

    // Validate interface mappings reference valid children and interface IDs
    if (node.interfaceMappings && node.interfaceMappings.length > 0) {
      const childTempIds = new Set(node.children.map((c) => c.tempId))
      const childInterfaceIds = new Map<string, Set<string>>()
      for (const child of node.children) {
        if (child.interfaces) {
          childInterfaceIds.set(
            child.tempId,
            new Set(child.interfaces.map((i) => i.id)),
          )
        }
      }

      for (const mapping of node.interfaceMappings) {
        if (!childTempIds.has(mapping.partATempId)) {
          issues.push({
            severity: 'error',
            message: `Interface mapping "${mapping.id}" in ${node.name}: partA "${mapping.partATempId}" is not a child`,
            path: `${path}.interfaceMappings`,
          })
        }
        if (!childTempIds.has(mapping.partBTempId)) {
          issues.push({
            severity: 'error',
            message: `Interface mapping "${mapping.id}" in ${node.name}: partB "${mapping.partBTempId}" is not a child`,
            path: `${path}.interfaceMappings`,
          })
        }
        const ifacesA = childInterfaceIds.get(mapping.partATempId)
        if (ifacesA && !ifacesA.has(mapping.interfaceAId)) {
          issues.push({
            severity: 'warning',
            message: `Interface mapping "${mapping.id}" in ${node.name}: interfaceA "${mapping.interfaceAId}" not found on partA`,
            path: `${path}.interfaceMappings`,
          })
        }
        const ifacesB = childInterfaceIds.get(mapping.partBTempId)
        if (ifacesB && !ifacesB.has(mapping.interfaceBId)) {
          issues.push({
            severity: 'warning',
            message: `Interface mapping "${mapping.id}" in ${node.name}: interfaceB "${mapping.interfaceBId}" not found on partB`,
            path: `${path}.interfaceMappings`,
          })
        }
      }
    }

    // Warn if assembly children have zero interface mappings
    if (node.children.length > 0) {
      const mappedChildIds = new Set<string>()
      if (node.interfaceMappings) {
        for (const m of node.interfaceMappings) {
          mappedChildIds.add(m.partATempId)
          mappedChildIds.add(m.partBTempId)
        }
      }
      for (const child of node.children) {
        if (
          child.isNew &&
          child.partType === 'Manufacture' &&
          !mappedChildIds.has(child.tempId)
        ) {
          issues.push({
            severity: 'warning',
            message: `Child "${child.name}" in assembly "${node.name}" has no interface mappings`,
            path: `${path}.interfaceMappings`,
          })
        }
      }
    }
  }

  checkCircular(bom.rootAssembly, 'rootAssembly', new Set())

  // Check requirements coverage
  const requirementTempIds = new Set(
    artifacts.requirements.map((r) => r.tempId),
  )
  const coveredReqIds = new Set(Object.keys(bom.requirementsCoverage))
  const uncoveredIds: Array<string> = []

  for (const reqId of requirementTempIds) {
    if (!coveredReqIds.has(reqId)) {
      uncoveredIds.push(reqId)
    }
  }

  if (uncoveredIds.length > 0) {
    const uncoveredNames = uncoveredIds
      .map((id) => artifacts.requirements.find((r) => r.tempId === id)?.name)
      .filter(Boolean)

    issues.push({
      severity: 'warning',
      message: `${uncoveredIds.length} requirement(s) not covered by any BOM item: ${uncoveredNames.join(', ')}`,
    })

    // Update the uncovered list
    bom.uncoveredRequirements = uncoveredIds
  }

  // ================================================================
  // Manufacturing validation (Layer 2)
  // ================================================================
  const toolset = artifacts.toolset
  if (toolset && toolset.tools.length > 0) {
    const toolIds = new Set(toolset.tools.map((t) => t.id))

    function checkManufacturing(node: BomNodeDraft, path: string) {
      if (node.partType === 'Manufacture' && node.isNew) {
        // Check tool assignment
        if (toolset!.scope === 'in_house_only' && !node.assignedToolId) {
          issues.push({
            severity: 'error',
            message: `Manufacture part "${node.name}" has no assigned tool (scope is in_house_only)`,
            path,
          })
        }

        if (node.assignedToolId && !node.manufacturingConstraints) {
          issues.push({
            severity: 'error',
            message: `Manufacture part "${node.name}" has assigned tool but no manufacturing constraints`,
            path,
          })
        }

        if (node.assignedToolId && !toolIds.has(node.assignedToolId)) {
          issues.push({
            severity: 'warning',
            message: `Manufacture part "${node.name}" references tool not in session toolset`,
            path,
          })
        }

        // Check outsourced
        if (node.manufacturingConstraints?.outsourced) {
          issues.push({
            severity: 'warning',
            message: `Manufacture part "${node.name}" is marked as outsourced`,
            path,
          })
        }

        // Check cadGenerationHint
        if (!node.cadGenerationHint) {
          issues.push({
            severity: 'warning',
            message: `Manufacture part "${node.name}" has no cadGenerationHint`,
            path,
          })
        } else if (node.cadGenerationHint.length < 50) {
          issues.push({
            severity: 'warning',
            message: `Manufacture part "${node.name}" has a very short cadGenerationHint (< 50 chars)`,
            path,
          })
        } else if (!/\d/.test(node.cadGenerationHint)) {
          issues.push({
            severity: 'info',
            message: `Manufacture part "${node.name}" cadGenerationHint contains no numeric values (may not be specific enough)`,
            path,
          })
        }

        // Check FDM segmentation
        if (
          node.manufacturingConstraints?.fdm?.buildVolume &&
          !node.manufacturingConstraints.fdm.segmentation?.needed
        ) {
          // We can't perfectly check if part exceeds build volume without geometry,
          // but we can flag if the hint mentions "segment" or "split"
          const hint = (node.cadGenerationHint ?? '').toLowerCase()
          if (
            hint.includes('segment') ||
            hint.includes('split') ||
            hint.includes('exceed')
          ) {
            issues.push({
              severity: 'warning',
              message: `Manufacture part "${node.name}" hint suggests segmentation but segmentation.needed is not set`,
              path,
            })
          }
        }
      }

      node.children.forEach((child, i) => {
        checkManufacturing(child, `${path}.children[${i}]`)
      })
    }

    checkManufacturing(bom.rootAssembly, 'rootAssembly')
  }

  return issues
}
