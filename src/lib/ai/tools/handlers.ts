/**
 * AI Tool Handlers
 *
 * Server-side implementations for the AI tools.
 * Each handler uses existing services and is wrapped with permission checking.
 */

import { withPermissionAndAudit } from './permission-wrapper'
import type { ToolContext } from './permission-wrapper'
import { ImpactAssessmentService } from '@/lib/items/services/ImpactAssessmentService'
import { ItemService } from '@/lib/items/services/ItemService'
import { DesignService } from '@/lib/services/DesignService'
import { ProgramService } from '@/lib/services/ProgramService'
import { AccessControlService } from '@/lib/auth/AccessControlService'

/**
 * Helper to resolve a design identifier to a UUID.
 * Accepts either a UUID or a design code (e.g., "PC-PROTO").
 */
async function resolveDesignId(
  designIdOrCode: string | undefined,
): Promise<string | undefined> {
  if (!designIdOrCode) return undefined

  // Check if it's already a UUID (basic pattern check)
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (uuidPattern.test(designIdOrCode)) {
    return designIdOrCode
  }

  // Otherwise, treat as design code and look it up
  const design = await DesignService.getByCode(designIdOrCode)
  if (!design) {
    throw new Error(`Design not found: "${designIdOrCode}"`)
  }
  return design.id
}

/**
 * Helper to resolve a program identifier to a UUID.
 * Accepts either a UUID or a program code (e.g., "WIDGET").
 */
async function resolveProgramId(
  programIdOrCode: string | undefined,
): Promise<string | undefined> {
  if (!programIdOrCode) return undefined

  // Check if it's already a UUID (basic pattern check)
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (uuidPattern.test(programIdOrCode)) {
    return programIdOrCode
  }

  // Otherwise, treat as program code and look it up via search
  const result = await ProgramService.search({
    columnFilters: { code: programIdOrCode },
    limit: 1,
  })
  if (result.items.length === 0) {
    throw new Error(`Program not found: "${programIdOrCode}"`)
  }
  return result.items[0].id
}

// Input types for handlers - we manually apply defaults since TanStack AI
// doesn't apply Zod defaults when inferring types
interface SearchItemsInput {
  itemType?: 'Part' | 'Document' | 'ChangeOrder' | 'Requirement' | 'Task'
  query?: string
  state?: string
  designId?: string
  limit?: number
}

interface GetItemDetailsInput {
  id?: string
  itemNumber?: string
  revision?: string
}

interface GetBomInput {
  itemId: string
  depth?: number
}

interface GetWhereUsedInput {
  itemId: string
  maxDepth?: number
}

interface AnalyzeChangeImpactInput {
  itemId: string
  includeDocuments?: boolean
  includeRelatedChanges?: boolean
}

interface OfferNavigationInput {
  itemId: string
  itemNumber: string
  itemName?: string | null
  itemType:
    | 'Part'
    | 'Document'
    | 'ChangeOrder'
    | 'Requirement'
    | 'Task'
    | 'Design'
    | 'Program'
  tab?: 'details' | 'relationships' | 'history' | 'bom' | 'affected-items'
  label?: string
}

interface SearchProgramsInput {
  query?: string
  status?: 'Active' | 'On Hold' | 'Completed' | 'Cancelled'
  limit?: number
}

interface SearchDesignsInput {
  query?: string
  programId?: string
  designType?: 'Engineering' | 'Manufacturing' | 'Library' | 'Family'
  limit?: number
}

// ============================================================================
// search_items handler
// ============================================================================

