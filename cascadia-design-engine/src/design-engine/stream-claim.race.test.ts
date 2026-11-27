// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Stream claim under real concurrency
 *
 * Data-integrity gate. Two tabs opening two streams on one design session
 * used to get two generators racing over one artifacts blob. The claim's
 * decision is serialized by an advisory xact lock, and only real
 * connections can prove that: under `TestDatabase` every caller queues on
 * one connection and the race cannot occur. This commits through
 * `ConcurrentTestDatabase`; design sessions cascade from their user, so the
 * harness's cleanup covers them.
 *
 * Run: npx vitest run cascadia-design-engine/src/design-engine/stream-claim.race.test.ts
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { ConcurrentTestDatabase } from '@/__tests__/helpers/concurrent-db'
import { DesignSessionService } from '@/design-engine/session-service'
import { designSessions } from '@/db/schema/design-engine'
import { ConflictError } from '@/errors'
import { takeFirst } from '@/db/take-first'

const CONTENDERS = 6

describe('DesignSessionService.claimStream — concurrent claims', () => {
  const concurrent = new ConcurrentTestDatabase()

  beforeAll(() => {
    concurrent.setup()
  })

  afterAll(async () => {
    await concurrent.teardown()
  })

  afterEach(async () => {
    await concurrent.cleanup()
  })

  it('gives the streaming slot to exactly one of six simultaneous claims', async () => {
    const { user, programId } = await concurrent.seedScope('stream-claim')
    const session = await DesignSessionService.create(user.id, {
      description: 'contended session',
      programId,
    })

    const outcomes = await Promise.allSettled(
      Array.from({ length: CONTENDERS }, () =>
        DesignSessionService.claimStream(session.id),
      ),
    )

    const winners = outcomes.filter((o) => o.status === 'fulfilled')
    const losers = outcomes.filter((o) => o.status === 'rejected')

    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(CONTENDERS - 1)
    // The class the API models — never a raw driver error.
    for (const loser of losers) {
      expect(loser.reason).toBeInstanceOf(ConflictError)
    }

    // The slot records the one winner's claim.
    const row = takeFirst(
      await concurrent.db
        .select({ activeStreamId: designSessions.activeStreamId })
        .from(designSessions)
        .where(eq(designSessions.id, session.id)),
    )
    const winnerClaim = (winners[0] as PromiseFulfilledResult<string>).value
    expect(row.activeStreamId).toBe(winnerClaim)
  })
})
