// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Retention's horizon rule, and where a new cursor starts.
 *
 * Gate 1 throughout. Every weakening of the horizon rule — excluding a parked
 * consumer, excluding a consumer this process does not register, or reading a
 * null minimum as zero — deletes committed facts a consumer was still owed, with
 * no error and no recovery. Each of those is a one-line change that looks like a
 * cleanup, which is exactly why they are pinned here.
 *
 * On the concurrent harness, because everything here reasons about committed
 * seqs and the sequencing trigger only assigns one at COMMIT.
 *
 * Two harness disciplines that are not optional. This suite **back-dates its own
 * events with an explicit update** rather than relying on the age of anything it
 * did not create — which also isolates it, since every other suite's events are
 * minutes old. And it cleans up **by the specific ids it created**, never by type
 * and never by truncation.
 */

import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import type { DomainEventConsumer } from '@/lib/events'
import { ConcurrentTestDatabase } from '@/__tests__/helpers/concurrent-db'
import { db } from '@/lib/db'
import { domainEvents, eventConsumers } from '@/lib/db/schema'
import { ConflictError } from '@/lib/errors'
import {
  abandonLongParkedConsumers,
  computeRetentionHorizon,
  defineDomainEvent,
  drainEventConsumer,
  ensureDomainEventSequencing,
  forgetEventConsumer,
  pruneDomainEvents,
  publishDomainEvent,
  resumeEventConsumer,
  runEventConsumerOnce,
  sequenceUnsequencedEvents,
  skipPoisonEvent,
} from '@/lib/events'

const RETENTION_SPEC = defineDomainEvent({
  type: 'test.events.retention_spec',
  schemaVersion: 1,
  description: 'Test-only event for retention invariants',
  payloadSchema: z.object({ marker: z.string() }),
})

