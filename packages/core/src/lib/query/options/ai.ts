// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import { qk } from '../keys'
import type { UIMessage } from '@tanstack/ai-react'
import { apiFetch } from '@/lib/api/client'

/** One row of the chat sidebar's conversation history. */
export interface AiChatSession {
  id: string
  title: string | null
  createdAt: string
  updatedAt: string
}

/**
 * A persisted turn, as `/ai/sessions/:id/messages` hands it back.
 *
 * `arguments` is whatever landed in the jsonb column: an object for a call
 * the server assembled itself, a string for one persisted verbatim from a
 * provider. Both shapes are real, and the UI wants the string form.
 */
interface PersistedChatMessage {
  id: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCalls: Array<{
    id: string
    name: string
    arguments: string | Record<string, unknown>
  }> | null
  createdAt: string
}

type ChatMessagePart = UIMessage['parts'][number]

/**
 * Rebuild the on-screen transcript from the persisted one.
 *
 * System prompts and raw tool-result rows are transcript plumbing rather
 * than turns, so they are dropped; a tool call is restored as the
 * `input-complete` part the streamed message would have carried, which is
 * what keeps a reopened conversation showing the same cards it showed live.
 */
function toUiMessages(messages: Array<PersistedChatMessage>): Array<UIMessage> {
  const uiMessages: Array<UIMessage> = []

  for (const message of messages) {
    if (message.role === 'system' || message.role === 'tool') continue

    const parts: Array<ChatMessagePart> = []

    if (message.content) {
      parts.push({ type: 'text', content: message.content })
    }

    for (const toolCall of message.toolCalls ?? []) {
      parts.push({
        type: 'tool-call',
        id: toolCall.id,
        name: toolCall.name,
        arguments:
          typeof toolCall.arguments === 'string'
            ? toolCall.arguments
            : JSON.stringify(toolCall.arguments),
        state: 'input-complete',
      })
    }

    // A turn with neither text nor tool calls still has to render as
    // something.
    if (parts.length === 0) {
      parts.push({ type: 'text', content: '' })
    }

    uiMessages.push({
      id: message.id,
      role: message.role,
      parts,
      createdAt: new Date(message.createdAt),
    })
  }

  return uiMessages
}

/**
 * Every chat session the signed-in user owns, newest first.
 *
 * Titles are generated server-side from the first message, so the list has
 * to restage once a response completes — the panel does that by invalidating
 * `'ai'` rather than refetching by hand. Pass `enabled: false` while the
 * panel is closed; reopening it inside the cache window then costs nothing.
 */
export function aiSessionsQuery(enabled = true) {
  return queryOptions({
    queryKey: qk.collection('ai', 'sessions'),
    queryFn: async (): Promise<Array<AiChatSession>> => {
      const result = await apiFetch<{
        data: { sessions: Array<AiChatSession> }
      }>('/api/v1/ai/sessions')
      return result.data.sessions
    },
    enabled,
  })
}

/**
 * One session's transcript, already in the shape `useChat` renders.
 *
 * The conversion lives in the queryFn so the cache holds UI messages
 * directly: the panel hydrates `setMessages` from this when the selected
 * session changes, and re-deriving on every read would be one more place for
 * the persisted and on-screen shapes to drift.
 */
export function aiSessionMessagesQuery(
  sessionId: string | undefined,
  enabled = true,
) {
  return queryOptions({
    queryKey: qk.sub('ai', sessionId ?? '', 'messages'),
    queryFn: async (): Promise<Array<UIMessage>> => {
      const result = await apiFetch<{
        data: { messages: Array<PersistedChatMessage> }
      }>(`/api/v1/ai/sessions/${sessionId ?? ''}/messages`)
      return toUiMessages(result.data.messages)
    },
    enabled: enabled && Boolean(sessionId),
  })
}
