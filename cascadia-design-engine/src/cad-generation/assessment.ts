// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * CAD Generation Assessment
 *
 * Uses an LLM to assess whether a part can be generated using the fast
 * parametric service (CadQuery templates) or needs the FreeCAD script agent.
 */

import { EventType, chat } from '@tanstack/ai'
import { getAdapter, loadProviderConfig } from '@/ai/adapters'
import { maxOutputTokens } from '@/ai/chat-options'
import { UsageAccumulator, recordLlmUsage } from '@/ai/usage'

export interface CadAssessmentResult {
  canParametric: boolean
  template?: string
  parameters?: Record<string, number>
  units?: 'mm' | 'in'
  reasoning: string
}

/** Who is spending, and under whose provider config and budget. */
export interface CadAssessmentContext {
  /** The caller, for the usage row. */
  userId: string
  /**
   * The program the part belongs to. This call used to pass nothing, so it
   * resolved the *global* provider settings and was gated against the global
   * budget — for a request that is program-scoped in every other respect.
   * Omitted (a part outside any program), the global row is still the honest
   * answer.
   */
  programId?: string
  /** Caller's abort signal, chained into the chat request. */
  signal?: AbortSignal
}

const ASSESSMENT_SYSTEM_PROMPT = `You are a manufacturing engineer assessing whether a part can be generated using a parametric CAD template or requires a FreeCAD script written by an AI agent.

You have access to the following parametric templates. Each template generates a precise STEP file given numeric parameters:

Templates (use EXACTLY these parameter names):
- bushing: od, id, length
- spacer: od, id, length
- tube: od, wall_thickness, length
- plate: width, height, thickness, corner_radius (optional)
- plate_with_holes: width, height, thickness, hole_diameter, corner_radius (optional), hole_count_x (optional), hole_count_y (optional), hole_margin_x (optional), hole_margin_y (optional)
- block: width, depth, height, corner_radius (optional)
- bracket_l: leg1_length, leg2_length, width, thickness, fillet_radius (optional), hole_diameter (optional), holes_leg1 (optional), holes_leg2 (optional)
- bracket_u: base_length, leg_height, width, thickness, fillet_radius (optional)
- extrusion_rectangular: width, height, length, wall_thickness (optional, solid if omitted)
- extrusion_circular: diameter, length, wall_thickness (optional, solid if omitted)

Rules:
1. If the part clearly maps to one of these templates, set canParametric=true and provide the template name and parameters with reasonable dimensions.
2. You MUST use the EXACT parameter names listed above. Do NOT rename them (e.g., use "od" not "outer_diameter", "id" not "inner_diameter", "length" not "height" for bushings/spacers/tubes).
3. Map the user's description to the correct parameter names. For example, a bushing described as "1 inch ID, 2 inch OD, 1.5 inch thick" maps to: od=2, id=1, length=1.5 (thickness/height of a bushing = "length" parameter).
4. If you are unsure about dimensions, estimate reasonable values based on the part name/description and common engineering practice.
5. If the part has complex geometry (organic shapes, compound curves, intricate features) that none of the templates can represent, set canParametric=false.
6. Default units to "mm" unless the description suggests imperial (inches, ", in).
7. Provide brief reasoning for your decision.

Respond with ONLY valid JSON (no markdown fences) in this exact format:
{
  "canParametric": boolean,
  "template": "template_name or omit if canParametric is false",
  "parameters": { "param": number } or omit if canParametric is false,
  "units": "mm" or "in",
  "reasoning": "brief explanation"
}`

/**
 * Assess whether a part can be generated parametrically or needs the FreeCAD agent.
 *
 * One request, one usage row — written in a `finally`, because a stream that
 * threw halfway still spent what the provider had already billed for, and
 * these rows are what `enforceMonthlyTokenBudget` sums.
 */
export async function assessPartForCadGeneration(
  partName: string,
  description: string | undefined,
  partType: string | undefined,
  attributes: Record<string, unknown>,
  context: CadAssessmentContext,
): Promise<CadAssessmentResult> {
  const usage = new UsageAccumulator()
  const startedAt = Date.now()
  let usageProvider: { provider: string | null; model: string | null } = {
    provider: null,
    model: null,
  }

  try {
    const providerConfig = await loadProviderConfig(context.programId)
    usageProvider = {
      provider: providerConfig.provider,
      model: providerConfig.model,
    }
    const adapter = getAdapter(providerConfig)

    const userPrompt = buildUserPrompt(
      partName,
      description,
      partType,
      attributes,
    )

    const messages = [{ role: 'user' as const, content: userPrompt }]

    // Own controller, aborted by the caller's signal: `chat` takes a
    // controller, not a signal.
    const abortController = new AbortController()
    if (context.signal) {
      if (context.signal.aborted) abortController.abort()
      else {
        context.signal.addEventListener('abort', () => abortController.abort())
      }
    }

    const stream = chat({
      adapter,
      systemPrompts: [ASSESSMENT_SYSTEM_PROMPT],
      messages,
      // A one-shot question, never a conversation to resume.
      threadId: `cad-assessment-${crypto.randomUUID()}`,
      modelOptions: maxOutputTokens(adapter, 1024),
      abortController,
    })

    let fullResponse = ''
    for await (const chunk of stream) {
      usage.observe(chunk)
      if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) {
        fullResponse += chunk.delta
      }
    }

    return parseAssessmentResponse(fullResponse)
  } finally {
    const totals = usage.totals
    await recordLlmUsage({
      userId: context.userId,
      // Not a chat session — this is a one-shot call from a route.
      sessionId: null,
      programId: context.programId ?? null,
      provider: usageProvider.provider,
      model: usageProvider.model,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      durationMs: Date.now() - startedAt,
    })
  }
}

function buildUserPrompt(
  partName: string,
  description: string | undefined,
  partType: string | undefined,
  attributes: Record<string, unknown>,
): string {
  const lines: Array<string> = []
  lines.push(`Part Name: ${partName}`)

  if (description) {
    lines.push(`Description: ${description}`)
  }

  if (partType) {
    lines.push(`Part Type: ${partType}`)
  }

  // Include relevant attributes (material, dimensions, etc.)
  const relevantKeys = ['material', 'weight', 'weightUnit', 'dimensions']
  for (const key of relevantKeys) {
    if (attributes[key] !== undefined && attributes[key] !== null) {
      lines.push(`${key}: ${String(attributes[key])}`)
    }
  }

  lines.push('')
  lines.push('Assess this part for CAD generation.')

  return lines.join('\n')
}

function parseAssessmentResponse(response: string): CadAssessmentResult {
  // Strip markdown code fences if present
  let cleaned = response.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
  }

  try {
    const parsed = JSON.parse(cleaned)
    return {
      canParametric: Boolean(parsed.canParametric),
      template: parsed.template,
      parameters: parsed.parameters,
      units: parsed.units === 'in' ? 'in' : 'mm',
      reasoning: parsed.reasoning || 'No reasoning provided.',
    }
  } catch {
    // If parsing fails, return a safe fallback
    return {
      canParametric: false,
      reasoning: `Unable to parse assessment. Raw response: ${response.slice(0, 200)}`,
    }
  }
}
