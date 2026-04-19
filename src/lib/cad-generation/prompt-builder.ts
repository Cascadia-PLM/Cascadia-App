/**
 * CAD Prompt Builder
 *
 * Constructs effective prompts for Zoo's Text-to-CAD API by synthesizing
 * part metadata, interface definitions, material, and assembly context.
 *
 * Key principle: lead with the feature tree ("rectangular plate with 4x M4
 * through-holes"), not the noun ("a base plate").
 */

import { getDfmRules } from './dfm-rules'
import type { CadPromptContext } from './types'
import type { ManufacturingConstraints } from '@/lib/design-engine/types'

/**
 * Build a prompt for Zoo Text-to-CAD from part context.
 */
export function buildCadPrompt(context: CadPromptContext): string {
  const sections: Array<string> = []

  // Lead with geometry and features, not just the part name
  sections.push(buildGeometryDescription(context))

  // Material specification
  if (context.material) {
    sections.push(`Material: ${context.material}.`)
  }

  // Interface features (the most important part for CAD generation)
  if (context.interfaces.length > 0) {
    sections.push(buildInterfaceFeatures(context.interfaces))
  }

  // Detailed geometry specification (LLM-authored during BOM drafting)
  if (context.cadGenerationHint) {
    sections.push(
      `DETAILED GEOMETRY SPECIFICATION:\n${context.cadGenerationHint}`,
    )
  }

  // Manufacturing constraints and DFM rules (tool-derived)
  if (context.manufacturingConstraints) {
    sections.push(buildManufacturingSection(context.manufacturingConstraints))
  }

  // Assembly context for better proportioning
  if (context.parentAssemblyName) {
    sections.push(buildAssemblyContext(context))
  }

  // User feedback for regeneration
  if (context.additionalFeedback) {
    sections.push(`Additional requirements: ${context.additionalFeedback}`)
  }

  // Priority note when geometry spec and constraints are both present
  if (context.cadGenerationHint && context.manufacturingConstraints) {
    sections.push(
      'PRIORITY: The Detailed Geometry Specification defines what this part IS. ' +
        'Manufacturing Constraints define how it will be MADE. ' +
        'Interface definitions are connection points to satisfy. ' +
        'If the geometry spec conflicts with interfaces, the geometry spec takes precedence.',
    )
  }

  return sections.join('\n\n')
}

function buildGeometryDescription(context: CadPromptContext): string {
  // Extract key dimensions from interfaces to inform overall shape
  const allDimensions = context.interfaces.flatMap((i) =>
    Object.entries(i.geometry.nominalDimensions).map(
      ([key, val]) => `${key}: ${val}${i.geometry.units}`,
    ),
  )

  let desc = context.partDescription || context.partName

  // If we have dimensional data, incorporate it
  if (allDimensions.length > 0) {
    desc += `. Key dimensions: ${allDimensions.slice(0, 6).join(', ')}`
  }

  return desc
}

function buildInterfaceFeatures(
  interfaces: CadPromptContext['interfaces'],
): string {
  const features = interfaces.map((iface) => {
    let feature = iface.description

    // Add explicit geometry
    const dims = Object.entries(iface.geometry.nominalDimensions)
      .map(([k, v]) => `${k}=${v}${iface.geometry.units}`)
      .join(', ')

    if (dims) {
      feature += ` (${dims})`
    }

    // Add count and pattern
    if (iface.geometry.count && iface.geometry.count > 1) {
      const pattern = iface.geometry.patternType
        ? ` in ${iface.geometry.patternType} pattern`
        : ''
      const spacing = iface.geometry.patternSpacing
        ? ` with ${iface.geometry.patternSpacing}${iface.geometry.units} spacing`
        : ''
      feature += `, ${iface.geometry.count}x${pattern}${spacing}`
    }

    // Add location
    if (iface.locationHint) {
      feature += ` on ${iface.locationHint}`
    }

    return `- ${feature}`
  })

  return `Required features:\n${features.join('\n')}`
}

