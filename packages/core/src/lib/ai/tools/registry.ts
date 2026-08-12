// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * PLM Tool Registry
 *
 * The single source of truth for the assistant-facing PLM tools. Every tool
 * is defined once here — with its TanStack AI definition, its context-bound
 * handler, and the surfaces it is exposed on — and consumed by two frontends:
 *
 * - The in-app AI chatbot (`createServerTools()` / `createSearchTools()` in
 *   `./index.ts`) binds entries into TanStack AI server tools.
 * - The MCP server (`@/lib/mcp/plm-server`) publishes entries as MCP tools
 *   for external agents (Claude, IDE agents, other integrations).
 *
 * Adding a tool: define it in `definitions.ts`/`write-definitions.ts`, write
 * its handler, then append one entry below. Both surfaces pick it up.
 */

import {
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
  createChangeOrderDef,
  createItemDef,
  createProgramDef,
  createRelationshipDef,
  transitionItemStateDef,
  updateItemDef,
} from './write-definitions'
import {
  createChangeOrderHandler,
  createItemHandler,
  createProgramHandler,
  createRelationshipHandler,
  transitionItemStateHandler,
  updateItemHandler,
} from './write-handlers'
import type { z } from 'zod'
import type { ServerTool } from '@tanstack/ai'
import type { ToolContext } from './permission-wrapper'

/**
 * Surfaces a tool can be exposed on:
 * - `chat`: the in-app chatbot's full tool set
 * - `search`: the in-app chat panel's lightweight search mode
 * - `mcp`: the MCP server for external agents
 *
 * UI-coupled tools (navigation offers, launching in-app workspaces) are
 * deliberately not exposed over MCP — they only make sense inside the SPA.
 */
export type ToolSurface = 'chat' | 'search' | 'mcp'

export interface ToolRegistryEntry {
  /** Tool name as exposed to models (matches the definition's name). */
  name: string
  /** Model-facing description from the definition. */
  description: string
  /** Zod input schema from the definition (used for MCP validation). */
  inputSchema: z.ZodType
  /** True when the tool never mutates PLM data. */
  readOnly: boolean
  /** Which assistant surfaces expose this tool. */
  surfaces: ReadonlyArray<ToolSurface>
  /** Bind into a TanStack AI server tool for the in-app chatbot. */
  bind: (context: ToolContext) => ServerTool
  /**
   * Invoke the handler directly (MCP path). `input` must already have been
   * validated with `inputSchema` — parse before calling. The handlers apply
   * their own permission checks and audit logging, so this is safe to call
   * from any surface that provides an authenticated ToolContext.
   */
  invoke: (input: unknown, context: ToolContext) => Promise<unknown>
}

/**
 * Narrow a definition's optional input schema to a definite one.
 * Every tool definition in this module declares an input schema; the
 * optionality only exists in TanStack AI's ToolDefinition type.
 *
 * Exported because a module contributing a tool needs it to build its entry.
 */
export function schemaOf(def: {
  name: string
  inputSchema?: z.ZodType
}): z.ZodType {
  if (!def.inputSchema) {
    throw new Error(`Tool "${def.name}" has no input schema`)
  }
  return def.inputSchema
}

// The `input as never` casts below hand pre-validated input (parsed with the
// entry's own inputSchema) to handlers whose parameter types the registry
// erases. Each cast is adjacent to the schema that validated the input.

