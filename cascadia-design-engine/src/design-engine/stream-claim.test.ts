// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Stream claim semantics
 *
 * Data-integrity gate. A design session admits exactly one streaming writer:
 * the stage generators persist artifacts as they go, and two generators
 * interleaving over one session write each other's state back out. Nothing
 * UI-side stops a second tab opening a second stream, so the claim is the
 * server-side refusal — and its lifecycle (refuse fresh, beat on a timer,
 * take over stale, release only your own) is what these tests pin. True
 * cross-connection contention is covered by stream-claim.race.test.ts.
 *
 * Run: npx vitest run cascadia-design-engine/src/design-engine/stream-claim.test.ts
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
import { DesignSessionService } from '@/design-engine/session-service'
import { designSessions } from '@/db/schema/design-engine'
import { programs } from '@/db/schema'
import { ConflictError } from '@/errors'
import { takeFirst } from '@/db/take-first'

/**
 * Heartbeat cadence for the timer tests. Real time against a real Postgres,
 * so every wait below is a generous multiple of it rather than one beat.
 */
const BEAT_MS = 25

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

describe('DesignSessionService stream claim', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let sessionId: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    user = await insertTestUser(testDb.db)
    const program = takeFirst(
      await testDb.db
        .insert(programs)
        .values({
          name: 'Claim P',
          code: `CP-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          createdBy: user.id,
        })
        .returning(),
    )
    const session = await DesignSessionService.create(user.id, {
      description: 'claim fixture',
      programId: program.id,
    })
    sessionId = session.id
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  async function claimRow() {
    return takeFirst(
      await testDb.db
        .select({
          activeStreamId: designSessions.activeStreamId,
          streamClaimedAt: designSessions.streamClaimedAt,
        })
        .from(designSessions)
        .where(eq(designSessions.id, sessionId)),
    )
  }

  async function claimedAtMs(): Promise<number> {
    const at = (await claimRow()).streamClaimedAt
    if (!at) throw new Error('expected the session to hold a stream claim')
    return at.getTime()
  }

  it('refuses a second claim while the first is fresh', async () => {
    const claimId = await DesignSessionService.claimStream(sessionId)
    expect(claimId).toBeTruthy()

    await expect(DesignSessionService.claimStream(sessionId)).rejects.toThrow(
      ConflictError,
    )

    // The refused claim changed nothing.
    expect((await claimRow()).activeStreamId).toBe(claimId)
  })

  it('takes over a claim whose heartbeat went stale', async () => {
    const staleClaim = await DesignSessionService.claimStream(sessionId)

    // A crashed server heartbeats nothing; age the claim past the window.
    await testDb.db
      .update(designSessions)
      .set({ streamClaimedAt: new Date(Date.now() - 10 * 60 * 1000) })
      .where(eq(designSessions.id, sessionId))

    const newClaim = await DesignSessionService.claimStream(sessionId)
    expect(newClaim).not.toBe(staleClaim)
    expect((await claimRow()).activeStreamId).toBe(newClaim)
  })

  it('releases only its own claim', async () => {
    const staleClaim = await DesignSessionService.claimStream(sessionId)
    await testDb.db
      .update(designSessions)
      .set({ streamClaimedAt: new Date(Date.now() - 10 * 60 * 1000) })
      .where(eq(designSessions.id, sessionId))
    const newClaim = await DesignSessionService.claimStream(sessionId)

    // The displaced stream's late release must not evict the new owner.
    await DesignSessionService.releaseStream(sessionId, staleClaim)
    expect((await claimRow()).activeStreamId).toBe(newClaim)

    // The owner's release clears the slot, and the next claim succeeds.
    await DesignSessionService.releaseStream(sessionId, newClaim)
    expect((await claimRow()).activeStreamId).toBeNull()
    await expect(
      DesignSessionService.claimStream(sessionId),
    ).resolves.toBeTruthy()
  })

  it('a late heartbeat from a displaced stream does not revive its claim', async () => {
    const staleClaim = await DesignSessionService.claimStream(sessionId)
    await testDb.db
      .update(designSessions)
      .set({ streamClaimedAt: new Date(Date.now() - 10 * 60 * 1000) })
      .where(eq(designSessions.id, sessionId))
    const newClaim = await DesignSessionService.claimStream(sessionId)
    const ownerClaimedAt = (await claimRow()).streamClaimedAt

    await DesignSessionService.heartbeatStream(sessionId, staleClaim)

    const after = await claimRow()
    expect(after.activeStreamId).toBe(newClaim)
    expect(after.streamClaimedAt?.getTime()).toBe(ownerClaimedAt?.getTime())
  })

  it('keeps the claim alive on a timer while no events flow', async () => {
    // The generation stages this protects go quiet for minutes at a time —
    // one FreeCAD agent run per CAD part, one planner call per assembly — so liveness
    // cannot be a function of event traffic. The timer is the whole point.
    const claimId = await DesignSessionService.claimStream(sessionId)
    const claimedAt = await claimedAtMs()

    const stop = DesignSessionService.startStreamHeartbeat(
      sessionId,
      claimId,
      BEAT_MS,
    )
    try {
      await sleep(BEAT_MS * 6)
    } finally {
      stop()
    }

    expect(await claimedAtMs()).toBeGreaterThan(claimedAt)
    // Beating refreshes liveness without loosening ownership: the second tab
    // is still refused, and the slot still records the original claim.
    await expect(DesignSessionService.claimStream(sessionId)).rejects.toThrow(
      ConflictError,
    )
    expect((await claimRow()).activeStreamId).toBe(claimId)
  })

  it('stops beating once the stream stops it', async () => {
    const claimId = await DesignSessionService.claimStream(sessionId)
    const stop = DesignSessionService.startStreamHeartbeat(
      sessionId,
      claimId,
      BEAT_MS,
    )
    await sleep(BEAT_MS * 6)
    stop()

    // Let any beat that was already in flight when stop() ran land first.
    await sleep(BEAT_MS * 3)
    const settled = await claimedAtMs()

    await sleep(BEAT_MS * 8)
    expect(await claimedAtMs()).toBe(settled)
  })

  it("a displaced stream's running heartbeat never touches the new owner", async () => {
    const staleClaim = await DesignSessionService.claimStream(sessionId)
    await testDb.db
      .update(designSessions)
      .set({ streamClaimedAt: new Date(Date.now() - 10 * 60 * 1000) })
      .where(eq(designSessions.id, sessionId))
    const newClaim = await DesignSessionService.claimStream(sessionId)
    const ownerClaimedAt = await claimedAtMs()

    // The displaced stream is never told it lost the slot — its generator runs
    // on and its timer beats on. Started here rather than before the takeover
    // only so a beat cannot refresh the claim mid-takeover, back when it was
    // still legitimately the owner's; from this line on the state is identical.
    const stop = DesignSessionService.startStreamHeartbeat(
      sessionId,
      staleClaim,
      BEAT_MS,
    )
    try {
      await sleep(BEAT_MS * 8)
    } finally {
      stop()
    }

    const after = await claimRow()
    expect(after.activeStreamId).toBe(newClaim)
    expect(after.streamClaimedAt?.getTime()).toBe(ownerClaimedAt)
  })
})
