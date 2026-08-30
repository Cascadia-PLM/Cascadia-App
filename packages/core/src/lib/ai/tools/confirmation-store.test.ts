// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * AI write confirmation token invariants (AI-3)
 *
 * Security gate. The old flow trusted the model-supplied `confirmed: true`,
 * so any agent — or a prompt injection steering one — could execute a write
 * on the first call with no preview. These tests pin the token contract:
 * minted by the server on the preview, bound to user + tool + exact
 * parameters, short-lived, and redeemable exactly once even under a
 * concurrent double-redeem. The handler-level block proves the gate as
 * wired: no token → preview, never a mutation; redeemed token → execution;
 * replay → fresh preview, no second mutation.
 *
 * Run: npx vitest run packages/core/src/lib/ai/tools/confirmation-store.test.ts
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
import {
  insertTestUser,
  insertTestUserWithRole,
} from '@/__tests__/fixtures/users'
import {
  hashConfirmationParams,
  issueConfirmationToken,
  redeemConfirmationToken,
} from '@/lib/ai/tools/confirmation-store'
import { createProgramHandler } from '@/lib/ai/tools/write-handlers'
import { aiWriteConfirmations } from '@/lib/db/schema/ai'
import { programs } from '@/lib/db/schema'

const TOOL = 'create_item'
const PARAMS = { itemType: 'Part', name: 'Widget', designId: 'abc' }

describe('AI write confirmation tokens', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let other: TestUser

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    user = await insertTestUser(testDb.db)
    other = await insertTestUser(testDb.db)
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  describe('store', () => {
    it('issues a token the same user/tool/params can redeem exactly once', async () => {
      const token = await issueConfirmationToken(user.id, TOOL, PARAMS)
      expect(token.length).toBeGreaterThan(20)

      expect(await redeemConfirmationToken(user.id, TOOL, PARAMS, token)).toBe(
        true,
      )
      // Replay: the row is used; nothing to claim.
      expect(await redeemConfirmationToken(user.id, TOOL, PARAMS, token)).toBe(
        false,
      )
    })

    it('a concurrent double-redeem lets exactly one caller through', async () => {
      const token = await issueConfirmationToken(user.id, TOOL, PARAMS)

      const results = await Promise.all([
        redeemConfirmationToken(user.id, TOOL, PARAMS, token),
        redeemConfirmationToken(user.id, TOOL, PARAMS, token),
      ])

      expect(results.filter(Boolean)).toHaveLength(1)
    })

    it('rejects an expired token', async () => {
      const token = await issueConfirmationToken(user.id, TOOL, PARAMS)
      await testDb.db
        .update(aiWriteConfirmations)
        .set({ expiresAt: new Date(Date.now() - 1000) })
      expect(await redeemConfirmationToken(user.id, TOOL, PARAMS, token)).toBe(
        false,
      )
    })

    it("rejects another user's token — and the attempt burns it", async () => {
      const token = await issueConfirmationToken(user.id, TOOL, PARAMS)

      expect(await redeemConfirmationToken(other.id, TOOL, PARAMS, token)).toBe(
        false,
      )
      // The mismatched attempt consumed the token; the owner cannot use it
      // either. Safer than leaving a probed token live.
      expect(await redeemConfirmationToken(user.id, TOOL, PARAMS, token)).toBe(
        false,
      )
    })

    it('rejects a token redeemed for different parameters or a different tool', async () => {
      const tokenA = await issueConfirmationToken(user.id, TOOL, PARAMS)
      expect(
        await redeemConfirmationToken(
          user.id,
          TOOL,
          { ...PARAMS, name: 'Widget v2' },
          tokenA,
        ),
      ).toBe(false)

      const tokenB = await issueConfirmationToken(user.id, TOOL, PARAMS)
      expect(
        await redeemConfirmationToken(user.id, 'update_item', PARAMS, tokenB),
      ).toBe(false)
    })

    it('rejects a token that was never issued', async () => {
      expect(
        await redeemConfirmationToken(user.id, TOOL, PARAMS, 'forged-token'),
      ).toBe(false)
    })

    it('hashes parameters canonically: key order and undefined members do not matter, confirmation fields are excluded', () => {
      const a = hashConfirmationParams({
        name: 'Widget',
        itemType: 'Part',
        material: undefined,
      })
      const b = hashConfirmationParams({
        itemType: 'Part',
        name: 'Widget',
        confirmed: true,
        confirmationToken: 'anything',
      })
      expect(a).toBe(b)

      const c = hashConfirmationParams({ name: 'Widget', itemType: 'Document' })
      expect(c).not.toBe(a)
    })
  })

  describe('write handler gate (create_program)', () => {
    it('no token → preview with a token, never a mutation; redeem → executes; replay → preview again', async () => {
      const { user: admin } = await insertTestUserWithRole(
        testDb.db,
        'Administrator',
      )
      const context = { userId: admin.id }
      const input = { name: 'Confirmation Gate Program' }

      // Old-style confirmed:true degrades to a preview too — no execution.
      const legacy = await createProgramHandler(
        { ...input, confirmed: true },
        context,
      )
      expect(legacy.requiresConfirmation).toBe(true)
      expect(legacy.confirmationToken).toBeTruthy()

      const preview = await createProgramHandler(input, context)
      expect(preview.requiresConfirmation).toBe(true)
      expect(preview.confirmationToken).toBeTruthy()

      const createdBefore = await testDb.db
        .select()
        .from(programs)
        .where(eq(programs.name, input.name))
      expect(createdBefore).toHaveLength(0)

      const executed = await createProgramHandler(
        { ...input, confirmationToken: preview.confirmationToken },
        context,
      )
      expect(executed.success).toBe(true)
      expect(executed.requiresConfirmation).toBe(false)

      const createdAfter = await testDb.db
        .select()
        .from(programs)
        .where(eq(programs.name, input.name))
      expect(createdAfter).toHaveLength(1)

      // Replaying the spent token yields a fresh preview, not a second row.
      const replay = await createProgramHandler(
        { ...input, confirmationToken: preview.confirmationToken },
        context,
      )
      expect(replay.requiresConfirmation).toBe(true)
      expect(
        await testDb.db
          .select()
          .from(programs)
          .where(eq(programs.name, input.name)),
      ).toHaveLength(1)
    })
  })
})
