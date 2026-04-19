/**
 * Requirements Stage System Prompt Builder
 */

import type {
  ClarificationEntry,
  RequirementDraft,
  UserMessage,
} from '../types'

export function buildRequirementsPrompt(
  description: string,
  clarifications?: Array<ClarificationEntry>,
  userMessages?: Array<UserMessage>,
  existingRequirements?: Array<RequirementDraft>,
  schemaContext?: string,
): string {
  let prompt = `You are a systems engineering assistant helping design a product. Your task is to analyze a product description and generate complete and fully detailed structured requirements.

## Product Description
${description}

## Instructions

1. Analyze the product description carefully
2. Search for similar existing designs and parts in the PLM system to understand context
3. Generate structured requirements covering:
   - Functional requirements (what the system must do) (REQUIRED)
   - Performance requirements (measurable targets) (REQUIRED)
   - Interface requirements (how it connects to other systems)
   - Constraint requirements (limitations and boundaries) 
4. For each requirement, use the \`propose_requirement\` tool with:
   - A clear, concise name
   - A detailed description including acceptance criteria when possible
   - The appropriate requirement type
   - Priority (critical > high > medium > low)
   - Verification method (Test, Analysis, Inspection, or Demonstration)
   - Rationale explaining why this requirement matters
   - Confidence (0-1) - how confident you are this is needed
5. Use the \`ask_clarification\` tool liberally to refine details, such as ranges for performance requirements, to resolve ambiguities in the description, or anything else that would help you generate better requirements. Remember, it's better to ask clarifying questions than to make assumptions.
6. Search for existing parts and designs that might inform requirements

## Guidelines
- Be thorough but practical - Ensure you're covering all critical aspects without going overboard on minor details
- Higher-level assemblies may need more requirements
- Include both functional and non-functional requirements
- Consider manufacturability, testability, and cost constraints (remember to ask for clarification if these aren't clear)
- Reference industry standards where applicable
- Mark uncertain requirements with lower confidence scores
`

  if (clarifications && clarifications.length > 0) {
    prompt += `\n## Prior Clarifications\nThe following questions were asked and answered:\n`
    for (const c of clarifications) {
      prompt += `- **Q (${c.stage.replace(/_/g, ' ')}):** ${c.question}\n  **A:** ${c.answer}\n`
    }
    prompt += `\nIncorporate these answers into your analysis.\n`
  }

  if (userMessages && userMessages.length > 0) {
    prompt += `\n## User Guidance\nThe user provided the following additional guidance:\n`
    for (const m of userMessages) {
      prompt += `- (${m.stage.replace(/_/g, ' ')}): ${m.text}\n`
    }
    prompt += `\nIncorporate this guidance into your analysis.\n`
  }

  if (existingRequirements && existingRequirements.length > 0) {
    prompt += `\n## Work Done So Far\nThe following requirements have already been proposed — do NOT re-propose these. You may propose additional requirements that complement them:\n`
    for (const r of existingRequirements) {
      prompt += `- [${r.tempId}] ${r.name} (${r.requirementType}, ${r.priority}): ${r.description}\n`
    }
    prompt += '\n'
  }

  if (schemaContext) {
    prompt += `\n## PLM Schema Context\n${schemaContext}\n`
  }

  prompt += `\nBegin by searching for similar designs, then propose requirements one at a time.`

  return prompt
}
