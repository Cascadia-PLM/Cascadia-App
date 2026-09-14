// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Invariants of the consumer runner: ordered at-least-once delivery through
 * durable cursors, partial progress on failure, savepoint isolation of
 * failing handlers — and the sequencing that makes the plain `seq > cursor`
 * scan safe.
 *
 * Gate 1 (data integrity): a consumer that skips, reorders, or double-books
 * cursor state silently corrupts every downstream projection.
 *
 * Real commits, deliberately. `seq` is assigned by the sequencing trigger when
 * the emitting transaction commits, so nothing published inside the gate
 * harness's rolled-back transaction ever gets one — under `TestDatabase` a
 * consumer would be shown an empty log. This file therefore uses the
 * concurrent harness and owns its cleanup: scoped deletes of its own event
 * types and cursor rows, never a truncate. Consumers start at the current
 * head of the log so events committed by other suites stay out of scope.
 */

import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { asc, eq, inArray, max } from 'drizzle-orm'
import { z } from 'zod'
import type { DomainEventConsumer } from '@/lib/events'
import { ConcurrentTestDatabase } from '@/__tests__/helpers/concurrent-db'
import { db } from '@/lib/db'
import { domainEvents, eventConsumers } from '@/lib/db/schema'
import { ValidationError } from '@/lib/errors'
import {
  EventHandlerTimeoutError,
  TransientConsumerError,
  defineDomainEvent,
  drainEventConsumer,
  ensureDomainEventSequencing,
  isTransientConsumerFailure,
  publishDomainEvent,
  resumeEventConsumer,
  runEventConsumerOnce,
  skipPoisonEvent,
} from '@/lib/events'
import { ExtensionDispatchError } from '@/lib/extensions'

const CONSUMER_SPEC_A = defineDomainEvent({
  type: 'test.events.consumer_spec.a',
  schemaVersion: 1,
  description: 'Test-only event A for consumer invariants',
  payloadSchema: z.object({ marker: z.string() }),
})

const CONSUMER_SPEC_B = defineDomainEvent({
  type: 'test.events.consumer_spec.b',
  schemaVersion: 1,
  description: 'Test-only event B for consumer invariants',
  payloadSchema: z.object({ marker: z.string() }),
})

const TEST_TYPES = [CONSUMER_SPEC_A.type, CONSUMER_SPEC_B.type]

