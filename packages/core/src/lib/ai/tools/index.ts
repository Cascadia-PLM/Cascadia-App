// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * AI Tools Module
 *
 * Assistant-facing PLM tools, shared between the in-app chatbot and the
 * MCP server. The canonical list lives in `./registry.ts` — this module
 * binds registry entries into TanStack AI server tools for the chatbot.
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
 * - create_program: Create a new program (creator becomes admin)
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
  allWriteToolDefinitions,
  createChangeOrderDef,
  createItemDef,
  createProgramDef,
  createRelationshipDef,
  transitionItemStateDef,
  updateItemDef,
} from './write-definitions'

import { toolRegistry, toolsForSurface } from './registry'

import type { ToolContext } from './permission-wrapper'

// Re-export types and definitions for external use
export {
  allToolDefinitions,
  allWriteToolDefinitions,
  toolRegistry,
  toolsForSurface,
  type ToolContext,
}
export type { ToolRegistryEntry, ToolSurface } from './registry'

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
  createProgramDef,
}

/**
 * Create search-only tool implementations (no write tools, no BOM/impact analysis)
 *
 * Used for search mode in the chat panel - a lightweight tool set focused on
 * finding items quickly.
 */
export function createSearchTools(context: ToolContext) {
  return toolsForSurface('search').map((entry) => entry.bind(context))
}

/**
 * Create server-side tool implementations with permission context
 *
 * Binds every registry entry exposed on the `chat` surface to the given
 * user context for permission checking and audit logging.
 *
 * @param context - User context for permission checking and audit logging
 * @returns Array of server tool implementations to pass to chat()
 */
export function createServerTools(context: ToolContext) {
  return toolsForSurface('chat').map((entry) => entry.bind(context))
}