export const searchItemsHandler = withPermissionAndAudit(
  'search_items',
  { resource: 'parts', action: 'read' },
  async (input: SearchItemsInput, context: ToolContext) => {
    // Apply defaults
    const limit = input.limit ?? 20

    // Resolve designId - accepts either UUID or design code (e.g., "PC-PROTO")
    const resolvedDesignId = await resolveDesignId(input.designId)

    // Access control: restrict to user's accessible designs
    const isAdmin = await AccessControlService.isGlobalAdmin(context.userId)
    let accessibleDesignIds: Array<string> | undefined
    if (!isAdmin) {
      const accessibleDesigns = await AccessControlService.getAccessibleDesigns(
        context.userId,
      )
      accessibleDesignIds = accessibleDesigns.map((d) => d.id)
    }

    // Validate explicit designId against access control
    if (resolvedDesignId && !isAdmin) {
      const hasAccess = await AccessControlService.canAccessDesign(
        context.userId,
        resolvedDesignId,
      )
      if (!hasAccess) {
        return { items: [], total: 0 }
      }
    }

    // If a text query is provided, use searchByItemNumber which searches both
    // itemNumber and name fields. Then filter by itemType/state afterward.
    // (ItemService.search doesn't implement text search yet)
    if (input.query && input.query.length >= 2) {
      const items = await ItemService.searchByItemNumber(input.query, {
        limit: limit * 2, // Fetch more to account for filtering
        currentOnly: true,
        itemTypes: input.itemType ? [input.itemType] : undefined,
        designIds: resolvedDesignId ? [resolvedDesignId] : accessibleDesignIds,
      })

      // Filter by state if specified
      let filtered = input.state
        ? items.filter((item) => item.state === input.state)
        : items

      // Apply limit after filtering
      filtered = filtered.slice(0, limit)

      return {
        items: filtered.map((item) => ({
          id: item.id,
          itemNumber: item.itemNumber,
          name: item.name ?? null,
          revision: item.revision,
          state: item.state,
          itemType: item.itemType,
          designId: item.designId ?? null,
        })),
        total: filtered.length,
      }
    }

    // No text query - use ItemService.search if itemType is specified
    if (input.itemType) {
      const result = await ItemService.search(input.itemType, {
        state: input.state,
        designId: resolvedDesignId,
        designIds: !resolvedDesignId ? accessibleDesignIds : undefined,
        limit,
      })

      return {
        items: result.items.map((item) => ({
          id: item.id,
          itemNumber: item.itemNumber,
          name: item.name ?? null,
          revision: item.revision,
          state: item.state,
          itemType: item.itemType,
          designId: item.designId ?? null,
        })),
        total: result.total,
      }
    }

    // No query and no itemType - return empty (need at least one filter)
    return {
      items: [],
      total: 0,
    }
  },
)

// ============================================================================
// get_item_details handler
// ============================================================================

export const getItemDetailsHandler = withPermissionAndAudit(
  'get_item_details',
  { resource: 'parts', action: 'read' },
  async (input: GetItemDetailsInput, _context: ToolContext) => {
    let item

    if (input.id) {
      item = await ItemService.findById(input.id)
    } else if (input.itemNumber) {
      item = await ItemService.findByNumber(input.itemNumber, input.revision)
    } else {
      throw new Error('Must provide either id or itemNumber')
    }

    if (!item) {
      throw new Error(
        input.id
          ? `Item with ID ${input.id} not found`
          : `Item ${input.itemNumber}${input.revision ? `-${input.revision}` : ''} not found`,
      )
    }

    // Separate base fields from type-specific fields
    const {
      id,
      masterId,
      itemNumber,
      name,
      revision,
      state,
      itemType,
      designId,
      createdAt,
      createdBy,
      modifiedAt,
      modifiedBy,
      ...typeSpecificData
    } = item

    return {
      id,
      masterId,
      itemNumber,
      name: name ?? null,
      revision,
      state,
      itemType,
      designId: designId ?? null,
      createdAt: createdAt?.toISOString() ?? new Date().toISOString(),
      createdBy,
      modifiedAt: modifiedAt?.toISOString() ?? new Date().toISOString(),
      modifiedBy,
      typeSpecificData:
        Object.keys(typeSpecificData).length > 0 ? typeSpecificData : undefined,
    }
  },
)

// ============================================================================
// get_bom handler
// ============================================================================

interface BomChild {
  itemId: string
  itemNumber: string
  name: string | null
  revision: string
  state: string
  itemType: string
  quantity?: number
  findNumber?: number
  referenceDesignator?: string
  depth: number
  children?: Array<BomChild>
}

