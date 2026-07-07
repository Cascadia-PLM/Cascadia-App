/**
 * Tool-event tracker
 *
 * Translates the raw stream chunks emitted by TanStack AI's `chat()` into
 * design-engine `StageEvent`s of type `tool_call` / `tool_result`.
 *
 * Why this exists: the SDK streams tool arguments incrementally as JSON string
 * fragments (multiple `tool_call` chunks share an `index`), and `tool_result`
 * chunks carry only a `toolCallId` — never the tool name. This helper
 * reassembles the arguments, maps `toolCallId → name`, and emits one
 * `tool_call` event (with parsed args) immediately before its matching
 * `tool_result` event. Those events feed `wrapWithHistoryCapture` in
 * `engine.ts`, which is what populates `llmHistory` for the resume-time
 * `summarizeToolCalls` prompt.
 *
 * SDK chunk shapes (see `@tanstack/ai` `types.ts`):
 *   tool_call   → { type, index, toolCall: { id, function: { name, arguments } } }
 *   tool_result → { type, toolCallId, content }   (content = JSON.stringify(result))
 *   done        → { type, finishReason }           ('tool_calls' ends a round)
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

export function createToolEventTracker(): ToolEventTracker {
  // Accumulate incremental tool_call fragments, keyed by the SDK's `index`.
  const pending = new Map<number, PendingCall>()
  // Resolve a tool_result's `toolCallId` back to its tool name.
  const idToName = new Map<string, string>()
  // Guard against emitting the same tool_call twice (done-flush + result-flush).
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
    for (const index of Array.from(pending.keys())) {
      const entry = pending.get(index)
      if (!entry) continue
      const ev = emitCall(entry)
      if (ev) {
        events.push(ev)
        pending.delete(index)
      }
    }
    return events
  }

  /** Emit the tool_call for a specific id (so it precedes its result). */
  function flushForId(id: string): Array<StageEvent> {
    for (const index of Array.from(pending.keys())) {
      const entry = pending.get(index)
      if (!entry || entry.id !== id) continue
      const ev = emitCall(entry)
      pending.delete(index)
      return ev ? [ev] : []
    }
    return []
  }

  return {
    handle(chunk: unknown): Array<StageEvent> {
      if (!isRecord(chunk) || typeof chunk.type !== 'string') return []

      if (chunk.type === 'tool_call') {
        const toolCall = chunk.toolCall
        if (!isRecord(toolCall)) return []
        const index = typeof chunk.index === 'number' ? chunk.index : 0
        const entry = pending.get(index) ?? { id: '', name: '', args: '' }
        if (typeof toolCall.id === 'string' && toolCall.id) {
          entry.id = toolCall.id
        }
        const fn = toolCall.function
        if (isRecord(fn)) {
          if (typeof fn.name === 'string' && fn.name) entry.name = fn.name
          if (typeof fn.arguments === 'string') entry.args += fn.arguments
        }
        pending.set(index, entry)
        if (entry.id && entry.name) idToName.set(entry.id, entry.name)
        return []
      }

      if (chunk.type === 'done') {
        return chunk.finishReason === 'tool_calls' ? flushAll() : []
      }

      if (chunk.type === 'tool_result') {
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
