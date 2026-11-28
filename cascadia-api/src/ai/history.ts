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

// ============================================================================
// Fitting a transcript to a budget
// ============================================================================

/**
 * The share of a model's context a conversation's history may take, in
 * tokens. `AI_CHAT_HISTORY_TOKEN_BUDGET` overrides it — lower it for a small
 * local model, raise it for a large-context one.
 *
 * The default leaves room, in the smallest window among the supported hosted
 * providers, for the system prompt, the tool schemas and the answer beside
 * it — and it is a cost bound too: every turn re-sends what is kept.
 */
const DEFAULT_HISTORY_TOKEN_BUDGET = 24_000

/**
 * Characters per token, for estimating. Deliberately below English prose
 * (~4): tool results are JSON full of ids, which tokenizes denser, and
 * overshooting a context window is a failed request while undershooting a
 * budget is one fewer old turn.
 */
const CHARS_PER_TOKEN = 3

/** Turns, counted from the newest, whose tool results are sent in full. */
const FULL_RESULT_TURNS = 2

/** How much of an older tool result survives, in characters. */
const OLD_RESULT_HEAD_CHARS = 400

export function chatHistoryTokenBudget(): number {
  const parsed = Number(process.env.AI_CHAT_HISTORY_TOKEN_BUDGET)
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_HISTORY_TOKEN_BUDGET
}

/**
 * Told to the model when turns were dropped, as a system prompt of its own:
 * without it the model cannot know the conversation began earlier than what
 * it can see, and answers "as we discussed" by guessing.
 */
export const HISTORY_TRIMMED_NOTE = `## Earlier Conversation Omitted
This conversation is longer than what you are shown: its oldest turns were left out to fit. If the user refers to something you cannot see, say so and ask, or look it up again with a tool — do not guess at what was said.`

function messageChars(message: ModelMessage): number {
  const content =
    typeof message.content === 'string'
      ? message.content.length
      : message.content
        ? JSON.stringify(message.content).length
        : 0
  const calls = (message.toolCalls ?? []).reduce(
    (sum, call) =>
      sum + call.function.name.length + call.function.arguments.length,
    0,
  )
  return content + calls
}

export interface FittedHistory {
  messages: Array<ModelMessage>
  /** Whole turns left out from the start of the conversation. */
  droppedTurns: number
  /** Tool results in older turns that were cut down to their head. */
  shortenedResults: number
}

/**
 * Cut a replayed transcript down to a token budget.
 *
 * Without this every turn re-sent the whole conversation, tool results
 * included, so a session cost more with each message and eventually failed
 * outright at the provider's context limit.
 *
 * Two passes, cheapest loss first:
 *
 *   1. **Old tool results are shortened.** They are most of the bulk — a
 *      search result is fifty rows of JSON — and the least useful part once
 *      the assistant has answered from them: the answer is kept, and the tool
 *      can be called again. The newest `FULL_RESULT_TURNS` turns keep theirs
 *      whole, since a follow-up question is usually about those.
 *   2. **Oldest turns are dropped, whole**, until the rest fits.
 *
 * A turn is a user message and everything up to the next one, and it is the
 * unit throughout. That is what keeps the result valid: a tool call and its
 * result always fall in the same turn, so neither is ever sent without the
 * other (see the note on `replayChatHistory`), and the transcript always
 * opens on a user message. The newest turn is kept even when it alone is
 * over budget — dropping it would hand the model a question with no context
 * at all, which is worse than a provider error naming the real problem.
 */
export function fitHistory(
  messages: ReadonlyArray<ModelMessage>,
  maxTokens: number = chatHistoryTokenBudget(),
): FittedHistory {
  // Split into turns. Anything before the first user message is not a turn
  // of the conversation and is not replayed.
  const turns: Array<Array<ModelMessage>> = []
  for (const message of messages) {
    if (message.role === 'user') turns.push([message])
    else turns.at(-1)?.push(message)
  }

  let shortenedResults = 0
  const firstFullTurn = turns.length - FULL_RESULT_TURNS
  const shortened = turns.map((turn, index) =>
    index >= firstFullTurn
      ? turn
      : turn.map((message) => {
          if (
            message.role !== 'tool' ||
            typeof message.content !== 'string' ||
            message.content.length <= OLD_RESULT_HEAD_CHARS * 2
          ) {
            return message
          }
          shortenedResults++
          const cut = message.content.length - OLD_RESULT_HEAD_CHARS
          return {
            ...message,
            content: `${message.content.slice(0, OLD_RESULT_HEAD_CHARS)}… [${cut} more characters of this earlier tool result were left out. Call the tool again if you need them.]`,
          }
        }),
  )

  // Keep turns from the newest back while they fit.
  const maxChars = maxTokens * CHARS_PER_TOKEN
  let used = 0
  let start = shortened.length
  while (start > 0) {
    const turn = shortened[start - 1]
    if (!turn) break
    const size = turn.reduce((sum, message) => sum + messageChars(message), 0)
    if (start < shortened.length && used + size > maxChars) break
    used += size
    start--
  }

  return {
    messages: shortened.slice(start).flat(),
    droppedTurns: start,
    shortenedResults,
  }
}
