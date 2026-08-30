// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Link enrichment — usage metering
 *
 * Data-integrity gate, and the data is money: `ai_usage_logs` is what
 * `enforceMonthlyTokenBudget` sums, so an extraction that writes no row is
 * spend that escapes the budget rather than merely missing telemetry. This
 * one is reachable by anyone who can create a part, once per dropped link.
 *
 * Two properties of the row are deliberate and pinned here. It carries the
 * user who dropped the link, so the spend is attributable; and it carries a
 * null program, because enrichment runs before the item exists and there is
 * no program to charge it to — global scope is the honest answer, not a
 * placeholder.
 *
 * The rows are asserted in the database rather than on a `recordLlmUsage`
 * spy on purpose — that function swallows its own insert failures, so a spy
 * can pass while nothing lands.
 *
 * Run: npx vitest run packages/core/src/lib/items/enrichment/enrich-from-url.test.ts
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
import type * as Adapters from '@/lib/ai/adapters'
import type * as HtmlToText from './html-to-text'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { aiSettings, aiUsageLogs } from '@/lib/db/schema'

/** Scripted chunk that makes the stream throw where a real provider would. */
const THROW = Symbol('stream throws here')

/** Chunks the single chat() call yields. */
let chunks: Array<unknown> = []

vi.mock('@tanstack/ai', async (importOriginal) => ({
  ...(await importOriginal<typeof TanStackAi>()),
  chat: () =>
    (async function* () {
      await Promise.resolve()
      for (const chunk of chunks) {
        if (chunk === THROW) throw new Error('provider stream terminated')
        yield chunk
      }
    })(),
}))

vi.mock('./html-to-text', async (importOriginal) => ({
  // The real `assertSafeUrl` — it is pure, and it is the SSRF gate.
  ...(await importOriginal<typeof HtmlToText>()),
  fetchPageText: () =>
    Promise.resolve({
      title: 'M4 Socket Head Cap Screw',
      description: 'Stainless, 16mm',
      text: 'M4 x 16mm socket head cap screw, A2 stainless, 1.9 g.',
    }),
}))

vi.mock('@/lib/ai/adapters', async (importOriginal) => ({
  // `isAIEnabled` and `loadProviderConfig` stay real, so the settings row
  // seeded below is what resolves. Only the adapter is faked: a real one
  // wants a decryptable API key and nothing downstream of it runs here.
  ...(await importOriginal<typeof Adapters>()),
  getAdapter: () => ({}),
}))

// Imported after the mocks so the factories above are the ones that bind.
const { enrichItemFromUrl } = await import('./enrich-from-url')

const contentChunk = (content: string) => ({ type: 'content', content })
const doneChunk = (promptTokens: number, completionTokens: number) => ({
  type: 'done',
  usage: {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  },
})

const EXTRACTION = JSON.stringify({
  fields: { name: 'M4 x 16 SHCS', partType: 'Purchase' },
  customAttributes: { Material: 'A2 stainless' },
})

describe('enrichItemFromUrl usage metering', () => {
  const testDb = new TestDatabase()
  let user: TestUser

  beforeAll(() => {
    testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    chunks = [contentChunk(EXTRACTION), doneChunk(900, 60)]

    await testDb.beginTransaction()
    user = await insertTestUser(testDb.db)
    await testDb.db.insert(aiSettings).values({
      programId: null,
      provider: 'anthropic',
      config: { provider: 'anthropic', model: 'global-model' },
      enabled: true,
    })
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  function enrich() {
    return enrichItemFromUrl({
      url: 'https://example.com/m4-shcs',
      itemType: 'Part',
      userId: user.id,
    })
  }

  /** Every usage row this call wrote. */
  async function usageRows() {
    return await testDb.db
      .select()
      .from(aiUsageLogs)
      .where(eq(aiUsageLogs.userId, user.id))
  }

  it('records one row against the user who dropped the link', async () => {
    const result = await enrich()

    expect(result.fields.name).toBe('M4 x 16 SHCS')

    const rows = await usageRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      userId: user.id,
      // No program: the item this enriches does not exist yet.
      programId: null,
      // An LLM-call row, not a tool-call row.
      toolName: null,
      provider: 'anthropic',
      model: 'global-model',
      inputTokens: 900,
      outputTokens: 60,
    })
  })

  it('records the tokens a call spent before the stream died', async () => {
    chunks = [doneChunk(900, 0), THROW]

    // The caller sees a graceful "link only" degrade, not a failure — the
    // tokens were still spent, and that is what must not be lost with it.
    const result = await enrich()
    expect(result).toMatchObject({ aiEnabled: true, fields: {} })

    const rows = await usageRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ inputTokens: 900, outputTokens: 0 })
  })
})
