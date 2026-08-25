// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Shared MCP server plumbing.
 *
 * Both Cascadia MCP servers — the PLM end-use server (`./plm-server`) and
 * the dev/admin server (`./dev-server`) — are built from a flat list of
 * tool specs. This module owns the protocol mechanics: tools/list with
 * JSON Schema conversion, tools/call with Zod validation, and the
 * tool-error vs protocol-error distinction the MCP spec draws.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { Tool, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { safeErrorMessage } from '@/lib/errors/pg'

export interface McpToolSpec {
  name: string
  description: string
  /** Zod schema; converted to JSON Schema for tools/list, used to validate tools/call arguments. */
  inputSchema: z.ZodType
  /** Behavior hints surfaced to clients (readOnlyHint, destructiveHint, ...). */
  annotations?: ToolAnnotations
  /** Execute with validated input. Throwing reports a tool error (isError), not a protocol error. */
  execute: (input: unknown) => Promise<unknown>
}

/** JSON-serialize a tool result for the MCP text content block. */
function toText(result: unknown): string {
  if (typeof result === 'string') return result
  return JSON.stringify(result, null, 2)
}

export function buildMcpServer(options: {
  name: string
  version: string
  instructions: string
  tools: Array<McpToolSpec>
}): Server {
  const byName = new Map(options.tools.map((tool) => [tool.name, tool]))

  const server = new Server(
    { name: options.name, version: options.version },
    {
      capabilities: { tools: {} },
      instructions: options.instructions,
    },
  )

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: options.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.inputSchema, {
        io: 'input',
        target: 'draft-2020-12',
      }) as Tool['inputSchema'],
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name)
    if (!tool) {
      throw new McpError(
        ErrorCode.MethodNotFound,
        `Unknown tool: ${request.params.name}`,
      )
    }

    const parsed = tool.inputSchema.safeParse(request.params.arguments ?? {})
    if (!parsed.success) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid arguments for ${tool.name}: ${z.prettifyError(parsed.error)}`,
      )
    }

    try {
      const result = await tool.execute(parsed.data)
      const structured =
        typeof result === 'object' && result !== null && !Array.isArray(result)
          ? (result as Record<string, unknown>)
          : undefined
      return {
        content: [{ type: 'text', text: toText(result) }],
        ...(structured ? { structuredContent: structured } : {}),
      }
    } catch (error) {
      // Tool execution failures (permission denials, not-found, validation)
      // are reported as tool errors so the model can correct course, per
      // the MCP spec — not as protocol errors. A database failure is the one
      // kind the model cannot correct, and its message is the failed SQL and
      // every bound parameter, so it is replaced rather than forwarded.
      const message = safeErrorMessage(error, 'Tool execution failed')
      return {
        content: [{ type: 'text', text: message }],
        isError: true,
      }
    }
  })

  return server
}
