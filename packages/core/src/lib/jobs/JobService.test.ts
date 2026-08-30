// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Job claim and retry-parking invariants
 *
 * Data-integrity gate. RabbitMQ promises at-least-once delivery, so the same
 * job message can arrive twice — after a connection drop, or when the retry
 * sweep re-publishes a job a worker already took. Execution used to start
 * with a read ("is it cancelled?") followed by a blind status write, so both
 * deliveries ran the job. `claimJob` is the fix: one atomic UPDATE that only
 * a claimable row satisfies, making the second delivery's claim come back
 * empty.
 *
 * The claim also settles what `attempts` means: an execution that starts is
 * an attempt, counted at claim time — the semantics the Python workers had
 * all along, while the TS side counted at failure time. `markFailed` now
 * only compares, so these tests pin the whole ledger: a job that fails to
 * the end reports exactly maxAttempts executions, not double.
 *
 * The last block covers the window the claim opened up: `submit` and `retry`
 * publish first and flip the row to 'queued' second, so a worker can claim
 * (or an operator cancel) the job in between. Those flips are guarded to the
 * status they expect, and these tests race them on purpose.
 *
 * Run: npx vitest run packages/core/src/lib/jobs/JobService.test.ts
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
import { z } from 'zod'
import type { MockInstance } from 'vitest'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { JobStatus } from '@/lib/db/schema/jobs'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { JobService } from '@/lib/jobs/JobService'
import { JobTypeRegistry } from '@/lib/jobs/registry'
import { RabbitMQClient } from '@/lib/jobs/rabbitmq/client'
import { createJobContext, executeWithTimeout } from '@/lib/jobs/worker/index'
import { ValidationError } from '@/lib/errors'
import { jobs } from '@/lib/db/schema/jobs'
import { takeFirst } from '@/lib/db/take-first'

const TEST_TYPE = 'test.jobs.claim-invariants'
const MAX_ATTEMPTS = 3
const RETRY_DELAYS = [30000, 60000, 120000]

