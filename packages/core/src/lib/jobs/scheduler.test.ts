// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Retry sweep invariants
 *
 * Data-integrity gate. A job that fails retryably is parked 'pending' with a
 * `nextRetryAt` — and until the sweep existed, nothing ever re-published it,
 * so the configured retries were fiction. These tests drive one sweep tick
 * directly (no timers) against a real database, with `RabbitMQClient.publish`
 * spied out — CI runs Postgres, not a broker — and pin the whole loop:
 * park → sweep → re-publish → claim.
 *
 * The sweep is also the recovery path for the submit dual-write hole:
 * `submit` inserts 'pending', publishes, then flips to 'queued', and a crash
 * between insert and publish used to strand the row forever.
 *
 * It is likewise the recovery path for a row stranded at 'queued': the claim
 * is the only thing that ever moves one, so a delivery acked without claiming
 * took the job's last wake-up with it. `queued_at` plus a grace window is the
 * lease that recovers those.
 *
 * The stale-running sweep covers the other end of the same durability
 * problem: only the worker executing a job ever moves it off 'running', so a
 * worker that dies mid-execution wedged its row there permanently.
 *
 * The last block races the sweep's own publish window: `requeueForRetry`
 * publishes first and flips the row to 'queued' second, so a worker can claim
 * the delivery in between. Its flip is guarded to the statuses a re-publish
 * may legitimately move, which is what keeps the claim from being undone.
 *
 * Run: npx vitest run packages/core/src/lib/jobs/scheduler.test.ts
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
import { z } from 'zod'
import type { MockInstance } from 'vitest'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { JobStatus } from '@/lib/db/schema/jobs'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { JobService } from '@/lib/jobs/JobService'
import { JobTypeRegistry } from '@/lib/jobs/registry'
import { RabbitMQClient } from '@/lib/jobs/rabbitmq/client'
import {
  clearContributedMaintenanceJobTypes,
  registerMaintenanceJobType,
  sweepMaintenanceJobs,
  sweepRetryableJobs,
  sweepStaleRunningJobs,
} from '@/lib/jobs/scheduler'
import { jobs } from '@/lib/db/schema/jobs'
import { takeFirst } from '@/lib/db/take-first'

const TEST_TYPE = 'test.jobs.retry-sweep'
const MAX_ATTEMPTS = 3
/** Registered with a timeout far longer than the sweep's grace window. */
const LONG_RUNNING_TYPE = 'test.jobs.long-running'
const LONG_RUNNING_TIMEOUT_MS = 10 * 60 * 1000
/** Deliberately never registered — the foreign-fleet row. */
const UNREGISTERED_TYPE = 'test.jobs.owned-by-another-fleet'
/** Stand-ins for a module's contributed maintenance entries. */
const CONTRIBUTED_TYPE = 'test.jobs.maintenance-contributed'
const CONTRIBUTED_SLOW_TYPE = 'test.jobs.maintenance-contributed-slow'

