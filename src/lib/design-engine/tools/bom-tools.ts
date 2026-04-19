/**
 * BOM Stage Tools
 *
 * Tools available to the LLM during the BOM generation stage.
 */

import { toolDefinition } from '@tanstack/ai'
import { z } from 'zod'
import {
  computeMechanismPreview,
  getMechanismRoles,
  validateMechanismParameters,
} from '../validation/mechanism-schemas'
import type { ToolContext } from '@/lib/ai/tools/permission-wrapper'
import type {
  BomDraft,
  BomNodeDraft,
  InterfaceIntent,
  InterfaceMapping,
  MechanismType,
  ParametricPartSpec,
  ProposedPart,
} from '../types'
import {
  getBomHandler,
  getItemDetailsHandler,
  searchItemsHandler,
} from '@/lib/ai/tools/handlers'
import { CatalogService } from '@/lib/services/CatalogService'

interface BomBuildState {
  nodes: Map<string, BomNodeDraft>
  proposedParts: Array<ProposedPart>
  rootTempId: string | null
  changeVersion: number
}

export function createBomTools(
  context: ToolContext,
  state: BomBuildState,
  onUpdate: (bom: BomDraft) => void,
  onClarification: (
    questionId: string,
    question: string,
    options?: Array<string>,
  ) => void,
) {
  const searchParts = toolDefinition({
    name: 'search_parts',
    description:
      'Search for existing parts in the PLM system to reuse in the BOM.',
    inputSchema: z.object({
      query: z.string().describe('Search query'),
      itemType: z
        .enum(['Part', 'Document', 'Requirement'])
        .optional()
        .describe('Filter by type'),
      limit: z.number().optional(),
    }),
    outputSchema: z.object({
      items: z.array(z.record(z.string(), z.unknown())),
      total: z.number(),
    }),
  }).server(async (input) => {
    return (await searchItemsHandler(
      {
        query: input.query,
        itemType: input.itemType,
        limit: input.limit ?? 10,
      },
      context,
    )) as { items: Array<Record<string, unknown>>; total: number }
  })

  const lookupComponentCatalog = toolDefinition({
    name: 'lookup_component_catalog',
    description:
      'Search the component catalog for real, purchasable components and raw stock materials ' +
      'with specs, pricing, and sourcing info. Use for Purchase parts when no existing PLM library part ' +
      'matches via search_parts. Include specific specs in the query for best results ' +
      '(e.g., "NEMA 17 stepper 5mm shaft", "M3 socket head cap screw 12mm", "2020 T-slot extrusion").',
    inputSchema: z.object({
      query: z.string().describe('Natural language search query'),
      category: z
        .string()
        .optional()
        .describe(
          'Category slug to narrow results (e.g., "fasteners", "motors", "linear-motion", "raw-stock")',
        ),
      entryType: z
        .enum(['component', 'raw_stock'])
        .optional()
        .describe(
          'Filter by entry type. Use "raw_stock" for extrusions, sheet metal, rod stock, etc.',
        ),
      limit: z.number().optional().describe('Max results (default 5)'),
    }),
    outputSchema: z.object({
      results: z.array(z.record(z.string(), z.unknown())),
      total: z.number(),
      message: z.string().optional(),
    }),
  }).server(async (input) => {
    const { results, total } = await CatalogService.search(input.query, {
      categorySlug: input.category,
      entryType: input.entryType,
      limit: input.limit ?? 5,
    })

    if (results.length === 0) {
      return {
        results: [],
        total: 0,
        message:
          'No catalog matches found. Propose the part with your best knowledge of specs ' +
          'and set requiresManualSourcing = true so engineers can source it manually.',
      }
    }

    return {
      results: results as unknown as Array<Record<string, unknown>>,
      total,
    }
  })

  const getExistingBom = toolDefinition({
    name: 'get_existing_bom',
    description: 'Get the BOM of an existing part to understand its structure.',
    inputSchema: z.object({
      itemId: z.string().describe('Item ID to get BOM for'),
      depth: z.number().optional().describe('Max depth (default 1)'),
    }),
    outputSchema: z.record(z.string(), z.unknown()),
  }).server(async (input) => {
    return (await getBomHandler(
      { itemId: input.itemId, depth: input.depth },
      context,
    )) as Record<string, unknown>
  })

  const getItemDetails = toolDefinition({
    name: 'get_item_details',
    description: 'Get full details of a specific item.',
    inputSchema: z.object({
      id: z.string().describe('Item ID'),
    }),
    outputSchema: z.record(z.string(), z.unknown()),
  }).server(async (input) => {
    return (await getItemDetailsHandler({ id: input.id }, context)) as Record<
      string,
      unknown
    >
  })

  const proposeNewPart = toolDefinition({
    name: 'propose_new_part',
    description:
      'Propose a new part that needs to be created. Use this when no suitable existing part is found.',
    inputSchema: z.object({
      name: z.string().describe('Part name'),
      description: z.string().describe('Part description'),
      partType: z
        .enum(['Manufacture', 'Purchase', 'Software', 'Phantom'])
        .describe('Part type classification'),
      material: z.string().optional().describe('Material'),
      estimatedCost: z.number().optional().describe('Estimated cost'),
      rationale: z.string().describe('Why this part is needed'),
      satisfiesRequirements: z
        .array(z.string())
        .describe('Requirement tempIds this part satisfies'),
      quantity: z.number().default(1).describe('Quantity in parent assembly'),
      findNumber: z.number().optional().describe('Find number in assembly'),
      parentTempId: z
        .string()
        .optional()
        .describe(
          'Parent BOM node tempId. Every node except the root MUST specify a parent.',
        ),
      parametricSpec: z
        .object({
          shapeTemplate: z.enum([
            'bushing',
            'spacer',
            'tube',
            'plate',
            'plate_with_holes',
            'block',
            'bracket_l',
            'bracket_u',
            'extrusion_rectangular',
            'extrusion_circular',
          ]),
          parameters: z.record(z.string(), z.number()),
          units: z.enum(['mm', 'in']),
        })
        .optional()
        .describe(
          'If this is a simple geometric part matching one of the available shape templates, ' +
            'provide the parametric spec for instant STEP generation. ' +
            'Omit for complex parts that require Text-to-CAD generation.',
        ),
      catalogComponentId: z
        .string()
        .uuid()
        .optional()
        .describe(
          'ID from lookup_component_catalog if this part matches a catalog entry. ' +
            'Populates the PLM part with real specs during materialization.',
        ),
      requiresManualSourcing: z
        .boolean()
        .optional()
        .describe(
          'Set true if no catalog or library match was found and manual sourcing is needed.',
        ),
      selectedStockSize: z
        .string()
        .optional()
        .describe(
          'For raw_stock catalog entries, the label of the selected stock size (e.g., "500mm").',
        ),
      assignedToolId: z
        .string()
        .optional()
        .describe(
          'SessionTool.id from the session toolset. Assigns this tool as the manufacturing method.',
        ),
      manufacturingConstraints: z
        .object({
          process: z
            .string()
            .describe('Manufacturing process matching tool subtype'),
          toolReference: z.string().describe('SessionTool.id'),
          fdm: z
            .object({
              buildVolume: z.tuple([z.number(), z.number(), z.number()]),
              nozzleDiameter: z.number(),
              layerHeight: z.number(),
              material: z.string(),
              needsSupports: z.boolean(),
              segmentation: z
                .object({
                  needed: z.boolean(),
                  maxSegmentSize: z.tuple([z.number(), z.number(), z.number()]),
                  jointType: z.enum([
                    'dovetail',
                    'pin_slot',
                    'bolt_through',
                    'tongue_groove',
                    'glue_face',
                  ]),
                  overlapLength: z.number().optional(),
                  alignmentFeatures: z.boolean().optional(),
                })
                .optional(),
            })
            .optional(),
          laserCut: z
            .object({
              bedSize: z.tuple([z.number(), z.number()]),
              material: z.string(),
              thickness: z.number(),
              requiresNesting: z.boolean(),
            })
            .optional(),
          cnc: z
            .object({
              workVolume: z.tuple([z.number(), z.number(), z.number()]),
              material: z.string(),
              minToolDiameter: z.number(),
              axes: z.number(),
            })
            .optional(),
          manualCut: z
            .object({
              toolReference: z.string(),
              maxCutWidth: z.number().optional(),
              maxCutDepth: z.number().optional(),
              cutTypes: z.array(z.string()),
            })
            .optional(),
          outsourced: z.boolean().optional(),
          outsourceNotes: z.string().optional(),
        })
        .optional()
        .describe(
          'Manufacturing constraints derived from the assigned tool capabilities. Required for Manufacture parts when a session toolset exists.',
        ),
      cadGenerationHint: z
        .string()
        .optional()
        .describe(
          'Detailed geometry description for CAD generation (3-8 sentences with exact dimensions, features, mating references). ' +
            'Required for every Manufacture part.',
        ),
    }),
    outputSchema: z.object({
      tempId: z.string(),
    }),
  }).server(async (input) => {
    const tempId = crypto.randomUUID()

    const proposedPart: ProposedPart = {
      tempId,
      name: input.name,
      description: input.description,
      partType: input.partType,
      material: input.material,
      estimatedCost: input.estimatedCost,
      rationale: input.rationale,
      satisfiesRequirements: input.satisfiesRequirements,
      parametricSpec: input.parametricSpec as ParametricPartSpec | undefined,
      catalogComponentId: input.catalogComponentId,
      requiresManualSourcing: input.requiresManualSourcing,
      selectedStockSize: input.selectedStockSize,
      assignedToolId: input.assignedToolId,
      manufacturingConstraints: input.manufacturingConstraints as any,
      cadGenerationHint: input.cadGenerationHint,
    }
    state.proposedParts.push(proposedPart)

    const bomNode: BomNodeDraft = {
      tempId,
      name: input.name,
      isNew: true,
      quantity: input.quantity ?? 1,
      findNumber: input.findNumber,
      children: [],
      requirementTempIds: input.satisfiesRequirements,
      partType: input.partType,
      material: input.material,
      rationale: input.rationale,
      confidence: 0.8,
      parametricSpec: input.parametricSpec as ParametricPartSpec | undefined,
      catalogComponentId: input.catalogComponentId,
      requiresManualSourcing: input.requiresManualSourcing,
      selectedStockSize: input.selectedStockSize,
      assignedToolId: input.assignedToolId,
      manufacturingConstraints: input.manufacturingConstraints as any,
      cadGenerationHint: input.cadGenerationHint,
    }
    state.nodes.set(tempId, bomNode)

    // Auto-link to parent if provided
    if (input.parentTempId) {
      const parent = state.nodes.get(input.parentTempId)
      if (parent) {
        parent.children.push(bomNode)
      }
    }

    // First node becomes root only if no parent specified
    if (!state.rootTempId && !input.parentTempId) {
      state.rootTempId = tempId
    }

    rebuildAndNotify()
    return { tempId }
  })

  const addExistingToBom = toolDefinition({
    name: 'add_existing_to_bom',
    description:
      'Add an existing item from the PLM system to the BOM structure.',
    inputSchema: z.object({
      existingItemId: z.string().describe('Existing item ID'),
      existingItemNumber: z.string().optional().describe('Item number'),
      name: z.string().describe('Display name'),
      quantity: z.number().default(1),
      findNumber: z.number().optional(),
      requirementTempIds: z
        .array(z.string())
        .optional()
        .describe('Linked requirement tempIds'),
      parentTempId: z
        .string()
        .optional()
        .describe(
          'Parent BOM node tempId. Every node except the root MUST specify a parent.',
        ),
    }),
    outputSchema: z.object({
      tempId: z.string(),
    }),
  }).server(async (input) => {
    const tempId = crypto.randomUUID()
    const bomNode: BomNodeDraft = {
      tempId,
      name: input.name,
      existingItemId: input.existingItemId,
      existingItemNumber: input.existingItemNumber,
      isNew: false,
      quantity: input.quantity ?? 1,
      findNumber: input.findNumber,
      children: [],
      requirementTempIds: input.requirementTempIds ?? [],
      rationale: 'Existing part reused from library',
      confidence: 1.0,
    }
    state.nodes.set(tempId, bomNode)

    // Auto-link to parent if provided
    if (input.parentTempId) {
      const parent = state.nodes.get(input.parentTempId)
      if (parent) {
        parent.children.push(bomNode)
      }
    }

    // First node becomes root only if no parent specified
    if (!state.rootTempId && !input.parentTempId) {
      state.rootTempId = tempId
    }

    rebuildAndNotify()
    return { tempId }
  })

  const setBomParent = toolDefinition({
    name: 'set_bom_parent',
    description:
      'Set a parent-child relationship in the BOM tree. The child will be nested under the parent.',
    inputSchema: z.object({
      parentTempId: z.string().describe('Parent BOM node tempId'),
      childTempId: z.string().describe('Child BOM node tempId'),
    }),
    outputSchema: z.object({
      success: z.boolean(),
    }),
  }).server(async (input) => {
    const parent = state.nodes.get(input.parentTempId)
    const child = state.nodes.get(input.childTempId)
    if (!parent || !child) return { success: false }

    // Remove child from any existing parent
    for (const node of state.nodes.values()) {
      node.children = node.children.filter(
        (c) => c.tempId !== input.childTempId,
      )
    }

    parent.children.push(child)
    rebuildAndNotify()
    return { success: true }
  })

  const linkRequirementToPart = toolDefinition({
    name: 'link_requirement_to_part',
    description:
      'Link a requirement to a BOM node to track requirements coverage.',
    inputSchema: z.object({
      requirementTempId: z.string().describe('Requirement tempId'),
      tempId: z.string().describe('BOM node tempId'),
    }),
    outputSchema: z.object({
      linked: z.boolean(),
    }),
  }).server(async (input) => {
    const node = state.nodes.get(input.tempId)
    if (!node) return { linked: false }

    if (!node.requirementTempIds.includes(input.requirementTempId)) {
      node.requirementTempIds.push(input.requirementTempId)
    }
    rebuildAndNotify()
    return { linked: true }
  })

  const askBomClarification = toolDefinition({
    name: 'ask_bom_clarification',
    description: 'Ask the user for clarification about the BOM structure.',
    inputSchema: z.object({
      question: z.string(),
      options: z.array(z.string()).optional(),
    }),
    outputSchema: z.object({
      acknowledged: z.boolean(),
    }),
  }).server(async (input) => {
    const questionId = crypto.randomUUID()
    onClarification(questionId, input.question, input.options)
    return { acknowledged: true }
  })

  const setPartInterfaces = toolDefinition({
    name: 'set_part_interfaces',
    description:
      'Set mechanical interface definitions on a Manufacture part for CAD generation. Interfaces describe connection features like mounting holes, mating faces, shafts, etc.',
    inputSchema: z.object({
      tempId: z.string().describe('BOM node tempId'),
      interfaces: z.array(
        z.object({
          id: z.string().describe('Unique interface ID within this part'),
          description: z
            .string()
            .describe('Human-readable description of the interface'),
          mateType: z.enum([
            'coaxial',
            'coincident',
            'concentric',
            'insert',
            'parallel_offset',
            'tangent',
            'fixed_offset',
          ]),
          geometry: z.object({
            shape: z.enum([
              'circular',
              'rectangular',
              'linear',
              'planar',
              'cylindrical',
            ]),
            nominalDimensions: z
              .record(z.string(), z.number())
              .describe(
                'Key-value pairs of dimension names to values, e.g. { diameter: 6, depth: 12 }',
              ),
            units: z.enum(['mm', 'in']),
            count: z.number().optional(),
            patternType: z
              .enum(['linear', 'circular', 'rectangular_grid'])
              .optional(),
            patternSpacing: z.number().optional(),
          }),
          locationHint: z
            .string()
            .describe('Where on the part this interface is located'),
        }),
      ),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      interfaceCount: z.number(),
    }),
  }).server(async (input) => {
    const node = state.nodes.get(input.tempId)
    if (!node) return { success: false, interfaceCount: 0 }

    node.interfaces = input.interfaces as Array<InterfaceIntent>
    rebuildAndNotify()
    return { success: true, interfaceCount: input.interfaces.length }
  })

  const setAssemblyInterfaceMappings = toolDefinition({
    name: 'set_assembly_interface_mappings',
    description:
      'Set interface mappings on an assembly node describing how its children connect to each other.',
    inputSchema: z.object({
      tempId: z.string().describe('Assembly BOM node tempId'),
      mappings: z.array(
        z.object({
          id: z.string().describe('Unique mapping ID within this assembly'),
          partATempId: z.string().describe('First child part tempId'),
          interfaceAId: z.string().describe('Interface ID on part A'),
          partBTempId: z.string().describe('Second child part tempId'),
          interfaceBId: z.string().describe('Interface ID on part B'),
          mateType: z.enum([
            'coaxial',
            'coincident',
            'concentric',
            'insert',
            'parallel_offset',
            'tangent',
            'fixed_offset',
          ]),
          positioningIntent: z
            .string()
            .describe(
              'Natural-language description of how the parts are positioned',
            ),
        }),
      ),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      mappingCount: z.number(),
    }),
  }).server(async (input) => {
    const node = state.nodes.get(input.tempId)
    if (!node) return { success: false, mappingCount: 0 }

    // Validate that all referenced parts are direct children of this assembly
    const childTempIds = new Set(node.children.map((c) => c.tempId))
    const invalidRefs: Array<string> = []
    for (const m of input.mappings) {
      if (!childTempIds.has(m.partATempId)) invalidRefs.push(m.partATempId)
      if (!childTempIds.has(m.partBTempId)) invalidRefs.push(m.partBTempId)
    }

    if (invalidRefs.length > 0) {
      const childList = node.children
        .map((c) => `  - "${c.name}" (${c.tempId})`)
        .join('\n')
      return {
        success: false,
        mappingCount: 0,
        error: `Some referenced parts are not direct children of "${node.name}". Invalid tempIds: ${[...new Set(invalidRefs)].join(', ')}. Direct children are:\n${childList}\n\nOnly reference direct children of this assembly. Cross-assembly connections should be set on the parent assembly that contains both sub-assemblies.`,
      } as any
    }

    node.interfaceMappings = input.mappings as Array<InterfaceMapping>
    rebuildAndNotify()
    return { success: true, mappingCount: input.mappings.length }
  })

  const assignManufacturing = toolDefinition({
    name: 'assign_manufacturing',
    description:
      'Assign manufacturing data to an existing BOM node. Use this to set the assigned tool, manufacturing constraints, and CAD generation hint on a Manufacture part that was already proposed.',
    inputSchema: z.object({
      tempId: z.string().describe('BOM node tempId to update'),
      assignedToolId: z
        .string()
        .describe('SessionTool.id from the session toolset'),
      manufacturingConstraints: z
        .object({
          process: z.string(),
          toolReference: z.string(),
          fdm: z
            .object({
              buildVolume: z.tuple([z.number(), z.number(), z.number()]),
              nozzleDiameter: z.number(),
              layerHeight: z.number(),
              material: z.string(),
              needsSupports: z.boolean(),
              segmentation: z
                .object({
                  needed: z.boolean(),
                  maxSegmentSize: z.tuple([z.number(), z.number(), z.number()]),
                  jointType: z.enum([
                    'dovetail',
                    'pin_slot',
                    'bolt_through',
                    'tongue_groove',
                    'glue_face',
                  ]),
                  overlapLength: z.number().optional(),
                  alignmentFeatures: z.boolean().optional(),
                })
                .optional(),
            })
            .optional(),
          laserCut: z
            .object({
              bedSize: z.tuple([z.number(), z.number()]),
              material: z.string(),
              thickness: z.number(),
              requiresNesting: z.boolean(),
            })
            .optional(),
          cnc: z
            .object({
              workVolume: z.tuple([z.number(), z.number(), z.number()]),
              material: z.string(),
              minToolDiameter: z.number(),
              axes: z.number(),
            })
            .optional(),
          manualCut: z
            .object({
              toolReference: z.string(),
              maxCutWidth: z.number().optional(),
              maxCutDepth: z.number().optional(),
              cutTypes: z.array(z.string()),
            })
            .optional(),
          outsourced: z.boolean().optional(),
          outsourceNotes: z.string().optional(),
        })
        .optional()
        .describe('Manufacturing constraints from the assigned tool'),
      cadGenerationHint: z
        .string()
        .optional()
        .describe(
          'Detailed geometry description (3-8 sentences with exact mm dimensions, features, mating references)',
        ),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      message: z.string().optional(),
    }),
  }).server(async (input) => {
    const node = state.nodes.get(input.tempId)
    if (!node) {
      return { success: false, message: `Node ${input.tempId} not found` }
    }

    node.assignedToolId = input.assignedToolId
    if (input.manufacturingConstraints) {
      node.manufacturingConstraints = input.manufacturingConstraints as any
    }
    if (input.cadGenerationHint) {
      node.cadGenerationHint = input.cadGenerationHint
    }

    rebuildAndNotify()
    return { success: true }
  })

  const applyMechanismTemplate = toolDefinition({
    name: 'apply_mechanism_template',
    description:
      'Apply a parametric mechanism template to an assembly node. This generates dimensionally accurate, coordinated geometry for mechanical systems like gear trains. The child parts must already exist (created via propose_new_part). Do NOT set parametricSpec on mechanism children — the mechanism template handles their geometry.',
    inputSchema: z.object({
      tempId: z
        .string()
        .describe('Assembly/Phantom BOM node tempId (the parent)'),
      mechanismType: z
        .enum(['rack_and_pinion'] as [MechanismType])
        .describe('Type of mechanism to generate'),
      parameters: z
        .record(z.string(), z.number())
        .describe('Engineering parameters for the mechanism'),
      units: z
        .enum(['mm', 'in'])
        .default('mm')
        .describe('Unit system for parameters'),
      partMapping: z
        .array(
          z.object({
            role: z.string().describe('Role name (e.g., "rack", "pinion")'),
            childTempId: z
              .string()
              .describe('tempId of the child BOM node for this role'),
          }),
        )
        .describe('Maps mechanism output roles to child part tempIds'),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      message: z.string().optional(),
      computedMetadata: z.record(z.string(), z.unknown()).optional(),
    }),
  }).server(async (input) => {
    const node = state.nodes.get(input.tempId)
    if (!node) {
      return { success: false, message: `Node ${input.tempId} not found` }
    }

    // Validate children exist and are direct children of this node
    for (const mapping of input.partMapping) {
      const child = state.nodes.get(mapping.childTempId)
      if (!child) {
        return {
          success: false,
          message: `Child node ${mapping.childTempId} (role: ${mapping.role}) not found. Create parts with propose_new_part first.`,
        }
      }
      const isDirectChild = node.children.some(
        (c) => c.tempId === mapping.childTempId,
      )
      if (!isDirectChild) {
        return {
          success: false,
          message: `Node ${mapping.childTempId} (role: ${mapping.role}) is not a direct child of ${input.tempId}. Only direct children can be mapped.`,
        }
      }
    }

    // Validate mechanism parameters (hard reject on failure)
    const validation = validateMechanismParameters(
      input.mechanismType,
      input.parameters,
    )
    if (!validation.valid) {
      return {
        success: false,
        message: `Invalid mechanism parameters: ${validation.error}`,
      }
    }

    // Validate roles match the mechanism type
    const expectedRoles = getMechanismRoles(input.mechanismType)
    if (!expectedRoles) {
      return {
        success: false,
        message: `Unknown mechanism type: ${input.mechanismType}`,
      }
    }
    const providedRoles = input.partMapping.map((m) => m.role).sort()
    const expected = [...expectedRoles].sort()
    if (
      providedRoles.length !== expected.length ||
      !providedRoles.every((r, i) => r === expected[i])
    ) {
      return {
        success: false,
        message: `Mechanism ${input.mechanismType} requires roles [${expected.join(', ')}], got [${providedRoles.join(', ')}]`,
      }
    }

    // Apply mechanism template to the assembly node
    node.mechanismTemplate = {
      mechanismType: input.mechanismType,
      parameters: input.parameters,
      units: input.units ?? 'mm',
      partMapping: input.partMapping.map((m) => ({
        role: m.role,
        tempId: m.childTempId,
      })),
    }

    // Compute preview metadata for LLM feedback
    const preview = computeMechanismPreview(
      input.mechanismType,
      input.parameters,
    )

    rebuildAndNotify()
    return {
      success: true,
      message: `Applied ${input.mechanismType} mechanism template. Geometry will be generated during CAD generation stage.`,
      computedMetadata: preview,
    }
  })

  function rebuildAndNotify() {
    state.changeVersion++
    const bom = buildBomDraft(state)
    onUpdate(bom)
  }

  return [
    searchParts,
    lookupComponentCatalog,
    getExistingBom,
    getItemDetails,
    proposeNewPart,
    addExistingToBom,
    setBomParent,
    linkRequirementToPart,
    setPartInterfaces,
    setAssemblyInterfaceMappings,
    assignManufacturing,
    applyMechanismTemplate,
    askBomClarification,
  ]
}

function buildBomDraft(state: BomBuildState): BomDraft {
  const rootNode = state.rootTempId
    ? state.nodes.get(state.rootTempId)
    : undefined

  const defaultRoot: BomNodeDraft = {
    tempId: 'root-placeholder',
    name: 'Assembly (pending)',
    isNew: true,
    quantity: 1,
    children: [],
    requirementTempIds: [],
    rationale: '',
    confidence: 0,
  }

  // Build requirements coverage map
  const coverage: Record<string, Array<string>> = {}
  for (const node of state.nodes.values()) {
    for (const reqId of node.requirementTempIds) {
      if (!coverage[reqId]) coverage[reqId] = []
      coverage[reqId].push(node.tempId)
    }
  }

  return {
    rootAssembly: rootNode ?? defaultRoot,
    proposedParts: [...state.proposedParts],
    requirementsCoverage: coverage,
    uncoveredRequirements: [], // Will be populated during validation
    validationIssues: [],
  }
}
