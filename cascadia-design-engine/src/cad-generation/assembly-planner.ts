// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Assembly Planner
 *
 * Uses an LLM to plan how child parts should be positioned within an
 * assembly, producing one placement transform per child. The planner receives
 * child bounding boxes, interface descriptions, and interface mappings. The
 * placements are the whole output: the render worker positions the real STEP
 * geometry from them, and `assembly-script.ts` serializes them to a FreeCAD
 * script for the record, so the model is never asked to write code.
 */

import { EventType, chat, toolDefinition } from '@tanstack/ai'
import { z } from 'zod'
import type { BomNodeDraft } from '@/design-engine/types'
import type { AssemblyPlan, BoundingBox3D, Transform3D } from './types'
import type { UsageAccumulator } from '@/ai/usage'
import { getAdapter, loadProviderConfig } from '@/ai/adapters'
import { maxOutputTokens } from '@/ai/chat-options'

export interface AssemblyClarificationRequest {
  questionId: string
  question: string
  options?: Array<string>
  multiSelect?: boolean
}

export interface PlanAssemblyOptions {
  /** Per-assembly user feedback to address in the plan */
  userNotes?: Array<string>
  /** Previously answered clarifications (fed back into the prompt on resume) */
  priorClarifications?: Array<{ question: string; answer: string }>
  /**
   * When provided, the planner may ask the user a clarification instead of
   * planning; planAssembly then returns null and the caller pauses the stage.
   */
  onClarification?: (request: AssemblyClarificationRequest) => void
  /**
   * Where this call's tokens are counted. The planner never writes a row: a
   * stage plans one assembly per node and those are one *run*, the way the
   * BOM stage's several passes are, so the caller owns one accumulator across
   * every call and writes the single row itself. Omitted, the call is
   * unmetered — which is what every call was before AI2-6.
   */
  usage?: UsageAccumulator
  /**
   * Told which provider/model actually served the call, because
   * `UsageAccumulator` carries token counts and nothing else, and the config
   * is resolved in here rather than by the caller. Fires once, before the
   * request goes out — so a caller that never sees it knows no tokens were
   * spent and has no row to write.
   */
  onProviderResolved?: (resolved: {
    provider: string | null
    model: string | null
  }) => void
  /**
   * Caller's abort signal. Chained into the chat request, so a cancelled
   * stage stops paying for a stream nobody is reading.
   */
  signal?: AbortSignal
}

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
   *
   * Returns null when the planner asked the user a clarification instead of
   * producing a plan (only possible when options.onClarification is given).
   */
  static async planAssembly(
    assemblyNode: BomNodeDraft,
    childData: Array<AssemblyChildData>,
    designContext?: string,
    programId?: string,
    options?: PlanAssemblyOptions,
  ): Promise<AssemblyPlan | null> {
    const providerConfig = await loadProviderConfig(programId)
    options?.onProviderResolved?.({
      provider: providerConfig.provider,
      model: providerConfig.model,
    })
    const adapter = getAdapter(providerConfig)

    const prompt = buildAssemblyPlanPrompt(
      assemblyNode,
      childData,
      designContext,
      options?.userNotes,
      options?.priorClarifications,
    )

    const messages = [{ role: 'user' as const, content: prompt }]

    // Clarification escape hatch: the planner may ask the user one question
    // instead of guessing (e.g. ambiguous orientation with no mappings).
    const clarificationRef: { request: AssemblyClarificationRequest | null } = {
      request: null,
    }
    const tools = options?.onClarification
      ? [
          toolDefinition({
            name: 'ask_assembly_clarification',
            description:
              'Ask the user a clarification question about how this assembly should be composed, when the interfaces/mappings are too ambiguous to plan confidently. Use sparingly — only when a wrong guess would produce an unusable assembly. ALWAYS provide `options` when the answer is a known choice from a finite set.',
            inputSchema: z.object({
              question: z
                .string()
                .describe(
                  'The question to ask the user. Keep it concise — options are rendered separately.',
                ),
              options: z
                .array(z.string())
                .optional()
                .describe('Suggested answers, presented as buttons.'),
              multiSelect: z
                .boolean()
                .optional()
                .describe('True when more than one option can apply.'),
            }),
            outputSchema: z.object({ acknowledged: z.boolean() }),
          }).server((input) => {
            if (!clarificationRef.request) {
              clarificationRef.request = {
                questionId: crypto.randomUUID(),
                question: input.question,
                options: input.options,
                multiSelect: input.multiSelect,
              }
            }
            return { acknowledged: true }
          }),
        ]
      : undefined

    // Own controller, aborted by the caller's signal: `chat` takes a
    // controller rather than a signal, and the planner has no other reason to
    // abort, so this is a straight forward of the caller's decision.
    const abortController = new AbortController()
    if (options?.signal) {
      if (options.signal.aborted) abortController.abort()
      else {
        options.signal.addEventListener('abort', () => abortController.abort())
      }
    }

    const stream = chat({
      adapter,
      systemPrompts: [ASSEMBLY_SYSTEM_PROMPT],
      messages,
      ...(tools ? { tools } : {}),
      // One plan per assembly node, never a conversation to resume.
      threadId: `assembly-plan-${assemblyNode.tempId}-${crypto.randomUUID()}`,
      modelOptions: maxOutputTokens(adapter, 8192),
      abortController,
    })

    // The plan is the newest message that said anything: a turn that asks a
    // clarifying question first opens a second message for its answer.
    let fullResponse = ''
    let currentMessageId: string | undefined
    for await (const chunk of stream) {
      // Before the breaks below: a clarification round and an abort both still
      // spent whatever the model had already billed for.
      options?.usage?.observe(chunk)
      if (clarificationRef.request) break
      if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) {
        if (chunk.messageId !== currentMessageId) {
          currentMessageId = chunk.messageId
          fullResponse = ''
        }
        fullResponse += chunk.delta
      }
    }

    if (clarificationRef.request) {
      options?.onClarification?.(clarificationRef.request)
      return null
    }

    return parseAssemblyPlan(assemblyNode.tempId, fullResponse)
  }
}

