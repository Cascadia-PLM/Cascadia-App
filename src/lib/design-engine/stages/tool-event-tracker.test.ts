import { describe, expect, it } from 'vitest'
import { createToolEventTracker } from './tool-event-tracker'

function callChunk(index: number, id: string, name: string, args: string) {
  return {
    type: 'tool_call',
    index,
    toolCall: { id, type: 'function', function: { name, arguments: args } },
  }
}

function resultChunk(toolCallId: string, content: string) {
  return { type: 'tool_result', toolCallId, content }
}

function doneChunk(finishReason: string) {
  return { type: 'done', finishReason }
}

describe('createToolEventTracker', () => {
  it('ignores non-tool chunks', () => {
    const t = createToolEventTracker()
    expect(t.handle({ type: 'content', content: 'hi' })).toEqual([])
    expect(t.handle({ type: 'thinking', content: '...' })).toEqual([])
    expect(t.handle('not even an object')).toEqual([])
  })

  it('reassembles incrementally streamed arguments and pairs the result', () => {
    const t = createToolEventTracker()
    // id + name arrive on the first fragment; args stream in pieces (same index).
    expect(t.handle(callChunk(0, 'c1', 'search_parts', '{"query":'))).toEqual([])
    expect(t.handle(callChunk(0, '', '', '"bear'))).toEqual([])
    expect(t.handle(callChunk(0, '', '', 'ing"}'))).toEqual([])

    const events = t.handle(resultChunk('c1', '{"items":[],"total":2}'))
    expect(events).toEqual([
      { type: 'tool_call', toolName: 'search_parts', args: { query: 'bearing' } },
      {
        type: 'tool_result',
        toolName: 'search_parts',
        result: { items: [], total: 2 },
      },
    ])
  })

  it('emits the tool_call before its tool_result', () => {
    const t = createToolEventTracker()
    t.handle(callChunk(0, 'c1', 'search_parts', '{}'))
    const events = t.handle(resultChunk('c1', '{"total":0}'))
    expect(events.map((e) => e.type)).toEqual(['tool_call', 'tool_result'])
  })

  it('maps parallel calls to the correct result names', () => {
    const t = createToolEventTracker()
    t.handle(callChunk(0, 'a', 'search_parts', '{"q":"x"}'))
    t.handle(callChunk(1, 'b', 'lookup_component_catalog', '{"q":"y"}'))

    // done flush emits both tool_call events, in index order.
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

  it('does not emit a tool_call twice (done flush + result flush)', () => {
    const t = createToolEventTracker()
    t.handle(callChunk(0, 'a', 'search_parts', '{}'))
    expect(t.handle(doneChunk('tool_calls')).map((e) => e.type)).toEqual([
      'tool_call',
    ])
    // The result must NOT re-emit the already-flushed tool_call.
    const events = t.handle(resultChunk('a', '{"total":0}'))
    expect(events.map((e) => e.type)).toEqual(['tool_result'])
  })

  it('ignores a done chunk that is not a tool round', () => {
    const t = createToolEventTracker()
    t.handle(callChunk(0, 'a', 'search_parts', '{}'))
    expect(t.handle(doneChunk('stop'))).toEqual([])
  })

  it('wraps non-object result payloads as { value }', () => {
    const t = createToolEventTracker()
    t.handle(callChunk(0, 'a', 'get_item_details', '{}'))
    const strResult = t.handle(resultChunk('a', '"just text"'))
    expect(strResult).toContainEqual({
      type: 'tool_result',
      toolName: 'get_item_details',
      result: { value: 'just text' },
    })
  })

  it('handles non-JSON result content gracefully', () => {
    const t = createToolEventTracker()
    t.handle(callChunk(0, 'a', 'get_item_details', '{}'))
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
})
