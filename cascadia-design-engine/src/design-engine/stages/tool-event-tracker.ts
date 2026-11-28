// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Tool-event tracker
 *
 * Translates the raw stream chunks emitted by TanStack AI's `chat()` into
 * design-engine `StageEvent`s of type `tool_call` / `tool_result`.
 *
 * Why this exists: the SDK streams a tool call as a start event (id and name),
 * argument fragments against that id, and an end event — and the result that
 * follows carries only the `toolCallId`, never the tool name. This helper
 * reassembles the arguments, maps `toolCallId → name`, and emits one
 * `tool_call` event (with parsed args) immediately before its matching
 * `tool_result` event. Those events feed `wrapWithHistoryCapture` in
 * `engine.ts`, which is what populates `llmHistory` for the resume-time
 * `summarizeToolCalls` prompt.
 *
 * SDK event shapes (AG-UI, see `@tanstack/ai` `types.ts`):
 *   TOOL_CALL_START  → { type, toolCallId, toolCallName }
 *   TOOL_CALL_ARGS   → { type, toolCallId, delta }        (a JSON fragment)
 *   TOOL_CALL_RESULT → { type, toolCallId, content }      (JSON.stringify(result))
 *   RUN_FINISHED     → { type, metadata.tanstack.finishReason }
 *                      ('tool_calls' ends a round; one per model turn)
 */

import type { StageEvent } from '../types'

interface PendingCall {
  id: string
  name: string
  args: string
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** Parse accumulated argument fragments into an object (empty on failure). */
function parseArgs(raw: string): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** Parse a tool_result payload; wrap non-object results as `{ value }`. */
function parseResult(content: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(content)
    return isRecord(parsed) ? parsed : { value: parsed }
  } catch {
    return { value: content }
  }
}

export interface ToolEventTracker {
  /** Feed one raw SDK chunk; returns 0+ StageEvents to yield for it. */
  handle: (chunk: unknown) => Array<StageEvent>
}

/**
 * Why a model turn ended. `chat()` reports it under `metadata.tanstack`; an
 * adapter driven directly, and an event restored off the wire, carry it at
 * the top level.
 */
export function finishReasonOf(chunk: Record<string, unknown>): unknown {
  if (chunk.finishReason !== undefined) return chunk.finishReason
  const metadata = chunk.metadata
  const tanstack = isRecord(metadata) ? metadata.tanstack : undefined
  return isRecord(tanstack) ? tanstack.finishReason : undefined
}

export function createToolEventTracker(): ToolEventTracker {
  // Accumulate argument fragments, keyed by the call id. A Map iterates in
  // insertion order, which is the order the model made the calls in.
  const pending = new Map<string, PendingCall>()
  // Resolve a tool_result's `toolCallId` back to its tool name.
  const idToName = new Map<string, string>()
  // Guard against emitting the same tool_call twice (finish-flush + result-flush).
  const emitted = new Set<string>()

  function emitCall(entry: PendingCall): StageEvent | null {
    if (!entry.id || !entry.name) return null
    if (emitted.has(entry.id)) return null
    emitted.add(entry.id)
    idToName.set(entry.id, entry.name)
    return {
      type: 'tool_call',
      toolName: entry.name,
      args: parseArgs(entry.args),
    }
  }

  /** Emit tool_call events for every complete pending entry. */
  function flushAll(): Array<StageEvent> {
    const events: Array<StageEvent> = []
    for (const [id, entry] of Array.from(pending)) {
      const ev = emitCall(entry)
      if (ev) {
        events.push(ev)
        pending.delete(id)
      }
    }
    return events
  }

  /** Emit the tool_call for a specific id (so it precedes its result). */
  function flushForId(id: string): Array<StageEvent> {
    const entry = pending.get(id)
    if (!entry) return []
    pending.delete(id)
    const ev = emitCall(entry)
    return ev ? [ev] : []
  }

  return {
    handle(chunk: unknown): Array<StageEvent> {
      if (!isRecord(chunk) || typeof chunk.type !== 'string') return []

      if (chunk.type === 'TOOL_CALL_START') {
        const id = typeof chunk.toolCallId === 'string' ? chunk.toolCallId : ''
        const name =
          typeof chunk.toolCallName === 'string' ? chunk.toolCallName : ''
        if (!id) return []
        pending.set(id, { id, name, args: '' })
        if (name) idToName.set(id, name)
        return []
      }

      if (chunk.type === 'TOOL_CALL_ARGS') {
        const entry =
          typeof chunk.toolCallId === 'string'
            ? pending.get(chunk.toolCallId)
            : undefined
        if (entry && typeof chunk.delta === 'string') entry.args += chunk.delta
        return []
      }

      if (chunk.type === 'RUN_FINISHED') {
        return finishReasonOf(chunk) === 'tool_calls' ? flushAll() : []
      }

      if (chunk.type === 'TOOL_CALL_RESULT') {
        const toolCallId =
          typeof chunk.toolCallId === 'string' ? chunk.toolCallId : ''
        // Ensure the matching tool_call is emitted before its result.
        const events = toolCallId ? flushForId(toolCallId) : []
        const content =
          typeof chunk.content === 'string'
            ? chunk.content
            : JSON.stringify(chunk.content ?? null)
        events.push({
          type: 'tool_result',
          toolName: idToName.get(toolCallId) ?? 'unknown',
          result: parseResult(content),
        })
        return events
      }

      return []
    },
  }
}