describe('event log retention', () => {
  const concurrent = new ConcurrentTestDatabase()
  const createdEventIds: Array<string> = []
  const createdConsumerIds: Array<string> = []

  beforeAll(async () => {
    concurrent.setup()
    await ensureDomainEventSequencing(concurrent.db)
  })

  afterAll(async () => {
    await concurrent.teardown()
  })

  afterEach(async () => {
    if (createdEventIds.length > 0) {
      await concurrent.db
        .delete(domainEvents)
        .where(inArray(domainEvents.id, createdEventIds))
      createdEventIds.length = 0
    }
    if (createdConsumerIds.length > 0) {
      await concurrent.db
        .delete(eventConsumers)
        .where(inArray(eventConsumers.id, createdConsumerIds))
      createdConsumerIds.length = 0
    }
    await concurrent.cleanup()
  })

  /** Publish in its own committed transaction, and remember the id for cleanup. */
  async function publish(marker: string): Promise<{ id: string; seq: number }> {
    const pending = await db.transaction((tx) =>
      publishDomainEvent(tx, RETENTION_SPEC, { payload: { marker } }),
    )
    createdEventIds.push(pending.id)
    const row = await concurrent.db
      .select({ seq: domainEvents.seq })
      .from(domainEvents)
      .where(eq(domainEvents.id, pending.id))
      .then((rows) => rows.at(0))
    return { id: pending.id, seq: row?.seq ?? 0 }
  }

  /** Back-date an event this suite created, explicitly. */
  async function backDate(id: string, days: number): Promise<void> {
    await concurrent.db
      .update(domainEvents)
      .set({ occurredAt: new Date(Date.now() - days * 24 * 60 * 60 * 1000) })
      .where(eq(domainEvents.id, id))
  }

  async function cursor(id: string, lastSeq: number, parkedAt?: Date) {
    createdConsumerIds.push(id)
    await concurrent.db
      .insert(eventConsumers)
      .values({ id, lastSeq, parkedAt: parkedAt ?? null })
  }

  async function readCursor(id: string) {
    return concurrent.db
      .select()
      .from(eventConsumers)
      .where(eq(eventConsumers.id, id))
      .then((rows) => rows.at(0))
  }

  describe('the horizon', () => {
    it('a parked consumer pins the horizon exactly like a healthy one', async () => {
      const first = await publish('parked-1')
      const parkedId = `test.retention.parked-${randomUUID().slice(0, 8)}`
      await cursor(parkedId, first.seq, new Date())

      const horizon = await computeRetentionHorizon(concurrent.db)

      // Still owed its backlog: parking is a pause, not a forfeit.
      expect(horizon.horizonSeq).toBeLessThanOrEqual(first.seq)
      expect(horizon.abandoned).not.toContain(parkedId)
    })

    it('a consumer parked past the give-up horizon is excluded and marked', async () => {
      const event = await publish('abandoned-1')
      const staleId = `test.retention.stale-${randomUUID().slice(0, 8)}`
      const longAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
      await cursor(staleId, event.seq, longAgo)

      const stamped = await abandonLongParkedConsumers(concurrent.db, {
        abandonAfterDays: 30,
      })
      const horizon = await computeRetentionHorizon(concurrent.db, {
        abandonAfterDays: 30,
      })

      // One extension that parks and is never fixed must not make the log grow
      // without bound while the prune reports success every run.
      expect(stamped).toContain(staleId)
      expect(horizon.abandoned).toContain(staleId)
      // ...and the exclusion is an announced state rather than a recomputation.
      expect((await readCursor(staleId))?.abandonedAt).not.toBeNull()
    })

    /**
     * Its backlog may already be pruned, so reopening it would run it from a
     * cursor whose events have holes nobody can see. Forgetting is the only way
     * back, and the one action still allowed.
     */
    it('refuses to resume or skip an abandoned consumer, and lets it be forgotten', async () => {
      const event = await publish('abandoned-reopen')
      const id = `test.retention.reopen-${randomUUID().slice(0, 8)}`
      createdConsumerIds.push(id)
      await concurrent.db.insert(eventConsumers).values({
        id,
        lastSeq: event.seq - 1,
        failureCount: 10,
        lastErrorSeq: event.seq,
        parkedAt: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000),
        abandonedAt: new Date(),
      })

      await expect(resumeEventConsumer(id)).rejects.toBeInstanceOf(
        ConflictError,
      )
      await expect(skipPoisonEvent(id)).rejects.toBeInstanceOf(ConflictError)
      // Still parked and still abandoned: the refusals changed nothing.
      const row = await readCursor(id)
      expect(row?.parkedAt).not.toBeNull()
      expect(row?.abandonedAt).not.toBeNull()

      expect(await forgetEventConsumer(concurrent.db, id)).toBe(true)
    })

    it('forgetting a cursor takes it off the floor', async () => {
      const lowId = `test.retention.low-${randomUUID().slice(0, 8)}`
      // At 0, the lowest position a cursor can hold — so the floor is 0 and
      // this cursor is among those pinning it, whatever cursors other suites
      // hold. An equality on anything higher raced them.
      await cursor(lowId, 0)

      const before = await computeRetentionHorizon(concurrent.db)
      expect(before.horizonSeq).toBe(0)
      expect(before.pinnedBy).toContain(lowId)

      expect(await forgetEventConsumer(concurrent.db, lowId)).toBe(true)

      const after = await computeRetentionHorizon(concurrent.db)
      expect(after.pinnedBy).not.toContain(lowId)
    })

    it('counts a null-seq row and never prunes it', async () => {
      // A committed row with no seq: real, undelivered, and invisible to every
      // consumer's `seq > cursor` scan. It means the sequencing trigger is
      // missing, which is worth reporting rather than sweeping up.
      //
      // Nulled *after* the insert rather than inserted null, because the
      // sequencing trigger is `AFTER INSERT ... DEFERRABLE` and assigns the seq
      // at COMMIT — so a null in the INSERT does not stay null. An UPDATE to
      // null does not re-fire it, which is what makes this reachable without
      // disabling a trigger other suites in the pool are relying on.
      const published = await publish('null-seq')
      const id = published.id
      await backDate(id, 400)
      await concurrent.db
        .update(domainEvents)
        .set({ seq: null })
        .where(eq(domainEvents.id, id))

      const horizon = await computeRetentionHorizon(concurrent.db)
      expect(horizon.unsequenced).toBeGreaterThanOrEqual(1)

      await pruneDomainEvents(concurrent.db, {
        cutoff: new Date(),
        horizonSeq: null,
        batchSize: 100,
        maxBatches: 1,
      })

      const survived = await concurrent.db
        .select({ id: domainEvents.id })
        .from(domainEvents)
        .where(eq(domainEvents.id, id))
      expect(survived).toHaveLength(1)

      // ...until boot gives it one. Scoped to this row, so no other suite's
      // deliberately unsequenced row is touched.
      expect(
        await sequenceUnsequencedEvents(concurrent.db, { ids: [id] }),
      ).toBe(1)
      const [resequenced] = await concurrent.db
        .select({ seq: domainEvents.seq })
        .from(domainEvents)
        .where(eq(domainEvents.id, id))
      expect(resequenced?.seq).toBeGreaterThan(published.seq)
    })
  })

  describe('the prune', () => {
    it('keeps an ancient event above the horizon, and a recent one below it', async () => {
      const ancient = await publish('ancient')
      await backDate(ancient.id, 400)
      const recent = await publish('recent')

      // Horizon below the ancient event: it is old enough but nobody has passed
      // it, so it stays.
      await pruneDomainEvents(concurrent.db, {
        cutoff: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
        horizonSeq: ancient.seq - 1,
        batchSize: 100,
        maxBatches: 5,
      })
      expect(
        await concurrent.db
          .select({ id: domainEvents.id })
          .from(domainEvents)
          .where(eq(domainEvents.id, ancient.id)),
      ).toHaveLength(1)

      // Horizon past both, but the recent one is newer than the cutoff: it
      // stays too. Age and horizon are both required, not either.
      const result = await pruneDomainEvents(concurrent.db, {
        cutoff: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
        horizonSeq: recent.seq,
        batchSize: 100,
        maxBatches: 5,
      })
      expect(result.deleted).toBeGreaterThanOrEqual(1)
      expect(
        await concurrent.db
          .select({ id: domainEvents.id })
          .from(domainEvents)
          .where(eq(domainEvents.id, recent.id)),
      ).toHaveLength(1)
    })

    it('batches, and reports whether more remains', async () => {
      const ids: Array<number> = []
      for (let i = 0; i < 3; i++) {
        const event = await publish(`batch-${i}`)
        await backDate(event.id, 400)
        ids.push(event.seq)
      }
      const highest = Math.max(...ids)

      const first = await pruneDomainEvents(concurrent.db, {
        cutoff: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
        horizonSeq: highest,
        batchSize: 1,
        maxBatches: 1,
      })
      expect(first.deleted).toBe(1)
      expect(first.batches).toBe(1)
      expect(first.hasMore).toBe(true)

      const rest = await pruneDomainEvents(concurrent.db, {
        cutoff: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
        horizonSeq: highest,
        batchSize: 10,
        maxBatches: 5,
      })
      expect(rest.deleted).toBeGreaterThanOrEqual(2)
      expect(rest.hasMore).toBe(false)
    })
  })

  describe('startAt', () => {
    function consumerFor(
      id: string,
      seen: Array<string>,
      startAt?: 'origin' | 'head',
    ): DomainEventConsumer {
      createdConsumerIds.push(id)
      return {
        id,
        eventTypes: [RETENTION_SPEC.type],
        startAt,
        handler: (event) => {
          seen.push((event.payload as { marker: string }).marker)
          return Promise.resolve()
        },
      }
    }

    it('a head-start consumer skips history, then sees what comes next', async () => {
      await publish('before-head')
      const seen: Array<string> = []
      const id = `test.retention.head-${randomUUID().slice(0, 8)}`
      const consumer = consumerFor(id, seen, 'head')

      const firstRun = await runEventConsumerOnce(consumer)
      // Zero processed rather than an `idle` status: another suite's event
      // committed after the seed is skipped past, which is progress.
      expect(firstRun.processed).toBe(0)
      expect(seen).toEqual([])

      await publish('after-head')
      await drainEventConsumer(consumer)
      expect(seen).toEqual(['after-head'])
    })

    it('an origin-start consumer delivers from the beginning', async () => {
      const event = await publish('from-origin')
      const seen: Array<string> = []
      const id = `test.retention.origin-${randomUUID().slice(0, 8)}`
      await drainEventConsumer(consumerFor(id, seen, 'origin'))

      expect(seen).toContain('from-origin')
      void event
    })

    it('never re-seeds an existing cursor row', async () => {
      const id = `test.retention.noreseed-${randomUUID().slice(0, 8)}`
      await cursor(id, 1)
      await publish('after-existing-cursor')

      const seen: Array<string> = []
      // `DO UPDATE` here would re-seed this lagging head-start consumer to the
      // head on every poll and silently drop its backlog.
      await runEventConsumerOnce({
        id,
        eventTypes: [RETENTION_SPEC.type],
        startAt: 'head',
        handler: (event) => {
          seen.push((event.payload as { marker: string }).marker)
          return Promise.resolve()
        },
      })
      expect(seen).toContain('after-existing-cursor')
    })
  })

  describe('enabled', () => {
    it('a disabled run creates no cursor row and advances nothing', async () => {
      await publish('while-disabled')
      const id = `test.retention.disabled-${randomUUID().slice(0, 8)}`
      createdConsumerIds.push(id)

      const result = await runEventConsumerOnce({
        id,
        eventTypes: [RETENTION_SPEC.type],
        startAt: 'head',
        enabled: () => false,
        handler: () => Promise.resolve(),
      })

      expect(result.status).toBe('disabled')
      // No cursor at all, which is what lets the first enable start wherever
      // `startAt` says rather than at a head frozen while it was off.
      expect(await readCursor(id)).toBeUndefined()
    })

    it('enabling later starts at the head as it stands then', async () => {
      const id = `test.retention.enable-${randomUUID().slice(0, 8)}`
      createdConsumerIds.push(id)
      let on = false
      const seen: Array<string> = []
      const consumer: DomainEventConsumer = {
        id,
        eventTypes: [RETENTION_SPEC.type],
        startAt: 'head',
        enabled: () => on,
        handler: (event) => {
          seen.push((event.payload as { marker: string }).marker)
          return Promise.resolve()
        },
      }

      await publish('published-while-off')
      expect((await runEventConsumerOnce(consumer)).status).toBe('disabled')

      on = true
      await runEventConsumerOnce(consumer)
      // The backlog accrued while it was off is not replayed — the head it
      // starts from is the head at first enable, not at registration.
      expect(seen).toEqual([])

      await publish('published-while-on')
      await drainEventConsumer(consumer)
      expect(seen).toEqual(['published-while-on'])
    })
  })
})
