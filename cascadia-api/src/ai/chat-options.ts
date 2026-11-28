// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * What every `chat()` call here has to get right, in one place.
 *
 * TanStack AI moved two things out of `chat()`'s top level and into
 * provider-shaped slots: the output cap and the system prompt. Both fail
 * quietly when they are put in the wrong place — an unknown `modelOptions` key
 * is dropped and the request runs uncapped; a `system` message is sent as a
 * user turn — so the mapping is written down once and every call site asks.
 *
 * No database and no provider SDK is imported here, so a test that fakes
 * `@/ai/adapters` still gets the real thing.
 */

/**
 * Cap a request's output, as `chat()`'s `modelOptions`.
 *
 * TanStack AI has no portable token limit: it lives in `modelOptions` under
 * the provider's own key, and a key the adapter does not know is dropped
 * without a word — which leaves the request uncapped. The key follows the
 * wire API, and the adapter's `name` says which one that is: OpenAI's
 * Responses API takes `max_output_tokens`; Anthropic's Messages API and every
 * Chat Completions endpoint take `max_tokens`.
 */
export function maxOutputTokens(
  adapter: unknown,
  limit: number,
): Record<string, number> {
  const name =
    typeof adapter === 'object' && adapter !== null && 'name' in adapter
      ? adapter.name
      : undefined
  return name === 'openai'
    ? { max_output_tokens: limit }
    : { max_tokens: limit }
}

/**
 * Lift the system prompt off the front of a transcript.
 *
 * `chat()` takes system prompts in `systemPrompts`, which each adapter maps to
 * the provider's own slot (Anthropic `system`, OpenAI `instructions`, a leading
 * `system` message on Chat Completions). A `system`-role entry left in
 * `messages` is not an error — it is sent as a *user* turn, so the model reads
 * its instructions as something the user said.
 *
 * Only the leading run moves. A system entry later in the list is a note
 * placed at that point in the conversation, and stays where it was put.
 */
export function splitSystemPrompts<
  TMessage extends { role: string; content: unknown },
>(
  transcript: ReadonlyArray<TMessage>,
): { systemPrompts: Array<string>; messages: Array<TMessage> } {
  const systemPrompts: Array<string> = []
  let index = 0
  for (; index < transcript.length; index++) {
    const entry = transcript[index]
    if (entry?.role !== 'system' || typeof entry.content !== 'string') break
    systemPrompts.push(entry.content)
  }
  return { systemPrompts, messages: transcript.slice(index) }
}