export const getBomHandler = withPermissionAndAudit(
  'get_bom',
  { resource: 'parts', action: 'read' },
  async (input: GetBomInput, _context: ToolContext) => {
    // Apply defaults
    const depth = input.depth ?? 1

    // Get the parent item first
    const parentItem = await ItemService.findById(input.itemId)
    if (!parentItem) {
      throw new Error(`Item with ID ${input.itemId} not found`)
    }

    if (parentItem.itemType !== 'Part') {
      throw new Error(
        `BOM is only available for Parts. This item is a ${parentItem.itemType}.`,
      )
    }

    // Recursive function to build BOM tree
    const addChildren = async (
      parentId: string,
      currentDepth: number,
      visited: Set<string>,
    ): Promise<Array<BomChild>> => {
      if (currentDepth > depth || visited.has(parentId)) {
        return []
      }

      visited.add(parentId)

      const rels = await ItemService.getRelationshipsWithDetails(
        parentId,
        'BOM',
      )
      const result: Array<BomChild> = []

      for (const rel of rels) {
        if (!rel.targetItem) continue

        const childNode: BomChild = {
          itemId: rel.targetItem.id,
          itemNumber: rel.targetItem.itemNumber,
          name: rel.targetItem.name ?? null,
          revision: rel.targetItem.revision,
          state: rel.targetItem.state,
          itemType: rel.targetItem.itemType,
          quantity: rel.quantity ? Number(rel.quantity) : undefined,
          findNumber: rel.findNumber ?? undefined,
          referenceDesignator: rel.referenceDesignator ?? undefined,
          depth: currentDepth,
        }

        // Recursively get children if depth allows
        if (currentDepth < depth && rel.targetItem.itemType === 'Part') {
          const nestedChildren = await addChildren(
            rel.targetItem.id,
            currentDepth + 1,
            new Set(visited),
          )
          if (nestedChildren.length > 0) {
            childNode.children = nestedChildren
          }
        }

        result.push(childNode)
      }

      return result
    }

    // Build the tree starting from depth 1
    const bomTree = await addChildren(input.itemId, 1, new Set())

    // Count total components (flatten tree)
    const countComponents = (children: Array<BomChild>): number => {
      let count = children.length
      for (const child of children) {
        if (child.children) {
          count += countComponents(child.children)
        }
      }
      return count
    }

    return {
      parentItemNumber: parentItem.itemNumber,
      parentName: parentItem.name ?? null,
      children: bomTree,
      totalComponents: countComponents(bomTree),
    }
  },
)

// ============================================================================
// get_where_used handler
// ============================================================================

export const getWhereUsedHandler = withPermissionAndAudit(
  'get_where_used',
  { resource: 'parts', action: 'read' },
  async (input: GetWhereUsedInput, _context: ToolContext) => {
    // Apply defaults
    const maxDepth = input.maxDepth ?? 15

    // Get the target item first
    const targetItem = await ItemService.findById(input.itemId)
    if (!targetItem) {
      throw new Error(`Item with ID ${input.itemId} not found`)
    }

    // Use existing ImpactAssessmentService.findWhereUsed()
    const whereUsed = await ImpactAssessmentService.findWhereUsed(
      input.itemId,
      {
        maxDepth,
      },
    )

    return {
      itemNumber: targetItem.itemNumber,
      itemName: targetItem.name ?? null,
      whereUsed: whereUsed.map((node) => ({
        itemId: node.itemId,
        itemNumber: node.itemNumber,
        name: node.name,
        revision: node.revision,
        state: node.state,
        itemType: node.itemType,
        depth: node.depth,
        quantity: node.quantity,
        findNumber: node.findNumber,
        designId: node.designId ?? null,
        designCode: node.designCode ?? null,
        designName: node.designName ?? null,
      })),
      totalUsages: whereUsed.length,
    }
  },
)

// ============================================================================
// analyze_change_impact handler
// ============================================================================

interface Risk {
  severity: 'low' | 'medium' | 'high' | 'critical'
  category: string
  description: string
}

