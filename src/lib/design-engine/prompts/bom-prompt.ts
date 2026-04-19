/**
 * BOM Stage System Prompt Builder
 */

import type {
  BomDraft,
  BomNodeDraft,
  ClarificationEntry,
  DesignSessionToolset,
  RequirementDraft,
  SessionTool,
  UserMessage,
} from '../types'

/**
 * Render a BOM tree as an indented text representation showing
 * each node's name, tempId, type, and children.
 */
function renderBomTree(node: BomNodeDraft, indent: number = 0): string {
  const prefix = '  '.repeat(indent)
  const type = node.partType ?? 'Unknown'
  const ifaceCount = node.interfaces?.length ?? 0
  const mappingCount = node.interfaceMappings?.length ?? 0
  const extras: Array<string> = []
  if (node.isNew) extras.push('new')
  if (ifaceCount > 0) extras.push(`${ifaceCount} interfaces`)
  if (mappingCount > 0) extras.push(`${mappingCount} mappings`)
  const extrasStr = extras.length > 0 ? ` [${extras.join(', ')}]` : ''

  let line = `${prefix}- ${node.name} (${node.tempId}) — ${type}${extrasStr}\n`
  for (const child of node.children) {
    line += renderBomTree(child, indent + 1)
  }
  return line
}

