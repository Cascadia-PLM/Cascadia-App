/**
 * AI Tools Module
 *
 * Read-only and write tools for the AI chatbot.
 *
 * Read Tools:
 * - search_items: Search PLM items by type, query, and filters
 * - get_item_details: Get complete item details by ID or item number
 * - get_bom: Get Bill of Materials (children) for a part
 * - get_where_used: Find parent assemblies that use an item
 * - analyze_change_impact: Analyze impact of changing an item
 * - offer_navigation: Offer clickable navigation to item pages
 * - search_programs: Search programs by name, code, or customer
 * - search_designs: Search designs by name, code, or program
 *
 * Write Tools (require user confirmation):
 * - create_item: Create a new item (Part, Document, Requirement, Task)
 * - update_item: Update an existing item's properties
 * - create_relationship: Create BOM or Document relationships
 * - transition_item_state: Transition items through workflow states
 * - create_change_order: Create a new ECO for managing changes
 *
 * Usage:
 * ```typescript
 * import { createServerTools } from '@/lib/ai/tools'
 *
 * const tools = createServerTools({
 *   userId: user.id,
 *   sessionId: session.id,
 * })
 *
 * const stream = chat({
 *   adapter,
 *   messages,
 *   tools,
 * })
 * ```
 */

import {
  allToolDefinitions,
  analyzeChangeImpactDef,
  getBomDef,
  getItemDetailsDef,
  getWhereUsedDef,
  offerNavigationDef,
  searchDesignsDef,
  searchItemsDef,
  searchProgramsDef,
} from './definitions'

import {
  analyzeChangeImpactHandler,
  getBomHandler,
  getItemDetailsHandler,
  getWhereUsedHandler,
  offerNavigationHandler,
  searchDesignsHandler,
  searchItemsHandler,
  searchProgramsHandler,
} from './handlers'

import {
  allWriteToolDefinitions,
  createChangeOrderDef,
  createItemDef,
  createRelationshipDef,
  transitionItemStateDef,
  updateItemDef,
} from './write-definitions'

import {
  createChangeOrderHandler,
  createItemHandler,
  createRelationshipHandler,
  transitionItemStateHandler,
  updateItemHandler,
} from './write-handlers'

import { initiateCollaborativeDesignDef } from './design-engine-definitions'
import { initiateCollaborativeDesignHandler } from './design-engine-handlers'

import type { ToolContext } from './permission-wrapper'

// Re-export types and definitions for external use
export {
  allToolDefinitions,
  allWriteToolDefinitions,
  initiateCollaborativeDesignDef,
  type ToolContext,
}

/**
 * Create search-only tool implementations (no write tools, no BOM/impact analysis)
 *
 * Used for search mode in the chat panel - a lightweight tool set focused on
 * finding items quickly.
 */
export function createSearchTools(context: ToolContext) {
  return [
    searchItemsDef.server((input) => searchItemsHandler(input, context)),
    getItemDetailsDef.server((input) => getItemDetailsHandler(input, context)),
    offerNavigationDef.server((input) =>
      offerNavigationHandler(input, context),
    ),
    searchProgramsDef.server((input) => searchProgramsHandler(input, context)),
    searchDesignsDef.server((input) => searchDesignsHandler(input, context)),
  ]
}

// Re-export individual definitions for type inference on client
export {
  searchItemsDef,
  getItemDetailsDef,
  getBomDef,
  getWhereUsedDef,
  analyzeChangeImpactDef,
  offerNavigationDef,
  searchProgramsDef,
  searchDesignsDef,
  createItemDef,
  updateItemDef,
  createRelationshipDef,
  transitionItemStateDef,
  createChangeOrderDef,
}

/**
 * Create server-side tool implementations with permission context
 *
 * This factory creates bound tool handlers that include user context
 * for permission checking and audit logging.
 *
 * @param context - User context for permission checking and audit logging
 * @returns Array of server tool implementations to pass to chat()
 */
export function createServerTools(context: ToolContext) {
  // Read-only tools
  const searchItems = searchItemsDef.server((input) =>
    searchItemsHandler(input, context),
  )

  const getItemDetails = getItemDetailsDef.server((input) =>
    getItemDetailsHandler(input, context),
  )

  const getBom = getBomDef.server((input) => getBomHandler(input, context))

  const getWhereUsed = getWhereUsedDef.server((input) =>
    getWhereUsedHandler(input, context),
  )

  const analyzeChangeImpact = analyzeChangeImpactDef.server((input) =>
    analyzeChangeImpactHandler(input, context),
  )

  const offerNavigation = offerNavigationDef.server((input) =>
    offerNavigationHandler(input, context),
  )

  const searchPrograms = searchProgramsDef.server((input) =>
    searchProgramsHandler(input, context),
  )

  const searchDesigns = searchDesignsDef.server((input) =>
    searchDesignsHandler(input, context),
  )

  // Write tools (require user confirmation)
  const createItem = createItemDef.server((input) =>
    createItemHandler(input, context),
  )

  const updateItem = updateItemDef.server((input) =>
    updateItemHandler(input, context),
  )

  const createRelationship = createRelationshipDef.server((input) =>
    createRelationshipHandler(input, context),
  )

  const transitionItemState = transitionItemStateDef.server((input) =>
    transitionItemStateHandler(input, context),
  )

  const createChangeOrder = createChangeOrderDef.server((input) =>
    createChangeOrderHandler(input, context),
  )

  // Design engine tools
  const initiateCollaborativeDesign = initiateCollaborativeDesignDef.server(
    (input) => initiateCollaborativeDesignHandler(input, context),
  )

  return [
    // Read tools
    searchItems,
    getItemDetails,
    getBom,
    getWhereUsed,
    analyzeChangeImpact,
    offerNavigation,
    searchPrograms,
    searchDesigns,
    // Write tools
    createItem,
    updateItem,
    createRelationship,
    transitionItemState,
    createChangeOrder,
    // Design engine
    initiateCollaborativeDesign,
  ]
}
