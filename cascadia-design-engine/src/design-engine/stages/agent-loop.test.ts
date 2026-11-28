// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The shared agent loop is a state machine over a stream it does not control:
 * transient failures, steering arriving mid-flight, a clarification tool
 * pausing the run, and the caller's abort all interleave. Three stages depend
 * on it behaving identically for each of them, so the branches are tested here
 * once rather than three times in stage suites that can only reach them
 * through a full stage.
 */

import { getEventListeners } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as TanStackAi from '@tanstack/ai'
import type * as AiUsage from '@/ai/usage'
import type { StageEvent, UserMessage } from '../types'

/** One entry per chat() call — the retry tests assert on request identity. */
const chatCalls: Array<{
  systemPrompts: Array<string>
  messages: Array<{ role: string; content: string }>
}> = []
/** Chunk script per chat() call, by index; the last entry repeats. */
let chunkScript: Array<Array<unknown>> = []
/** Called with the AbortController of each attempt, before chunks flow. */
let onAttempt: ((controller: AbortController) => void) | null = null

vi.mock('@tanstack/ai', async (importOriginal) => ({
  ...(await importOriginal<typeof TanStackAi>()),
  chat: (opts: {
    systemPrompts: Array<string>
    messages: Array<{ role: string; content: string }>
    abortController: AbortController
  }) => {
    const index = chatCalls.length
    chatCalls.push({
      systemPrompts: opts.systemPrompts,
      messages: opts.messages,
    })
    const controller = opts.abortController
    return (async function* () {
      await Promise.resolve()
      onAttempt?.(controller)
      const chunks = chunkScript[index] ?? chunkScript[chunkScript.length - 1]
      for (const chunk of chunks ?? []) {
        // A real stream stops delivering once its request is aborted.
        if (controller.signal.aborted) return
        yield chunk
      }
    })()
  },
}))

const recordLlmUsage = vi.fn(() => Promise.resolve())
vi.mock('@/ai/usage', async (importOriginal) => ({
  ...(await importOriginal<typeof AiUsage>()),
  recordLlmUsage,
}))

const { runAgentLoop, MAX_TRANSIENT_RETRIES } = await import('./agent-loop')

const SESSION = {
  id: 'design-session-1',
  aiChatSessionId: 'ai-chat-session-1',
  programId: 'program-1',
  userId: 'user-1',
}

function guidanceQueue(rounds: Array<Array<UserMessage>>) {
  let round = 0
  return {
    maybeDrain: () => Promise.resolve(rounds[round++] ?? []),
    drain: () => Promise.resolve([]),
  }
}

function steering(text: string): UserMessage {
  return {
    id: `msg-${text}`,
    text,
    createdAt: new Date(0).toISOString(),
    stage: 'bom_drafting',
  }
}

/** Drive the loop to completion, keeping every event it yielded. */
async function drive(overrides: Record<string, unknown> = {}) {
  const events: Array<StageEvent> = []
  const applied: Array<Array<UserMessage>> = []
  const generator = runAgentLoop({
    session: SESSION,
    adapter: {},
    provider: 'anthropic',
    model: 'claude-opus-5',
    buildMessages: ({ steering: drained }) => [
      { role: 'system', content: 'system' },
      {
        role: 'user',
        content: drained ? `steering:${drained[0]!.text}` : 'go',
      },
    ],
    isResuming: false,
    tools: [],
    maxTokens: 1024,
    maxIterations: 5,
    guidance: guidanceQueue([]),
    clarificationRef: { requested: false },
    persistDirtyArtifacts: () => Promise.resolve(null),
    maxSteeringContinuations: 0,
    applySteering: (drained: Array<UserMessage>) => {
      applied.push(drained)
      return Promise.resolve()
    },
    ...overrides,
  })

  for (;;) {
    const result = await generator.next()
    if (result.done) return { outcome: result.value, events, applied }
    events.push(result.value)
  }
}

const contentChunk = (delta: string) => ({
  type: 'TEXT_MESSAGE_CONTENT',
  messageId: 'message-1',
  delta,
})
const doneChunk = (promptTokens: number, completionTokens: number) => ({
  type: 'RUN_FINISHED',
  usage: { promptTokens, completionTokens },
})
const errorChunk = (message: string, code?: string) => ({
  type: 'RUN_ERROR',
  message,
  code,
})

beforeEach(() => {
  chatCalls.length = 0
  chunkScript = [[contentChunk('hello'), doneChunk(10, 5)]]
  onAttempt = null
  recordLlmUsage.mockClear()
})

