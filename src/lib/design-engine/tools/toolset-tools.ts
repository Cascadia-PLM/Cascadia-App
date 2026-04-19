/**
 * Toolset Establishment Stage Tools
 *
 * Tools available to the LLM during the toolset establishment stage.
 * Enables searching the user's tool library, adding tools to the session,
 * setting manufacturing scope, and asking clarification questions.
 */

import { toolDefinition } from '@tanstack/ai'
import { z } from 'zod'
import { and, eq, ilike, or } from 'drizzle-orm'
import type {
  DesignSessionToolset,
  ManufacturingScope,
  SessionTool,
} from '../types'
import { db } from '@/lib/db'
import { items, tools } from '@/lib/db/schema'

export interface ToolsetBuildState {
  scope: ManufacturingScope
  tools: Array<SessionTool>
  changeVersion: number
}

/** Create tool definitions for the toolset establishment stage */
export function createToolsetTools(
  _programId: string | undefined,
  onToolsetUpdate: (toolset: DesignSessionToolset) => void,
  onClarification: (
    questionId: string,
    question: string,
    options?: Array<string>,
  ) => void,
) {
  const state: ToolsetBuildState = {
    scope: 'unconstrained',
    tools: [],
    changeVersion: 0,
  }

  const emitUpdate = () => {
    state.changeVersion++
    onToolsetUpdate({
      scope: state.scope,
      tools: [...state.tools],
    })
  }

  const searchToolLibrary = toolDefinition({
    name: 'search_tool_library',
    description:
      "Search the user's tool library for manufacturing equipment, quality instruments, or utility devices. Returns tools with their capabilities.",
    inputSchema: z.object({
      query: z
        .string()
        .describe('Search query (e.g., "3D printer", "Prusa", "laser cutter")'),
      toolType: z
        .enum(['manufacturing', 'quality', 'utility'])
        .optional()
        .describe('Filter by tool type'),
      toolSubtype: z
        .string()
        .optional()
        .describe('Filter by subtype (e.g., "fdm_printer", "cnc_mill")'),
    }),
    outputSchema: z.object({
      tools: z.array(z.record(z.string(), z.unknown())),
      total: z.number(),
    }),
  }).server(async (input) => {
    const conditions = [
      eq(items.itemType, 'Tool'),
      eq(items.isCurrent, true),
      eq(items.isDeleted, false),
    ]

    // Search across name, manufacturer, model
    if (input.query) {
      const pattern = `%${input.query}%`
      conditions.push(
        or(
          ilike(items.name, pattern),
          ilike(tools.manufacturer, pattern),
          ilike(tools.model, pattern),
        )!,
      )
    }

    if (input.toolType) {
      conditions.push(eq(tools.toolType, input.toolType))
    }
    if (input.toolSubtype) {
      conditions.push(eq(tools.toolSubtype, input.toolSubtype))
    }

    const results = await db
      .select({
        id: items.id,
        itemNumber: items.itemNumber,
        name: items.name,
        state: items.state,
        toolType: tools.toolType,
        toolSubtype: tools.toolSubtype,
        manufacturer: tools.manufacturer,
        model: tools.model,
        capabilities: tools.capabilities,
        toolStatus: tools.toolStatus,
        location: tools.location,
        notes: tools.notes,
      })
      .from(items)
      .innerJoin(tools, eq(items.id, tools.itemId))
      .where(and(...conditions))
      .limit(20)

    // Only return active tools (toolStatus = available or in_use)
    const activeTools = results.filter(
      (t) => t.toolStatus === 'available' || t.toolStatus === 'in_use',
    )

    return {
      tools: activeTools as Array<Record<string, unknown>>,
      total: activeTools.length,
    }
  })

  const addSessionTool = toolDefinition({
    name: 'add_session_tool',
    description:
      "Add a tool to this design session's toolset. Provide either a toolItemId (from search_tool_library results) for a library tool, or an adhocTool object for equipment described by the user but not in the library.",
    inputSchema: z.object({
      toolItemId: z
        .string()
        .uuid()
        .optional()
        .describe('PLM item ID of the tool from the library'),
      adhocTool: z
        .object({
          name: z
            .string()
            .describe('Tool name (e.g., "Harbor Freight Drill Press")'),
          toolType: z
            .string()
            .describe('Tool type (manufacturing, quality, utility)'),
          toolSubtype: z
            .string()
            .describe('Subtype (e.g., "fdm_printer", "drill_press")'),
          capabilities: z
            .record(z.string(), z.unknown())
            .optional()
            .describe('Structured capabilities as described by the user'),
        })
        .optional()
        .describe('Ad-hoc tool not in the library'),
      source: z
        .enum(['prompt_detected', 'user_selected', 'user_freeform'])
        .describe('How this tool was identified'),
    }),
    outputSchema: z.object({
      sessionToolId: z.string(),
      added: z.boolean(),
      message: z.string().optional(),
    }),
  }).server(async (input) => {
    const sessionToolId = crypto.randomUUID()

    if (input.toolItemId) {
      // Look up the tool from the library
      const [result] = await db
        .select({
          id: items.id,
          itemNumber: items.itemNumber,
          name: items.name,
          toolType: tools.toolType,
          toolSubtype: tools.toolSubtype,
          manufacturer: tools.manufacturer,
          model: tools.model,
          capabilities: tools.capabilities,
        })
        .from(items)
        .innerJoin(tools, eq(items.id, tools.itemId))
        .where(eq(items.id, input.toolItemId))
        .limit(1)

      if (!result) {
        return {
          sessionToolId: '',
          added: false,
          message: 'Tool not found in library',
        }
      }

      // Check for duplicate
      if (state.tools.some((t) => t.toolItemId === input.toolItemId)) {
        return {
          sessionToolId: '',
          added: false,
          message: 'Tool already in session toolset',
        }
      }

      const sessionTool: SessionTool = {
        id: sessionToolId,
        toolItemId: result.id,
        toolItemNumber: result.itemNumber ?? undefined,
        name:
          result.name ??
          (result.manufacturer && result.model ? result.manufacturer + ' ' + result.model : undefined) ??
          'Unknown Tool',
        toolType: result.toolType ?? 'manufacturing',
        toolSubtype: result.toolSubtype ?? 'other',
        capabilities: (result.capabilities as Record<string, unknown>) ?? {},
        source: input.source,
      }

      state.tools.push(sessionTool)
      emitUpdate()
      return { sessionToolId, added: true }
    }

    if (input.adhocTool) {
      const sessionTool: SessionTool = {
        id: sessionToolId,
        adhocTool: {
          name: input.adhocTool.name,
          toolType: input.adhocTool.toolType,
          toolSubtype: input.adhocTool.toolSubtype,
          capabilities: input.adhocTool.capabilities ?? {},
        },
        name: input.adhocTool.name,
        toolType: input.adhocTool.toolType,
        toolSubtype: input.adhocTool.toolSubtype,
        capabilities: input.adhocTool.capabilities ?? {},
        source: input.source,
      }

      state.tools.push(sessionTool)
      emitUpdate()
      return { sessionToolId, added: true }
    }

    return {
      sessionToolId: '',
      added: false,
      message: 'Provide either toolItemId or adhocTool',
    }
  })

  const setManufacturingScope = toolDefinition({
    name: 'set_manufacturing_scope',
    description:
      'Set whether the design should be limited to in-house tools. "in_house_only" means all Manufacture parts must be producible with session tools. "in_house_preferred" allows outsourcing where necessary. "unconstrained" uses whatever methods make sense.',
    inputSchema: z.object({
      scope: z
        .enum(['in_house_only', 'in_house_preferred', 'unconstrained'])
        .describe('Manufacturing scope'),
    }),
    outputSchema: z.object({
      acknowledged: z.boolean(),
      scope: z.string(),
    }),
  }).server(async (input) => {
    state.scope = input.scope
    emitUpdate()
    return { acknowledged: true, scope: input.scope }
  })

  const askToolsetClarification = toolDefinition({
    name: 'ask_toolset_clarification',
    description:
      "Ask the user a question about their manufacturing capabilities, equipment, or preferences. Use this when the product description mentions manufacturing methods but you're unsure about specifics.",
    inputSchema: z.object({
      question: z
        .string()
        .describe(
          'The question to ask the user about their manufacturing setup',
        ),
      options: z
        .array(z.string())
        .optional()
        .describe('Optional list of suggested answers'),
    }),
    outputSchema: z.object({
      acknowledged: z.boolean(),
    }),
  }).server(async (input) => {
    const questionId = crypto.randomUUID()
    onClarification(questionId, input.question, input.options)
    return { acknowledged: true }
  })

  return {
    tools: [
      searchToolLibrary,
      addSessionTool,
      setManufacturingScope,
      askToolsetClarification,
    ],
    getState: () => state,
  }
}
