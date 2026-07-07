import { describe, expect, it } from 'vitest'
import { summarizeToolCalls } from './tool-call-summary'
import type { LlmHistoryEntry } from '../types'

/** A recorded tool *call* history entry (args, no result). */
function call(toolName: string, args: unknown): LlmHistoryEntry {
  return { role: 'tool', content: JSON.stringify({ toolName, args }) }
}

/** A recorded tool *result* history entry (result, no args). */
function result(toolName: string, res: unknown): LlmHistoryEntry {
  return { role: 'tool', content: JSON.stringify({ toolName, result: res }) }
}

describe('summarizeToolCalls', () => {
  it('returns empty string for missing / empty history', () => {
    expect(summarizeToolCalls(undefined)).toBe('')
    expect(summarizeToolCalls(null)).toBe('')
    expect(summarizeToolCalls([])).toBe('')
  })

  it('returns empty string when there are no tool-role entries', () => {
    const history: Array<LlmHistoryEntry> = [
      { role: 'assistant', content: 'thinking out loud' },
      { role: 'user', content: 'hello' },
    ]
    expect(summarizeToolCalls(history)).toBe('')
  })

  it('summarizes a search call + result as a "N results" line', () => {
    const history = [
      call('search_parts', { query: 'bearing' }),
      result('search_parts', { items: [], total: 3 }),
    ]
    const out = summarizeToolCalls(history)
    expect(out).toContain('## Prior Tool Calls')
    expect(out).toContain('`search_parts(query: "bearing")` → 3 results')
  })

  it('uses singular "result" when total is 1', () => {
    const history = [
      call('search_parts', { query: 'motor' }),
      result('search_parts', { items: [{}], total: 1 }),
    ]
    expect(summarizeToolCalls(history)).toContain('→ 1 result')
  })

  it('describes a mutation result via tempId (guards MUTATION_TOOLS names)', () => {
    const history = [
      call('propose_requirement', { name: 'Withstand 5G load' }),
      result('propose_requirement', { tempId: 'req-1', added: true }),
    ]
    const out = summarizeToolCalls(history)
    expect(out).toContain(
      '`propose_requirement(name: "Withstand 5G load")` → tempId=req-1',
    )
  })

  it('recognizes the corrected BOM mutation tool names', () => {
    const history = [
      call('propose_new_part', { name: 'Bracket' }),
      result('propose_new_part', { tempId: 'part-9' }),
    ]
    expect(summarizeToolCalls(history)).toContain(
      '`propose_new_part(name: "Bracket")` → tempId=part-9',
    )
  })

  it('collapses duplicate identical call lines', () => {
    const history = [
      call('search_parts', { query: 'screw' }),
      result('search_parts', { total: 2 }),
      call('search_parts', { query: 'screw' }),
      result('search_parts', { total: 2 }),
    ]
    const out = summarizeToolCalls(history)
    const occurrences = out.split('`search_parts(query: "screw")`').length - 1
    expect(occurrences).toBe(1)
  })

  it('marks a call with no matching result', () => {
    const history = [call('search_parts', { query: 'orphan' })]
    expect(summarizeToolCalls(history)).toContain('→ no result captured')
  })

  it('omits the header when nothing pairs into a line', () => {
    // Only a result entry (no call) — nothing to summarize.
    const history = [result('search_parts', { total: 5 })]
    expect(summarizeToolCalls(history)).toBe('')
  })
})