describe('retry sweep', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let publishSpy: MockInstance<typeof RabbitMQClient.publish>

  beforeAll(async () => {
    await testDb.setup()
    JobTypeRegistry.register({
      type: TEST_TYPE,
      label: 'Retry sweep fixture',
      routingKey: 'jobs.test.retry-sweep',
      payloadSchema: z.object({}),
      resultSchema: z.object({}),
      timeout: 1000,
      maxAttempts: MAX_ATTEMPTS,
      retryDelays: [30000, 60000, 120000],
      priority: 'normal',
    })
    JobTypeRegistry.register({
      type: LONG_RUNNING_TYPE,
      label: 'Long-running fixture',
      routingKey: 'jobs.test.long-running',
      payloadSchema: z.object({}),
      resultSchema: z.object({}),
      timeout: LONG_RUNNING_TIMEOUT_MS,
      maxAttempts: MAX_ATTEMPTS,
      retryDelays: [30000, 60000, 120000],
      priority: 'normal',
    })
    // A contributed maintenance entry names a type the sweep submits, so the
    // stand-ins have to be real registered types like any other.
    for (const type of [CONTRIBUTED_TYPE, CONTRIBUTED_SLOW_TYPE]) {
      JobTypeRegistry.register({
        type,
        label: 'Contributed maintenance fixture',
        routingKey: 'jobs.test.maintenance-contributed',
        payloadSchema: z.object({}),
        resultSchema: z.object({}),
        timeout: 60000,
        maxAttempts: 1,
        retryDelays: [],
        priority: 'normal',
      })
    }
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    user = await insertTestUser(testDb.db)
    publishSpy = vi
      .spyOn(RabbitMQClient, 'publish')
      .mockResolvedValue(undefined)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await testDb.rollback()
  })

  async function insertJob(
    status: JobStatus,
    overrides: Partial<typeof jobs.$inferInsert> = {},
  ) {
    return takeFirst(
      await testDb.db
        .insert(jobs)
        .values({
          type: TEST_TYPE,
          status,
          payload: {},
          createdBy: user.id,
          maxAttempts: MAX_ATTEMPTS,
          ...overrides,
        })
        .returning(),
    )
  }

  async function rowFor(jobId: string) {
    const row = await JobService.get(jobId)
    if (!row) throw new Error(`job ${jobId} vanished`)
    return row
  }

  it('re-publishes a parked job whose backoff elapsed, end to end to the next claim', async () => {
    // Park the job the way the worker does: claim it, then fail it — and
    // backdate the resulting nextRetryAt so the backoff has elapsed.
    const job = await insertJob('queued')
    await JobService.claimJob(job.id)
    await JobService.markFailed(job.id, 'transient failure')
    await testDb.db
      .update(jobs)
      .set({ nextRetryAt: new Date(Date.now() - 1000) })
      .where(eq(jobs.id, job.id))

    const requeued = await sweepRetryableJobs()

    expect(requeued).toBe(1)
    expect(publishSpy).toHaveBeenCalledTimes(1)

    const parked = await rowFor(job.id)
    expect(parked.status).toBe('queued')
    expect(parked.nextRetryAt).toBeNull()

    // The re-published delivery is claimable — the retry actually runs.
    const claimed = await JobService.claimJob(job.id)
    expect(claimed).not.toBeNull()
    expect(claimed!.attempts).toBe(2)
  })

  it('leaves a parked job alone until its backoff elapses', async () => {
    const job = await insertJob('queued')
    await JobService.claimJob(job.id)
    await JobService.markFailed(job.id, 'transient failure')
    // markFailed set nextRetryAt 30s out — still in the future.

    expect(await sweepRetryableJobs()).toBe(0)
    expect(publishSpy).not.toHaveBeenCalled()
    expect((await rowFor(job.id)).status).toBe('pending')
  })

  it('recovers a submit-crash orphan once past the grace window, never a fresh one', async () => {
    // The dual-write hole: submit inserted the row, crashed before
    // publishing. Status pending, no nextRetryAt, createdAt in the past.
    const orphan = await insertJob('pending', {
      createdAt: new Date(Date.now() - 3 * 60 * 1000),
    })
    // A submit still in flight looks identical except for its age.
    const inFlight = await insertJob('pending')

    const requeued = await sweepRetryableJobs()

    expect(requeued).toBe(1)
    expect((await rowFor(orphan.id)).status).toBe('queued')
    expect((await rowFor(inFlight.id)).status).toBe('pending')
  })

  it('never touches a terminally failed job; admin retry still re-queues it', async () => {
    const job = await insertJob('failed', {
      attempts: MAX_ATTEMPTS,
      completedAt: new Date(),
    })

    expect(await sweepRetryableJobs()).toBe(0)
    expect(publishSpy).not.toHaveBeenCalled()
    expect((await rowFor(job.id)).status).toBe('failed')

    // The deliberate path back from 'failed' is the admin retry, which
    // resets the ledger and publishes directly.
    const retried = await JobService.retry(job.id, user.id)
    expect(retried.status).toBe('queued')
    expect(retried.attempts).toBe(0)
    expect(publishSpy).toHaveBeenCalledTimes(1)
  })

  it('leaves the row pending when the publish fails, for the next tick', async () => {
    const job = await insertJob('queued')
    await JobService.claimJob(job.id)
    await JobService.markFailed(job.id, 'transient failure')
    await testDb.db
      .update(jobs)
      .set({ nextRetryAt: new Date(Date.now() - 1000) })
      .where(eq(jobs.id, job.id))

    publishSpy.mockRejectedValueOnce(new Error('broker unreachable'))

    // The sweep survives the failure and reports nothing requeued.
    expect(await sweepRetryableJobs()).toBe(0)

    const row = await rowFor(job.id)
    expect(row.status).toBe('pending')
    expect(row.nextRetryAt).not.toBeNull()

    // Next tick, broker back: the same row goes out.
    expect(await sweepRetryableJobs()).toBe(1)
    expect((await rowFor(job.id)).status).toBe('queued')
  })

  describe('maintenance sweep (JOBS-4)', () => {
    const MAINTENANCE_TYPES = [
      'maintenance.session.cleanup',
      'maintenance.cache.cleanup',
    ] as const

    async function insertMaintenanceJob(
      type: string,
      status: JobStatus,
      createdAt?: Date,
    ) {
      await testDb.db.insert(jobs).values({
        type,
        status,
        payload: {},
        createdBy: null,
        maxAttempts: 3,
        ...(createdAt ? { createdAt } : {}),
      })
    }

    it('submits exactly one of each maintenance type on an empty table, then nothing', async () => {
      expect(await sweepMaintenanceJobs()).toBe(2)

      for (const type of MAINTENANCE_TYPES) {
        const rows = await testDb.db
          .select()
          .from(jobs)
          .where(eq(jobs.type, type))
        expect(rows).toHaveLength(1)
        // System submission: no user attributed, published normally.
        expect(rows[0]!.createdBy).toBeNull()
        expect(rows[0]!.status).toBe('queued')
      }
      expect(publishSpy).toHaveBeenCalledTimes(2)

      // The guard sees the fresh rows — no unbounded accumulation.
      expect(await sweepMaintenanceJobs()).toBe(0)
      expect(publishSpy).toHaveBeenCalledTimes(2)
    })

    it('submits nothing while a job of the type is active or recent', async () => {
      await insertMaintenanceJob('maintenance.session.cleanup', 'running')
      await insertMaintenanceJob('maintenance.cache.cleanup', 'completed')

      expect(await sweepMaintenanceJobs()).toBe(0)
      expect(publishSpy).not.toHaveBeenCalled()
    })

    it('re-submits a type whose last run is older than the period', async () => {
      const overADayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000)
      await insertMaintenanceJob(
        'maintenance.session.cleanup',
        'completed',
        overADayAgo,
      )
      // cache-cleanup ran recently and stays quiet.
      await insertMaintenanceJob('maintenance.cache.cleanup', 'completed')

      expect(await sweepMaintenanceJobs()).toBe(1)

      const sessionRows = await testDb.db
        .select()
        .from(jobs)
        .where(eq(jobs.type, 'maintenance.session.cleanup'))
      expect(sessionRows).toHaveLength(2)
    })

    describe('contributed types (AA2-3)', () => {
      /** How many entries core itself ships, so counts read as base + N. */
      const BASE_COUNT = MAINTENANCE_TYPES.length

      async function rowsOfType(type: string) {
        return testDb.db.select().from(jobs).where(eq(jobs.type, type))
      }

      afterEach(() => {
        clearContributedMaintenanceJobTypes()
      })

      it("submits a contributed type alongside core's own", async () => {
        registerMaintenanceJobType({
          type: CONTRIBUTED_TYPE,
          enabled: () => true,
        })

        expect(await sweepMaintenanceJobs()).toBe(BASE_COUNT + 1)

        const rows = await rowsOfType(CONTRIBUTED_TYPE)
        expect(rows).toHaveLength(1)
        // The system path, exactly like core's own maintenance submissions.
        expect(rows[0]!.createdBy).toBeNull()
        expect(rows[0]!.status).toBe('queued')

        // And the recency guard covers it too — no unbounded accumulation.
        expect(await sweepMaintenanceJobs()).toBe(0)
      })

      it("skips a contributed type whose enabled() says no, and still submits core's", async () => {
        registerMaintenanceJobType({
          type: CONTRIBUTED_TYPE,
          enabled: () => false,
        })

        expect(await sweepMaintenanceJobs()).toBe(BASE_COUNT)
        expect(await rowsOfType(CONTRIBUTED_TYPE)).toHaveLength(0)
        for (const type of MAINTENANCE_TYPES) {
          expect(await rowsOfType(type)).toHaveLength(1)
        }
      })

      it("measures recency against the entry's own period, not the shared one", async () => {
        // Both cutoffs disagree with the shared 24h default, in opposite
        // directions — which is what a single `since` computed once for the
        // whole sweep would get wrong twice over.
        registerMaintenanceJobType({
          type: CONTRIBUTED_TYPE,
          periodMs: () => 60 * 60 * 1000,
        })
        registerMaintenanceJobType({
          type: CONTRIBUTED_SLOW_TYPE,
          periodMs: () => 48 * 60 * 60 * 1000,
        })
        // Two hours old: stale for a one-hour period, recent for the shared one.
        await insertMaintenanceJob(
          CONTRIBUTED_TYPE,
          'completed',
          new Date(Date.now() - 2 * 60 * 60 * 1000),
        )
        // Twenty-five hours old: recent for a two-day period, stale for the
        // shared one.
        await insertMaintenanceJob(
          CONTRIBUTED_SLOW_TYPE,
          'completed',
          new Date(Date.now() - 25 * 60 * 60 * 1000),
        )

        expect(await sweepMaintenanceJobs()).toBe(BASE_COUNT + 1)

        expect(await rowsOfType(CONTRIBUTED_TYPE)).toHaveLength(2)
        expect(await rowsOfType(CONTRIBUTED_SLOW_TYPE)).toHaveLength(1)
      })

      it('treats a non-positive period as the opt-out rather than every tick', async () => {
        registerMaintenanceJobType({
          type: CONTRIBUTED_TYPE,
          periodMs: () => 0,
        })

        expect(await sweepMaintenanceJobs()).toBe(BASE_COUNT)
        expect(await rowsOfType(CONTRIBUTED_TYPE)).toHaveLength(0)
      })

      it('lets a throwing contribution fail alone, never the whole sweep', async () => {
        registerMaintenanceJobType({
          type: CONTRIBUTED_TYPE,
          enabled: () => {
            throw new Error('module callback blew up')
          },
        })

        expect(await sweepMaintenanceJobs()).toBe(BASE_COUNT)
        expect(await rowsOfType(CONTRIBUTED_TYPE)).toHaveLength(0)
      })

      it('refuses a second entry for a type already registered', () => {
        registerMaintenanceJobType({ type: CONTRIBUTED_TYPE })

        expect(() =>
          registerMaintenanceJobType({ type: CONTRIBUTED_TYPE }),
        ).toThrow()
        // Core's own entries are just as protected.
        expect(() =>
          registerMaintenanceJobType({ type: 'maintenance.cache.cleanup' }),
        ).toThrow()
      })
    })
  })

  describe('stale-running sweep (JOBS2-2)', () => {
    // The fixture type's timeout is 1s, so the grace dominates its lease:
    // reapable once it has been running for grace + 1s.
    const GRACE_MS = 60_000
    const PAST_LEASE_MS = 2 * GRACE_MS

    /** A 'running' row whose worker started it `agoMs` ago and never came back. */
    async function insertLostRunning(
      agoMs: number,
      overrides: Partial<typeof jobs.$inferInsert> = {},
    ) {
      return insertJob('running', {
        startedAt: new Date(Date.now() - agoMs),
        attempts: 1,
        ...overrides,
      })
    }

    it("parks a lost worker's job for retry, and the retry sweep picks it up", async () => {
      const job = await insertLostRunning(PAST_LEASE_MS)

      expect(await sweepStaleRunningJobs(GRACE_MS)).toBe(1)

      const parked = await rowFor(job.id)
      expect(parked.status).toBe('pending')
      expect(parked.error).not.toBeNull()
      expect(parked.nextRetryAt).not.toBeNull()
      expect(parked.nextRetryAt!.getTime()).toBeGreaterThan(Date.now())
      // The reap leaves an operator-readable trace on the job itself.
      const logs = await JobService.getLogs(job.id)
      expect(logs.some((log) => log.level === 'warn')).toBe(true)

      // Off 'running', so a second pass finds nothing to reap.
      expect(await sweepStaleRunningJobs(GRACE_MS)).toBe(0)

      // And the row is back in the ordinary retry pipeline, not a dead end.
      await testDb.db
        .update(jobs)
        .set({ nextRetryAt: new Date(Date.now() - 1000) })
        .where(eq(jobs.id, job.id))
      expect(await sweepRetryableJobs()).toBe(1)
      expect((await rowFor(job.id)).status).toBe('queued')
    })

    it('fails a lost job terminally when the lost execution was its last attempt', async () => {
      const job = await insertLostRunning(PAST_LEASE_MS, {
        attempts: MAX_ATTEMPTS,
      })

      expect(await sweepStaleRunningJobs(GRACE_MS)).toBe(1)

      const row = await rowFor(job.id)
      expect(row.status).toBe('failed')
      expect(row.completedAt).not.toBeNull()
      expect(row.nextRetryAt).toBeNull()
    })

    it('never touches a running job still inside its lease', async () => {
      // Inside the grace window: barely started.
      const fresh = await insertLostRunning(10_000)
      // Well past the grace window, but nowhere near its own type's timeout.
      // The lease is the type's timeout *plus* the grace, never the grace
      // alone — a slow type must not be reaped while it is still working.
      const longRunner = await insertLostRunning(LONG_RUNNING_TIMEOUT_MS / 2, {
        type: LONG_RUNNING_TYPE,
      })

      expect(await sweepStaleRunningJobs(GRACE_MS)).toBe(0)

      expect((await rowFor(fresh.id)).status).toBe('running')
      expect((await rowFor(longRunner.id)).status).toBe('running')
    })

    it('never touches a running job whose type this process does not know', async () => {
      const foreign = await insertLostRunning(PAST_LEASE_MS, {
        type: UNREGISTERED_TYPE,
      })
      const owned = await insertLostRunning(PAST_LEASE_MS)

      // Skipped per row, not a bail-out: the type this process does own is
      // still reaped in the same pass.
      expect(await sweepStaleRunningJobs(GRACE_MS)).toBe(1)

      expect((await rowFor(foreign.id)).status).toBe('running')
      expect((await rowFor(owned.id)).status).toBe('pending')
    })

    it("makes the lost worker's late marks no-ops, parked or terminal", async () => {
      const parked = await insertLostRunning(PAST_LEASE_MS)
      const terminal = await insertLostRunning(PAST_LEASE_MS, {
        attempts: MAX_ATTEMPTS,
      })

      expect(await sweepStaleRunningJobs(GRACE_MS)).toBe(2)
      const reapedAt = await rowFor(parked.id)

      // The zombie handler finally reports, long after its row was reaped.
      await JobService.markCompleted(parked.id, { late: true })
      await JobService.markFailed(parked.id, 'late failure')
      await JobService.markCompleted(terminal.id, { late: true })

      const parkedRow = await rowFor(parked.id)
      expect(parkedRow.status).toBe('pending')
      expect(parkedRow.result).toBeNull()
      // Neither mark re-parked it, so the backoff the reap set still stands.
      expect(parkedRow.nextRetryAt).toEqual(reapedAt.nextRetryAt)

      const terminalRow = await rowFor(terminal.id)
      expect(terminalRow.status).toBe('failed')
      expect(terminalRow.result).toBeNull()
    })
  })

  describe("the sweep's publish window (JOBS2-3)", () => {
    /** A parked row the sweep will pick up on its next pass. */
    async function insertDueForRetry() {
      return insertJob('pending', {
        attempts: 1,
        nextRetryAt: new Date(Date.now() - 1000),
      })
    }

    it('never demotes a job a worker claimed while the sweep was publishing', async () => {
      const job = await insertDueForRetry()
      // The delivery is live before the flip to 'queued' lands, and the
      // claim is exactly what the sweep re-published the job for.
      publishSpy.mockImplementation(async (_routingKey, message) => {
        await JobService.claimJob(message.jobId)
      })

      await sweepRetryableJobs()

      const row = await rowFor(job.id)
      expect(row.status).toBe('running')
      expect(row.attempts).toBe(2)
    })

    it('never resurrects a job cancelled while the sweep was publishing', async () => {
      const job = await insertDueForRetry()
      publishSpy.mockImplementation(async (_routingKey, message) => {
        await JobService.cancel(message.jobId)
      })

      await sweepRetryableJobs()

      const row = await rowFor(job.id)
      expect(row.status).toBe('cancelled')
      expect(row.completedAt).not.toBeNull()
    })

    it('still re-publishes a row that is already queued', async () => {
      // 'queued' is in the guard's allow-list on purpose: sweepers are
      // deliberately unguarded against each other, so a second pass writing
      // 'queued' over 'queued' is the ordinary duplicate rather than a race
      // lost — and it is the seam a queued-staleness sweep re-publishes on.
      const staleQueuedAt = new Date(Date.now() - 60_000)
      const job = await insertJob('queued', { queuedAt: staleQueuedAt })

      await JobService.requeueForRetry(job.id)

      expect(publishSpy).toHaveBeenCalledTimes(1)
      const row = await rowFor(job.id)
      expect(row.status).toBe('queued')
      expect(row.queuedAt!.getTime()).toBeGreaterThan(staleQueuedAt.getTime())
    })

    it.each(['completed', 'failed', 'cancelled'] as const)(
      'leaves a %s row settled even though it published',
      async (status) => {
        const job = await insertJob(status, { completedAt: new Date() })

        await JobService.requeueForRetry(job.id)

        expect((await rowFor(job.id)).status).toBe(status)
      },
    )
  })

  describe('queued-staleness sweep (JOBS2-4)', () => {
    /**
     * Comfortably past the sweep's 10-minute default grace, so these tests
     * read the same default a deployment runs with rather than an override.
     */
    const PAST_GRACE_MS = 30 * 60 * 1000

    /**
     * A row whose message reached the broker and was then consumed without a
     * claim — a worker whose claim raised and acked anyway, or a broker that
     * lost the message. Indistinguishable from a healthy 'queued' row except
     * by how long it has been one.
     */
    async function insertStrandedQueued() {
      return insertJob('queued', {
        queuedAt: new Date(Date.now() - PAST_GRACE_MS),
      })
    }

    it('re-publishes a stranded queued job, end to end to the next claim', async () => {
      const job = await insertStrandedQueued()

      const requeued = await sweepRetryableJobs()

      expect(requeued).toBe(1)
      expect(publishSpy).toHaveBeenCalledTimes(1)

      // Still 'queued' — but on a delivery that exists this time, and with
      // the lease restarted.
      const republished = await rowFor(job.id)
      expect(republished.status).toBe('queued')
      expect(republished.queuedAt!.getTime()).toBeGreaterThan(
        Date.now() - PAST_GRACE_MS,
      )

      // The whole point: the job runs. Before this sweep the row sat here
      // until an admin cancelled it.
      const claimed = await JobService.claimJob(job.id)
      expect(claimed).not.toBeNull()
      expect(claimed!.attempts).toBe(1)
    })

    it('leaves a queued job alone until the grace elapses', async () => {
      // A healthy job waiting its turn behind a backlog looks exactly like a
      // stranded one, so the grace is the only thing separating them.
      const queuedAt = new Date()
      const fresh = await insertJob('queued', { queuedAt })

      expect(await sweepRetryableJobs()).toBe(0)
      expect(publishSpy).not.toHaveBeenCalled()

      const row = await rowFor(fresh.id)
      expect(row.status).toBe('queued')
      expect(row.queuedAt!.getTime()).toBe(queuedAt.getTime())
    })

    it('re-publishes a stranded queued job at most once per grace window', async () => {
      const job = await insertStrandedQueued()

      expect(await sweepRetryableJobs()).toBe(1)

      // `requeueForRetry` restamped `queued_at`, so the row is fresh again
      // and every tick until the grace elapses anew leaves it alone. That
      // restamp is what bounds a legitimately deep backlog to one duplicate
      // delivery per row per window instead of one per tick.
      expect(await sweepRetryableJobs()).toBe(0)
      expect(await sweepRetryableJobs()).toBe(0)
      expect(publishSpy).toHaveBeenCalledTimes(1)
      expect((await rowFor(job.id)).status).toBe('queued')
    })

    it('never selects a cancelled or running row, however long it waited', async () => {
      // Both were queued far longer ago than the grace — the status is what
      // keeps them out, not the timestamp. The running one matters most: a
      // re-publish would hand a live job a second delivery.
      const longAgo = new Date(Date.now() - PAST_GRACE_MS)
      const cancelled = await insertJob('cancelled', {
        queuedAt: longAgo,
        completedAt: new Date(),
      })
      const running = await insertJob('running', {
        queuedAt: longAgo,
        startedAt: new Date(),
        attempts: 1,
      })

      const due = await JobService.getJobsForRetry()
      expect(due.map((job) => job.id)).not.toContain(cancelled.id)
      expect(due.map((job) => job.id)).not.toContain(running.id)

      // And nothing publishes, so neither row is resurrected or duplicated.
      expect(await sweepRetryableJobs()).toBe(0)
      expect(publishSpy).not.toHaveBeenCalled()
      expect((await rowFor(cancelled.id)).status).toBe('cancelled')
      expect((await rowFor(running.id)).status).toBe('running')
    })
  })
})
