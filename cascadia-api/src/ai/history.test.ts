// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { describe, expect, it } from 'vitest'
import { replayChatHistory } from './history'
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
