/**
 * CAD Generation Assessment
 *
 * Uses an LLM to assess whether a part can be generated using the fast
 * parametric service (CadQuery templates) or needs the external Zoo API.
 */

import { chat } from '@tanstack/ai'
import { getAdapter, loadProviderConfig } from '@/lib/ai/adapters'

export interface CadAssessmentResult {
  canParametric: boolean
  template?: string
  parameters?: Record<string, number>
  units?: 'mm' | 'in'
  reasoning: string
}

const ASSESSMENT_SYSTEM_PROMPT = `You are a manufacturing engineer assessing whether a part can be generated using a parametric CAD template or requires a more advanced text-to-CAD AI service.

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
 * Assess whether a part can be generated parametrically or needs the Zoo API.
 */
export async function assessPartForCadGeneration(
  partName: string,
  description: string | undefined,
  partType: string | undefined,
  attributes: Record<string, unknown>,
): Promise<CadAssessmentResult> {
  const providerConfig = await loadProviderConfig()
  const adapter = getAdapter(providerConfig)

  const userPrompt = buildUserPrompt(
    partName,
    description,
    partType,
    attributes,
  )

  const messages: any = [
    { role: 'system', content: ASSESSMENT_SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ]

  const stream = chat({
    adapter,
    messages,
    maxTokens: 1024,
  })

  let fullResponse = ''
  for await (const chunk of stream) {
    if (chunk.type === 'content' && chunk.content) {
      fullResponse = chunk.content
    }
  }

  return parseAssessmentResponse(fullResponse)
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