const entries: Array<ToolRegistryEntry> = [
  // ── Read tools ────────────────────────────────────────────────────────
  {
    name: searchItemsDef.name,
    description: searchItemsDef.description,
    inputSchema: schemaOf(searchItemsDef),
    readOnly: true,
    surfaces: ['chat', 'search', 'mcp'],
    bind: (context) =>
      searchItemsDef.server((input) => searchItemsHandler(input, context)),
    invoke: (input, context) => searchItemsHandler(input as never, context),
  },
  {
    name: getItemDetailsDef.name,
    description: getItemDetailsDef.description,
    inputSchema: schemaOf(getItemDetailsDef),
    readOnly: true,
    surfaces: ['chat', 'search', 'mcp'],
    bind: (context) =>
      getItemDetailsDef.server((input) =>
        getItemDetailsHandler(input, context),
      ),
    invoke: (input, context) => getItemDetailsHandler(input as never, context),
  },
  {
    name: getBomDef.name,
    description: getBomDef.description,
    inputSchema: schemaOf(getBomDef),
    readOnly: true,
    surfaces: ['chat', 'mcp'],
    bind: (context) =>
      getBomDef.server((input) => getBomHandler(input, context)),
    invoke: (input, context) => getBomHandler(input as never, context),
  },
  {
    name: getWhereUsedDef.name,
    description: getWhereUsedDef.description,
    inputSchema: schemaOf(getWhereUsedDef),
    readOnly: true,
    surfaces: ['chat', 'mcp'],
    bind: (context) =>
      getWhereUsedDef.server((input) => getWhereUsedHandler(input, context)),
    invoke: (input, context) => getWhereUsedHandler(input as never, context),
  },
  {
    name: analyzeChangeImpactDef.name,
    description: analyzeChangeImpactDef.description,
    inputSchema: schemaOf(analyzeChangeImpactDef),
    readOnly: true,
    surfaces: ['chat', 'mcp'],
    bind: (context) =>
      analyzeChangeImpactDef.server((input) =>
        analyzeChangeImpactHandler(input, context),
      ),
    invoke: (input, context) =>
      analyzeChangeImpactHandler(input as never, context),
  },
  {
    name: offerNavigationDef.name,
    description: offerNavigationDef.description,
    inputSchema: schemaOf(offerNavigationDef),
    readOnly: true,
    // UI affordance: renders a clickable button in the chat panel.
    surfaces: ['chat', 'search'],
    bind: (context) =>
      offerNavigationDef.server((input) =>
        offerNavigationHandler(input, context),
      ),
    invoke: (input, context) => offerNavigationHandler(input as never, context),
  },
  {
    name: searchProgramsDef.name,
    description: searchProgramsDef.description,
    inputSchema: schemaOf(searchProgramsDef),
    readOnly: true,
    surfaces: ['chat', 'search', 'mcp'],
    bind: (context) =>
      searchProgramsDef.server((input) =>
        searchProgramsHandler(input, context),
      ),
    invoke: (input, context) => searchProgramsHandler(input as never, context),
  },
  {
    name: searchDesignsDef.name,
    description: searchDesignsDef.description,
    inputSchema: schemaOf(searchDesignsDef),
    readOnly: true,
    surfaces: ['chat', 'search', 'mcp'],
    bind: (context) =>
      searchDesignsDef.server((input) => searchDesignsHandler(input, context)),
    invoke: (input, context) => searchDesignsHandler(input as never, context),
  },

  // ── Write tools (two-step confirmation built into the handlers) ──────
  {
    name: createItemDef.name,
    description: createItemDef.description,
    inputSchema: schemaOf(createItemDef),
    readOnly: false,
    surfaces: ['chat', 'mcp'],
    bind: (context) =>
      createItemDef.server((input) => createItemHandler(input, context)),
    invoke: (input, context) => createItemHandler(input as never, context),
  },
  {
    name: updateItemDef.name,
    description: updateItemDef.description,
    inputSchema: schemaOf(updateItemDef),
    readOnly: false,
    surfaces: ['chat', 'mcp'],
    bind: (context) =>
      updateItemDef.server((input) => updateItemHandler(input, context)),
    invoke: (input, context) => updateItemHandler(input as never, context),
  },
  {
    name: createRelationshipDef.name,
    description: createRelationshipDef.description,
    inputSchema: schemaOf(createRelationshipDef),
    readOnly: false,
    surfaces: ['chat', 'mcp'],
    bind: (context) =>
      createRelationshipDef.server((input) =>
        createRelationshipHandler(input, context),
      ),
    invoke: (input, context) =>
      createRelationshipHandler(input as never, context),
  },
  {
    name: transitionItemStateDef.name,
    description: transitionItemStateDef.description,
    inputSchema: schemaOf(transitionItemStateDef),
    readOnly: false,
    surfaces: ['chat', 'mcp'],
    bind: (context) =>
      transitionItemStateDef.server((input) =>
        transitionItemStateHandler(input, context),
      ),
    invoke: (input, context) =>
      transitionItemStateHandler(input as never, context),
  },
  {
    name: createChangeOrderDef.name,
    description: createChangeOrderDef.description,
    inputSchema: schemaOf(createChangeOrderDef),
    readOnly: false,
    surfaces: ['chat', 'mcp'],
    bind: (context) =>
      createChangeOrderDef.server((input) =>
        createChangeOrderHandler(input, context),
      ),
    invoke: (input, context) =>
      createChangeOrderHandler(input as never, context),
  },
  {
    name: createProgramDef.name,
    description: createProgramDef.description,
    inputSchema: schemaOf(createProgramDef),
    readOnly: false,
    surfaces: ['chat', 'mcp'],
    bind: (context) =>
      createProgramDef.server((input) => createProgramHandler(input, context)),
    invoke: (input, context) => createProgramHandler(input as never, context),
  },
]

/**
 * Every tool this instance exposes: core's, plus whatever modules contributed.
 *
 * The same array throughout — `registerTool` appends to it, so a consumer that
 * captured the reference still sees contributions. That only works because
 * registration happens at boot, before the first read; see the ordering note in
 * `src/server/dev.ts`.
 */
export const toolRegistry: ReadonlyArray<ToolRegistryEntry> = entries

/**
 * Contribute a tool. Called from a composition root, never from core.
 *
 * Names must be unique: they are what a model sees and calls, so two entries
 * sharing one would make dispatch ambiguous in a way that surfaces as a
 * mysteriously wrong answer rather than an error.
 */
export function registerTool(entry: ToolRegistryEntry): void {
  const clash = entries.find((e) => e.name === entry.name)
  if (clash) {
    throw new Error(`Tool "${entry.name}" is already registered`)
  }
  entries.push(entry)
}

/**
 * How many tools core itself ships. Captured at module load, immediately after
 * the literal above and before any module can register, so it is the exact
 * boundary between core's entries and contributed ones.
 */
const CORE_TOOL_COUNT = entries.length

/** Drop contributed tools, keeping core's. Tests only. */
export function resetContributedTools(): void {
  entries.length = CORE_TOOL_COUNT
}

/** Registry entries exposed on a given surface. */
export function toolsForSurface(
  surface: ToolSurface,
): Array<ToolRegistryEntry> {
  return toolRegistry.filter((entry) => entry.surfaces.includes(surface))
}
