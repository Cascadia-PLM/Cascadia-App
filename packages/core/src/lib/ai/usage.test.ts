// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * LLM usage capture invariants
 *
 * Usage rows are what a per-program token budget (AI-2) sums over — spend
 * data, so the ledger semantics matter: one row per chat request with the
 * turns summed, attributed to the program where the tokens were spent, and
 * `null` (visible as unmetered) rather than a silent zero when the provider
 * reported nothing.
 *
 * The accumulator + record pair is exactly what the chat route drives — it
 * feeds every stream chunk through `observe` and writes `totals` once in the
 * stream's finally — so these tests pin the request-level invariant without
 * standing up the SSE stack around it.
 *
 * Run: npx vitest run packages/core/src/lib/ai/usage.test.ts
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import { eq } from 'drizzle-orm'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { UsageAccumulator, recordLlmUsage } from '@/lib/ai/usage'
import { aiUsageLogs } from '@/lib/db/schema/ai'
import { programs } from '@/lib/db/schema'
import { takeFirst } from '@/lib/db/take-first'

describe('LLM usage capture', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let programId: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    user = await insertTestUser(testDb.db)
    programId = takeFirst(
      await testDb.db
        .insert(programs)
        .values({
          name: 'Usage P',
          code: `UP-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          createdBy: user.id,
        })
        .returning(),
    ).id
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  it('sums usage across the done chunks of one request into one row, with programId', async () => {
    // The stream shape the agent loop produces for a request with one tool
    // call: content and tool chunks interleaved, one done chunk per model
    // turn, each carrying that turn's usage.
    const usage = new UsageAccumulator()
    const chunks = [
      { type: 'content' },
      { type: 'tool_call' },
      {
        type: 'done',
        usage: { promptTokens: 120, completionTokens: 40, totalTokens: 160 },
      },
      { type: 'tool_result' },
      { type: 'content' },
      {
        type: 'done',
        usage: { promptTokens: 300, completionTokens: 75, totalTokens: 375 },
      },
    ]
    for (const chunk of chunks) usage.observe(chunk)

    await recordLlmUsage({
      userId: user.id,
      programId,
      provider: 'anthropic',
      model: 'claude-test',
      ...usage.totals,
      durationMs: 1234,
    })

    const rows = await testDb.db
      .select()
      .from(aiUsageLogs)
      .where(eq(aiUsageLogs.userId, user.id))

    expect(rows).toHaveLength(1)
    expect(rows[0]!.inputTokens).toBe(420)
    expect(rows[0]!.outputTokens).toBe(115)
    expect(rows[0]!.programId).toBe(programId)
    expect(rows[0]!.provider).toBe('anthropic')
    // An LLM-call row, distinguished from tool-audit rows by a null toolName
    expect(rows[0]!.toolName).toBeNull()
  })

  it('records null, not zero, when no turn reported usage', async () => {
    const usage = new UsageAccumulator()
    usage.observe({ type: 'content' })
    usage.observe({ type: 'done' }) // provider omitted usage entirely

    await recordLlmUsage({
      userId: user.id,
      programId,
      ...usage.totals,
    })

    const row = takeFirst(
      await testDb.db
        .select()
        .from(aiUsageLogs)
        .where(eq(aiUsageLogs.userId, user.id)),
    )
    // Unmetered must be visible as unmetered — a budget summing silent
    // zeros undercounts without anyone knowing.
    expect(row.inputTokens).toBeNull()
    expect(row.outputTokens).toBeNull()
  })

  it('never throws when the insert fails', async () => {
    // A userId that satisfies the type but no FK — the insert fails, the
    // stream that called this must not.
    await expect(
      recordLlmUsage({
        userId: '00000000-0000-0000-0000-000000000000',
        inputTokens: 1,
        outputTokens: 1,
      }),
    ).resolves.toBeUndefined()
  })
})
