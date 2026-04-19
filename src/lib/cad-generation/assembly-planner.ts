// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

/**
 * Assembly Planner
 *
 * Uses an LLM to plan how child parts should be positioned within an
 * assembly, producing transforms and KCL code. The planner receives
 * child bounding boxes, interface descriptions, and interface mappings.
 */

import { chat } from '@tanstack/ai'
import type { BomNodeDraft } from '@/lib/design-engine/types'
import type { AssemblyPlan, BoundingBox3D, Transform3D } from './types'
import { getAdapter, loadProviderConfig } from '@/lib/ai/adapters'

interface AssemblyChildData {
  tempId: string
  name: string
  stepFileKey: string
  boundingBox?: BoundingBox3D
  interfaces: Array<{
    id: string
    description: string
    mateType: string
    locationHint: string
    geometry: {
      shape: string
      nominalDimensions: Record<string, number>
      units: string
    }
  }>
}

export class AssemblyPlanner {
  /**
   * Plan assembly composition using LLM analysis.
   */
  static async planAssembly(
    assemblyNode: BomNodeDraft,
    childData: Array<AssemblyChildData>,
    designContext?: string,
    programId?: string,
  ): Promise<AssemblyPlan> {
    const providerConfig = await loadProviderConfig(programId)
    const adapter = getAdapter(providerConfig)

    const prompt = buildAssemblyPlanPrompt(
      assemblyNode,
      childData,
      designContext,
    )

    const messages: any = [
      { role: 'system', content: ASSEMBLY_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ]

    const stream = chat({
      adapter,
      messages,
      maxTokens: 8192,
    })

    let fullResponse = ''
    for await (const chunk of stream) {
      if (chunk.type === 'content' && chunk.content) {
        fullResponse = chunk.content
      }
    }

    return parseAssemblyPlan(assemblyNode.tempId, fullResponse)
  }
}

const ASSEMBLY_SYSTEM_PROMPT = `You are a mechanical engineering CAD assembly planner. Given a set of child parts with their bounding boxes, interfaces, and connection mappings, you must produce:

1. A "reasoning" section explaining your assembly strategy
2. A list of "placements" with translation and rotation transforms for each child
3. KCL code that imports each child STEP file and applies the transforms

Rules:
- Place the first/largest part at or near the origin
- Position subsequent parts based on interface mappings
- Ensure mating interfaces are aligned (e.g., coaxial holes share the same axis)
- No parts should overlap (respect bounding boxes)
- Use millimeters for all dimensions

Respond with ONLY a JSON object in this exact format:
{
  "reasoning": "...",
  "placements": [
    {
      "tempId": "...",
      "partName": "...",
      "stepFileKey": "...",
      "transform": {
        "translation": { "x": 0, "y": 0, "z": 0 },
        "rotation": { "x": 0, "y": 0, "z": 0 }
      },
      "quantity": 1
    }
  ],
  "kclCode": "..."
}`

function buildAssemblyPlanPrompt(
  assemblyNode: BomNodeDraft,
  childData: Array<AssemblyChildData>,
  designContext?: string,
): string {
  let prompt = `## Assembly: ${assemblyNode.name}\n`
  if (assemblyNode.rationale) {
    prompt += `Purpose: ${assemblyNode.rationale}\n`
  }
  if (designContext) {
    prompt += `Product context: ${designContext}\n`
  }

  prompt += `\n## Child Parts\n`
  for (const child of childData) {
    prompt += `\n### ${child.name} (tempId: ${child.tempId})\n`
    prompt += `STEP file: ${child.stepFileKey}\n`

    if (child.boundingBox) {
      const bb = child.boundingBox
      const w = (bb.maxX - bb.minX).toFixed(1)
      const h = (bb.maxY - bb.minY).toFixed(1)
      const d = (bb.maxZ - bb.minZ).toFixed(1)
      prompt += `Bounding box: ${w} x ${h} x ${d} mm\n`
    }

    if (child.interfaces.length > 0) {
      prompt += `Interfaces:\n`
      for (const iface of child.interfaces) {
        const dims = Object.entries(iface.geometry.nominalDimensions)
          .map(([k, v]) => `${k}=${v}${iface.geometry.units}`)
          .join(', ')
        prompt += `  - [${iface.id}] ${iface.description} (${iface.mateType}, ${dims}) on ${iface.locationHint}\n`
      }
    }
  }

  // Interface mappings
  if (
    assemblyNode.interfaceMappings &&
    assemblyNode.interfaceMappings.length > 0
  ) {
    prompt += `\n## Interface Mappings (how parts connect)\n`
    for (const mapping of assemblyNode.interfaceMappings) {
      const partA = childData.find((c) => c.tempId === mapping.partATempId)
      const partB = childData.find((c) => c.tempId === mapping.partBTempId)
      prompt += `- ${partA?.name ?? mapping.partATempId}[${mapping.interfaceAId}] ↔ ${partB?.name ?? mapping.partBTempId}[${mapping.interfaceBId}] (${mapping.mateType}): ${mapping.positioningIntent}\n`
    }
  }

  prompt += `\nGenerate the assembly plan with transforms and KCL code.`
  return prompt
}

function parseAssemblyPlan(
  assemblyTempId: string,
  response: string,
): AssemblyPlan {
  // Extract JSON from response (may be wrapped in markdown code fences)
  const jsonMatch = response.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    throw new Error(
      'Failed to parse assembly plan: no JSON found in LLM response',
    )
  }

  try {
    const parsed = JSON.parse(jsonMatch[0])

    return {
      assemblyTempId,
      reasoning: parsed.reasoning ?? '',
      placements: (parsed.placements ?? []).map(
        (p: {
          tempId: string
          partName: string
          stepFileKey: string
          transform: Transform3D
          quantity: number
        }) => ({
          tempId: p.tempId,
          partName: p.partName ?? '',
          stepFileKey: p.stepFileKey ?? '',
          transform: p.transform ?? {
            translation: { x: 0, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0 },
          },
          quantity: p.quantity ?? 1,
        }),
      ),
      kclCode: parsed.kclCode ?? '',
    }
  } catch {
    throw new Error('Failed to parse assembly plan JSON from LLM response')
  }
}
