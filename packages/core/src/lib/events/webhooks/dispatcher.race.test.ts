// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The webhook fan-out: who gets a delivery row, and exactly once.
 *
 * Gate 1. Every rule here decides whether a customer's server receives an HTTP
 * request it should not — a second copy of an event it already handled, an event
 * from a program it cannot see, or an event that predates its subscription — and
 * none of them is visible by reading the handler, because all of them live in
 * one `where` clause.
 *
 * On the concurrent harness, because the fan-out is a function of committed
 * `seq` values and the sequencing trigger only assigns one at COMMIT.
 *
 * **Two harness disciplines this suite cannot skip.** Subscription rows are
 * committed and globally visible here, and the dispatcher is a wildcard
 * consumer — so a test subscription with an empty type filter would fan out
 * every event every other suite commits in the parallel pool. Every subscription
 * below therefore names this suite's own private event types explicitly, and
 * cleanup deletes by the ids it created rather than by type or by truncation.
 */

import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { asc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { createWebhookDispatcher } from './dispatcher'
import { ConcurrentTestDatabase } from '@/__tests__/helpers/concurrent-db'
import { db } from '@/lib/db'
import {
  domainEvents,
  eventConsumers,
  webhookDeliveries,
  webhookSubscriptions,
} from '@/lib/db/schema'
import {
  defineDomainEvent,
  ensureDomainEventSequencing,
  publishDomainEvent,
  runEventConsumerOnce,
} from '@/lib/events'
import { asDomainEventConsumer } from '@/lib/extensions'

/** This suite's own types. Nothing else in the pool publishes them. */
const WATCHED = defineDomainEvent({
  type: 'test.webhooks.watched',
  schemaVersion: 1,
  description: 'Test-only event a webhook subscription asks for',
  payloadSchema: z.object({ marker: z.string() }),
})

const IGNORED = defineDomainEvent({
  type: 'test.webhooks.ignored',
  schemaVersion: 1,
  description: 'Test-only event no webhook subscription asks for',
  payloadSchema: z.object({ marker: z.string() }),
})

describe('webhook dispatcher fan-out', () => {
  const concurrent = new ConcurrentTestDatabase()
  const createdEventIds: Array<string> = []
  const createdSubscriptionIds: Array<string> = []

  // A consumer id per run, so a re-run never inherits a cursor and parallel
  // files never contend for one.
  const consumerId = `test.webhooks.dispatch-${randomUUID().slice(0, 8)}`
  const dispatcher = asDomainEventConsumer({
    ...createWebhookDispatcher({ now: () => new Date('2026-09-12T00:00:00Z') }),
    id: consumerId,
    // 'origin' rather than the production 'head': a head-start consumer would
    // seed its cursor at the current head and process nothing, which is right
    // in production and useless here.
    startAt: 'origin',
  })

  beforeAll(async () => {
    concurrent.setup()
    await ensureDomainEventSequencing(concurrent.db)
  })

  afterAll(async () => {
    await concurrent.teardown()
  })

  afterEach(async () => {
    // Deliveries cascade from subscriptions, but delete them explicitly so a
    // failure that left an orphan is visible rather than swept up.
    if (createdSubscriptionIds.length > 0) {
      await concurrent.db
        .delete(webhookDeliveries)
        .where(
          inArray(webhookDeliveries.subscriptionId, createdSubscriptionIds),
        )
      await concurrent.db
        .delete(webhookSubscriptions)
        .where(inArray(webhookSubscriptions.id, createdSubscriptionIds))
      createdSubscriptionIds.length = 0
    }
    if (createdEventIds.length > 0) {
      await concurrent.db
        .delete(domainEvents)
        .where(inArray(domainEvents.id, createdEventIds))
      createdEventIds.length = 0
    }
    await concurrent.db
      .delete(eventConsumers)
      .where(eq(eventConsumers.id, consumerId))
    await concurrent.cleanup()
  })

  /** Publish in its own committed transaction so the trigger assigns a seq. */
  async function publish(
    definition: typeof WATCHED | typeof IGNORED,
    marker: string,
    context?: { designId?: string; programId?: string },
  ): Promise<{ id: string; seq: number }> {
    const pending = await db.transaction((tx) =>
      publishDomainEvent(tx, definition, { payload: { marker }, context }),
    )
    createdEventIds.push(pending.id)
    const row = await concurrent.db
      .select({ seq: domainEvents.seq })
      .from(domainEvents)
      .where(eq(domainEvents.id, pending.id))
      .then((rows) => rows.at(0))
    return { id: pending.id, seq: row?.seq ?? 0 }
  }

  interface SubscriptionOverrides {
    eventTypes?: Array<string>
    enabled?: boolean
    deletedAt?: Date | null
    programId?: string | null
    createdFromSeq?: number
  }

  async function subscribe(
    label: string,
    overrides: SubscriptionOverrides = {},
  ): Promise<string> {
    const [row] = await concurrent.db
      .insert(webhookSubscriptions)
      .values({
        name: `test-${label}-${randomUUID().slice(0, 8)}`,
        targetUrl: 'https://example.test/hook',
        // Never empty by default: an empty filter means every type, and on this
        // harness that means every other suite's committed events too.
        eventTypes: overrides.eventTypes ?? [WATCHED.type],
        enabled: overrides.enabled ?? true,
        deletedAt: overrides.deletedAt ?? null,
        programId: overrides.programId ?? null,
        createdFromSeq: overrides.createdFromSeq ?? 0,
      })
      .returning({ id: webhookSubscriptions.id })
    if (!row) throw new Error('subscription insert returned nothing')
    createdSubscriptionIds.push(row.id)
    return row.id
  }

  async function deliveriesFor(subscriptionId: string) {
    return concurrent.db
      .select({
        eventId: webhookDeliveries.eventId,
        eventSeq: webhookDeliveries.eventSeq,
        eventType: webhookDeliveries.eventType,
        status: webhookDeliveries.status,
        body: webhookDeliveries.body,
      })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.subscriptionId, subscriptionId))
      .orderBy(asc(webhookDeliveries.eventSeq))
  }

  /** Start the cursor just below `seq` so the run sees that event and no other. */
  async function cursorJustBefore(seq: number): Promise<void> {
    await concurrent.db
      .insert(eventConsumers)
      .values({ id: consumerId, lastSeq: seq - 1 })
      .onConflictDoUpdate({
        target: eventConsumers.id,
        set: { lastSeq: seq - 1 },
      })
  }

  describe('matching', () => {
    it('writes exactly one delivery per matching subscription', async () => {
      const first = await subscribe('first')
      const second = await subscribe('second')
      const event = await publish(WATCHED, 'match')
      await cursorJustBefore(event.seq)

      await runEventConsumerOnce(dispatcher)

      const firstRows = await deliveriesFor(first)
      const secondRows = await deliveriesFor(second)
      expect(firstRows).toHaveLength(1)
      expect(secondRows).toHaveLength(1)
      expect(firstRows[0]?.eventId).toBe(event.id)
      expect(firstRows[0]?.eventSeq).toBe(event.seq)
      expect(firstRows[0]?.status).toBe('pending')
    })

    it('writes nothing for a type the subscription did not ask for', async () => {
      const subscription = await subscribe('typed', {
        eventTypes: [WATCHED.type],
      })
      const event = await publish(IGNORED, 'other-type')
      await cursorJustBefore(event.seq)

      await runEventConsumerOnce(dispatcher)

      expect(await deliveriesFor(subscription)).toHaveLength(0)
    })

    it('matches every type for a subscription with an empty filter', async () => {
      const subscription = await subscribe('wildcard', { eventTypes: [] })
      const event = await publish(IGNORED, 'wildcard')
      await cursorJustBefore(event.seq)

      await runEventConsumerOnce(dispatcher)

      // Scoped to this event. A wildcard subscription matches every event the
      // run reads, and other suites in the pool commit events between this
      // publish and this run — so the subscription's whole delivery set is not
      // this test's to count.
      const rows = (await deliveriesFor(subscription)).filter(
        (row) => row.eventId === event.id,
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]?.eventType).toBe(IGNORED.type)
    })

    it('writes nothing for a disabled subscription', async () => {
      const subscription = await subscribe('disabled', { enabled: false })
      const event = await publish(WATCHED, 'disabled')
      await cursorJustBefore(event.seq)

      await runEventConsumerOnce(dispatcher)

      expect(await deliveriesFor(subscription)).toHaveLength(0)
    })

    it('writes nothing for a soft-deleted subscription', async () => {
      const subscription = await subscribe('deleted', { deletedAt: new Date() })
      const event = await publish(WATCHED, 'deleted')
      await cursorJustBefore(event.seq)

      await runEventConsumerOnce(dispatcher)

      expect(await deliveriesFor(subscription)).toHaveLength(0)
    })

    /**
     * The property that makes creating a subscription safe on an instance with
     * a long history: it starts at the head of the log, not the beginning.
     */
    it('writes nothing for an event that predates the subscription', async () => {
      const event = await publish(WATCHED, 'too-early')
      const subscription = await subscribe('late', {
        createdFromSeq: event.seq,
      })
      await cursorJustBefore(event.seq)

      await runEventConsumerOnce(dispatcher)

      expect(await deliveriesFor(subscription)).toHaveLength(0)
    })

    it('writes for an event committed after the subscription', async () => {
      const marker = await publish(WATCHED, 'watermark')
      const subscription = await subscribe('timely', {
        createdFromSeq: marker.seq,
      })
      const event = await publish(WATCHED, 'after')
      await cursorJustBefore(event.seq)

      await runEventConsumerOnce(dispatcher)

      const rows = await deliveriesFor(subscription)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.eventId).toBe(event.id)
    })
  })

  /**
   * At-least-once consumption means the handler can re-run over an event it
   * already fanned out — after a crash between the insert and the cursor
   * commit, or after an admin resume. Without the unique key and
   * `ON CONFLICT DO NOTHING` the second run either parks the dispatcher on a
   * duplicate-key error or sends a customer a second copy.
   */
  describe('at-most-once fan-out', () => {
    it('inserts no second row when the same event is re-processed', async () => {
      const subscription = await subscribe('idempotent')
      const event = await publish(WATCHED, 'twice')

      await cursorJustBefore(event.seq)
      await runEventConsumerOnce(dispatcher)
      expect(await deliveriesFor(subscription)).toHaveLength(1)

      // Rewind the cursor: exactly what a crash before the cursor commit, or an
      // admin resume, leaves behind.
      await cursorJustBefore(event.seq)
      const second = await runEventConsumerOnce(dispatcher)

      // 'processed', not 'failed': the duplicate is expected, so the run must
      // succeed rather than parking the dispatcher on a unique-key error.
      expect(second.status).toBe('processed')
      expect(await deliveriesFor(subscription)).toHaveLength(1)
    })
  })

  /**
   * Scope resolves through the event's **design**, not `context.programId` —
   * which no emission site populates, so a filter on it would match nothing and
   * a null-means-all reading of it would leak every program to every scoped
   * subscriber.
   */
  describe('program scope', () => {
    it('delivers an event from the subscription’s own program', async () => {
      const scope = await concurrent.seedScope('webhook-own')
      const subscription = await subscribe('scoped', {
        programId: scope.programId,
      })
      const event = await publish(WATCHED, 'own-program', {
        designId: scope.designId,
      })
      await cursorJustBefore(event.seq)

      await runEventConsumerOnce(dispatcher)

      expect(await deliveriesFor(subscription)).toHaveLength(1)
    })

    it('does not deliver an event from another program', async () => {
      const mine = await concurrent.seedScope('webhook-mine')
      const theirs = await concurrent.seedScope('webhook-theirs')
      const subscription = await subscribe('scoped-other', {
        programId: mine.programId,
      })
      const event = await publish(WATCHED, 'other-program', {
        designId: theirs.designId,
      })
      await cursorJustBefore(event.seq)

      await runEventConsumerOnce(dispatcher)

      expect(await deliveriesFor(subscription)).toHaveLength(0)
    })

    /**
     * Failing closed. An event with no design cannot be attributed to a
     * program, and the safe reading of "cannot attribute" is "not yours" — the
     * alternative delivers instance-wide events to every program-scoped
     * subscriber, which is a cross-program leak.
     */
    it('does not deliver a program-less event to a scoped subscription', async () => {
      const scope = await concurrent.seedScope('webhook-closed')
      const subscription = await subscribe('scoped-closed', {
        programId: scope.programId,
      })
      const event = await publish(WATCHED, 'no-design')
      await cursorJustBefore(event.seq)

      await runEventConsumerOnce(dispatcher)

      expect(await deliveriesFor(subscription)).toHaveLength(0)
    })

    it('delivers a program-less event to an unscoped subscription', async () => {
      const subscription = await subscribe('unscoped', { programId: null })
      const event = await publish(WATCHED, 'instance-wide')
      await cursorJustBefore(event.seq)

      await runEventConsumerOnce(dispatcher)

      expect(await deliveriesFor(subscription)).toHaveLength(1)
    })

    it('delivers a scoped event to an unscoped subscription too', async () => {
      const scope = await concurrent.seedScope('webhook-both')
      const subscription = await subscribe('unscoped-sees-all', {
        programId: null,
      })
      const event = await publish(WATCHED, 'scoped-to-unscoped', {
        designId: scope.designId,
      })
      await cursorJustBefore(event.seq)

      await runEventConsumerOnce(dispatcher)

      expect(await deliveriesFor(subscription)).toHaveLength(1)
    })

    /**
     * A change order has no design, so its facts name their program directly
     * when every design it links shares one. Scope used to be read from the
     * design alone, so a program-scoped subscriber never heard a release.
     */
    it('delivers an event that names its program, with no design, to that program only', async () => {
      const mine = await concurrent.seedScope('webhook-named')
      const theirs = await concurrent.seedScope('webhook-named-other')
      const ours = await subscribe('scoped-named', {
        programId: mine.programId,
      })
      const other = await subscribe('scoped-named-other', {
        programId: theirs.programId,
      })
      const event = await publish(WATCHED, 'named-program', {
        programId: mine.programId,
      })
      await cursorJustBefore(event.seq)

      await runEventConsumerOnce(dispatcher)

      expect(await deliveriesFor(ours)).toHaveLength(1)
      expect(await deliveriesFor(other)).toHaveLength(0)
    })
  })

  describe('the frozen body', () => {
    /**
     * The signature is over these exact bytes, so the body must be stored as
     * sent. Storing it as JSONB would reorder keys on the round trip and the
     * receiver would compute a different digest over what it received.
     */
    it('stores the event as text a receiver can verify byte for byte', async () => {
      const subscription = await subscribe('body')
      const event = await publish(WATCHED, 'frozen')
      await cursorJustBefore(event.seq)

      await runEventConsumerOnce(dispatcher)

      const rows = await deliveriesFor(subscription)
      const body = rows[0]?.body
      expect(body).toBeDefined()
      expect(typeof body).toBe('string')

      const parsed = JSON.parse(body ?? '{}') as {
        id: string
        seq: number
        type: string
        payload: { marker: string }
      }
      expect(parsed.id).toBe(event.id)
      expect(parsed.seq).toBe(event.seq)
      expect(parsed.type).toBe(WATCHED.type)
      expect(parsed.payload.marker).toBe('frozen')
    })

    it('gives every subscription of one event identical bytes', async () => {
      const first = await subscribe('same-bytes-1')
      const second = await subscribe('same-bytes-2')
      const event = await publish(WATCHED, 'shared')
      await cursorJustBefore(event.seq)

      await runEventConsumerOnce(dispatcher)

      const firstBody = (await deliveriesFor(first))[0]?.body
      const secondBody = (await deliveriesFor(second))[0]?.body
      expect(firstBody).toBeDefined()
      expect(firstBody).toBe(secondBody)
    })
  })
})