describe('runAgentLoop', () => {
  it('yields content deltas and completes', async () => {
    const { outcome, events } = await drive()

    expect(outcome).toEqual({ type: 'completed' })
    expect(events).toContainEqual({ type: 'llm_text', text: 'hello' })
    expect(chatCalls).toHaveLength(1)
    // The stage's leading system entry is sent as the system prompt, not as
    // a turn of the conversation.
    expect(chatCalls[0]!.systemPrompts).toEqual(['system'])
    expect(chatCalls[0]!.messages.map((m) => m.role)).toEqual(['user'])
  })

  describe('transient failures', () => {
    it('retries the same request, up to the cap, then succeeds', async () => {
      chunkScript = [
        [errorChunk('terminated')],
        [errorChunk('terminated')],
        [contentChunk('second time lucky'), doneChunk(1, 1)],
      ]

      const { outcome } = await drive()

      expect(outcome).toEqual({ type: 'completed' })
      expect(chatCalls).toHaveLength(MAX_TRANSIENT_RETRIES + 1)
      // Same request each time — a retry that rebuilt the prompt would be a
      // different question, and the model's partial work would be re-asked.
      const asked = chatCalls.map((c) => c.messages[0]!.content)
      expect(new Set(asked)).toEqual(new Set(['go']))
    })

    it('surfaces a typed failure once the retries are spent', async () => {
      chunkScript = [[errorChunk('terminated')]]

      await expect(drive()).rejects.toThrow(/terminated/)
      expect(chatCalls).toHaveLength(MAX_TRANSIENT_RETRIES + 1)
    })

    it('does not retry a rejection that would fail identically', async () => {
      chunkScript = [[errorChunk('model not found', 'not_found_error')]]

      await expect(drive()).rejects.toThrow(/not_found_error/)
      expect(chatCalls).toHaveLength(1)
    })

    it('reports a non-fatal truncation and keeps going', async () => {
      chunkScript = [[errorChunk('hit the cap', 'max_tokens'), doneChunk(1, 1)]]

      const { outcome, events } = await drive()

      expect(outcome).toEqual({ type: 'completed' })
      expect(chatCalls).toHaveLength(1)
      expect(
        events.some(
          (e) => e.type === 'llm_text' && e.text.includes('hit the cap'),
        ),
      ).toBe(true)
    })
  })

  describe('steering', () => {
    it('restarts with the guidance injected as the next user turn', async () => {
      const guidance = steering('use aluminium')

      const { outcome, events, applied } = await drive({
        guidance: guidanceQueue([[guidance]]),
        maxSteeringContinuations: 1,
      })

      expect(outcome).toEqual({ type: 'completed' })
      expect(chatCalls).toHaveLength(2)
      expect(chatCalls[1]!.messages[0]!.content).toBe('steering:use aluminium')
      // Folded into the stage's artifacts before the restart, and announced.
      expect(applied).toEqual([[guidance]])
      expect(events).toContainEqual({
        type: 'user_message',
        id: guidance.id,
        text: guidance.text,
      })
    })

    it('hands back the guidance it has no round left to spend', async () => {
      const first = steering('use aluminium')
      const second = steering('and make it lighter')

      const { outcome, applied } = await drive({
        guidance: guidanceQueue([[first], [second]]),
        maxSteeringContinuations: 1,
      })

      // The second drain arrives on the last round: reporting it is the only
      // way the stage can fold it in rather than losing it.
      expect(outcome).toEqual({
        type: 'steering-exhausted',
        pendingSteering: [second],
      })
      expect(applied).toEqual([[first]])
      expect(chatCalls).toHaveLength(2)
    })

    it('never restarts when continuations are disabled', async () => {
      const guidance = steering('use aluminium')

      const { outcome, applied } = await drive({
        guidance: guidanceQueue([[guidance]]),
        maxSteeringContinuations: 0,
      })

      expect(outcome).toEqual({
        type: 'steering-exhausted',
        pendingSteering: [guidance],
      })
      expect(applied).toEqual([])
      expect(chatCalls).toHaveLength(1)
    })
  })

  it('pauses cleanly when a tool asks the user a question', async () => {
    const clarificationRef = { requested: false }
    chunkScript = [
      [
        contentChunk('thinking'),
        // Stands in for the stage's clarification tool firing mid-stream.
        {
          get type() {
            clarificationRef.requested = true
            return 'content'
          },
          delta: '',
        },
        contentChunk('never reached'),
      ],
    ]

    const { outcome, events } = await drive({ clarificationRef })

    expect(outcome).toEqual({ type: 'clarification' })
    expect(
      events.some((e) => e.type === 'llm_text' && e.text === 'never reached'),
    ).toBe(false)
  })

  describe('cancellation', () => {
    it('reports the caller aborting', async () => {
      const controller = new AbortController()
      chunkScript = [[contentChunk('starting'), contentChunk('never reached')]]
      let attemptController: AbortController | null = null
      onAttempt = (c) => {
        attemptController = c
        controller.abort()
      }

      const { outcome, events } = await drive({ signal: controller.signal })

      expect(outcome).toEqual({ type: 'aborted' })
      expect(
        events.some((e) => e.type === 'llm_text' && e.text === 'never reached'),
      ).toBe(false)
      // The provider request is torn down, not merely walked away from.
      expect(attemptController!.signal.aborted).toBe(true)
    })

    // The case the chained listener cannot cover: `addEventListener` never
    // fires on a signal that is already aborted, and a round or retry boundary
    // starts an attempt exactly there. The loop used to leave that request
    // live and just stop reading it — billed in full, cancelled in name only.
    it('aborts a request begun under an already-aborted signal', async () => {
      const controller = new AbortController()
      controller.abort()
      chunkScript = [[contentChunk('starting'), contentChunk('never reached')]]
      let attemptController: AbortController | null = null
      onAttempt = (c) => {
        attemptController = c
      }

      const { outcome, events } = await drive({ signal: controller.signal })

      expect(outcome).toEqual({ type: 'aborted' })
      expect(attemptController!.signal.aborted).toBe(true)
      expect(
        events.some((e) => e.type === 'llm_text' && e.text === 'starting'),
      ).toBe(false)
    })

    // Handlers were added per attempt and never removed, so a stage that rode
    // out two dropped sockets left three of them on a signal that lives as
    // long as the SSE request — each pinning a finished attempt's controller.
    it('does not accumulate abort listeners across attempts', async () => {
      const controller = new AbortController()
      chunkScript = [
        [errorChunk('terminated')],
        [errorChunk('terminated')],
        [contentChunk('third time lucky'), doneChunk(1, 1)],
      ]
      const listenersPerAttempt: Array<number> = []
      onAttempt = () => {
        listenersPerAttempt.push(
          getEventListeners(controller.signal, 'abort').length,
        )
      }

      const { outcome } = await drive({ signal: controller.signal })

      expect(outcome).toEqual({ type: 'completed' })
      expect(chatCalls).toHaveLength(MAX_TRANSIENT_RETRIES + 1)
      // One live handler at a time, however many attempts it takes.
      expect(listenersPerAttempt).toEqual([1, 1, 1])
      // And none left behind once the run is over.
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    })
  })

  it('yields whatever the stage persisted, when it persisted something', async () => {
    const artifactEvent: StageEvent = {
      type: 'artifact_update',
      artifacts: { bom: null },
    }
    let calls = 0
    const persistDirtyArtifacts = () => {
      calls++
      return Promise.resolve(calls === 1 ? artifactEvent : null)
    }

    const { events } = await drive({ persistDirtyArtifacts })

    expect(events.filter((e) => e.type === 'artifact_update')).toEqual([
      artifactEvent,
    ])
  })

  describe('usage', () => {
    it('sums every turn and writes one row per run', async () => {
      // An agent loop emits one done chunk per model turn, so a run with tool
      // calls has several — a row per turn would multiply-count the run.
      chunkScript = [[doneChunk(10, 5), doneChunk(7, 3), doneChunk(1, 1)]]

      await drive()

      expect(recordLlmUsage).toHaveBeenCalledTimes(1)
      expect(recordLlmUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: SESSION.userId,
          // The ai_chat_sessions row, not the design session — that is what
          // ai_usage_logs.session_id references.
          sessionId: SESSION.aiChatSessionId,
          programId: SESSION.programId,
          provider: 'anthropic',
          model: 'claude-opus-5',
          inputTokens: 18,
          outputTokens: 9,
        }),
      )
    })

    it('records the tokens a failed run already spent', async () => {
      chunkScript = [[doneChunk(10, 5), errorChunk('bad request', 'invalid')]]

      await expect(drive()).rejects.toThrow()

      expect(recordLlmUsage).toHaveBeenCalledTimes(1)
      expect(recordLlmUsage).toHaveBeenCalledWith(
        expect.objectContaining({ inputTokens: 10, outputTokens: 5 }),
      )
    })

    it('reports unmetered rather than zero when no turn reported usage', async () => {
      chunkScript = [[contentChunk('hello')]]

      await drive()

      expect(recordLlmUsage).toHaveBeenCalledWith(
        expect.objectContaining({ inputTokens: null, outputTokens: null }),
      )
    })

    it('leaves the row to the caller when the accumulator is shared', async () => {
      const { UsageAccumulator } = await import('@/ai/usage')

      await drive({ usage: new UsageAccumulator() })

      expect(recordLlmUsage).not.toHaveBeenCalled()
    })
  })
})
