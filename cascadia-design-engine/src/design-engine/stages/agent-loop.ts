// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The agent loop the drafting stages share.
 *
 * Three stages drive an LLM chat with tools until it stops: requirements, BOM,
 * and toolset establishment. They had drifted into three implementations of
 * the same idea — requirements inline, BOM rebuilt as local `processStream` /
 * `driveStream` generators, and toolset establishment a single pass with
 * *neither* transient retry nor steering continuation. That last one is a
 * behavioural divergence, not a stylistic one: a dropped socket ended the
 * toolset stage, and guidance sent while it ran was ignored until the next
 * stage.
 *
 * What the engine owns:
 *
 * - the round loop, bounded by `maxSteeringContinuations`
 * - a per-attempt `AbortController` chained to the caller's signal
 * - chunk iteration: fatal vs transient vs non-fatal error handling, retrying
 *   the *same* request on transient failures up to `maxTransientRetries`
 * - text yield, one `llm_text` per `TEXT_MESSAGE_CONTENT` delta
 * - tool-event translation through `createToolEventTracker`
 * - `guidance.maybeDrain()` at chunk boundaries: on a hit, abort and restart
 *   with the guidance injected as the next user turn
 * - clarification detection, reported as a clean pause outcome
 * - usage accumulation across each model turn's `RUN_FINISHED`, recorded
 *   once per stage run
 *
 * What a stage keeps: its prompt, its tools, its artifact shape, what "dirty"
 * means for it, and everything after the loop — completion validation, stage
 * transition, the events it emits on the way out.
 *
 * **`cad-generation.ts` and `assembly-composition.ts` are deliberately not on
 * this engine.** CAD generation drives the FreeCAD agent — one tool-calling
 * conversation per part, several in parallel, with no steering to fold in
 * and an attempt budget rather than a round loop to bound it — and assembly
 * composition does make one model call per assembly node, through
 * `AssemblyPlanner`, but it is a single request with no steering to fold in
 * and no round loop to bound — so it borrows the metering half only: the stage
 * owns a `UsageAccumulator`, hands it to the planner, and writes its own row.
 * A new stage that drives a chat *loop* belongs here; one that calls an
 * external generator, or asks a model exactly one question, does not.
 */

import { chat, maxIterations } from '@tanstack/ai'
import { createToolEventTracker } from './tool-event-tracker'
import {
  isTransientStreamError,
  streamChunkError,
  streamChunkErrorToError,
} from './stream-error'
import { buildSteeringUserMessage } from './guidance'
import type { GuidanceChecker } from './guidance'
import type { StageEvent, UserMessage } from '../types'
import { UsageAccumulator, recordLlmUsage } from '@/ai/usage'
import { maxOutputTokens, splitSystemPrompts } from '@/ai/chat-options'

/** How many times one request is retried after a transient provider failure. */
export const MAX_TRANSIENT_RETRIES = 2

/** Why the loop stopped. The stage decides what each one means for it. */
export type AgentLoopOutcome =
  /** The model finished a round with nothing left to fold in. */
  | { type: 'completed' }
  /**
   * A tool asked the user a question. The stage persists its partial work and
   * pauses — the engine deliberately does not, because what to save differs
   * per stage and the pause event carries stage-specific text.
   */
  | { type: 'clarification' }
  /** The caller's signal fired. */
  | { type: 'aborted' }
  /**
   * Every steering continuation was used. The stage has whatever the last
   * round produced; the guidance that triggered the final restart is in
   * `pendingSteering` and has *not* been folded into the artifacts.
   */
  | { type: 'steering-exhausted'; pendingSteering: Array<UserMessage> }

export interface AgentLoopConfig {
  session: {
    /** The design session — identity for logs, not a foreign key. */
    id: string
    /**
     * The `ai_chat_sessions` row this design session talks through. That, not
     * the design session id, is what `ai_usage_logs.session_id` references —
     * pass the design session's own id and every usage insert fails its FK,
     * silently, because `recordLlmUsage` swallows what it cannot write.
     */
    aiChatSessionId?: string | null
    programId?: string | null
    userId?: string | null
  }
  /** Provider adapter, already resolved through the budget chokepoint. */
  adapter: unknown
  /** For the usage row — what the accumulator cannot know. */
  provider?: string | null
  model?: string | null