describe('runEventConsumerOnce', () => {
  const concurrent = new ConcurrentTestDatabase()
  const createdConsumerIds: Array<string> = []

  beforeAll(async () => {
    concurrent.setup()
    await ensureDomainEventSequencing(concurrent.db)
  })

  afterAll(async () => {
    await concurrent.teardown()
  })

  afterEach(async () => {
    await concurrent.db
      .delete(domainEvents)
      .where(inArray(domainEvents.type, TEST_TYPES))
    if (createdConsumerIds.length > 0) {
      await concurrent.db
        .delete(eventConsumers)
        .where(inArray(eventConsumers.id, createdConsumerIds))
      createdConsumerIds.length = 0
    }
    await concurrent.cleanup()
  })

  async function currentHead(): Promise<number> {
    const rows = await concurrent.db
      .select({ value: max(domainEvents.seq) })
      .from(domainEvents)
    return rows.at(0)?.value ?? 0
  }

  /** Create a consumer whose cursor starts at the current head of the log. */
  async function makeConsumer(
    types: ReadonlyArray<string> | '*',
    handler: DomainEventConsumer['handler'],
    batchSize?: number,
  ): Promise<DomainEventConsumer> {
    const id = `test.consumer-${randomUUID().slice(0, 18)}`
    createdConsumerIds.push(id)
    await concurrent.db
      .insert(eventConsumers)
      .values({ id, lastSeq: await currentHead() })
    return { id, eventTypes: types, handler, batchSize }
  }

  /** Publish in its own committed transaction and read back the assigned seq. */
  async function publish(
    def: typeof CONSUMER_SPEC_A,
    marker: string,
  ): Promise<{ id: string; seq: number }> {
    const pending = await db.transaction(async (tx) =>
      publishDomainEvent(tx, def, { payload: { marker } }),
    )
    const rows = await concurrent.db
      .select({ seq: domainEvents.seq })
      .from(domainEvents)
      .where(eq(domainEvents.id, pending.id))
    const seq = rows.at(0)?.seq
    if (seq === null || seq === undefined) {
      throw new Error('committed event was not sequenced')
    }
    return { id: pending.id, seq }
  }

  async function consumerRow(id: string) {
    const rows = await concurrent.db
      .select()
      .from(eventConsumers)
      .where(eq(eventConsumers.id, id))
    expect(rows).toHaveLength(1)
    return rows[0]!
  }

  it('assigns contiguous ascending seqs at commit, in publish order', async () => {
    const ids = await db.transaction(async (tx) => {
      const first = await publishDomainEvent(tx, CONSUMER_SPEC_A, {
        payload: { marker: 'one' },
      })
      const second = await publishDomainEvent(tx, CONSUMER_SPEC_A, {
        payload: { marker: 'two' },
      })
      // Not yet committed: the trigger has not run, so no seq exists.
      const inFlight = await tx
        .select({ seq: domainEvents.seq })
        .from(domainEvents)
        .where(eq(domainEvents.id, first.id))
      expect(inFlight.at(0)?.seq).toBeNull()
      return [first.id, second.id]
    })

    const rows = await concurrent.db
      .select({ id: domainEvents.id, seq: domainEvents.seq })
      .from(domainEvents)
      .where(inArray(domainEvents.id, ids))
      .orderBy(asc(domainEvents.seq))
    expect(rows.map((r) => r.id)).toEqual(ids)
    const [a, b] = rows
    expect(a!.seq).not.toBeNull()
    expect(b!.seq).toBe(a!.seq! + 1)
  })

  it('delivers matching events in seq order and advances the cursor', async () => {
    const seen: Array<string> = []
    const consumer = await makeConsumer(
      ['test.events.consumer_spec.a'],
      (event) => {
        seen.push((event.payload as { marker: string }).marker)
        return Promise.resolve()
      },
    )

    await publish(CONSUMER_SPEC_A, 'one')
    await publish(CONSUMER_SPEC_A, 'two')
    const last = await publish(CONSUMER_SPEC_A, 'three')

    const result = await runEventConsumerOnce(consumer)
    expect(result.status).toBe('processed')
    expect(result.processed).toBe(3)
    expect(seen).toEqual(['one', 'two', 'three'])

    const row = await consumerRow(consumer.id)
    expect(row.lastSeq).toBeGreaterThanOrEqual(last.seq)
    expect(row.failureCount).toBe(0)

    // Nothing of ours is new — the next run delivers nothing twice. It may
    // still report 'processed' rather than 'idle': the log is shared, and a
    // foreign event another suite committed meanwhile is skipped past.
    const again = await runEventConsumerOnce(consumer)
    expect(again.processed).toBe(0)
    expect(seen).toHaveLength(3)
  })

  it('skips non-matching types but advances the cursor past them', async () => {
    const seen: Array<string> = []
    const consumer = await makeConsumer(
      ['test.events.consumer_spec.b'],
      (event) => {
        seen.push((event.payload as { marker: string }).marker)
        return Promise.resolve()
      },
    )

    await publish(CONSUMER_SPEC_A, 'ignored')
    const wanted = await publish(CONSUMER_SPEC_B, 'wanted')

    const result = await runEventConsumerOnce(consumer)
    expect(result.status).toBe('processed')
    expect(result.processed).toBe(1)
    expect(seen).toEqual(['wanted'])

    const row = await consumerRow(consumer.id)
    expect(row.lastSeq).toBeGreaterThanOrEqual(wanted.seq)
  })

  /**
   * A filtered cursor that stopped on the last event it wanted pinned the
   * retention horizon there — two `design.released` consumers run everywhere,
   * so nothing after the latest release was ever pruned — and read as lag on
   * the panel for as long as no release happened.
   */
  it('moves a filtered cursor past trailing events of other types', async () => {
    const seen: Array<string> = []
    const consumer = await makeConsumer(
      ['test.events.consumer_spec.b'],
      (event) => {
        seen.push((event.payload as { marker: string }).marker)
        return Promise.resolve()
      },
    )

    await publish(CONSUMER_SPEC_B, 'wanted')
    const trailing = await publish(CONSUMER_SPEC_A, 'unwanted, and last')

    const result = await runEventConsumerOnce(consumer)
    expect(result.processed).toBe(1)
    expect(seen).toEqual(['wanted'])
    expect((await consumerRow(consumer.id)).lastSeq).toBeGreaterThanOrEqual(
      trailing.seq,
    )
  })

  it('moves a filtered cursor to the head when nothing matches', async () => {
    const consumer = await makeConsumer(['test.events.consumer_spec.b'], () =>
      Promise.resolve(),
    )
    const other = await publish(CONSUMER_SPEC_A, 'only other types')

    const result = await runEventConsumerOnce(consumer)
    expect(result.processed).toBe(0)
    expect((await consumerRow(consumer.id)).lastSeq).toBeGreaterThanOrEqual(
      other.seq,
    )
  })

  it('stops before a failing event, records the error, and redelivers it next run', async () => {
    const seen: Array<string> = []
    let failOnTwo = true
    const consumer = await makeConsumer(
      ['test.events.consumer_spec.a'],
      (event) => {
        const marker = (event.payload as { marker: string }).marker
        if (marker === 'two' && failOnTwo) {
          throw new Error('handler exploded on two')
        }
        seen.push(marker)
        return Promise.resolve()
      },
    )

    const first = await publish(CONSUMER_SPEC_A, 'one')
    const second = await publish(CONSUMER_SPEC_A, 'two')
    await publish(CONSUMER_SPEC_A, 'three')

    const failed = await runEventConsumerOnce(consumer)
    expect(failed.status).toBe('failed')
    expect(failed.processed).toBe(1)
    expect(failed.failedSeq).toBe(second.seq)
    expect(seen).toEqual(['one'])

    // Partial progress committed: cursor sits just before the poison event.
    // A range, not an equality — the log is shared, and another suite's
    // committed event may legitimately sit between ours and be skipped past.
    const rowAfterFailure = await consumerRow(consumer.id)
    expect(rowAfterFailure.lastSeq).toBeGreaterThanOrEqual(first.seq)
    expect(rowAfterFailure.lastSeq).toBeLessThan(second.seq)
    expect(rowAfterFailure.failureCount).toBe(1)
    expect(rowAfterFailure.lastError).toContain('handler exploded on two')
    expect(rowAfterFailure.lastErrorAt).toBeInstanceOf(Date)

    // The fault clears — redelivery resumes from the failed event, in order.
    // The backoff is forced past rather than slept through.
    failOnTwo = false
    await concurrent.db
      .update(eventConsumers)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(eventConsumers.id, consumer.id))
    const recovered = await runEventConsumerOnce(consumer)
    expect(recovered.status).toBe('processed')
    expect(seen).toEqual(['one', 'two', 'three'])

    const rowAfterRecovery = await consumerRow(consumer.id)
    expect(rowAfterRecovery.failureCount).toBe(0)
    expect(rowAfterRecovery.lastError).toBeNull()
  })

  it("rolls back a failing handler's writes while keeping the batch's progress", async () => {
    const persistedMarkerId = `test.sideeffect-ok-${randomUUID().slice(0, 8)}`
    const rolledBackMarkerId = `test.sideeffect-bad-${randomUUID().slice(0, 8)}`
    createdConsumerIds.push(persistedMarkerId, rolledBackMarkerId)

    const consumer = await makeConsumer(
      ['test.events.consumer_spec.a'],
      async (event, ctx) => {
        const marker = (event.payload as { marker: string }).marker
        if (marker === 'good') {
          // A handler side effect that must survive the later failure.
          await ctx.tx
            .insert(eventConsumers)
            .values({ id: persistedMarkerId, lastSeq: 0 })
          return
        }
        // Writes, then fails: the savepoint must erase this insert.
        await ctx.tx
          .insert(eventConsumers)
          .values({ id: rolledBackMarkerId, lastSeq: 0 })
        throw new Error('failed after writing')
      },
    )

    const good = await publish(CONSUMER_SPEC_A, 'good')
    const bad = await publish(CONSUMER_SPEC_A, 'bad')

    const result = await runEventConsumerOnce(consumer)
    expect(result.status).toBe('failed')

    const persisted = await concurrent.db
      .select()
      .from(eventConsumers)
      .where(eq(eventConsumers.id, persistedMarkerId))
    expect(persisted).toHaveLength(1)

    const erased = await concurrent.db
      .select()
      .from(eventConsumers)
      .where(eq(eventConsumers.id, rolledBackMarkerId))
    expect(erased).toHaveLength(0)

    const row = await consumerRow(consumer.id)
    expect(row.lastSeq).toBeGreaterThanOrEqual(good.seq)
    expect(row.lastSeq).toBeLessThan(bad.seq)
  })

  it('drainEventConsumer keeps running while batches come back full', async () => {
    const seen: Array<string> = []
    const consumer = await makeConsumer(
      ['test.events.consumer_spec.a'],
      (event) => {
        seen.push((event.payload as { marker: string }).marker)
        return Promise.resolve()
      },
      2, // batchSize — five events need three runs
    )

    for (const marker of ['d1', 'd2', 'd3', 'd4', 'd5']) {
      await publish(CONSUMER_SPEC_A, marker)
    }

    const result = await drainEventConsumer(consumer)
    expect(seen).toEqual(['d1', 'd2', 'd3', 'd4', 'd5'])
    expect(result.hasMore).toBe(false)
  })
  it('backs off after a failure, parks at the threshold, and only an admin reopens it', async () => {
    const parkAfterBefore = process.env.EVENT_CONSUMER_PARK_AFTER
    process.env.EVENT_CONSUMER_PARK_AFTER = '2'
    try {
      const consumer = await makeConsumer(['test.events.consumer_spec.a'], () =>
        Promise.reject(new Error('always fails')),
      )
      const poison = await publish(CONSUMER_SPEC_A, 'poison')

      // First failure: recorded, with a backoff, not yet parked.
      const first = await runEventConsumerOnce(consumer)
      expect(first.status).toBe('failed')
      expect(first.parked).toBe(false)
      let row = await consumerRow(consumer.id)
      expect(row.failureCount).toBe(1)
      expect(row.lastErrorSeq).toBe(poison.seq)
      expect(row.parkedAt).toBeNull()
      expect(row.nextAttemptAt?.getTime()).toBeGreaterThan(Date.now())

      // Inside the backoff the runner does not even look at the log.
      const waiting = await runEventConsumerOnce(consumer)
      expect(waiting.status).toBe('waiting')

      // Past the backoff (forced, rather than slept): the second failure
      // crosses the threshold and parks the consumer.
      await concurrent.db
        .update(eventConsumers)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(eventConsumers.id, consumer.id))
      const second = await runEventConsumerOnce(consumer)
      expect(second.status).toBe('failed')
      expect(second.parked).toBe(true)
      row = await consumerRow(consumer.id)
      expect(row.parkedAt).not.toBeNull()
      expect(row.nextAttemptAt).toBeNull()

      // Parked: every later run is a no-op until an admin acts.
      const parked = await runEventConsumerOnce(consumer)
      expect(parked.status).toBe('parked')

      // Resume reopens the consumer at the same cursor; the poison event is
      // retried, not skipped.
      const resumed = await resumeEventConsumer(consumer.id)
      expect(resumed.parkedAt).toBeNull()
      expect(resumed.failureCount).toBe(0)
      const retried = await runEventConsumerOnce(consumer)
      expect(retried.status).toBe('failed')
      expect(retried.failedSeq).toBe(poison.seq)

      // Skip moves the cursor past it — deliberately — and clears the state.
      const skipped = await skipPoisonEvent(consumer.id)
      expect(skipped.lastSeq).toBeGreaterThanOrEqual(poison.seq)
      expect(skipped.lastErrorSeq).toBeNull()
      expect(skipped.parkedAt).toBeNull()
      const after = await runEventConsumerOnce(consumer)
      expect(after.processed).toBe(0)
      expect(after.status).not.toBe('failed')
    } finally {
      if (parkAfterBefore === undefined) {
        delete process.env.EVENT_CONSUMER_PARK_AFTER
      } else {
        process.env.EVENT_CONSUMER_PARK_AFTER = parkAfterBefore
      }
    }
  })

  it('aborts a handler that exceeds its timeout and counts it as a failure', async () => {
    let sawAbort = false
    const consumer = await makeConsumer(
      ['test.events.consumer_spec.a'],
      (_event, ctx) =>
        new Promise<void>((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => {
            sawAbort = true
            reject(new Error('handler observed abort'))
          })
        }),
    )
    consumer.handlerTimeoutMs = 50

    await publish(CONSUMER_SPEC_A, 'hangs')

    const result = await runEventConsumerOnce(consumer)
    expect(result.status).toBe('failed')
    expect(result.error).toBeInstanceOf(EventHandlerTimeoutError)
    expect(sawAbort).toBe(true)

    const row = await consumerRow(consumer.id)
    expect(row.failureCount).toBe(1)
    expect(row.lastError).toContain('exceeded 50 ms')
  })

  /**
   * Parking is for poison. Ten failures along the backoff ladder is about
   * eighteen minutes, so before this a broker outage longer than that parked the
   * relay and needed an administrator to resume it.
   */
  it('retries a transient failure with backoff and never parks for it', async () => {
    const parkAfterBefore = process.env.EVENT_CONSUMER_PARK_AFTER
    process.env.EVENT_CONSUMER_PARK_AFTER = '2'
    try {
      const consumer = await makeConsumer(['test.events.consumer_spec.a'], () =>
        Promise.reject(new TransientConsumerError('the broker is down')),
      )
      await publish(CONSUMER_SPEC_A, 'during an outage')

      for (let attempt = 1; attempt <= 3; attempt++) {
        await concurrent.db
          .update(eventConsumers)
          .set({ nextAttemptAt: new Date(0) })
          .where(eq(eventConsumers.id, consumer.id))
        const result = await runEventConsumerOnce(consumer)
        expect(result.status).toBe('failed')
        expect(result.parked).toBe(false)
      }

      // Past the threshold of two, and still retrying rather than parked.
      const row = await consumerRow(consumer.id)
      expect(row.failureCount).toBe(3)
      expect(row.parkedAt).toBeNull()
      expect(row.nextAttemptAt).not.toBeNull()
    } finally {
      if (parkAfterBefore === undefined) {
        delete process.env.EVENT_CONSUMER_PARK_AFTER
      } else {
        process.env.EVENT_CONSUMER_PARK_AFTER = parkAfterBefore
      }
    }
  })

  it('recognises a transient failure through the extension wrapper and by errno', () => {
    expect(
      isTransientConsumerFailure(
        new ExtensionDispatchError(
          'test.relay',
          'consumed',
          new TransientConsumerError('down'),
        ),
      ),
    ).toBe(true)
    expect(
      isTransientConsumerFailure(
        Object.assign(new Error('connect ECONNREFUSED'), {
          code: 'ECONNREFUSED',
        }),
      ),
    ).toBe(true)
    expect(isTransientConsumerFailure(new Error('a poison payload'))).toBe(
      false,
    )
  })

  /**
   * A handler that ignores its signal and writes after its deadline used to
   * land that write in the run's transaction — committed with the failure
   * record — or, once the transaction had ended, on whatever its connection
   * served next. Now the handle refuses the statement and the run rolls back.
   */
  it('discards what a timed-out handler tries to write after its deadline', async () => {
    const lateMarkerId = `test.late-write-${randomUUID().slice(0, 8)}`
    createdConsumerIds.push(lateMarkerId)
    let lateAttempt: unknown = 'not attempted'

    const consumer = await makeConsumer(
      ['test.events.consumer_spec.a'],
      (_event, ctx) =>
        new Promise<void>((resolve) => {
          // Ignores its signal, outlives its deadline, then tries to write.
          setTimeout(() => {
            void (async () => {
              try {
                await ctx.tx
                  .insert(eventConsumers)
                  .values({ id: lateMarkerId, lastSeq: 0 })
                lateAttempt = 'written'
              } catch (error) {
                lateAttempt = error
              }
              resolve()
            })()
          }, 150)
        }),
    )
    consumer.handlerTimeoutMs = 50
    await publish(CONSUMER_SPEC_A, 'outlives its deadline')

    const result = await runEventConsumerOnce(consumer)
    expect(result.status).toBe('failed')
    expect(result.error).toBeInstanceOf(EventHandlerTimeoutError)

    // The handle refused to start the statement…
    expect(lateAttempt).toBeInstanceOf(Error)
    // …so nothing landed, in the run's transaction or any other.
    const late = await concurrent.db
      .select()
      .from(eventConsumers)
      .where(eq(eventConsumers.id, lateMarkerId))
    expect(late).toHaveLength(0)
    // And the failure is on record against the event.
    const row = await consumerRow(consumer.id)
    expect(row.failureCount).toBe(1)
    expect(row.lastErrorSeq).not.toBeNull()
  })

  /**
   * The first run creates the cursor row, and a second process used to wait on
   * that uncommitted insert for the whole of the first run instead of reporting
   * `locked` and moving on.
   */
  it("reports locked on a second runner's first tick rather than waiting on the first's", async () => {
    const id = `test.consumer-${randomUUID().slice(0, 18)}`
    createdConsumerIds.push(id)
    await publish(CONSUMER_SPEC_A, 'first run')

    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered: () => void = () => undefined
    const inHandler = new Promise<void>((resolve) => {
      entered = resolve
    })

    const slow: DomainEventConsumer = {
      id,
      eventTypes: ['test.events.consumer_spec.a'],
      startAt: 'origin',
      handlerTimeoutMs: 10_000,
      handler: async () => {
        entered()
        await gate
      },
    }

    const first = runEventConsumerOnce(slow)
    try {
      // The first run has created its cursor row, uncommitted, and is working.
      await inHandler
      const started = Date.now()
      const second = await runEventConsumerOnce({
        ...slow,
        handler: () => Promise.resolve(),
      })
      expect(second.status).toBe('locked')
      expect(Date.now() - started).toBeLessThan(2_000)
    } finally {
      release()
    }
    expect((await first).status).toBe('processed')
  })

  it('refuses to skip when no failure is on record', async () => {
    const consumer = await makeConsumer(['test.events.consumer_spec.a'], () =>
      Promise.resolve(),
    )
    await expect(skipPoisonEvent(consumer.id)).rejects.toThrow(ValidationError)
  })
})