export function buildBomPrompt(
  description: string,
  requirements: Array<RequirementDraft>,
  clarifications?: Array<ClarificationEntry>,
  userMessages?: Array<UserMessage>,
  existingBom?: BomDraft | null,
  schemaContext?: string,
  toolset?: DesignSessionToolset,
): string {
  const requirementsList = requirements
    .map(
      (r, i) =>
        `${i + 1}. [${r.tempId}] ${r.name} (${r.requirementType}, ${r.priority}): ${r.description}`,
    )
    .join('\n')

  let prompt = `You are a systems engineering assistant helping build a Bill of Materials (BOM) for a product design.

## Product Description
${description}

## Confirmed Requirements
${requirementsList}

## Instructions

Work through the BOM in three distinct phases. **Do not stop early** — complete all three phases before finishing.

### Phase 1: Structure (build the complete tree)
1. Start with the top-level assembly using \`propose_new_part\` (no parentTempId — this becomes the root)
2. Decompose into logical sub-assemblies (Phantom type), always passing \`parentTempId\`
3. For each sub-assembly, **immediately decompose it** into its children before moving to the next sibling. Every Phantom/assembly node MUST have at least one child — do not leave any assembly as an empty leaf.
4. For each child, first search the existing parts library (\`search_parts\`) to see if a suitable part already exists
5. For existing parts that match, use \`add_existing_to_bom\` with their item ID and \`parentTempId\`
6. For Purchase parts with no library match, use \`lookup_component_catalog\` to find real-world components with specs, pricing, and sourcing info. Include specific specs in your query (e.g., "NEMA 17 stepper 5mm shaft", "M3x10 socket head cap screw stainless"). When a catalog match is found, pass its \`catalogComponentId\` to \`propose_new_part\` — the catalog specs will auto-populate the PLM part during materialization.
7. If no catalog match either, try ONE broader query before giving up. Then propose the part with your best knowledge and set \`requiresManualSourcing: true\` in \`propose_new_part\`.
8. For parts that don't exist and aren't Purchase parts, use \`propose_new_part\` with \`parentTempId\`
7. Link requirements to parts using \`link_requirement_to_part\` (pass the node's \`tempId\`)
8. If you need clarification, use \`ask_bom_clarification\`

**CRITICAL**: Every node except the root MUST have a \`parentTempId\`. Both \`propose_new_part\` and \`add_existing_to_bom\` accept \`parentTempId\` to set the parent-child relationship in one call. Each tool returns a single \`tempId\` — use that ID when adding children to that node or linking requirements.

You can also use \`set_bom_parent\` to move or re-parent nodes after creation if needed.

### Phase 2: Interfaces (define mechanical features)
After the full tree is built, call \`set_part_interfaces\` for **every** Manufacture part. An interface describes a physical feature used to connect or mate with other parts — mounting holes, mating faces, shafts, bores, etc.

Each interface must include:
- A descriptive name (e.g., "4x M4 mounting holes on bottom face")
- A mate type: coaxial, coincident, concentric, insert, parallel_offset, tangent, or fixed_offset
- Geometry: shape (circular/rectangular/linear/planar/cylindrical), nominal dimensions (e.g., \`{ diameter: 6, depth: 12 }\`), units (mm or in), optional count and pattern
- A location hint (e.g., "bottom face", "left side", "front panel")

### Phase 3: Assembly Mappings (connect children)
After interfaces are defined, call \`set_assembly_interface_mappings\` for **every** assembly that has children. These describe how children connect to each other:
- Reference the child tempIds and their interface IDs
- Specify the mate type and a natural-language positioning description

**CRITICAL**: You can ONLY reference **direct children** of the assembly in interface mappings. For example, if assembly A has children [B, C, D], mappings on A can only use tempIds of B, C, and D — not parts nested deeper inside B. Cross-assembly connections between sub-assemblies should be defined as mappings on their shared parent.

**Every child in an assembly should have at least one interface mapping.** Parts that don't connect to anything are likely misplaced in the BOM hierarchy.
`

  // Phase 4: Manufacturing Assignment (only when toolset exists)
  if (toolset && toolset.tools.length > 0) {
    prompt += `
### Phase 4: Manufacturing Assignment (assign tools and constraints)
After interfaces and mappings are complete, assign manufacturing processes to each Manufacture part using \`assign_manufacturing\` or include in \`propose_new_part\`:

1. **Assign a tool** from the session toolset to each Manufacture part. Set \`assignedToolId\` to the best-matching tool's ID.

2. **Populate manufacturingConstraints** based on the assigned tool's capabilities:
   - For FDM parts: use the tool's buildVolume, nozzleDiameter, and materials. Select layerHeight and material for this part's needs. If the part exceeds build volume, set segmentation.needed = true.
   - For laser-cut parts: use bedSize and material/thickness from the tool.
   - For CNC parts: use workVolume and material compatibility.
   - For manual cuts (miter saw, band saw): use the tool's max cut dimensions.

3. **Scope enforcement**:
   - If scope is "in_house_only" and no session tool can produce the part → flag as an issue.
   - If scope is "in_house_preferred" → set outsourced = true with notes on what's needed.

4. **Write a cadGenerationHint** for EVERY Manufacture part with specific geometry:
   - Exact dimensions in mm
   - Feature positions and sizes (holes, slots, fillets)
   - Functional surface descriptions
   - Reference to mating parts for dimensional coherence
   - A good hint is 3-8 sentences of dense engineering detail
   - Cross-reference hints across related parts (e.g., matching gear module, shared bolt patterns)

## Session Toolset
Manufacturing scope: **${toolset.scope}**

Available tools:
${toolset.tools.map((t) => formatToolForPrompt(t)).join('\n')}
`
  }

  prompt += `
## BOM Guidelines
- Build the tree top-down: create parent first, then children referencing its tempId
- Search for existing parts before proposing new ones
- For Purchase parts: search PLM library first (\`search_parts\`), then component catalog (\`lookup_component_catalog\`), then propose with \`requiresManualSourcing: true\`
- Set appropriate quantities for each BOM relationship
- Use Manufacture for custom-fabricated parts, Purchase for COTS/standard components, Software for firmware/code, Phantom for logical groupings
- Assign find numbers for position identification
- Link each part to the requirements it satisfies
- Aim for 100% requirements coverage

## Raw Stock Material Pattern
When the component catalog returns a \`raw_stock\` entry (extrusions, sheet stock, rod stock, etc.), the material needs to be cut/modified to its final form. Model this as a two-level structure:

\`\`\`
Finished Part (Manufacture)           ← final dimensions, interfaces, manufacturing notes
  └── Raw Stock Material (Purchase)   ← catalog entry with selected stock size
\`\`\`

Steps:
1. Check the catalog entry's \`stockSizes\` to find the smallest standard size that accommodates the required dimension. Always round UP.
2. Propose the Purchase child using the selected stock size. Pass \`catalogComponentId\` and \`selectedStockSize\` (the label). Name it with the material and stock size, e.g., "2020 Aluminum T-Slot Extrusion, 500mm".
3. Propose a Manufacture parent for the finished piece. Name it descriptively for its role, e.g., "Enclosure Frame Side Rail".
4. The Manufacture part's rationale should describe fabrication operations: "Cut 2020 T-slot extrusion to 437mm. Drill 5mm through-holes at 50mm from each end."
5. Set interfaces on the Manufacture part (not the Purchase child) — these describe the finished part's connection features.

## Parametric CAD Generation
For simple geometric parts, provide a \`parametricSpec\` in the \`propose_new_part\` call for instant STEP generation (~1 second) instead of slow AI-based generation (~10 minutes). Available templates and their parameters (all dimensions in mm unless requirements explicitly use inches):

- **bushing** — Required: \`od\` (outer diameter), \`id\` (inner diameter), \`length\`
- **spacer** — Required: \`od\` (outer diameter), \`id\` (inner diameter), \`length\`
- **tube** — Required: \`od\` (outer diameter), \`wall_thickness\`, \`length\`
- **plate** — Required: \`width\`, \`height\`, \`thickness\`. Optional: \`corner_radius\`
- **plate_with_holes** — Required: \`width\`, \`height\`, \`thickness\`, \`hole_diameter\`. Optional: \`corner_radius\`, \`hole_count_x\`, \`hole_count_y\`, \`hole_margin_x\`, \`hole_margin_y\`
- **block** — Required: \`width\`, \`depth\`, \`height\`. Optional: \`corner_radius\`
- **bracket_l** — Required: \`leg1_length\`, \`leg2_length\`, \`width\`, \`thickness\`. Optional: \`fillet_radius\`, \`hole_diameter\`, \`holes_leg1\`, \`holes_leg2\`
- **bracket_u** — Required: \`base_length\`, \`leg_height\`, \`width\`, \`thickness\`. Optional: \`fillet_radius\`
- **extrusion_rectangular** — Required: \`width\`, \`height\`, \`length\`. Optional: \`wall_thickness\` (makes it hollow)
- **extrusion_circular** — Required: \`diameter\`, \`length\`. Optional: \`wall_thickness\` (makes it a tube)

Omit \`parametricSpec\` for complex organic geometry, compound curves, or features that don't fit these templates. Both parametric and AI-generated parts can coexist in the same BOM.

## Mechanism Templates
For multi-part mechanisms that require coordinated engineering math, use the \`apply_mechanism_template\` tool. This generates STEP files for multiple linked parts simultaneously, ensuring dimensional coherence (e.g., matching gear module, correct involute tooth profiles, proper mesh geometry).

**Two-step process:**
1. First, use \`propose_new_part\` to create each child part that will be part of the mechanism (set partType to \`Manufacture\`). You may include a \`cadGenerationHint\` for supplementary context (surface finish, color) but do NOT set \`parametricSpec\` — the mechanism template handles geometry generation.
2. Then, call \`apply_mechanism_template\` on the parent assembly/Phantom node, referencing the child parts by their tempIds via \`partMapping\`.

### Available Mechanism Types

**rack_and_pinion** — Generates a meshing rack and pinion gear pair with involute tooth profiles for linear-motion drives.
Required parameters:
- \`module\` — gear module in mm (tooth pitch / pi). Common values: 0.5, 1.0, 1.5, 2.0, 2.5, 3.0
- \`rack_length\` — total rack length in mm
- \`rack_height\` — rack body height in mm (below teeth)
- \`rack_thickness\` — rack body thickness (face width) in mm
- \`pinion_teeth\` — number of teeth on pinion (integer, minimum 6)
- \`pinion_face_width\` — pinion gear face width in mm

Optional parameters:
- \`pressure_angle\` — default 20 degrees. Alternatives: 14.5 (legacy), 25 (high load)
- \`pinion_bore_diameter\` — center bore for shaft mounting
- \`pinion_hub_diameter\` — hub boss diameter
- \`pinion_hub_length\` — hub boss length

Part mapping roles: \`rack\`, \`pinion\`

Example:
\`\`\`
apply_mechanism_template({
  tempId: "<linear-drive-assembly-tempId>",
  mechanismType: "rack_and_pinion",
  parameters: { module: 1.5, rack_length: 200, rack_height: 15, rack_thickness: 20, pinion_teeth: 18, pinion_face_width: 20 },
  units: "mm",
  partMapping: [
    { role: "rack", childTempId: "<rack-part-tempId>" },
    { role: "pinion", childTempId: "<pinion-part-tempId>" }
  ]
})
\`\`\`

## Quality Checks
- Every Phantom/assembly node must have at least one child (no empty assemblies)
- Every proposed part should satisfy at least one requirement
- Every requirement should be linked to at least one part
- Every node except the root must have a parent (no orphans)
- No circular references in the BOM tree
- Quantities must be positive integers
- Find numbers should be unique within each parent assembly
- Every Manufacture part should have at least one interface defined
- Every assembly should have interface mappings connecting its children
`

  if (clarifications && clarifications.length > 0) {
    prompt += `\n## Prior Clarifications\nThe following questions were asked and answered across stages:\n`
    for (const c of clarifications) {
      prompt += `- **Q (${c.stage.replace(/_/g, ' ')}):** ${c.question}\n  **A:** ${c.answer}\n`
    }
    prompt += `\nIncorporate these answers into your BOM design.\n`
  }

  if (userMessages && userMessages.length > 0) {
    prompt += `\n## User Guidance\nThe user provided the following additional guidance:\n`
    for (const m of userMessages) {
      prompt += `- (${m.stage.replace(/_/g, ' ')}): ${m.text}\n`
    }
    prompt += `\nIncorporate this guidance into your BOM design.\n`
  }

  if (existingBom) {
    prompt += `\n## Work Done So Far\nA partial BOM has already been built. Continue from where you left off — do NOT re-propose parts that already exist in the tree.\n\n`
    prompt += `### Current Tree Structure\n\`\`\`\n${renderBomTree(existingBom.rootAssembly)}\`\`\`\n`
    prompt += `\n**IMPORTANT for interface mappings**: \`set_assembly_interface_mappings\` on an assembly node can ONLY reference that node's **direct children**. Use the tree above to identify each assembly's direct children by their tempIds.\n`
  }

  if (schemaContext) {
    prompt += `\n## PLM Schema Context\n${schemaContext}\n`
  }

  const phaseCount =
    toolset && toolset.tools.length > 0 ? 'all four phases' : 'all three phases'
  prompt += `\nBegin by proposing the top-level assembly, then decompose into sub-assemblies and components. Complete ${phaseCount} before stopping.`

  return prompt
}

