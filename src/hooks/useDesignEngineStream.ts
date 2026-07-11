/**
 * useDesignEngineStream - SSE client hook for the design engine
 *
 * Manages the EventSource connection to the streaming endpoint,
 * parses StageEvents, and exposes state for the workspace UI.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  DesignArtifacts,
  DesignSessionStage,
  LlmHistoryEntry,
  StageEvent,
} from '@/lib/design-engine/types'

interface UseDesignEngineStreamOptions {
  sessionId: string
}

/**
 * Rebuild the activity feed from persisted LLM history so a reloaded session
 * shows the prior reasoning and tool calls, not just the final artifacts.
 * Mirrors the capture format in CollaborativeDesignEngine.wrapWithHistoryCapture:
 * assistant text is stored raw, tool entries as JSON with args (a call) or a
 * result (a completion).
 */
function hydrateEventsFromHistory(
  history: Array<LlmHistoryEntry>,
): Array<StageEvent> {
  const events: Array<StageEvent> = []
  for (const entry of history) {
    if (entry.role === 'assistant') {
      if (entry.content) events.push({ type: 'llm_text', text: entry.content })
    } else if (entry.role === 'tool') {
      try {
        const parsed = JSON.parse(entry.content) as {
          toolName?: string
          args?: Record<string, unknown>
          result?: Record<string, unknown>
        }
        if (!parsed.toolName) continue
        if (parsed.result !== undefined) {
          events.push({
            type: 'tool_result',
            toolName: parsed.toolName,
            result: parsed.result,
          })
        } else {
          events.push({
            type: 'tool_call',
            toolName: parsed.toolName,
            args: parsed.args ?? {},
          })
        }
      } catch {
        // Skip unparseable history entries
      }
    }
  }
  return events
}

interface StreamState {
  events: Array<StageEvent>
  isStreaming: boolean
  currentStage: DesignSessionStage
  artifacts: DesignArtifacts
  error: string | null
}

type StreamAction =
  | 'start_toolset'
  | 'start_requirements'
  | 'start_bom'
  | 'start_cad_generation'
  | 'start_assembly_composition'
  | 'regenerate_part'
  | 'resume'
  | 'confirm_toolset'
  | 'confirm_requirements'
  | 'confirm_bom'
  | 'confirm_cad'
  | 'confirm_assembly'
  | 'answer_clarification'
  | 'send_message'
  | 'reopen_stage'

interface StreamActionExtra {
  questionId?: string
  answer?: string
  message?: string
  tempId?: string
  feedback?: string
  targetStage?: 'toolset_review' | 'requirements_review' | 'bom_review'
  force?: boolean
}

