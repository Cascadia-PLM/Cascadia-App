// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Cascadia PLM MCP Server
 *
 * Publishes the PLM tool registry (`@/lib/ai/tools/registry`) over the
 * Model Context Protocol so external agents — Claude, IDE assistants,
 * other integrations — can search part data, walk BOMs, create ECOs, and
 * drive PLM workflows with the same tools, permission checks, and audit
 * logging as the in-app AI chatbot.
 *
 * A server instance is scoped to one authenticated user (and optionally a
 * narrowed API-key scope). The HTTP endpoint in `src/server/routes/mcp.ts`
 * creates one per request; every tool call runs through the registry
 * handlers, which enforce permissions and write `ai_usage_logs` rows.
 */

import { buildMcpServer } from './server-factory'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { ToolContext } from '@/lib/ai/tools'
import { toolsForSurface } from '@/lib/ai/tools/registry'

export const PLM_SERVER_NAME = 'cascadia-plm'
export const PLM_SERVER_VERSION = '1.0.0'

const SERVER_INSTRUCTIONS = `Cascadia PLM — Product Lifecycle Management tools.

Read tools (search_items, get_item_details, get_bom, get_where_used,
analyze_change_impact, search_programs, search_designs) answer questions
about parts, documents, BOMs, requirements, and change orders. Results are
scoped to what the authenticated user can access.

Write tools (create_item, update_item, create_relationship,
transition_item_state, create_change_order, create_program) use a two-step
confirmation flow: the first call returns { requiresConfirmation: true }
with a summary of what will happen and a single-use "confirmationToken".
Show the summary to the user, and only after they approve, repeat the exact
same call with that confirmationToken added. The token expires after a few
minutes, is bound to those exact parameters, and works once — changing any
parameter or reusing a token yields a fresh preview instead of executing.

Cascadia uses ECO-as-Branch versioning: released items in protected designs
cannot be modified directly. When a write tool responds with
suggestCreateEco, create a change order first (create_change_order), then
pass its changeOrderId to the write call.`

/**
 * Create an MCP server exposing the PLM tool registry for one
 * authenticated user context.
 */
export function createPlmMcpServer(context: ToolContext): Server {
  return buildMcpServer({
    name: PLM_SERVER_NAME,
    version: PLM_SERVER_VERSION,
    instructions: SERVER_INSTRUCTIONS,
    tools: toolsForSurface('mcp').map((entry) => ({
      name: entry.name,
      description: entry.description,
      inputSchema: entry.inputSchema,
      annotations: {
        readOnlyHint: entry.readOnly,
        // Every tool operates on the connected Cascadia instance only.
        openWorldHint: false,
      },
      execute: (input) => entry.invoke(input, context),
    })),
  })
}