/**
 * Build a targeted continuation prompt listing exactly what's missing.
 */
export function buildBomContinuationPrompt(gaps: {
  undecomposedAssemblies: Array<{ tempId: string; name: string }>
  partsWithoutInterfaces: Array<{ tempId: string; name: string }>
  assembliesWithoutMappings: Array<{ tempId: string; name: string }>
}): string {
  const sections: Array<string> = []

  sections.push(
    `The BOM tree has been partially built but has gaps that need to be filled. Address each category below.`,
  )

  if (gaps.undecomposedAssemblies.length > 0) {
    const list = gaps.undecomposedAssemblies
      .map((a) => `- "${a.name}" (${a.tempId})`)
      .join('\n')
    sections.push(
      `## Undecomposed Assemblies\nThese Phantom/assembly nodes have zero children. Decompose each into its component parts:\n${list}`,
    )
  }

  if (gaps.partsWithoutInterfaces.length > 0) {
    const list = gaps.partsWithoutInterfaces
      .map((p) => `- "${p.name}" (${p.tempId})`)
      .join('\n')
    sections.push(
      `## Parts Missing Interfaces\nThese Manufacture parts need interface definitions for CAD generation. Call \`set_part_interfaces\` for each:\n${list}`,
    )
  }

  if (gaps.assembliesWithoutMappings.length > 0) {
    const list = gaps.assembliesWithoutMappings
      .map((a) => `- "${a.name}" (${a.tempId})`)
      .join('\n')
    sections.push(
      `## Assemblies Missing Interface Mappings\nThese assemblies have children but no interface mappings. Call \`set_assembly_interface_mappings\` for each:\n${list}`,
    )
  }

  sections.push(
    `Do NOT re-propose parts that already exist in the tree. Only fill in the missing pieces listed above.`,
  )

  return sections.join('\n\n')
}

