// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { describe, expect, it } from 'vitest'
import { createToolEventTracker } from './tool-event-tracker'

/** The start of a call: its id and name. */
function startChunk(toolCallId: string, toolCallName: string) {
  return { type: 'TOOL_CALL_START', toolCallId, toolCallName }
}

/** One fragment of a call's argument JSON. */
function argsChunk(toolCallId: string, delta: string) {
  return { type: 'TOOL_CALL_ARGS', toolCallId, delta }
}

/** A whole call: start plus its arguments in one fragment. */
function feedCall(
  t: ReturnType<typeof createToolEventTracker>,
  id: string,
  name: string,
  args: string,
) {
  t.handle(startChunk(id, name))
  t.handle(argsChunk(id, args))
  t.handle({ type: 'TOOL_CALL_END', toolCallId: id })
}

function resultChunk(toolCallId: string, content: string) {
  return { type: 'TOOL_CALL_RESULT', toolCallId, content }
}

/** `chat()` reports why a model turn ended under `metadata.tanstack`. */
function doneChunk(finishReason: string) {
  return { type: 'RUN_FINISHED', metadata: { tanstack: { finishReason } } }
}

describe('createToolEventTracker', () => {
  it('ignores non-tool chunks', () => {
    const t = createToolEventTracker()
    expect(t.handle({ type: 'TEXT_MESSAGE_CONTENT', delta: 'hi' })).toEqual([])
    expect(
      t.handle({ type: 'REASONING_MESSAGE_CONTENT', delta: '...' }),
    ).toEqual([])
    expect(t.handle('not even an object')).toEqual([])
  })

  it('reassembles incrementally streamed arguments and pairs the result', () => {
    const t = createToolEventTracker()
    // id + name arrive on the start event; args stream in pieces against the id.
    expect(t.handle(startChunk('c1', 'search_parts'))).toEqual([])
    expect(t.handle(argsChunk('c1', '{"query":'))).toEqual([])
    expect(t.handle(argsChunk('c1', '"bear'))).toEqual([])
    expect(t.handle(argsChunk('c1', 'ing"}'))).toEqual([])

    const events = t.handle(resultChunk('c1', '{"items":[],"total":2}'))
    expect(events).toEqual([
      {
        type: 'tool_call',
        toolName: 'search_parts',
        args: { query: 'bearing' },
      },
      {
        type: 'tool_result',
        toolName: 'search_parts',
        result: { items: [], total: 2 },
      },
    ])
  })

  it('emits the tool_call before its tool_result', () => {
    const t = createToolEventTracker()
    feedCall(t, 'c1', 'search_parts', '{}')
    const events = t.handle(resultChunk('c1', '{"total":0}'))
    expect(events.map((e) => e.type)).toEqual(['tool_call', 'tool_result'])
  })

  it('maps parallel calls to the correct result names', () => {
    const t = createToolEventTracker()
    feedCall(t, 'a', 'search_parts', '{"q":"x"}')
    feedCall(t, 'b', 'lookup_component_catalog', '{"q":"y"}')

    // The finished turn flushes both tool_call events, in call order.
    const flushed = t.handle(doneChunk('tool_calls'))
    expect(flushed.map((e) => e.type)).toEqual(['tool_call', 'tool_call'])

    const resA = t.handle(resultChunk('a', '{"total":1}'))
    const resB = t.handle(resultChunk('b', '{"total":2}'))
    expect(resA).toEqual([
      { type: 'tool_result', toolName: 'search_parts', result: { total: 1 } },
    ])
    expect(resB).toEqual([
      {
        type: 'tool_result',
        toolName: 'lookup_component_catalog',
        result: { total: 2 },
      },
    ])
  })

  it('does not emit a tool_call twice (finish flush + result flush)', () => {
    const t = createToolEventTracker()
    feedCall(t, 'a', 'search_parts', '{}')
    expect(t.handle(doneChunk('tool_calls')).map((e) => e.type)).toEqual([
      'tool_call',
    ])
    // The result must NOT re-emit the already-flushed tool_call.
    const events = t.handle(resultChunk('a', '{"total":0}'))
    expect(events.map((e) => e.type)).toEqual(['tool_result'])
  })

  it('ignores a finished turn that is not a tool round', () => {
    const t = createToolEventTracker()
    feedCall(t, 'a', 'search_parts', '{}')
    expect(t.handle(doneChunk('stop'))).toEqual([])
  })

  it('wraps non-object result payloads as { value }', () => {
    const t = createToolEventTracker()
    feedCall(t, 'a', 'get_item_details', '{}')
    const strResult = t.handle(resultChunk('a', '"just text"'))
    expect(strResult).toContainEqual({
      type: 'tool_result',
      toolName: 'get_item_details',
      result: { value: 'just text' },
    })
  })

  it('handles non-JSON result content gracefully', () => {
    const t = createToolEventTracker()
    feedCall(t, 'a', 'get_item_details', '{}')
    const events = t.handle(resultChunk('a', 'totally not json'))
    expect(events).toContainEqual({
      type: 'tool_result',
      toolName: 'get_item_details',
      result: { value: 'totally not json' },
    })
  })

  it('falls back to "unknown" when a result has no known tool_call', () => {
    const t = createToolEventTracker()
    const events = t.handle(resultChunk('ghost', '{"total":0}'))
    expect(events).toEqual([
      { type: 'tool_result', toolName: 'unknown', result: { total: 0 } },
    ])
  })

  it('reads a finish reason carried at the top level too', () => {
    // An adapter driven directly, and an event restored off the wire, carry
    // `finishReason` on the event itself rather than under metadata.
    const t = createToolEventTracker()
    feedCall(t, 'a', 'search_parts', '{}')
    const flushed = t.handle({
      type: 'RUN_FINISHED',
      finishReason: 'tool_calls',
    })
    expect(flushed.map((e) => e.type)).toEqual(['tool_call'])
  })
})