function buildAssemblyContext(context: CadPromptContext): string {
  let assemblyCtx = `This part is a component of "${context.parentAssemblyName}".`

  if (context.parentAssemblyDescription) {
    assemblyCtx += ` Assembly purpose: ${context.parentAssemblyDescription}.`
  }

  // Add sibling context for proportioning
  if (context.siblingParts && context.siblingParts.length > 0) {
    const siblings = context.siblingParts
      .slice(0, 5)
      .map((s) => {
        let info = s.name
        if (s.boundingBox) {
          const w = (s.boundingBox.maxX - s.boundingBox.minX).toFixed(1)
          const h = (s.boundingBox.maxY - s.boundingBox.minY).toFixed(1)
          const d = (s.boundingBox.maxZ - s.boundingBox.minZ).toFixed(1)
          info += ` (${w}x${h}x${d}mm)`
        }
        return info
      })
      .join(', ')

    assemblyCtx += ` Other parts in this assembly: ${siblings}.`
  }

  return assemblyCtx
}

function buildManufacturingSection(mc: ManufacturingConstraints): string {
  const lines: Array<string> = ['MANUFACTURING CONSTRAINTS:']

  if (mc.fdm) {
    lines.push(`Process: FDM 3D Printing`)
    lines.push(`Build volume: ${mc.fdm.buildVolume.join(' x ')} mm`)
    lines.push(
      `Nozzle: ${mc.fdm.nozzleDiameter}mm, Layer height: ${mc.fdm.layerHeight}mm`,
    )
    lines.push(`Material: ${mc.fdm.material}`)
    lines.push('')
    lines.push('DFM rules for FDM:')
    const rules = getDfmRules('fdm_printer')
    for (const rule of rules) {
      lines.push(`- ${rule}`)
    }

    if (mc.fdm.segmentation?.needed) {
      const s = mc.fdm.segmentation
      lines.push('')
      lines.push('SEGMENTATION REQUIRED:')
      lines.push(
        `Each segment must fit within ${s.maxSegmentSize.join(' x ')} mm`,
      )
      lines.push(`Joint type: ${s.jointType}`)
      if (s.alignmentFeatures)
        lines.push('Include alignment pins/slots at each joint.')
      if (s.overlapLength) lines.push(`Joint engagement: ${s.overlapLength}mm`)
    }
  }

  if (mc.laserCut) {
    lines.push(`Process: Laser Cutting`)
    lines.push(`Bed size: ${mc.laserCut.bedSize.join(' x ')} mm`)
    lines.push(
      `Material: ${mc.laserCut.material}, ${mc.laserCut.thickness}mm thick`,
    )
    lines.push('')
    lines.push('DFM rules for laser cutting:')
    const rules = getDfmRules('laser_cutter')
    for (const rule of rules) {
      lines.push(`- ${rule}`)
    }
  }

  if (mc.cnc) {
    lines.push(`Process: CNC Milling (${mc.cnc.axes}-axis)`)
    lines.push(`Work volume: ${mc.cnc.workVolume.join(' x ')} mm`)
    lines.push(`Material: ${mc.cnc.material}`)
    lines.push('')
    lines.push('DFM rules for CNC:')
    const rules = getDfmRules('cnc_mill')
    for (const rule of rules) {
      lines.push(`- ${rule}`)
    }
  }

  if (mc.manualCut) {
    lines.push(`Process: Manual cut (${mc.manualCut.cutTypes.join(', ')})`)
    if (mc.manualCut.maxCutWidth)
      lines.push(`Max cut width: ${mc.manualCut.maxCutWidth}mm`)
    if (mc.manualCut.maxCutDepth)
      lines.push(`Max cut depth: ${mc.manualCut.maxCutDepth}mm`)
  }

  if (mc.outsourced) {
    lines.push(
      `Process: OUTSOURCED — ${mc.outsourceNotes || 'no in-house tool available'}`,
    )
    lines.push(
      'Design for general manufacturability; specific DFM constraints unknown.',
    )
  }

  // Fallback DFM rules if no specific process block was hit
  if (!mc.fdm && !mc.laserCut && !mc.cnc && !mc.manualCut && !mc.outsourced) {
    const rules = getDfmRules(mc.process)
    if (rules.length > 0) {
      lines.push(`Process: ${mc.process}`)
      lines.push('')
      for (const rule of rules) {
        lines.push(`- ${rule}`)
      }
    }
  }

  return lines.join('\n')
}
