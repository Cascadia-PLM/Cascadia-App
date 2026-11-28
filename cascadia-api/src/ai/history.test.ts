// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { describe, expect, it } from 'vitest'
import { fitHistory, replayChatHistory } from './history'
import type { StoredChatMessage } from './history'

/**
 * The rule every provider enforces on a transcript: a tool result answers a
 * call made by the assistant message before it, and every call is answered
 * before the conversation moves on.
 */
function assertPaired(messages: ReturnType<typeof replayChatHistory>): void {
  let open = new Set<string>()
  for (const message of messages) {
    if (message.role === 'tool') {
      expect(message.toolCallId).toBeDefined()
      expect(open.has(message.toolCallId ?? '')).toBe(true)
      open.delete(message.toolCallId ?? '')
      continue
    }
    // Anything else may only follow once every call has its result.
    expect(open.size).toBe(0)
    open = new Set((message.toolCalls ?? []).map((call) => call.id))
  }
  expect(open.size).toBe(0)
}

const user = (content: string): StoredChatMessage => ({ role: 'user', content })
const tool = (
  toolCallId: string | null,
  content = '{}',
): StoredChatMessage => ({
  role: 'tool',
  content,
  toolCallId,
})
const assistant = (
  content: string,
  calls: Array<string> = [],
): StoredChatMessage => ({
  role: 'assistant',
  content,
  toolCalls: calls.map((id) => ({
    id,
    name: 'search_items',
    arguments: { query: id },
  })),
})

describe('replayChatHistory', () => {
  it('replays a tool turn as call, result, then the closing answer', () => {
    const messages = replayChatHistory([
      user('find bolts'),
      assistant('No bolts.', ['c1']),
      tool('c1', '{"total":0}'),
      user('and nuts?'),
    ])

    assertPaired(messages)
    expect(messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'user',
    ])
    expect(messages[1]?.toolCalls?.[0]?.function).toEqual({
      name: 'search_items',
      arguments: '{"query":"c1"}',
    })
    expect(messages[2]).toMatchObject({
      toolCallId: 'c1',
      content: '{"total":0}',
    })
    expect(messages[3]?.content).toBe('No bolts.')
  })

  it('keeps every transcript paired, whatever was left behind', () => {
    const transcripts: Array<Array<StoredChatMessage>> = [
      // A stream cut off after the call, before its result was stored.
      [user('a'), assistant('', ['c1']), user('b')],
      // One of two calls answered.
      [user('a'), assistant('done', ['c1', 'c2']), tool('c2'), user('b')],
      // Results with no call: rows from before calls were stored, a result
      // with no id, and a result for a call some other turn made.
      [user('a'), assistant('done'), tool('ghost'), tool(null), user('b')],
      [tool('c1'), user('a'), assistant('x', ['c1'])],
      // The same result stored twice.
      [user('a'), assistant('done', ['c1']), tool('c1'), tool('c1')],
      // A system row in the stored history.
      [{ role: 'system', content: 'prompt' }, user('a'), assistant('b')],
    ]

    for (const rows of transcripts) {
      const messages = replayChatHistory(rows)
      assertPaired(messages)
      expect(messages.some((m) => (m.role as string) === 'system')).toBe(false)
    }
  })

  it('drops a call that was never answered, not the turn that made it', () => {
    const messages = replayChatHistory([
      user('a'),
      assistant('partial answer', ['c1', 'c2']),
      tool('c2', '{"ok":true}'),
    ])

    expect(messages[1]?.toolCalls?.map((call) => call.id)).toEqual(['c2'])
    expect(messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'partial answer',
    })
  })

  it('passes through arguments an older row stored as a JSON string', () => {
    const messages = replayChatHistory([
      user('a'),
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'get_bom', arguments: '{"itemId":"x"}' }],
      },
      tool('c1'),
    ])

    expect(messages[1]?.toolCalls?.[0]?.function.arguments).toBe(
      '{"itemId":"x"}',
    )
  })
})

describe('fitHistory', () => {
  // A long conversation: every turn makes one call with a large result.
  const longResult = JSON.stringify({ rows: 'x'.repeat(5_000) })
  const conversation = (turns: number) =>
    replayChatHistory(
      Array.from({ length: turns }, (_, i) => [
        user(`question ${i}`),
        assistant(`answer ${i}`, [`c${i}`]),
        tool(`c${i}`, longResult),
      ]).flat(),
    )

  it('returns a short conversation untouched', () => {
    const messages = conversation(2)
    expect(fitHistory(messages, 100_000)).toEqual({
      messages,
      droppedTurns: 0,
      shortenedResults: 0,
    })
  })

  it('never separates a call from its result, whatever the budget', () => {
    // The invariant a provider enforces. Swept across budgets so the cut
    // lands at every position inside a turn at least once.
    const messages = conversation(8)
    for (let budget = 1; budget <= 6_000; budget += 137) {
      const fitted = fitHistory(messages, budget)
      assertPaired(fitted.messages)
      expect(fitted.messages[0]?.role).toBe('user')
    }
  })

  it('drops the oldest turns first and keeps the newest', () => {
    const fitted = fitHistory(conversation(8), 1_000)

    expect(fitted.droppedTurns).toBeGreaterThan(0)
    expect(fitted.messages.at(-1)).toMatchObject({ content: 'answer 7' })
    expect(fitted.messages[0]).toMatchObject({
      content: `question ${fitted.droppedTurns}`,
    })
  })

  it('keeps the newest turn even when it alone is over budget', () => {
    const fitted = fitHistory(conversation(3), 1)

    expect(fitted.droppedTurns).toBe(2)
    expect(fitted.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ])
  })

  it('shortens old tool results before dropping anything, and leaves recent ones whole', () => {
    const fitted = fitHistory(conversation(4), 100_000)
    const results = fitted.messages.filter((m) => m.role === 'tool')

    expect(fitted.droppedTurns).toBe(0)
    expect(fitted.shortenedResults).toBe(2)
    expect(results.map((m) => m.content === longResult)).toEqual([
      false,
      false,
      true,
      true,
    ])
    // The assistant's own answers are never cut.
    expect(
      fitted.messages.filter((m) => m.content === 'answer 0'),
    ).toHaveLength(1)
  })
})
