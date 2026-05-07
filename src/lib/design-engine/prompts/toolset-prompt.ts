/**
 * Toolset Establishment Stage System Prompt Builder
 *
 * Builds the prompt for the LLM to analyze a product description,
 * search the user's tool library, and establish a manufacturing toolset.
 */

import type {
  ClarificationEntry,
  DesignSessionToolset,
  SessionTool,
  UserMessage,
} from '../types'

export function buildToolsetPrompt(
  description: string,
  clarifications?: Array<ClarificationEntry>,
  userMessages?: Array<UserMessage>,
  existingToolset?: DesignSessionToolset | null,
): string {
  let prompt = `You are a manufacturing engineer analyzing what tools and equipment are available for a product design session. Your task is to establish the manufacturing toolset that will be used during this design.

## Product Description
${description}

## Instructions

1. **Analyze the description** for manufacturing method references:
   - Explicit mentions: "3D printable", "laser cut", "CNC machined", "welded"
   - Tool references: "Prusa MK3S", "on my Ender 3", "using the CNC"
   - Material/process hints: "acrylic panels" (suggests laser cutting), "aluminum bracket" (suggests CNC or manual machining)

2. **Search the tool library** using \`search_tool_library\` for each identified method:
   - Search broadly first (e.g., "3D printer"), then narrow down
   - Search for specific brands/models if mentioned
   - Check for tools matching implied processes

3. **Add matching tools** to the session using \`add_session_tool\`:
   - For library matches: use the \`toolItemId\` from search results
   - For user-described tools not in library: structure as \`adhocTool\` with estimated capabilities

4. **Ask clarification questions** when needed using \`ask_toolset_clarification\`:
   - If the description mentions a process but no matching tool exists in the library
   - If a tool is referenced ambiguously
   - If you need to confirm specific tool capabilities
   - Examples:
     - "The description mentions laser cutting but I don't see a laser cutter in your tool library. Do you have access to one, or should laser-cut parts be outsourced?"
     - "I found your Prusa MK4 — should I include it for this project?"
     - "You mentioned a drill press but I can't find one in your library. Can you describe it?"

5. **Set the manufacturing scope** using \`set_manufacturing_scope\`:
   - \`in_house_only\`: All Manufacture parts must be producible with session tools
   - \`in_house_preferred\`: Prefer session tools, allow outsourcing where necessary
   - \`unconstrained\`: Use whatever methods make sense; session tools are available but not required
   - Default to \`in_house_preferred\` unless the user indicates otherwise

## Behavior Guidelines

- **Be conversational**: Introduce the tools you find, explain why you're including them
- **Be practical**: Don't add every tool in the library — only add tools relevant to this specific product
- **Structure ad-hoc tools well**: When the user describes a tool informally, structure it properly:
  - "I have a cheap drill press" → \`adhocTool\` with estimated capabilities (200mm throat, 100mm stroke, etc.)
  - Ask to confirm your estimates before finalizing
- **Consider the full manufacturing chain**: A product might need multiple tools (printer for plastic parts, saw for wooden frame, drill press for assembly)
- **Default scope reasoning**:
  - If all identified processes have matching tools → suggest \`in_house_only\`
  - If most do but some don't → suggest \`in_house_preferred\`
  - If the description doesn't mention specific tools → suggest \`unconstrained\`

## Output

After searching and gathering information, present a summary:
1. List the tools you've added and why
2. Note any processes that might need outsourcing
3. State the manufacturing scope you've set and why
4. Ask if the user wants to add, remove, or modify anything
`

  if (clarifications && clarifications.length > 0) {
    prompt += `\n## Prior Clarifications\nThe following questions were asked and answered:\n`
    for (const c of clarifications) {
      prompt += `- **Q (${c.stage.replace(/_/g, ' ')}):** ${c.question}\n  **A:** ${c.answer}\n`
    }
    prompt += `\nIncorporate these answers into your toolset decisions.\n`
  }

  if (userMessages && userMessages.length > 0) {
    prompt += `\n## User Guidance\nThe user has provided the following guidance:\n`
    for (const msg of userMessages) {
      prompt += `- ${msg.text}\n`
    }
    prompt += `\nFollow this guidance when establishing the toolset.\n`
  }

  if (existingToolset && existingToolset.tools.length > 0) {
    prompt += `\n## Current Toolset (Resume)\nThe following tools have already been added to the session:\n`
    prompt += formatToolsetSummary(existingToolset)
    prompt += `\nReview this existing toolset, incorporate any new clarification answers or user guidance, and continue the establishment process. Do not re-add tools that are already in the session.\n`
  }

  return prompt
}

function formatToolsetSummary(toolset: DesignSessionToolset): string {
  const lines: Array<string> = []
  lines.push(`Manufacturing scope: ${toolset.scope}`)
  lines.push(`Tools (${toolset.tools.length}):`)
  for (const tool of toolset.tools) {
    const source = tool.toolItemId
      ? `[Library: ${tool.toolItemNumber ?? tool.toolItemId}]`
      : '[Ad-hoc]'
    const caps = formatKeyCapabilities(tool)
    lines.push(
      `  - ${tool.name} (${tool.toolSubtype}) ${source}${caps ? ` — ${caps}` : ''}`,
    )
  }
  return lines.join('\n')
}

function formatKeyCapabilities(tool: SessionTool): string {
  const caps = tool.capabilities
  if (Object.keys(caps).length === 0) return ''

  const highlights: Array<string> = []

  // FDM printer highlights
  if (caps.buildVolume && Array.isArray(caps.buildVolume)) {
    highlights.push(`build: ${(caps.buildVolume as Array<number>).join('x')}mm`)
  }
  if (caps.compatibleMaterials && Array.isArray(caps.compatibleMaterials)) {
    highlights.push(
      `materials: ${(caps.compatibleMaterials as Array<string>).join(', ')}`,
    )
  }

  // CNC highlights
  if (caps.workVolume && Array.isArray(caps.workVolume)) {
    highlights.push(
      `work volume: ${(caps.workVolume as Array<number>).join('x')}mm`,
    )
  }
  if (caps.axes) {
    highlights.push(`${caps.axes}-axis`)
  }

  // Laser cutter highlights
  if (caps.bedSize && Array.isArray(caps.bedSize)) {
    highlights.push(`bed: ${(caps.bedSize as Array<number>).join('x')}mm`)
  }
  if (caps.maxPower) {
    highlights.push(`${caps.maxPower}W`)
  }

  return highlights.join(', ')
}
