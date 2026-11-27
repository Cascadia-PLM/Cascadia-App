// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Toolset Establishment Stage Tools
 *
 * Tools available to the LLM during the toolset establishment stage.
 * Enables searching the user's tool library, adding tools to the session,
 * setting manufacturing scope, and asking clarification questions.
 */

import { toolDefinition } from '@tanstack/ai'
import { z } from 'zod'
import { and, eq, ilike, notInArray, or, sql } from 'drizzle-orm'
import { toolErrorMessage } from './tool-utils'
import type {
  DesignSessionToolset,
  ManufacturingScope,
  SessionTool,
} from '../types'
import { db } from '@/db'
import { notDeleted } from '@/db/filters'
import { likeContains } from '@/db/like-pattern'
import { items, tools } from '@/db/schema'
import { LifecycleService } from '@/services/LifecycleService'

/**
 * Rows returned to the model per `search_tool_library` call. Bounded because
 * the result is serialized into the LLM's context, not because more could not
 * be fetched — `total` reports the full match count alongside it so the model
 * can tell a slice from the whole library.
 */
const TOOL_SEARCH_LIMIT = 20

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
    multiSelect?: boolean,
  ) => void,
  initialToolset?: DesignSessionToolset,
) {
  // Seed from any existing toolset so a resumed stage accumulates onto prior
  // tools/scope instead of replacing them. Every mutation emits the full set,
  // so an empty seed on resume would wipe tools added before the pause.
  const state: ToolsetBuildState = {
    scope: initialToolset?.scope ?? 'unconstrained',
    tools: initialToolset ? [...initialToolset.tools] : [],
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
      error: z.string().optional(),
    }),
  }).server(async (input) => {
    try {
      const conditions = [
        eq(items.itemType, 'Tool'),
        eq(items.isCurrent, true),
        notDeleted(),
      ]

      // Search across name, manufacturer, model
      if (input.query) {
        const pattern = likeContains(input.query)
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

      // A design plans around tools that are in service: past their initial
      // state (a Draft tool is not yet real) and short of a final one
      // (retirement removes the capability; a tool in maintenance returns).
      // Excluded in SQL rather than after the row limit — filtering the page
      // instead meant a shop whose most recent tools are retired could be
      // reported as owning almost nothing.
      const [initialStates, finalStates] = await Promise.all([
        LifecycleService.getLifecycleForItemType('Tool').then(
          (lc) => lc?.states.filter((s) => s.isInitial).map((s) => s.id) ?? [],
        ),
        LifecycleService.getFinalStateIds('Tool'),
      ])
      const excluded = [...initialStates, ...finalStates]
      if (excluded.length > 0) {
        conditions.push(notInArray(items.state, excluded))
      }

      const [results, countRows] = await Promise.all([
        db
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
            location: tools.location,
            notes: tools.notes,
          })
          .from(items)
          .innerJoin(tools, eq(items.id, tools.itemId))
          .where(and(...conditions))
          .limit(TOOL_SEARCH_LIMIT),
        db
          .select({ count: sql<number>`count(*)` })
          .from(items)
          .innerJoin(tools, eq(items.id, tools.itemId))
          .where(and(...conditions)),
      ])

      // `total` counts every match, not the rows returned — the model needs to
      // know when it is looking at a slice so it can narrow its query rather
      // than conclude the shop owns only what it can see.
      return {
        tools: results,
        total: Number(countRows[0]?.count ?? results.length),
      }
    } catch (err) {
      return { tools: [], total: 0, error: toolErrorMessage(err) }
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
        toolItemNumber: result.itemNumber,
        name:
          result.name ??
          (result.manufacturer && result.model
            ? result.manufacturer + ' ' + result.model
            : undefined) ??
          'Unknown Tool',
        toolType: result.toolType ?? 'manufacturing',
        toolSubtype: result.toolSubtype ?? 'other',
        capabilities: result.capabilities ?? {},
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
  }).server((input) => {
    state.scope = input.scope
    emitUpdate()
    return { acknowledged: true, scope: input.scope }
  })

  const askToolsetClarification = toolDefinition({
    name: 'ask_toolset_clarification',
    description:
      'Ask the user a question about their manufacturing capabilities, equipment, or preferences. Use this when the product description mentions manufacturing methods but you\'re unsure about specifics. ALWAYS provide `options` when the answer is a known choice from a finite set (yes/no, list of tools, list of processes). Set `multiSelect: true` when more than one option can apply (e.g., "which of these tools do you have?"). Set `multiSelect: false` (or omit) when exactly one option should be picked.',
    inputSchema: z.object({
      question: z
        .string()
        .describe(
          'The question to ask the user about their manufacturing setup. Keep it concise — the UI will render the options separately, so do not embed an inline list of choices in the question text.',
        ),
      options: z
        .array(z.string())
        .optional()
        .describe(
          'Suggested answers, presented as buttons or checkboxes. Provide these whenever the answer is a known choice from a finite set.',
        ),
      multiSelect: z
        .boolean()
        .optional()
        .describe(
          'True when the user can pick more than one option ("select all that apply"). Defaults to false (single choice).',
        ),
    }),
    outputSchema: z.object({
      acknowledged: z.boolean(),
    }),
  }).server((input) => {
    const questionId = crypto.randomUUID()
    onClarification(
      questionId,
      input.question,
      input.options,
      input.multiSelect,
    )
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
