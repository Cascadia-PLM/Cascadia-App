// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * ChatPanel - Main AI chat sidebar component
 *
 * Uses TanStack AI's useChat hook for streaming chat functionality.
 */

import { fetchServerSentEvents, useChat } from '@tanstack/ai-react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { AlertCircle, History, Plus, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { ChatInput } from './ChatInput'
import { ChatMessage } from './ChatMessage'

import { Button } from '@/components/ui/Button'
import { ResizeHandle } from '@/components/ui/ResizeHandle'
import {
  CHAT_PANEL_MAX_WIDTH,
  CHAT_PANEL_MIN_WIDTH,
  useChatPanel,
} from '@/lib/ai/chat-context'
import { apiFetch } from '@/lib/api/client'
import {
  aiSessionMessagesQuery,
  aiSessionsQuery,
  useInvalidateResources,
} from '@/lib/query'
import { cn } from '@/lib/utils'

export function ChatPanel() {
  const {
    isOpen,
    setIsOpen,
    currentSessionId,
    setCurrentSessionId,
    width,
    setWidth,
  } = useChatPanel()

  const navigate = useNavigate()
  // Declared before useChat: the client captures `onFinish` once, on the
  // first render, so anything that closure calls has to be stable.
  const invalidate = useInvalidateResources()
  const [showSessions, setShowSessions] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // The conversation list. Gated on the panel being open rather than
  // refetched every time it opens — reopening inside the cache window is
  // free, and the title a response generates arrives via `invalidate('ai')`.
  const { data: sessions = [], isLoading: loadingSessions } = useQuery(
    aiSessionsQuery(isOpen),
  )

  // The selected session's transcript, already in useChat's shape.
  const { data: sessionMessages } = useQuery(
    aiSessionMessagesQuery(currentSessionId),
  )

  // Handle navigation from AI chat navigation offers
  const handleNavigate = useCallback(
    (url: string) => {
      // Parse the URL to extract path and search params
      const [path = url, search] = url.split('?')
      navigate({
        to: path,
        search: search
          ? Object.fromEntries(new URLSearchParams(search))
          : undefined,
      })
    },
    [navigate],
  )

  // Use a ref to track the session ID for the connection function
  // This allows us to update the ID before sending without waiting for state
  const sessionIdRef = useRef<string | undefined>(currentSessionId)

  // Track chat mode ('chat' or 'search') for the current request
  const modeRef = useRef<'chat' | 'search'>('chat')

  // Track when we just created a session to avoid reloading messages
  const justCreatedSessionRef = useRef(false)

  // The session whose transcript is currently on screen, so hydration runs
  // once per session switch rather than on every arrival of query data.
  const hydratedSessionRef = useRef<string | undefined>(undefined)

  // Keep ref in sync with state changes
  useEffect(() => {
    sessionIdRef.current = currentSessionId
  }, [currentSessionId])

  // TanStack AI chat hook
  const {
    messages,
    sendMessage: originalSendMessage,
    isLoading,
    error,
    stop,
    setMessages,
  } = useChat({
    connection: fetchServerSentEvents('/api/v1/ai/chat', () => ({
      body: {
        data: {
          sessionId: sessionIdRef.current, // Use ref for immediate access
          mode: modeRef.current,
        },
      },
    })),
    onFinish: () => {
      // Reset mode back to chat after response completes
      modeRef.current = 'chat'
      // Restage the session list so the generated title appears
      void invalidate('ai')
    },
    onError: (err) => {
      console.error('Chat error:', err)
    },
  })

  // Shared helper: creates a session if needed, sets mode, then sends
  const sendWithMode = useCallback(
    async (message: string, mode: 'chat' | 'search') => {
      if (!sessionIdRef.current) {
        try {
          const result = await apiFetch<{
            data: { session: { id: string } }
          }>('/api/v1/ai/sessions', {
            method: 'POST',
            body: JSON.stringify({}),
          })
          const newSessionId = result.data.session.id
          sessionIdRef.current = newSessionId
          justCreatedSessionRef.current = true
          setCurrentSessionId(newSessionId)
        } catch (err) {
          console.error('Failed to create session:', err)
        }
      }
      modeRef.current = mode
      // Claim this session for the live stream before the request goes out.
      // A transcript fetch may still be in flight from the switch that
      // selected it; without the stamp its response lands mid-stream and
      // hydration replaces the turn being sent.
      hydratedSessionRef.current = sessionIdRef.current
      originalSendMessage(message)
    },
    [originalSendMessage, setCurrentSessionId],
  )

  const sendMessage = useCallback(
    (message: string) => sendWithMode(message, 'chat'),
    [sendWithMode],
  )

  const sendSearch = useCallback(
    (message: string) => sendWithMode(message, 'search'),
    [sendWithMode],
  )

  // Track which confirmations have been responded to
  const [respondedConfirmations, setRespondedConfirmations] = useState<
    Map<string, 'confirmed' | 'cancelled'>
  >(new Map())

  const handleConfirm = useCallback(
    (toolCallId: string, toolName: string, toolArgs: string) => {
      setRespondedConfirmations((prev) =>
        new Map(prev).set(toolCallId, 'confirmed'),
      )
      let argsObj: Record<string, unknown> = {}
      try {
        argsObj = JSON.parse(toolArgs)
      } catch {
        // use empty object
      }
      const summary = argsObj.name
        ? `Yes, please proceed with ${toolName} for "${argsObj.name}".`
        : `Yes, please proceed with the ${toolName} operation.`
      sendMessage(summary)
    },
    [sendMessage],
  )

  const handleCancel = useCallback(
    (toolCallId: string) => {
      setRespondedConfirmations((prev) =>
        new Map(prev).set(toolCallId, 'cancelled'),
      )
      sendMessage('No, cancel that operation.')
    },
    [sendMessage],
  )

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Hand the selected session's transcript to useChat.
  //
  // Deliberately once per session rather than on every arrival of query
  // data: a finished response invalidates 'ai', and re-hydrating from the
  // persisted history there would drop the tool results and confirmation
  // cards that only ever exist in the streamed messages.
  useEffect(() => {
    if (!currentSessionId) {
      hydratedSessionRef.current = undefined
      setMessages([])
      return
    }
    // A session we just created is already on screen as a live stream.
    if (justCreatedSessionRef.current) {
      justCreatedSessionRef.current = false
      hydratedSessionRef.current = currentSessionId
      return
    }
    if (hydratedSessionRef.current === currentSessionId) return
    if (!sessionMessages) return
    hydratedSessionRef.current = currentSessionId
    setMessages(sessionMessages)
  }, [currentSessionId, sessionMessages, setMessages])

  const handleNewSession = () => {
    sessionIdRef.current = undefined // Clear ref as well
    setCurrentSessionId(undefined)
    setMessages([])
    setShowSessions(false)
  }

  const handleSelectSession = (sessionId: string) => {
    sessionIdRef.current = sessionId // Update ref for immediate use
    setCurrentSessionId(sessionId)
    setShowSessions(false)
  }

  const handleDeleteSession = async (sessionId: string) => {
    try {
      await apiFetch(`/api/v1/ai/sessions/${sessionId}`, { method: 'DELETE' })
      if (sessionId === currentSessionId) {
        handleNewSession()
      }
      await invalidate('ai')
    } catch (err) {
      console.error('Failed to delete session:', err)
    }
  }

  return (
    <aside
      className={cn(
        'fixed right-0 top-0 z-50 h-full',
        'flex flex-col',
        'bg-white dark:bg-slate-800',
        'shadow-lg',
        'transition-all duration-300 ease-in-out',
        // Hide content when collapsed
        !isOpen && 'overflow-hidden',
      )}
      style={{ width: isOpen ? width : 0 }}
    >
      {/* Resize handle on left edge */}
      {isOpen && (
        <ResizeHandle
          side="left"
          currentWidth={width}
          onResize={setWidth}
          minWidth={CHAT_PANEL_MIN_WIDTH}
          maxWidth={CHAT_PANEL_MAX_WIDTH}
        />
      )}
      {/* Header - h-12 matches main app header */}
      <div className="flex items-center justify-between border-b border-slate-300 dark:border-slate-700 px-4 h-12">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold text-slate-900 dark:text-slate-100">
            Cascadia Chat
          </h2>
          {isLoading && (
            <span className="text-xs text-cyan-600 dark:text-cyan-400">
              Thinking...
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setShowSessions(!showSessions)}
            className="h-8 w-8"
            aria-label="View history"
          >
            <History className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleNewSession}
            className="h-8 w-8"
            aria-label="New conversation"
          >
            <Plus className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setIsOpen(false)}
            className="h-8 w-8"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Sessions list overlay */}
      {showSessions && (
        <div className="absolute inset-0 top-12 z-10 bg-white dark:bg-slate-800 flex flex-col">
          <div className="p-4 border-b border-slate-300 dark:border-slate-700">
            <h3 className="font-medium text-slate-900 dark:text-slate-100">
              Conversation History
            </h3>
          </div>
          <div className="flex-1 overflow-y-auto">
            {loadingSessions ? (
              <div className="p-4 text-center text-slate-500">Loading...</div>
            ) : sessions.length === 0 ? (
              <div className="p-4 text-center text-slate-500">
                No conversations yet
              </div>
            ) : (
              <div className="divide-y divide-slate-200 dark:divide-slate-800">
                {sessions.map((session) => (
                  <div
                    key={session.id}
                    className={cn(
                      'flex items-center justify-between p-3 cursor-pointer',
                      'hover:bg-slate-50 dark:hover:bg-slate-800',
                      session.id === currentSessionId &&
                        'bg-cyan-50 dark:bg-cyan-900/20',
                    )}
                    onClick={() => handleSelectSession(session.id)}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
                        {session.title || 'New conversation'}
                      </p>
                      <p className="text-xs text-slate-500">
                        {new Date(session.updatedAt).toLocaleDateString()}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDeleteSession(session.id)
                      }}
                      className="h-6 w-6 text-slate-400 hover:text-red-500"
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="p-2 border-t border-slate-300 dark:border-slate-700">
            <Button
              variant="outline"
              className="w-full"
              onClick={() => setShowSessions(false)}
            >
              Close
            </Button>
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-2 py-4 space-y-4">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="w-16 h-16 mb-4 rounded-full bg-cyan-100 dark:bg-cyan-900 flex items-center justify-center">
              <span className="text-2xl">🤖</span>
            </div>
            <h3 className="font-medium text-slate-900 dark:text-slate-100">
              How can I help you?
            </h3>
            <p className="mt-1 text-sm text-slate-500 max-w-xs">
              Ask questions about your PLM data, find items, or get help with
              workflows.
            </p>
          </div>
        ) : (
          messages.map((msg) => (
            <ChatMessage
              key={msg.id}
              role={msg.role}
              parts={msg.parts}
              isStreaming={isLoading && msg === messages[messages.length - 1]}
              onNavigate={handleNavigate}
              onConfirm={handleConfirm}
              onCancel={handleCancel}
              respondedConfirmations={respondedConfirmations}
            />
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Error display */}
      {error && (
        <div className="mx-2 mb-2 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 text-sm flex items-center gap-2">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          <span>{error.message || 'An error occurred'}</span>
        </div>
      )}

      {/* Input */}
      <div className="border-t border-slate-300 dark:border-slate-700 px-2 py-4">
        <ChatInput
          onSend={sendMessage}
          onSearch={sendSearch}
          onStop={stop}
          isLoading={isLoading}
        />
      </div>
    </aside>
  )
}