describe('JobService — claim and retry invariants', () => {
  const testDb = new TestDatabase()
  let user: TestUser

  beforeAll(async () => {
    await testDb.setup()
    JobTypeRegistry.register({
      type: TEST_TYPE,
      label: 'Claim invariant fixture',
      routingKey: 'jobs.test.claim',
      payloadSchema: z.object({}),
      resultSchema: z.object({}),
      timeout: 1000,
      maxAttempts: MAX_ATTEMPTS,
      retryDelays: RETRY_DELAYS,
      priority: 'normal',
    })
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    user = await insertTestUser(testDb.db)
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  /**
   * `retryDelays` defaults to null — the legacy shape of a row submitted
   * before the column existed, so the existing backoff tests keep exercising
   * the config fallback. Pass a schedule to write the snapshot a real
   * `JobService.submit` would.
   */
  async function insertJob(
    status: JobStatus,
    attempts = 0,
    retryDelays: Array<number> | null = null,
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
          attempts,
          retryDelays,
        })
        .returning(),
    )
  }

  async function rowFor(jobId: string) {
    const row = await JobService.get(jobId)
    if (!row) throw new Error(`job ${jobId} vanished`)
    return row
  }

  describe('claimJob', () => {
    it('claims a queued job: running, attempts counted exactly once', async () => {
      const job = await insertJob('queued')

      const claimed = await JobService.claimJob(job.id)

      expect(claimed).not.toBeNull()
      expect(claimed!.status).toBe('running')
      expect(claimed!.attempts).toBe(1)
      expect(claimed!.startedAt).not.toBeNull()

      const row = await rowFor(job.id)
      expect(row.status).toBe('running')
      expect(row.attempts).toBe(1)
    })

    it('claims a pending job (the retry-parked shape)', async () => {
      const job = await insertJob('pending', 1)

      const claimed = await JobService.claimJob(job.id)

      expect(claimed).not.toBeNull()
      expect(claimed!.attempts).toBe(2)
    })

    it('refuses the second claim for the same job', async () => {
      const job = await insertJob('queued')

      const first = await JobService.claimJob(job.id)
      const second = await JobService.claimJob(job.id)

      expect(first).not.toBeNull()
      expect(second).toBeNull()

      // The refused duplicate changed nothing.
      const row = await rowFor(job.id)
      expect(row.status).toBe('running')
      expect(row.attempts).toBe(1)
    })

    it.each(['cancelled', 'completed', 'failed'] as const)(
      'refuses to claim a %s job',
      async (status) => {
        const job = await insertJob(status)

        expect(await JobService.claimJob(job.id)).toBeNull()

        const row = await rowFor(job.id)
        expect(row.status).toBe(status)
        expect(row.attempts).toBe(0)
      },
    )

    it('returns null for a job that does not exist', async () => {
      expect(
        await JobService.claimJob('00000000-0000-0000-0000-000000000000'),
      ).toBeNull()
    })
  })

  describe('markFailed after a claim', () => {
    it('parks for retry without touching attempts, with the first backoff delay', async () => {
      const job = await insertJob('queued')
      await JobService.claimJob(job.id)

      const before = Date.now()
      await JobService.markFailed(job.id, 'boom')

      const row = await rowFor(job.id)
      expect(row.status).toBe('pending')
      expect(row.attempts).toBe(1) // counted at claim, not re-counted here
      expect(row.error).toBe('boom')
      expect(row.nextRetryAt).not.toBeNull()
      const delay = row.nextRetryAt!.getTime() - before
      expect(delay).toBeGreaterThan(RETRY_DELAYS[0]! - 5000)
      expect(delay).toBeLessThan(RETRY_DELAYS[0]! + 5000)
    })

    it('walks the backoff schedule as attempts accumulate', async () => {
      const job = await insertJob('queued')

      await JobService.claimJob(job.id)
      await JobService.markFailed(job.id, 'first')

      await JobService.claimJob(job.id)
      const before = Date.now()
      await JobService.markFailed(job.id, 'second')

      const row = await rowFor(job.id)
      expect(row.status).toBe('pending')
      expect(row.attempts).toBe(2)
      const delay = row.nextRetryAt!.getTime() - before
      expect(delay).toBeGreaterThan(RETRY_DELAYS[1]! - 5000)
      expect(delay).toBeLessThan(RETRY_DELAYS[1]! + 5000)
    })

    it('fails terminally at the last allowed attempt', async () => {
      const job = await insertJob('queued', MAX_ATTEMPTS - 1)
      await JobService.claimJob(job.id) // attempts -> MAX_ATTEMPTS

      await JobService.markFailed(job.id, 'final straw')

      const row = await rowFor(job.id)
      expect(row.status).toBe('failed')
      expect(row.attempts).toBe(MAX_ATTEMPTS)
      expect(row.completedAt).not.toBeNull()
    })

    it('parks on the schedule carried by the row, not the registry (JOBS2-10)', async () => {
      // The row's snapshot is deliberately nothing like the registered
      // config's 30s first delay. Whichever the Python workers and this
      // implementation read, they must read the same one — and that is the
      // row, so a per-type schedule governs Python-executed types too.
      const ROW_DELAY_MS = 7000
      const job = await insertJob('queued', 0, [ROW_DELAY_MS])
      await JobService.claimJob(job.id)

      const before = Date.now()
      await JobService.markFailed(job.id, 'boom')

      const row = await rowFor(job.id)
      expect(row.status).toBe('pending')
      const delay = row.nextRetryAt!.getTime() - before
      expect(delay).toBeGreaterThan(ROW_DELAY_MS - 5000)
      expect(delay).toBeLessThan(ROW_DELAY_MS + 5000)
      // Well clear of the registry's schedule, so this cannot pass by luck.
      expect(delay).toBeLessThan(RETRY_DELAYS[0]! - 5000)
    })

    it('a pre-migration row with no schedule falls back to the config', async () => {
      const job = await insertJob('queued', 0, null)
      await JobService.claimJob(job.id)

      const before = Date.now()
      await JobService.markFailed(job.id, 'boom')

      const row = await rowFor(job.id)
      expect(row.status).toBe('pending')
      const delay = row.nextRetryAt!.getTime() - before
      expect(delay).toBeGreaterThan(RETRY_DELAYS[0]! - 5000)
      expect(delay).toBeLessThan(RETRY_DELAYS[0]! + 5000)
    })

    it('an empty carried schedule falls back rather than indexing nothing', async () => {
      // A type may declare `retryDelays: []` (advanced-auditing does). Empty
      // must behave exactly like absent in both executors.
      const job = await insertJob('queued', 0, [])
      await JobService.claimJob(job.id)

      const before = Date.now()
      await JobService.markFailed(job.id, 'boom')

      const row = await rowFor(job.id)
      expect(row.status).toBe('pending')
      const delay = row.nextRetryAt!.getTime() - before
      expect(delay).toBeGreaterThan(RETRY_DELAYS[0]! - 5000)
      expect(delay).toBeLessThan(RETRY_DELAYS[0]! + 5000)
    })

    it('a job that fails every attempt reports exactly maxAttempts, not double', async () => {
      const job = await insertJob('queued')

      let executions = 0
      // Drive the full lifecycle the worker + sweep would: claim, fail,
      // until the claim refuses. The loop bound proves termination.
      for (let i = 0; i < MAX_ATTEMPTS * 2; i++) {
        const claimed = await JobService.claimJob(job.id)
        if (!claimed) break
        executions++
        await JobService.markFailed(job.id, `failure ${executions}`)
      }

      const row = await rowFor(job.id)
      expect(executions).toBe(MAX_ATTEMPTS)
      expect(row.status).toBe('failed')
      expect(row.attempts).toBe(MAX_ATTEMPTS)
    })
  })

  describe('cross-process cancel and terminal-state immutability (JOBS-6)', () => {
    it('cancels a running job; late completion and failure marks change nothing', async () => {
      const job = await insertJob('queued')
      await JobService.claimJob(job.id)

      await JobService.cancel(job.id)
      let row = await rowFor(job.id)
      expect(row.status).toBe('cancelled')
      expect(row.completedAt).not.toBeNull()
      const settledAt = row.completedAt

      // The worker whose handler is still unwinding eventually reports —
      // the terminal state must win both races.
      await JobService.markCompleted(job.id, { late: true })
      row = await rowFor(job.id)
      expect(row.status).toBe('cancelled')
      expect(row.result).toBeNull()

      await JobService.markFailed(job.id, 'late failure')
      row = await rowFor(job.id)
      expect(row.status).toBe('cancelled')
      expect(row.error).toBeNull()
      expect(row.nextRetryAt).toBeNull()
      expect(row.completedAt).toEqual(settledAt)
    })

    it('still refuses to cancel a settled job', async () => {
      const job = await insertJob('completed')
      await expect(JobService.cancel(job.id)).rejects.toThrow(ValidationError)
    })

    it('updateProgress writes to a running row and reports its status; a cancelled row stays untouched', async () => {
      const job = await insertJob('queued')
      await JobService.claimJob(job.id)

      expect(await JobService.updateProgress(job.id, 40, 'homing')).toBe(
        'running',
      )
      let row = await rowFor(job.id)
      expect(row.progress).toBe(40)

      await JobService.cancel(job.id)

      expect(await JobService.updateProgress(job.id, 90, 'late write')).toBe(
        'cancelled',
      )
      row = await rowFor(job.id)
      expect(row.progress).toBe(40)
      expect(row.progressMessage).toBe('homing')
    })

    it('a handler that ignores its signal past the timeout ends failed, and its late completion is a no-op', async () => {
      const job = await insertJob('queued', MAX_ATTEMPTS - 1)
      await JobService.claimJob(job.id) // attempts -> MAX_ATTEMPTS

      const controller = new AbortController()
      const ignoresItsSignal = new Promise<never>(() => {})

      await expect(
        executeWithTimeout(ignoresItsSignal, 50, controller),
      ).rejects.toThrow(/timed out after 50ms/)
      // The timeout aborted the controller — this is what actually stops a
      // cooperative handler, not just the rejection.
      expect(controller.signal.aborted).toBe(true)

      await JobService.markFailed(job.id, 'Job timed out after 50ms')
      let row = await rowFor(job.id)
      expect(row.status).toBe('failed')

      await JobService.markCompleted(job.id, { zombie: true })
      row = await rowFor(job.id)
      expect(row.status).toBe('failed')
      expect(row.result).toBeNull()
    })

    it('a handler that honors its signal aborts within one progress checkpoint of cancel', async () => {
      const job = await insertJob('queued')
      await JobService.claimJob(job.id)

      const controller = new AbortController()
      const context = createJobContext(job.id, 1, controller)

      await context.updateProgress(10, 'step 1')
      expect(controller.signal.aborted).toBe(false)

      await JobService.cancel(job.id) // another process cancels

      await context.updateProgress(20, 'step 2') // next checkpoint notices
      expect(controller.signal.aborted).toBe(true)
    })
  })

  describe('publish-window races (JOBS2-3)', () => {
    let publishSpy: MockInstance<typeof RabbitMQClient.publish>

    beforeEach(() => {
      publishSpy = vi
        .spyOn(RabbitMQClient, 'publish')
        .mockResolvedValue(undefined)
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    /**
     * The other side of the race, run from inside the publish call: the
     * message is live the moment `publish` returns, so a worker claiming it
     * — or an operator cancelling — genuinely can land before the flip to
     * 'queued' that follows.
     */
    function duringPublish(act: (jobId: string) => Promise<unknown>) {
      publishSpy.mockImplementation(async (_routingKey, message) => {
        await act(message.jobId)
      })
    }

    it('submit queues the job and reports it when nothing races the publish', async () => {
      const submitted = await JobService.submit(TEST_TYPE, {}, user.id)

      expect(submitted.status).toBe('queued')
      expect(submitted.queuedAt).not.toBeNull()
      expect((await rowFor(submitted.id)).status).toBe('queued')
    })

    it('submit never demotes a job a worker claimed inside the publish window', async () => {
      duringPublish((jobId) => JobService.claimJob(jobId))

      const submitted = await JobService.submit(TEST_TYPE, {}, user.id)

      // The claim owns the execution; a flip back to 'queued' would strand
      // it with its message already consumed.
      const row = await rowFor(submitted.id)
      expect(row.status).toBe('running')
      expect(row.attempts).toBe(1)
      expect(row.queuedAt).toBeNull()
      // And the caller is told what is true, not the 'queued' this used to
      // fabricate.
      expect(submitted.status).toBe('running')
    })

    it('submit never resurrects a job cancelled inside the publish window', async () => {
      duringPublish((jobId) => JobService.cancel(jobId))

      const submitted = await JobService.submit(TEST_TYPE, {}, user.id)

      expect(submitted.status).toBe('cancelled')
      const row = await rowFor(submitted.id)
      expect(row.status).toBe('cancelled')
      expect(row.completedAt).not.toBeNull()
    })

    it('marks the job failed when the publish fails and nothing raced it', async () => {
      const brokerDown = new Error('broker unreachable')
      let submittedId = ''
      publishSpy.mockImplementation((_routingKey, message) => {
        submittedId = message.jobId
        return Promise.reject(brokerDown)
      })

      // The original error reaches the caller unwrapped.
      await expect(JobService.submit(TEST_TYPE, {}, user.id)).rejects.toBe(
        brokerDown,
      )

      const row = await rowFor(submittedId)
      expect(row.status).toBe('failed')
      expect(row.error).not.toBeNull()
    })

    it('a failed publish does not overwrite a cancel that beat it, since the broker may have the message anyway', async () => {
      const brokerDown = new Error('broker unreachable')
      let submittedId = ''
      publishSpy.mockImplementation(async (_routingKey, message) => {
        submittedId = message.jobId
        await JobService.cancel(message.jobId)
        throw brokerDown
      })

      await expect(JobService.submit(TEST_TYPE, {}, user.id)).rejects.toBe(
        brokerDown,
      )

      const row = await rowFor(submittedId)
      expect(row.status).toBe('cancelled')
      expect(row.error).toBeNull()
    })

    it('retry never demotes a job a worker claimed inside the publish window', async () => {
      const job = await insertJob('failed', MAX_ATTEMPTS)
      duringPublish((jobId) => JobService.claimJob(jobId))

      const retried = await JobService.retry(job.id, user.id)

      const row = await rowFor(job.id)
      expect(row.status).toBe('running')
      // The reset zeroed the ledger, then the claim counted its own attempt.
      expect(row.attempts).toBe(1)
      expect(retried.status).toBe('running')
    })

    it('retry resets a failed job exactly once when two operators race it', async () => {
      const job = await insertJob('failed', MAX_ATTEMPTS)

      const outcomes = await Promise.allSettled([
        JobService.retry(job.id, user.id),
        JobService.retry(job.id, user.id),
      ])

      // Whichever loses — at its pre-check or at the guarded reset — is
      // refused rather than resetting the job a second time.
      const reasons = outcomes.flatMap((outcome) =>
        outcome.status === 'rejected' ? [outcome.reason as unknown] : [],
      )
      expect(reasons).toHaveLength(1)
      expect(reasons[0]).toBeInstanceOf(ValidationError)

      expect(publishSpy).toHaveBeenCalledTimes(1)
      const row = await rowFor(job.id)
      expect(row.status).toBe('queued')
      expect(row.attempts).toBe(0)
    })
  })
})