export const analyzeChangeImpactHandler = withPermissionAndAudit(
  'analyze_change_impact',
  { resource: 'parts', action: 'read' },
  async (input: AnalyzeChangeImpactInput, _context: ToolContext) => {
    // Apply defaults
    const includeDocuments = input.includeDocuments ?? true
    const includeRelatedChanges = input.includeRelatedChanges ?? true

    // Get the target item
    const item = await ItemService.findById(input.itemId)
    if (!item) {
      throw new Error(`Item with ID ${input.itemId} not found`)
    }

    // Get where-used data
    const whereUsed = await ImpactAssessmentService.findWhereUsed(
      input.itemId,
      {
        maxDepth: 15,
      },
    )

    // Calculate max depth
    const maxDepth = whereUsed.reduce(
      (max, node) => Math.max(max, node.depth),
      0,
    )

    // Get related documents if requested
    let relatedDocuments:
      | Array<{ id: string; itemNumber: string; name: string | null }>
      | undefined
    if (includeDocuments) {
      const docs = await ItemService.getRelated(input.itemId, 'Document')
      relatedDocuments = docs.map((doc) => ({
        id: doc.id,
        itemNumber: doc.itemNumber,
        name: doc.name ?? null,
      }))
    }

    // Get related change orders if requested
    let relatedChangeOrders:
      | Array<{ id: string; itemNumber: string; state: string }>
      | undefined
    if (includeRelatedChanges) {
      const impactedItemIds = whereUsed.map((node) => node.itemId)
      // Pass empty string for currentChangeOrderId since we're not in an ECO context
      const relatedChanges = await ImpactAssessmentService.findRelatedChanges(
        '',
        [input.itemId, ...impactedItemIds],
      )
      relatedChangeOrders = relatedChanges.map((co) => ({
        id: co.changeOrderId,
        itemNumber: co.itemNumber,
        state: co.state,
      }))
    }

    // Calculate risks
    const risks: Array<Risk> = []

    // High fan-out risk
    if (whereUsed.length > 50) {
      risks.push({
        severity: 'high',
        category: 'production',
        description: `High impact: item is used in ${whereUsed.length} assemblies`,
      })
    } else if (whereUsed.length > 20) {
      risks.push({
        severity: 'medium',
        category: 'production',
        description: `Moderate impact: item is used in ${whereUsed.length} assemblies`,
      })
    }

    // Deep hierarchy risk
    if (maxDepth > 7) {
      risks.push({
        severity: 'medium',
        category: 'production',
        description: `Change affects ${maxDepth} levels of assemblies`,
      })
    }

    // Document update risk
    if (relatedDocuments && relatedDocuments.length > 10) {
      risks.push({
        severity: 'medium',
        category: 'compliance',
        description: `${relatedDocuments.length} documents may need updating`,
      })
    }

    // Concurrent change risk
    if (relatedChangeOrders && relatedChangeOrders.length > 0) {
      risks.push({
        severity: 'critical',
        category: 'schedule',
        description: `Conflicts with ${relatedChangeOrders.length} active change orders`,
      })
    }

    // Cross-design risk
    const externalDesigns = new Set(
      whereUsed.filter((n) => n.designCode).map((n) => n.designCode),
    )
    if (externalDesigns.size > 0) {
      risks.push({
        severity: externalDesigns.size > 3 ? 'high' : 'medium',
        category: 'cross-design',
        description: `Item is used in ${externalDesigns.size} other design(s)`,
      })
    }

    // Calculate overall risk level
    const riskLevel: 'low' | 'medium' | 'high' | 'critical' = risks.some(
      (r) => r.severity === 'critical',
    )
      ? 'critical'
      : risks.some((r) => r.severity === 'high')
        ? 'high'
        : risks.some((r) => r.severity === 'medium')
          ? 'medium'
          : 'low'

    return {
      item: {
        itemNumber: item.itemNumber,
        name: item.name ?? null,
        revision: item.revision,
        state: item.state,
      },
      whereUsedCount: whereUsed.length,
      maxDepthAffected: maxDepth,
      affectedAssemblies: whereUsed.slice(0, 20).map((node) => ({
        itemId: node.itemId,
        itemNumber: node.itemNumber,
        name: node.name,
        depth: node.depth,
        state: node.state,
      })),
      relatedDocuments,
      relatedChangeOrders,
      risks,
      riskLevel,
    }
  },
)