const ASSEMBLY_SYSTEM_PROMPT = `You are a mechanical engineering CAD assembly planner. Given a set of child parts with their bounding boxes, interfaces, and connection mappings, you must produce:

1. A "reasoning" section explaining your assembly strategy
2. A list of "placements" with translation and rotation transforms for each child

Rules:
- Place the first/largest part at or near the origin
- Position subsequent parts based on interface mappings
- Ensure mating interfaces are aligned (e.g., coaxial holes share the same axis)
- No parts should overlap (respect bounding boxes)
- Use millimeters for all dimensions
- Each child's STEP geometry is in its own canonical pose (base on Z=0, footprint centred on the origin). Rotation is Euler XYZ in degrees, applied rotateX then rotateY then rotateZ about the global origin, followed by the translation
- If the composition is too ambiguous to plan confidently (e.g. no interface mappings and no obvious arrangement) and the ask_assembly_clarification tool is available, call it ONCE instead of responding with JSON

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
  ]
}`

function buildAssemblyPlanPrompt(
  assemblyNode: BomNodeDraft,
  childData: Array<AssemblyChildData>,
  designContext?: string,
  userNotes?: Array<string>,
  priorClarifications?: Array<{ question: string; answer: string }>,
): string {
  let prompt = `## Assembly: ${assemblyNode.name}\n`
  if (assemblyNode.rationale) {
    prompt += `Purpose: ${assemblyNode.rationale}\n`
  }
  if (designContext) {
    prompt += `Product context: ${designContext}\n`
  }
  if (userNotes && userNotes.length > 0) {
    prompt += `\n## User Feedback on This Assembly\nAddress each of these notes in your assembly plan:\n`
    for (const note of userNotes) {
      prompt += `- ${note}\n`
    }
  }
  if (priorClarifications && priorClarifications.length > 0) {
    prompt += `\n## Prior Clarifications\nYou already asked and the user answered — do NOT re-ask these:\n`
    for (const c of priorClarifications) {
      prompt += `- Q: ${c.question}\n  A: ${c.answer}\n`
    }
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

  prompt += `\nGenerate the assembly plan with one transform per child.`
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
          partName: p.partName,
          stepFileKey: p.stepFileKey,
          transform: p.transform,
          quantity: p.quantity,
        }),
      ),
    }
  } catch {
    throw new Error('Failed to parse assembly plan JSON from LLM response')
  }
}
