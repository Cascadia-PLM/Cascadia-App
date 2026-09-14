// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * A submitted job with a dedupe key is submitted once.
 *
 * Gate 1. Event delivery is at-least-once, and `JobService.submit` writes
 * through the module-level connection — so a `consumed` handler that submits a
 * job can be asked to submit it again, and without a key the second ask is a
 * second job, a second broker message and a second execution.
 *
 * **The reason this lives on the jobs table and not in the handler** is the case
 * in `rolls back the handler's own bookkeeping but not the job` below. A handler
 * runs in a savepoint; the job does not. Every way a duplicate arises rolls back
 * anything the handler wrote to deduplicate with and leaves the job standing, so
 * a dedupe row inside the handler cannot see the thing it is deduplicating
 * against. The key can, because it is on the row that survived.
 *
 * On `ConcurrentTestDatabase` because that is the whole point: the job row has
 * to be committed and visible from outside the transaction that caused it.
 */

import { randomUUID } from 'node:crypto'
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
import { eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { ConcurrentTestDatabase } from '@/__tests__/helpers/concurrent-db'
import { db } from '@/lib/db'
import { ConflictError } from '@/lib/errors'
import { jobs } from '@/lib/db/schema'
import { JobService } from '@/lib/jobs/JobService'
import { JobTypeRegistry } from '@/lib/jobs/registry'
import { RabbitMQClient } from '@/lib/jobs/rabbitmq/client'

describe('job submission dedupe key', () => {
  const concurrent = new ConcurrentTestDatabase()
  const createdKeys: Array<string> = []

  // A type of this suite's own, registered here rather than borrowed from the
  // shipped catalog.
  //
  // This harness **commits**, and the maintenance sweep skips any type with a
  // recent job — so borrowing a real maintenance type made a parallel scheduler
  // suite see these rows and count one fewer submission. The rows were cleaned
  // up correctly; the window in which they existed was the problem, which is
  // the commit-time discipline in the harness README.
  const TYPE = `test.dedupe.type-${randomUUID().slice(0, 8)}`

  beforeAll(() => {
    concurrent.setup()
    JobTypeRegistry.register({
      type: TYPE,
      label: 'Dedupe key test job',
      routingKey: 'jobs.test.dedupe',
      payloadSchema: z.object({}),
      resultSchema: z.object({}),
      timeout: 1000,
      maxAttempts: 1,
      retryDelays: [],
      priority: 'low',
    })
    expect(JobTypeRegistry.getType(TYPE)).toBeDefined()
  })

  // The broker is incidental here — every assertion below is about what the
  // jobs *table* does — and no broker runs in CI. Stubbed the way the
  // publish-window races in `JobService.test.ts` stub it: `submit` connects
  // before it writes a row, and publishes after.
  beforeEach(() => {
    vi.spyOn(RabbitMQClient, 'connect').mockResolvedValue(undefined)
    vi.spyOn(RabbitMQClient, 'publish').mockResolvedValue(undefined)
  })

  afterAll(async () => {
    await concurrent.teardown()
  })

  afterEach(async () => {
    // By this suite's own type, not by the keys it happened to record. A test
    // that fails partway — as these did against a broker that was not running —
    // leaves rows its own bookkeeping never saw, and this harness commits, so
    // those rows are visible to every other file in the parallel pool until
    // something removes them. The type is unique to this run, so deleting by it
    // is both exhaustive and incapable of reaching another suite's jobs.
    await concurrent.db.delete(jobs).where(eq(jobs.type, TYPE))
    createdKeys.length = 0
    await concurrent.cleanup()
    vi.restoreAllMocks()
  })

  function key(label: string): string {
    const value = `test.dedupe.${label}-${randomUUID().slice(0, 8)}`
    createdKeys.push(value)
    return value
  }

  async function rowsFor(dedupeKey: string) {
    return concurrent.db
      .select()
      .from(jobs)
      .where(eq(jobs.dedupeKey, dedupeKey))
  }

  it('a second submit under the same key returns the first job', async () => {
    const dedupeKey = key('same')

    const first = await JobService.submit(TYPE, {}, null, { dedupeKey })
    const second = await JobService.submit(TYPE, {}, null, { dedupeKey })

    expect(second.id).toBe(first.id)
    expect(await rowsFor(dedupeKey)).toHaveLength(1)
    // No second broker message either: the deduplicated path never publishes.
    expect(RabbitMQClient.publish).toHaveBeenCalledTimes(1)
  })

  /**
   * A failed publish marks its row 'failed' — and used to leave the key on it,
   * so every later submission under that key was handed the dead job and
   * nothing was ever queued. For a `consumed` extension that meant a broker
   * outage turned into work that silently never happened, with the handler and
   * its cursor both recording success.
   */
  it('a job whose broker publish failed releases its key', async () => {
    const dedupeKey = key('publish-failed')
    vi.mocked(RabbitMQClient.publish).mockRejectedValueOnce(
      new Error('broker unreachable'),
    )

    await expect(
      JobService.submit(TYPE, {}, null, { dedupeKey }),
    ).rejects.toThrow('broker unreachable')
    const [failed] = await rowsFor(dedupeKey)
    expect(failed?.status).toBe('failed')

    const resubmitted = await JobService.submit(TYPE, {}, null, { dedupeKey })

    expect(resubmitted.id).not.toBe(failed?.id)
    expect(resubmitted.status).toBe('queued')
  })

  /**
   * An unreachable broker is found before the row is written, so there is no
   * failed row to release a key from — and none to pile up. A consumer retrying
   * through an outage used to leave one failed job per attempt.
   */
  it('an unreachable broker writes no row, and the retry queues the work once', async () => {
    const dedupeKey = key('broker-unreachable')
    const refused = new Error('connect ECONNREFUSED 127.0.0.1:5672')
    vi.mocked(RabbitMQClient.connect).mockRejectedValueOnce(refused)

    await expect(JobService.submit(TYPE, {}, null, { dedupeKey })).rejects.toBe(
      refused,
    )
    expect(await rowsFor(dedupeKey)).toHaveLength(0)

    const retried = await JobService.submit(TYPE, {}, null, { dedupeKey })

    expect(retried.status).toBe('queued')
    expect(await rowsFor(dedupeKey)).toHaveLength(1)
  })

  /**
   * Work already submitted under a key needs no broker: a redelivered event
   * whose job was queued before its run failed is answered with that job
   * during an outage, rather than waiting the outage out.
   */
  it('answers a held key while the broker is unreachable', async () => {
    const dedupeKey = key('held-during-outage')
    const first = await JobService.submit(TYPE, {}, null, { dedupeKey })
    vi.mocked(RabbitMQClient.connect).mockRejectedValue(
      new Error('connect ECONNREFUSED 127.0.0.1:5672'),
    )

    const second = await JobService.submit(TYPE, {}, null, { dedupeKey })

    expect(second.id).toBe(first.id)
    expect(await rowsFor(dedupeKey)).toHaveLength(1)
  })

  it('a cancelled or terminally failed job releases its key, a completed one keeps it', async () => {
    for (const status of ['cancelled', 'failed'] as const) {
      const dedupeKey = key(status)
      const first = await JobService.submit(TYPE, {}, null, { dedupeKey })
      await concurrent.db
        .update(jobs)
        .set({ status })
        .where(eq(jobs.id, first.id))

      const second = await JobService.submit(TYPE, {}, null, { dedupeKey })
      expect(second.id).not.toBe(first.id)
    }

    // Completed work is the case the key exists for: a redelivery must not run
    // it again.
    const dedupeKey = key('completed')
    const done = await JobService.submit(TYPE, {}, null, { dedupeKey })
    await concurrent.db
      .update(jobs)
      .set({ status: 'completed' })
      .where(eq(jobs.id, done.id))

    const again = await JobService.submit(TYPE, {}, null, { dedupeKey })
    expect(again.id).toBe(done.id)
  })

  it('refuses to retry a failed job whose key another job now holds', async () => {
    const dedupeKey = key('retry-conflict')
    const first = await JobService.submit(TYPE, {}, null, { dedupeKey })
    await concurrent.db
      .update(jobs)
      .set({ status: 'failed' })
      .where(eq(jobs.id, first.id))
    await JobService.submit(TYPE, {}, null, { dedupeKey })

    await expect(JobService.retry(first.id, 'operator')).rejects.toBeInstanceOf(
      ConflictError,
    )
  })

  it('two different keys are two jobs', async () => {
    const a = key('a')
    const b = key('b')

    const first = await JobService.submit(TYPE, {}, null, { dedupeKey: a })
    const second = await JobService.submit(TYPE, {}, null, { dedupeKey: b })

    expect(second.id).not.toBe(first.id)
  })

  /**
   * The null majority must not deduplicate against itself — two ordinary
   * submissions are two jobs, which is what the partial index buys.
   */
  it('submissions with no key are never deduplicated', async () => {
    const first = await JobService.submit(TYPE, {}, null)
    const second = await JobService.submit(TYPE, {}, null)

    expect(second.id).not.toBe(first.id)

    await concurrent.db
      .delete(jobs)
      .where(inArray(jobs.id, [first.id, second.id]))
  })

  /**
   * The case that decides where the fix belongs.
   *
   * A `consumed` handler runs in a savepoint. It submits a job — which commits
   * immediately, through a different connection — and then throws. Its savepoint
   * rolls back, so anything it wrote to deduplicate with is gone, while the job
   * it queued is not. On redelivery the handler runs again with no record of
   * what it did.
   *
   * This test reproduces exactly that, and asserts the outcome the dedupe key
   * gives: one job, not two.
   */
  it('rolls back the handler-side bookkeeping but not the job, and still submits once', async () => {
    const dedupeKey = key('savepoint')
    let attempts = 0

    // One "handler run": a savepoint that submits and then fails.
    const handlerRun = async () => {
      await db
        .transaction(async (tx) => {
          await tx.transaction(async (savepoint) => {
            // Bookkeeping the handler would use to deduplicate. It is on the
            // savepoint, so it does not survive the throw below.
            await savepoint.select().from(jobs).limit(1)

            attempts += 1
            await JobService.submit(TYPE, {}, null, { dedupeKey })

            throw new Error('handler failed after submitting')
          })
        })
        .catch(() => undefined)
    }

    await handlerRun()
    // The job survived the rollback — which is the defect.
    expect(await rowsFor(dedupeKey)).toHaveLength(1)

    // Redelivery. The handler has no memory of the first attempt.
    await handlerRun()

    expect(attempts).toBe(2)
    // …and still exactly one job.
    expect(await rowsFor(dedupeKey)).toHaveLength(1)
  })

  /**
   * Two pollers cannot both hold one consumer's cursor, but two processes can
   * still race here through a retry — and the unique index is what decides it,
   * rather than a read-then-write that has a window between the two.
   */
  it('concurrent submits under one key produce one job', async () => {
    const dedupeKey = key('concurrent')

    const results = await Promise.all([
      JobService.submit(TYPE, {}, null, { dedupeKey }),
      JobService.submit(TYPE, {}, null, { dedupeKey }),
      JobService.submit(TYPE, {}, null, { dedupeKey }),
    ])

    expect(new Set(results.map((job) => job.id)).size).toBe(1)
    expect(await rowsFor(dedupeKey)).toHaveLength(1)
  })

  /**
   * A deduplicated submit returns the existing job **as it stands** — it does
   * not re-queue it, reset its status or change its priority. The job is
   * already on its way, or already done.
   */
  it('does not disturb the job it returns', async () => {
    const dedupeKey = key('untouched')

    const first = await JobService.submit(TYPE, {}, null, { dedupeKey })
    await concurrent.db
      .update(jobs)
      .set({ status: 'running', progress: 40 })
      .where(eq(jobs.id, first.id))

    const second = await JobService.submit(TYPE, {}, null, { dedupeKey })

    expect(second.id).toBe(first.id)
    expect(second.status).toBe('running')
    const [row] = await rowsFor(dedupeKey)
    expect(row?.status).toBe('running')
    expect(row?.progress).toBe(40)
  })
})
