// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * LLM token usage capture.
 *
 * Token counts live on the stream, not on the tools: TanStack AI's `done`
 * chunk carries `usage` per model turn, and the tool wrappers
 * (`tools/permission-wrapper.ts`) never see stream chunks — which is why the
 * old TODO there could never be fixed there. Capture belongs at the stream
 * consumer: the chat route accumulates every turn's usage through
 * `UsageAccumulator` and writes exactly one row per request in its stream's
 * finally block.
 *
 * Missing usage stays `null`, never zero. Not every provider populates
 * `usage` on every done chunk (Ollama through the OpenAI adapter may omit
 * it), and a budget summing zeros silently undercounts — a null row is
 * visible as "unmetered", which is the truth.
 *
 * Design-engine stage loops capture through the same accumulator, in the
 * shared agent-loop engine (`stages/agent-loop.ts`). A stage that drives more
 * than one chat — BOM runs an initial pass, gap continuations and a
 * consolidation pass — shares one accumulator across them and writes the row
 * itself: those are one *run* however many requests they take.
 */

import { db } from '../db'
import { aiUsageLogs } from '../db/schema/ai'
import { aiLogger } from '@/lib/logging/logger'

/** One chat request's worth of LLM usage, summed across model turns. */
export interface LlmUsageRecord {
  userId: string
  sessionId?: string | null
  programId?: string | null
  provider?: string | null
  model?: string | null
  inputTokens: number | null
  outputTokens: number | null
  durationMs?: number | null
}

/**
 * Sums `usage` across the `done` chunks of one request's stream — the agent
 * loop emits one per model turn, so a request with tool calls has several.
 */
export class UsageAccumulator {
  private inputTokens: number | null = null
  private outputTokens: number | null = null

  /** Feed every stream chunk through; only `done` chunks with usage count. */
  observe(chunk: {
    type: string
    usage?: { promptTokens: number; completionTokens: number }
  }): void {
    if (chunk.type !== 'done' || !chunk.usage) return
    this.inputTokens = (this.inputTokens ?? 0) + chunk.usage.promptTokens
    this.outputTokens = (this.outputTokens ?? 0) + chunk.usage.completionTokens
  }

  /** Null when no turn reported usage — unmetered, not zero. */
  get totals(): { inputTokens: number | null; outputTokens: number | null } {
    return { inputTokens: this.inputTokens, outputTokens: this.outputTokens }
  }
}

/**
 * Write one usage row. Never throws: usage logging must not break the stream
 * it measures, so a failed insert is logged and swallowed.
 */
export async function recordLlmUsage(record: LlmUsageRecord): Promise<void> {
  try {
    await db.insert(aiUsageLogs).values({
      userId: record.userId,
      sessionId: record.sessionId ?? null,
      programId: record.programId ?? null,
      // An LLM-call row, not a tool-call row — toolName stays null, which is
      // how the two kinds of rows in this table are told apart.
      toolName: null,
      provider: record.provider ?? null,
      model: record.model ?? null,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      durationMs: record.durationMs ?? null,
    })
  } catch (error) {
    aiLogger.error({ err: error }, 'Failed to record LLM usage')
  }
}
