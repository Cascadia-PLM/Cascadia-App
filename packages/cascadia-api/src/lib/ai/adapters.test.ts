// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Monthly token budget invariants (AI-2)
 *
 * Security/limits gate. `loadProviderConfig` is the chokepoint every AI
 * surface resolves its provider through — chat, all design-engine stages,
 * enrichment — so the budget enforced there is the budget, full stop. These
 * tests pin the ledger semantics: a program's budget sums that program's
 * month-to-date spend and nothing else; the global row's budget bounds the
 * whole instance; no budget means the check costs nothing and blocks
 * nothing.
 *
 * Run: npx vitest run packages/core/src/lib/ai/adapters.test.ts
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
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { loadProviderConfig } from '@/lib/ai/adapters'
import { RateLimitedError } from '@/lib/errors'
import { aiSettings, aiUsageLogs } from '@/lib/db/schema/ai'
import { programs } from '@/lib/db/schema'
import { takeFirst } from '@/lib/db/take-first'

describe('loadProviderConfig — monthly token budget', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let programId: string
  let otherProgramId: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    user = await insertTestUser(testDb.db)
    const insertProgram = async (name: string) =>
      takeFirst(
        await testDb.db
          .insert(programs)
          .values({
            name,
            code: `BP-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            createdBy: user.id,
          })
          .returning(),
      ).id
    programId = await insertProgram('Budget P')
    otherProgramId = await insertProgram('Budget Q')
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  async function insertSettings(
    scopeProgramId: string | null,
    monthlyTokenBudget?: number,
  ) {
    await testDb.db.insert(aiSettings).values({
      programId: scopeProgramId,
      provider: 'ollama',
      enabled: true,
      config: {
        provider: 'ollama',
        model: 'llama3',
        baseURL: 'http://localhost:11434/v1',
        ...(monthlyTokenBudget !== undefined ? { monthlyTokenBudget } : {}),
      },
    })
  }

  async function seedSpend(
    spendProgramId: string | null,
    tokens: number,
    timestamp?: Date,
  ) {
    await testDb.db.insert(aiUsageLogs).values({
      userId: user.id,
      programId: spendProgramId,
      inputTokens: Math.floor(tokens / 2),
      outputTokens: Math.ceil(tokens / 2),
      provider: 'ollama',
      model: 'llama3',
      ...(timestamp ? { timestamp } : {}),
    })
  }

  const lastMonth = () => {
    const d = new Date()
    d.setMonth(d.getMonth() - 1)
    return d
  }

  it('throws RateLimitedError once month-to-date spend reaches the budget', async () => {
    await insertSettings(programId, 1000)
    await seedSpend(programId, 600)
    await seedSpend(programId, 500)

    await expect(loadProviderConfig(programId)).rejects.toThrow(
      RateLimitedError,
    )
  })

  it('does not count last month or another program toward the budget', async () => {
    await insertSettings(programId, 1000)
    await seedSpend(programId, 900) // under budget this month
    await seedSpend(programId, 5000, lastMonth()) // outside the window
    await seedSpend(otherProgramId, 5000) // someone else's spend

    const config = await loadProviderConfig(programId)
    expect(config.provider).toBe('ollama')
    expect(config.monthlyTokenBudget).toBe(1000)
  })

  it('with no budget set, any amount of spend resolves the config', async () => {
    await insertSettings(programId)
    await seedSpend(programId, 10_000_000)

    const config = await loadProviderConfig(programId)
    expect(config.provider).toBe('ollama')
  })

  it("the global row's budget bounds instance-wide spend, whatever program it lands in", async () => {
    await insertSettings(null, 1000)
    await seedSpend(programId, 600)
    await seedSpend(otherProgramId, 500)

    // No program scope: global config, instance-wide sum trips it.
    await expect(loadProviderConfig()).rejects.toThrow(RateLimitedError)

    // A program with no settings row of its own falls back to the same
    // global config — and the same instance-wide ceiling.
    await expect(loadProviderConfig(programId)).rejects.toThrow(
      RateLimitedError,
    )
  })

  it('a budget not yet reached still resolves through the global row', async () => {
    await insertSettings(null, 1000)
    await seedSpend(programId, 400)

    const config = await loadProviderConfig()
    expect(config.provider).toBe('ollama')
  })
})