// ============================================================================
// offer_navigation handler
// ============================================================================

/**
 * Route mapping for item types
 */
const ITEM_TYPE_ROUTES: Record<OfferNavigationInput['itemType'], string> = {
  Part: '/parts',
  Document: '/documents',
  ChangeOrder: '/change-orders',
  Requirement: '/requirements',
  Task: '/tasks',
  Design: '/designs',
  Program: '/programs',
}

export const offerNavigationHandler = withPermissionAndAudit(
  'offer_navigation',
  { resource: 'parts', action: 'read' },
  async (input: OfferNavigationInput, _context: ToolContext) => {
    // Validate item exists for most item types
    // Note: Programs and Designs have separate services but we'll skip validation
    // since this is just offering navigation, not accessing data
    if (
      input.itemType !== 'Program' &&
      input.itemType !== 'Design' &&
      input.itemType !== 'ChangeOrder'
    ) {
      const item = await ItemService.findById(input.itemId)
      if (!item) {
        throw new Error(`Item with ID ${input.itemId} not found`)
      }
    }

    // Build the navigation URL
    const baseRoute = ITEM_TYPE_ROUTES[input.itemType]
    let navigationUrl = `${baseRoute}/${input.itemId}`

    // Append tab as query param if specified
    if (input.tab) {
      navigationUrl += `?tab=${input.tab}`
    }

    return {
      navigationUrl,
      displayed: true,
    }
  },
)

// ============================================================================
// search_programs handler
// ============================================================================

export const searchProgramsHandler = withPermissionAndAudit(
  'search_programs',
  { resource: 'programs', action: 'read' },
  async (input: SearchProgramsInput, context: ToolContext) => {
    const limit = input.limit ?? 20

    // Get accessible program IDs for the current user
    const programIds = await AccessControlService.getAccessibleProgramIds(
      context.userId,
    )

    // Build search criteria
    const result = await ProgramService.search({
      globalSearch: input.query,
      columnFilters: input.status ? { status: input.status } : undefined,
      programIds,
      limit,
    })

    return {
      programs: result.items.map((program) => ({
        id: program.id,
        name: program.name,
        code: program.code,
        status: program.status,
        customer: program.customer ?? null,
        description: program.description ?? null,
      })),
      total: result.total,
    }
  },
)

// ============================================================================
// search_designs handler
// ============================================================================

export const searchDesignsHandler = withPermissionAndAudit(
  'search_designs',
  { resource: 'designs', action: 'read' },
  async (input: SearchDesignsInput, context: ToolContext) => {
    const limit = input.limit ?? 20

    // Get accessible program IDs for the current user
    const programIds = await AccessControlService.getAccessibleProgramIds(
      context.userId,
    )

    // Resolve programId input (could be UUID or program code)
    const resolvedProgramId = await resolveProgramId(input.programId)

    // If a specific program was requested, scope to just that program
    // (but still respect access control - if user can't access it, search returns empty)
    const scopedProgramIds = resolvedProgramId
      ? [resolvedProgramId]
      : programIds

    // Build column filters for designType if specified
    const columnFilters: Record<string, string> = {}
    if (input.designType) {
      columnFilters.designType = input.designType
    }

    const result = await DesignService.search({
      globalSearch: input.query,
      columnFilters:
        Object.keys(columnFilters).length > 0 ? columnFilters : undefined,
      programIds: scopedProgramIds,
      includeArchived: false,
      limit,
    })

    // Look up program names for the results
    const programNameCache = new Map<string, string>()
    for (const design of result.items) {
      if (design.programId && !programNameCache.has(design.programId)) {
        const program = await ProgramService.getById(design.programId)
        if (program) {
          programNameCache.set(design.programId, program.name)
        }
      }
    }

    return {
      designs: result.items.map((design) => ({
        id: design.id,
        name: design.name,
        code: design.code,
        designType: design.designType,
        programId: design.programId ?? null,
        programName: design.programId
          ? (programNameCache.get(design.programId) ?? null)
          : null,
        description: design.description ?? null,
      })),
      total: result.total,
    }
  },
)
