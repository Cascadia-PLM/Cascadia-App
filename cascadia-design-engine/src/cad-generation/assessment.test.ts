// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * CAD assessment — metering and program scope
 *
 * Data-integrity gate, and the data is money. This call had two defects at
 * once: it wrote no `ai_usage_logs` row, so its spend escaped
 * `enforceMonthlyTokenBudget` entirely; and it passed no program to
 * `loadProviderConfig`, so a request about one program's part resolved the
 * *global* provider settings and was gated against the *global* budget.
 *
 * The rows are asserted in the database rather than on a `recordLlmUsage`
 * spy on purpose — that function swallows its own insert failures, so a spy
 * can pass while nothing lands. `loadProviderConfig` is the real one, wrapped
 * only to record what it was asked for, so the scoping test proves the
 * program's settings row actually wins rather than that an argument was
 * passed.
 *
 * Run: npx vitest run cascadia-design-engine/src/cad-generation/assessment.test.ts
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { eq } from 'drizzle-orm'
import type * as TanStackAi from '@tanstack/ai'
import type * as Adapters from '@/ai/adapters'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { aiSettings, aiUsageLogs, programs } from '@/db/schema'
import { takeFirst } from '@/db/take-first'

/** Scripted chunk that makes the stream throw where a real provider would. */
const THROW = Symbol('stream throws here')

/** Chunks the single chat() call yields. */
let chunks: Array<unknown> = []
let chatCallCount = 0

vi.mock('@tanstack/ai', async (importOriginal) => ({
  ...(await importOriginal<typeof TanStackAi>()),
  chat: () => {
    chatCallCount++
    return (async function* () {
      await Promise.resolve()
      for (const chunk of chunks) {
        if (chunk === THROW) throw new Error('provider stream terminated')
        yield chunk
      }
    })()
  },
}))

/** What `loadProviderConfig` was asked to resolve, in order. */
const resolvedFor: Array<string | undefined> = []

vi.mock('@/ai/adapters', async (importOriginal) => {
  const actual = await importOriginal<typeof Adapters>()
  return {
    ...actual,
    loadProviderConfig: (programId?: string) => {
      resolvedFor.push(programId)
      return actual.loadProviderConfig(programId)
    },
    // The only mock: a real adapter would want a decryptable API key, and
    // nothing downstream of it runs here anyway.
    getAdapter: () => ({}),
  }
})

// Imported after the mocks so the factories above are the ones that bind.
const { assessPartForCadGeneration } = await import('./assessment')

const contentChunk = (content: string) => ({
  type: 'TEXT_MESSAGE_CONTENT',
  messageId: 'message-1',
  delta: content,
})
const doneChunk = (promptTokens: number, completionTokens: number) => ({
  type: 'RUN_FINISHED',
  usage: {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  },
})

const ASSESSMENT = JSON.stringify({
  canParametric: true,
  template: 'bushing',
  parameters: { od: 20, id: 10, length: 15 },
  units: 'mm',
  reasoning: 'a plain bushing',
})

describe('assessPartForCadGeneration', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let programId: string

  beforeAll(() => {
    testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    chatCallCount = 0
    resolvedFor.length = 0
    chunks = [contentChunk(ASSESSMENT), doneChunk(40, 12)]

    await testDb.beginTransaction()
    user = await insertTestUser(testDb.db)
    const program = takeFirst(
      await testDb.db
        .insert(programs)
        .values({
          name: 'Assessment P',
          code: `ASSP-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          createdBy: user.id,
        })
        .returning(),
    )
    programId = program.id

    // Two settings rows that disagree, so which one resolved is visible in
    // the model name the usage row carries. No apiKey on either: the real
    // `loadProviderConfig` would try to decrypt one, and the adapter that
    // would need it is mocked out.
    await testDb.db.insert(aiSettings).values([
      {
        programId: null,
        provider: 'anthropic',
        config: { provider: 'anthropic', model: 'global-model' },
        enabled: true,
      },
      {
        programId,
        provider: 'anthropic',
        config: { provider: 'anthropic', model: 'program-model' },
        enabled: true,
      },
    ])
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  function assess(scope: { programId?: string } = { programId: undefined }) {
    return assessPartForCadGeneration(
      'Bushing',
      'A bronze bushing',
      'Manufacture',
      { material: 'Bronze' },
      { userId: user.id, programId: scope.programId },
    )
  }

  /** Every usage row this call wrote. */
  async function usageRows() {
    return await testDb.db
      .select()
      .from(aiUsageLogs)
      .where(eq(aiUsageLogs.userId, user.id))
  }

  it('records one row carrying the calling user and the part’s program', async () => {
    const result = await assess({ programId })

    expect(result.canParametric).toBe(true)

    const rows = await usageRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      userId: user.id,
      programId,
      // An LLM-call row, not a tool-call row.
      toolName: null,
      inputTokens: 40,
      outputTokens: 12,
    })
  })

  it('resolves the program’s provider config, not the global one', async () => {
    await assess({ programId })

    expect(resolvedFor).toEqual([programId])
    // The program's settings row won: the global one names a different model.
    expect((await usageRows())[0]).toMatchObject({ model: 'program-model' })
  })

  it('falls back to the global config when the part is in no program', async () => {
    await assess()

    expect(resolvedFor).toEqual([undefined])
    const rows = await usageRows()
    expect(rows[0]).toMatchObject({ model: 'global-model', programId: null })
  })

  it('records the tokens a call spent before the stream died', async () => {
    chunks = [doneChunk(31, 0), THROW]

    await expect(assess({ programId })).rejects.toThrow()

    expect(chatCallCount).toBe(1)
    const rows = await usageRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ inputTokens: 31, outputTokens: 0 })
  })
})