export function useDesignEngineStream({
  sessionId,
}: UseDesignEngineStreamOptions) {
  const [state, setState] = useState<StreamState>({
    events: [],
    isStreaming: false,
    currentStage: 'idle',
    artifacts: {
      description: '',
      requirements: [],
      bom: null,
      clarifications: [],
      userMessages: [],
    },
    error: null,
  })

  const abortControllerRef = useRef<AbortController | null>(null)
  // Ref mirror of isStreaming so callbacks don't act on a stale closure
  const isStreamingRef = useRef(false)

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort()
    }
  }, [])

  const handleStageEvent = useCallback((event: StageEvent) => {
    setState((prev) => {
      const newState = { ...prev, events: [...prev.events, event] }

      switch (event.type) {
        case 'stage_change':
          newState.currentStage = event.stage
          break
        case 'artifact_update':
          newState.artifacts = { ...prev.artifacts, ...event.artifacts }
          break
        case 'error':
          newState.error = event.message
          break
        case 'stage_complete':
          if (
            event.stage === 'toolset_establishment' ||
            event.stage === 'toolset_review'
          ) {
            newState.currentStage = 'toolset_review'
          } else if (
            event.stage === 'requirements_drafting' ||
            event.stage === 'requirements_review'
          ) {
            newState.currentStage = 'requirements_review'
          } else if (
            event.stage === 'bom_drafting' ||
            event.stage === 'bom_review'
          ) {
            newState.currentStage = 'bom_review'
          } else if (
            event.stage === 'cad_generation' ||
            event.stage === 'cad_review'
          ) {
            newState.currentStage = 'cad_review'
          } else if (
            event.stage === 'assembly_composition' ||
            event.stage === 'assembly_review'
          ) {
            newState.currentStage = 'assembly_review'
          }
          break
      }

      return newState
    })
  }, [])

  /**
   * Start an SSE streaming connection and process events.
   */
  const startStream = useCallback(
    async (action: StreamAction, extra?: StreamActionExtra) => {
      // Abort existing stream
      abortControllerRef.current?.abort()
      const abortController = new AbortController()
      abortControllerRef.current = abortController

      isStreamingRef.current = true
      setState((prev) => ({
        ...prev,
        isStreaming: true,
        error: null,
      }))

      try {
        const response = await fetch(
          `/api/v1/design-engine/sessions/${sessionId}/stream`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, ...extra }),
            signal: abortController.signal,
          },
        )

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}))
          throw new Error(
            errorData.error?.message ?? `Stream failed: ${response.status}`,
          )
        }

        const reader = response.body?.getReader()
        if (!reader) throw new Error('No response body')

        const decoder = new TextDecoder()
        let buffer = ''

        for (;;) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })

          // Parse SSE events from buffer
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? '' // Keep incomplete line in buffer

          let eventType = ''
          let eventData = ''

          for (const line of lines) {
            if (line.startsWith('event: ')) {
              eventType = line.slice(7)
            } else if (line.startsWith('data: ')) {
              eventData = line.slice(6)
            } else if (line === '' && eventData) {
              // End of event
              if (eventType === 'stage_event') {
                try {
                  const stageEvent = JSON.parse(eventData) as StageEvent
                  handleStageEvent(stageEvent)
                } catch {
                  // Skip malformed events
                }
              }
              eventType = ''
              eventData = ''
            }
          }
        }
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          setState((prev) => ({
            ...prev,
            error:
              error instanceof Error ? error.message : 'Stream disconnected',
          }))
        }
      } finally {
        isStreamingRef.current = false
        setState((prev) => ({ ...prev, isStreaming: false }))
      }
    },
    [sessionId, handleStageEvent],
  )

  const sendAction = useCallback(
    async (action: StreamAction, extra?: StreamActionExtra) => {
      // Handle non-streaming actions (stage confirmations and reopens)
      if (
        action === 'confirm_toolset' ||
        action === 'confirm_requirements' ||
        action === 'confirm_bom' ||
        action === 'confirm_cad' ||
        action === 'confirm_assembly' ||
        action === 'reopen_stage'
      ) {
        // Guard against double-clicks
        if (state.isStreaming) return
        setState((prev) => ({ ...prev, isStreaming: true, error: null }))

        try {
          const response = await fetch(
            `/api/v1/design-engine/sessions/${sessionId}/stream`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action, ...extra }),
            },
          )

          if (!response.ok) {
            const errBody = await response.text().catch(() => '')
            throw new Error(
              `${action === 'reopen_stage' ? 'Reopen' : 'Confirm'} failed (${response.status}): ${errBody}`,
            )
          }

          const data = await response.json()
          const session = data.data?.session
          if (session) {
            setState((prev) => ({
              ...prev,
              isStreaming: false,
              currentStage: session.stage as DesignSessionStage,
              artifacts: session.artifacts ?? prev.artifacts,
              events: [],
            }))
          } else {
            // Response OK but no session — log and show error
            console.warn('Confirm response missing session:', data)
            setState((prev) => ({
              ...prev,
              isStreaming: false,
              error: `Confirm succeeded but response missing session data`,
            }))
          }
        } catch (err) {
          console.error('Confirm action failed:', err)
          setState((prev) => ({
            ...prev,
            isStreaming: false,
            error: err instanceof Error ? err.message : 'Confirmation failed',
          }))
        }
        return
      }

      // answer_clarification and send_message are now streaming actions
      if (action === 'answer_clarification') {
        // Add immediate feedback event
        setState((prev) => ({
          ...prev,
          events: [
            ...prev.events,
            {
              type: 'llm_text' as const,
              text: `\n\n**Your answer:** ${extra?.answer ?? ''}\n\n`,
            },
          ],
        }))

        await startStream(action, extra)
        return
      }

      if (action === 'send_message') {
        // Add immediate user message event to feed
        const msgId = crypto.randomUUID()
        setState((prev) => ({
          ...prev,
          events: [
            ...prev.events,
            {
              type: 'user_message' as const,
              id: msgId,
              text: extra?.message ?? '',
            },
          ],
        }))

        // A drafting stream is in flight: steer it via the mailbox instead of
        // aborting and restarting it. The running stage loop drains the
        // mailbox mid-generation; if the stream dies first, the next stage
        // start drains it instead — the message is never lost.
        if (isStreamingRef.current) {
          try {
            await fetch(`/api/v1/design-engine/sessions/${sessionId}/stream`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action,
                message: extra?.message,
                queue: true,
              }),
            })
          } catch {
            // Best-effort — drain-on-start covers delivery
          }
          return
        }

        // If in a drafting stage, this becomes a streaming action
        await startStream(action, extra)
        return
      }

      // All other actions are streaming
      await startStream(action, extra)
    },
    [sessionId, startStream],
  )

  const pause = useCallback(() => {
    abortControllerRef.current?.abort()
    isStreamingRef.current = false
    setState((prev) => ({ ...prev, isStreaming: false }))
  }, [])

  const initializeArtifacts = useCallback(
    (
      artifacts: DesignArtifacts,
      stage: DesignSessionStage,
      llmHistory?: Array<LlmHistoryEntry> | null,
    ) => {
      const events = llmHistory ? hydrateEventsFromHistory(llmHistory) : []
      // Re-surface an unanswered clarification so the prompt reappears on reload.
      if (artifacts.pendingClarification) {
        events.push({
          type: 'clarification_needed',
          questionId: artifacts.pendingClarification.id,
          question: artifacts.pendingClarification.question,
          options: artifacts.pendingClarification.options,
          multiSelect: artifacts.pendingClarification.multiSelect,
        })
      }
      setState((prev) => ({
        ...prev,
        events,
        artifacts: {
          ...artifacts,
          clarifications: artifacts.clarifications,
          userMessages: artifacts.userMessages,
        },
        currentStage: stage,
      }))
    },
    [],
  )

  const sendMessage = useCallback(
    (message: string) => {
      sendAction('send_message', { message })
    },
    [sendAction],
  )

  return {
    ...state,
    sendAction,
    sendMessage,
    pause,
    initializeArtifacts,
  }
}