  /** Caller's abort signal; each attempt chains its own controller to it. */
  signal?: AbortSignal

  /**
   * Build the messages for one round. `steering` is null on the first round
   * and on a normal continuation; non-null when a restart is folding guidance
   * in, in which case the user turn should be the steering message.
   *
   * A leading `system` entry is the stage's system prompt and is sent in the
   * provider's system slot; one further down stays in the conversation.
   */
  buildMessages: (round: {
    steering: Array<UserMessage> | null
    isResuming: boolean
    index: number
  }) => Array<{ role: string; content: unknown }>
  isResuming: boolean

  tools: unknown
  maxTokens: number
  maxIterations: number

  guidance: GuidanceChecker
  /** Set by the stage's clarification tool; checked at chunk boundaries. */
  clarificationRef: { requested: boolean }

  /**
   * Called per chunk. Persist whatever the stage considers newly dirty and
   * return the event announcing it, or null when nothing changed. The engine
   * does not know what an artifact is; this is the whole of that knowledge.
   */
  persistDirtyArtifacts: () => Promise<StageEvent | null>

  /** 0 disables steering continuations entirely. */
  maxSteeringContinuations: number
  maxTransientRetries?: number

  /**
   * Share one accumulator across several calls, for a stage that drives more
   * than one chat — the BOM stage runs an initial pass, gap continuations and
   * a consolidation pass, and those are one *run* however many requests they
   * take. When given, the caller owns the accumulator and writes the row; the
   * engine only feeds it.
   */
  usage?: UsageAccumulator

  /**
   * Fold drained guidance into the stage's artifacts before the restart. The
   * engine yields the `user_message` events; this persists them.
   */
  applySteering: (drained: Array<UserMessage>) => Promise<void>
}

/**
 * Drive one stage's chat loop.
 *
 * Yields the events the stage should forward to its own consumer, and returns
 * why it stopped. The stage is responsible for everything after that.
 */