/**
 * Format a session tool for inclusion in the BOM prompt.
 */
function formatToolForPrompt(tool: SessionTool): string {
  const caps = tool.capabilities
  const highlights: Array<string> = []

  // FDM
  if (caps.buildVolume && Array.isArray(caps.buildVolume)) {
    highlights.push(
      `build volume: ${(caps.buildVolume as Array<number>).join(' x ')}mm`,
    )
  }
  if (caps.nozzleDiameter) highlights.push(`nozzle: ${caps.nozzleDiameter}mm`)
  if (caps.compatibleMaterials && Array.isArray(caps.compatibleMaterials)) {
    highlights.push(
      `materials: ${(caps.compatibleMaterials as Array<string>).join(', ')}`,
    )
  }
  if (caps.layerHeightRange && Array.isArray(caps.layerHeightRange)) {
    highlights.push(
      `layer height: ${(caps.layerHeightRange as Array<number>).join('-')}mm`,
    )
  }

  // CNC
  if (caps.workVolume && Array.isArray(caps.workVolume)) {
    highlights.push(
      `work volume: ${(caps.workVolume as Array<number>).join(' x ')}mm`,
    )
  }
  if (caps.axes) highlights.push(`${caps.axes}-axis`)

  // Laser
  if (caps.bedSize && Array.isArray(caps.bedSize)) {
    highlights.push(`bed: ${(caps.bedSize as Array<number>).join(' x ')}mm`)
  }
  if (caps.maxPower)
    highlights.push(`${caps.maxPower}W ${caps.laserType ?? ''}`.trim())

  // Manual tools
  if (caps.maxCrosscutWidth)
    highlights.push(`max crosscut: ${caps.maxCrosscutWidth}mm`)
  if (caps.maxCutDepth) highlights.push(`max cut depth: ${caps.maxCutDepth}mm`)

  const capsStr = highlights.length > 0 ? ` — ${highlights.join(', ')}` : ''
  const source = tool.toolItemId
    ? `[${tool.toolItemNumber ?? 'Library'}]`
    : '[Ad-hoc]'

  return `- **${tool.name}** (ID: \`${tool.id}\`, subtype: ${tool.toolSubtype}) ${source}${capsStr}`
}
