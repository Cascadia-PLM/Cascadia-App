// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * A stored chat session, replayed as the transcript a model is sent.
 *
 * What is stored and what a provider accepts are not the same shape. One
 * request's assistant turn is persisted as a single row — its closing text
 * plus every tool call it made — followed by one `tool` row per result. A
 * provider wants that as a sequence: the assistant message that made the
 * calls, each result answering a call by id, then the assistant's answer.
 *
 * The pairing is the part that cannot be approximate. Every provider rejects
 * a tool result that answers no call, and a call that never got a result:
 * OpenAI's APIs and every Chat Completions endpoint with a 400, Anthropic
 * with an `unexpected tool_use_id`. So a call is replayed only when its
 * result is there to follow it, and a result only when its call is — a stream
 * cut off between the two leaves neither behind.
 */

import type { ModelMessage } from '@tanstack/ai'

/** The columns of a stored message this needs — see `SessionService`. */
export interface StoredChatMessage {
  role: string
  content: string
  toolCalls?: ReadonlyArray<{
    id: string
    name: string
    /** An object as this server persists it; a JSON string on older rows. */
    arguments: unknown
  }> | null
  toolCallId?: string | null
}

function argumentsJson(args: unknown): string {
  if (typeof args === 'string') return args
  return JSON.stringify(args ?? {})
}

export function replayChatHistory(
  rows: ReadonlyArray<StoredChatMessage>,
): Array<ModelMessage> {
  const messages: Array<ModelMessage> = []

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]
    if (!row) continue

    if (row.role === 'user') {
      messages.push({ role: 'user', content: row.content })
      continue
    }

    // System rows are not conversation, and a `tool` row reached here was not
    // claimed by the assistant turn before it: an orphan, which no provider
    // accepts.
    if (row.role !== 'assistant') continue

    // The results of this turn's calls are the `tool` rows that follow it.
    const results = new Map<string, string>()
    while (rows[index + 1]?.role === 'tool') {
      index++
      const result = rows[index]
      if (result?.toolCallId && !results.has(result.toolCallId)) {
        results.set(result.toolCallId, result.content)
      }
    }

    const answered = (row.toolCalls ?? []).filter((call) =>
      results.has(call.id),
    )
    if (answered.length > 0) {
      messages.push({
        role: 'assistant',
        content: null,
        toolCalls: answered.map((call) => ({
          id: call.id,
          type: 'function' as const,
          function: {
            name: call.name,
            arguments: argumentsJson(call.arguments),
          },
        })),
      })
      for (const call of answered) {
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: results.get(call.id) ?? '',
        })
      }
    }

    // The stored text is what the turn closed with, so it follows the calls.
    if (row.content) {
      messages.push({ role: 'assistant', content: row.content })
    }
  }

  return messages
}