export async function* runAgentLoop(
  config: AgentLoopConfig,
): AsyncGenerator<StageEvent, AgentLoopOutcome> {
  const {
    session,
    adapter,
    signal,
    buildMessages,
    isResuming,
    tools,
    maxTokens,
    guidance,
    clarificationRef,
    persistDirtyArtifacts,
    maxSteeringContinuations,
    applySteering,
  } = config
  const maxRetries = config.maxTransientRetries ?? MAX_TRANSIENT_RETRIES

  const usage = config.usage ?? new UsageAccumulator()
  const ownsUsageRow = config.usage === undefined
  const startedAt = Date.now()

  try {
    let steering: Array<UserMessage> | null = null

    for (let round = 0; round <= maxSteeringContinuations; round++) {
      const { systemPrompts, messages } = splitSystemPrompts(
        buildMessages({ steering, isResuming, index: round }),
      )

      // Drained mid-stream; injected as the next round's user turn.
      let drainedSteering: Array<UserMessage> | null = null

      for (let attempt = 0; ; attempt++) {
        // Internal controller: aborted by the caller's signal *and* by steering,
        // which cuts the current chat short so the restart carries guidance.
        const abortController = new AbortController()
        const tracker = createToolEventTracker()
        let retryTransient = false

        // One listener per attempt, removed when the attempt ends. It used to
        // be added and never taken off, so a stage that retried a dropped
        // socket twice and then restarted for steering left five handlers on
        // a signal that lives as long as the SSE request — each one pinning a
        // finished attempt's controller.
        const chainAbort = () => abortController.abort()
        signal?.addEventListener('abort', chainAbort, { once: true })

        try {
          const stream = chat({
            adapter,
            systemPrompts,
            messages,
            tools,
            // The design session is the conversation; the id is also the
            // default prompt-cache key, so rounds and retries share a cache.
            threadId: `design-session-${session.id}`,
            modelOptions: maxOutputTokens(adapter, maxTokens),
            agentLoopStrategy: maxIterations(config.maxIterations),
            // One tool at a time, in the order the model asked: the drafting
            // tools all edit the same in-memory artifact, and a model that
            // adds a node and then parents another to it means that order.
            toolExecution: 'sequential',
            abortController,
          } as never) as AsyncIterable<Record<string, unknown>>

          for await (const chunk of stream) {
            if (clarificationRef.requested || signal?.aborted) {
              // Tear the provider request down before walking away. The
              // chained handler cannot be relied on to have done it:
              // `addEventListener` never fires on a signal that was already
              // aborted when the attempt started, which is exactly what a
              // round or retry boundary produces. Bare `break` left the
              // request running to completion server-side — billed in full,
              // cancelled in name only.
              abortController.abort()
              break
            }

            usage.observe(chunk as { type: string; usage?: unknown })

            // Adapter errors arrive as terminal error chunks, not throws — a
            // loop that ignores them mistakes a rejected request for an empty
            // answer.
            const chunkError = streamChunkError(chunk)
            if (chunkError?.fatal) {
              // Retry transient failures; surface genuine rejections at once.
              if (isTransientStreamError(chunkError) && attempt < maxRetries) {
                retryTransient = true
                abortController.abort()
                yield {
                  type: 'llm_text',
                  text: `\n\n_The AI provider connection dropped (${chunkError.message}) — retrying (attempt ${attempt + 2}/${maxRetries + 1})..._\n\n`,
                }
                break
              }
              throw streamChunkErrorToError(chunkError)
            }
            if (chunkError) {
              yield {
                type: 'llm_text',
                text: `\n\n_${chunkError.message}_\n\n`,
              }
              continue
            }

            if (
              chunk.type === 'TEXT_MESSAGE_CONTENT' &&
              typeof chunk.delta === 'string' &&
              chunk.delta
            ) {
              yield { type: 'llm_text', text: chunk.delta }
            }

            for (const ev of tracker.handle(chunk)) yield ev

            const artifactEvent = await persistDirtyArtifacts()
            if (artifactEvent) yield artifactEvent

            // Mid-stream steering: internally throttled, so this is cheap per
            // chunk. On a hit, cut this chat short and restart.
            const drained = await guidance.maybeDrain()
            if (drained.length > 0) {
              drainedSteering = drained
              abortController.abort()
              break
            }
          }
        } finally {
          // Whatever ended the attempt — completion, a throw, or the consumer
          // abandoning the generator — this attempt's handler comes off.
          signal?.removeEventListener('abort', chainAbort)
        }

        // Re-run the same request on a transient failure; otherwise the stream
        // is finished (clarification, steering, or normal completion).
        if (retryTransient) continue
        break
      }

      if (clarificationRef.requested) return { type: 'clarification' }
      if (signal?.aborted) return { type: 'aborted' }

      if (drainedSteering) {
        if (round === maxSteeringContinuations) {
          // The last round is used up; the guidance has nowhere to go, and
          // pretending otherwise would silently drop it.
          return {
            type: 'steering-exhausted',
            pendingSteering: drainedSteering,
          }
        }
        await applySteering(drainedSteering)
        for (const m of drainedSteering) {
          yield { type: 'user_message', id: m.id, text: m.text }
        }
        yield {
          type: 'llm_text',
          text: '\n\n_Incorporating your guidance..._\n\n',
        }
        steering = drainedSteering
        continue
      }

      return { type: 'completed' }
    }

    // Unreachable while maxSteeringContinuations >= 0: the round-0 pass either
    // returns or continues, and the final round always returns.
    return { type: 'completed' }
  } finally {
    // One row per stage run, whatever ended it — a stage that died mid-stream
    // still spent the tokens it spent. A stage sharing an accumulator writes
    // its own row instead, once, after its last pass.
    const totals = usage.totals
    if (ownsUsageRow && session.userId) {
      await recordLlmUsage({
        userId: session.userId,
        sessionId: session.aiChatSessionId ?? null,
        programId: session.programId ?? null,
        provider: config.provider ?? null,
        model: config.model ?? null,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        durationMs: Date.now() - startedAt,
      })
    }
  }
}

export { buildSteeringUserMessage }
