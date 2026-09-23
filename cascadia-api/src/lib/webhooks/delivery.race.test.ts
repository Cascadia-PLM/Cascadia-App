// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The delivery executor and the pump's lease claim.
 *
 * Gates 1 and 3. The ordering promise — within one subscription, deliveries go
 * out in seq order, at least once — is bought by four things together, and the
 * one most easily broken by a later refactor is the claim rule: selecting "the
 * next *due* pending row" instead of "the oldest pending row unconditionally"
 * preserves order within a run and silently breaks it across runs. Nothing about
 * reading the query says so, which is why it is pinned here.
 *
 * The HTTP boundary is **injected as an option**, never patched onto the global,
 * so these tests say what the executor does with a response rather than what it
 * does to `globalThis`.
 *
 * On the concurrent harness because the lease claim is a race, and because the
 * executor's own writes have to be visible to the next statement.
 */

import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { asc, eq, inArray } from 'drizzle-orm'
import {
  WEBHOOK_FAILURE_THRESHOLD,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RESPONSE_SNIPPET_BYTES,
} from '@cascadia/commons/lib/webhooks/config'
import { deliverForSubscription, deliverNextForSubscription } from './delivery'
import { runWebhookPumpOnce } from './pump'
import { pruneWebhookDeliveries } from './retention'
import type { WebhookSubscriptionRow } from '@/lib/db/schema'
import { ConcurrentTestDatabase } from '@/__tests__/helpers/concurrent-db'
import { webhookDeliveries, webhookSubscriptions } from '@/lib/db/schema'

/** A response, without a real socket. */
function reply(status: number, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : 'ok', { status, headers })
}

describe('webhook delivery', () => {
  const concurrent = new ConcurrentTestDatabase()
  const createdSubscriptionIds: Array<string> = []

  beforeAll(() => {
    concurrent.setup()
  })

  afterAll(async () => {
    await concurrent.teardown()
  })

  afterEach(async () => {
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
    await concurrent.cleanup()
  })

  async function subscribe(
    overrides: Partial<typeof webhookSubscriptions.$inferInsert> = {},
  ): Promise<WebhookSubscriptionRow> {
    const [row] = await concurrent.db
      .insert(webhookSubscriptions)
      .values({
        name: `delivery-${randomUUID().slice(0, 8)}`,
        targetUrl: 'https://hooks.example.test/cascadia',
        eventTypes: ['test.delivery.only'],
        ...overrides,
      })
      .returning()
    if (!row) throw new Error('subscription insert returned nothing')
    createdSubscriptionIds.push(row.id)
    return row
  }

  /** Queue `count` pending deliveries in seq order. */
  async function queue(
    subscriptionId: string,
    count: number,
    createdAt?: Date,
  ): Promise<Array<string>> {
    const inserted = await concurrent.db
      .insert(webhookDeliveries)
      .values(
        Array.from({ length: count }, (_, index) => ({
          subscriptionId,
          eventId: randomUUID(),
          eventSeq: index + 1,
          eventType: 'test.delivery.only',
          body: JSON.stringify({ seq: index + 1 }),
          ...(createdAt ? { createdAt } : {}),
        })),
      )
      .returning({ id: webhookDeliveries.id })
    return inserted.map((row) => row.id)
  }

  async function rows(subscriptionId: string) {
    return concurrent.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.subscriptionId, subscriptionId))
      .orderBy(asc(webhookDeliveries.eventSeq))
  }

  async function reload(id: string): Promise<WebhookSubscriptionRow> {
    const [row] = await concurrent.db
      .select()
      .from(webhookSubscriptions)
      .where(eq(webhookSubscriptions.id, id))
    if (!row) throw new Error('subscription vanished')
    return row
  }

  const allow = () => Promise.resolve()

  describe('ordering within a subscription', () => {
    it('delivers in seq order', async () => {
      const subscription = await subscribe()
      await queue(subscription.id, 3)
      const sent: Array<number> = []

      await deliverForSubscription(concurrent.db, subscription, 10, {
        assertHost: allow,
        fetchImpl: (_url, init) => {
          sent.push((JSON.parse(init.body) as { seq: number }).seq)
          return Promise.resolve(reply(200))
        },
      })

      expect(sent).toEqual([1, 2, 3])
      expect((await rows(subscription.id)).map((r) => r.status)).toEqual([
        'delivered',
        'delivered',
        'delivered',
      ])
    })

    /**
     * Head-of-line blocking is the cost of the ordering promise, and it is the
     * behaviour, not a limitation to route around.
     */
    it('does not send the third when the second fails retryably', async () => {
      const subscription = await subscribe()
      await queue(subscription.id, 3)
      const sent: Array<number> = []

      await deliverForSubscription(concurrent.db, subscription, 10, {
        assertHost: allow,
        fetchImpl: (_url, init) => {
          const seq = (JSON.parse(init.body) as { seq: number }).seq
          sent.push(seq)
          return Promise.resolve(reply(seq === 2 ? 503 : 200))
        },
      })

      expect(sent).toEqual([1, 2])
      const state = await rows(subscription.id)
      expect(state.map((r) => r.status)).toEqual([
        'delivered',
        'pending',
        'pending',
      ])
      expect(state[1]?.nextAttemptAt).not.toBeNull()
    })

    /**
     * Order resumes where it stopped once the failed row is due again. This does
     * not pin the claim rule on its own: the second sweep moves the clock past
     * 2's backoff, so a query selecting the oldest *due* row would send 2 first
     * too. The test after this one is the pin — it sweeps while 2 is still
     * backing off and 3 is due, and expects nothing to go out.
     */
    it('a second sweep still delivers the second before the third', async () => {
      const subscription = await subscribe()
      await queue(subscription.id, 3)
      let attempt = 0

      // First sweep: 1 delivered, 2 fails, 3 untouched.
      await deliverForSubscription(concurrent.db, subscription, 10, {
        assertHost: allow,
        fetchImpl: (_url, init) => {
          const seq = (JSON.parse(init.body) as { seq: number }).seq
          attempt += 1
          return Promise.resolve(reply(seq === 2 && attempt === 2 ? 503 : 200))
        },
      })

      const sent: Array<number> = []
      // Second sweep, with the clock moved past 2's backoff. 2 must go first.
      await deliverForSubscription(
        concurrent.db,
        await reload(subscription.id),
        10,
        {
          assertHost: allow,
          now: () => new Date(Date.now() + 60 * 60 * 1000),
          fetchImpl: (_url, init) => {
            sent.push((JSON.parse(init.body) as { seq: number }).seq)
            return Promise.resolve(reply(200))
          },
        },
      )

      expect(sent).toEqual([2, 3])
    })

    it('stops without sending when the oldest row is not yet due', async () => {
      const subscription = await subscribe()
      await queue(subscription.id, 2)
      let calls = 0

      await deliverForSubscription(concurrent.db, subscription, 10, {
        assertHost: allow,
        fetchImpl: () => {
          calls += 1
          return Promise.resolve(reply(503))
        },
      })
      expect(calls).toBe(1)

      // Immediately again: the first row's backoff has not elapsed, so nothing
      // goes out — not even the second row, which is due.
      await deliverForSubscription(
        concurrent.db,
        await reload(subscription.id),
        10,
        {
          assertHost: allow,
          fetchImpl: () => {
            calls += 1
            return Promise.resolve(reply(200))
          },
        },
      )
      expect(calls).toBe(1)
    })
  })

  describe('attempt accounting', () => {
    /**
     * Incremented *before* the request. A worker that dies mid-flight then costs
     * one attempt from the budget rather than losing the record entirely.
     */
    it('has already incremented the attempt count when fetch is called', async () => {
      const subscription = await subscribe()
      const [deliveryId] = await queue(subscription.id, 1)
      let observed: number | null = null

      await deliverNextForSubscription(concurrent.db, subscription, {
        assertHost: allow,
        fetchImpl: async () => {
          const [row] = await concurrent.db
            .select({ attemptCount: webhookDeliveries.attemptCount })
            .from(webhookDeliveries)
            .where(eq(webhookDeliveries.id, deliveryId ?? ''))
          observed = row?.attemptCount ?? null
          return reply(200)
        },
      })

      expect(observed).toBe(1)
    })

    it('never overwrites a delivery another executor already settled', async () => {
      const subscription = await subscribe()
      const [deliveryId] = await queue(subscription.id, 1)

      await deliverNextForSubscription(concurrent.db, subscription, {
        assertHost: allow,
        fetchImpl: async () => {
          // Another executor records a success while this one is in flight.
          await concurrent.db
            .update(webhookDeliveries)
            .set({ status: 'delivered', deliveredAt: new Date() })
            .where(eq(webhookDeliveries.id, deliveryId ?? ''))
          return reply(404)
        },
      })

      const [row] = await rows(subscription.id)
      expect(row?.status).toBe('delivered')
      // …and the breaker is not charged for a delivery that did not die here.
      expect((await reload(subscription.id)).consecutiveFailures).toBe(0)
    })

    /**
     * Our configuration fault, not the receiver's: no attempt spent, no
     * breaker charged, and the run stops until the key is right.
     */
    it('spends no attempt when the signing secret cannot be decrypted', async () => {
      const subscription = await subscribe({
        encryptedSecret: 'enc:v1:not-real-ciphertext',
        secretPrefix: 'cscwh_test',
      })
      await queue(subscription.id, 1)
      let called = false

      const outcome = await deliverNextForSubscription(
        concurrent.db,
        subscription,
        {
          assertHost: allow,
          fetchImpl: () => {
            called = true
            return Promise.resolve(reply(200))
          },
        },
      )

      expect(called).toBe(false)
      expect(outcome?.stop).toBe(true)
      const [row] = await rows(subscription.id)
      expect(row?.status).toBe('pending')
      expect(row?.attemptCount).toBe(0)
      expect((await reload(subscription.id)).consecutiveFailures).toBe(0)
    })

    it('gives the attempt back when the pump stops mid-request', async () => {
      const subscription = await subscribe()
      await queue(subscription.id, 1)
      const pump = new AbortController()

      const outcome = await deliverNextForSubscription(
        concurrent.db,
        subscription,
        {
          assertHost: allow,
          signal: pump.signal,
          fetchImpl: (_url, init) =>
            new Promise<Response>((_resolve, reject) => {
              init.signal.addEventListener(
                'abort',
                () =>
                  reject(
                    init.signal.reason instanceof Error
                      ? init.signal.reason
                      : new Error('aborted'),
                  ),
                { once: true },
              )
              pump.abort()
            }),
        },
      )

      expect(outcome?.stop).toBe(true)
      const [row] = await rows(subscription.id)
      expect(row?.status).toBe('pending')
      expect(row?.attemptCount).toBe(0)
      expect(row?.error).toBeNull()
    })

    it('marks a row dead once the attempt budget is spent', async () => {
      const subscription = await subscribe()
      await queue(subscription.id, 2)

      let current = subscription
      for (let sweep = 0; sweep < WEBHOOK_MAX_ATTEMPTS; sweep += 1) {
        await deliverForSubscription(concurrent.db, current, 1, {
          assertHost: allow,
          // Far enough ahead each time that the longest backoff (two hours)
          // has elapsed, and deliberately NOT far enough to cross the maximum
          // pending age: expiry is checked before the attempt, so a coarser
          // clock here would expire the row instead of exhausting it — and
          // would hide the fact that a real row cannot retry its way to
          // expiry, the whole retry schedule spanning under three hours.
          now: () => new Date(Date.now() + sweep * 3 * 60 * 60 * 1000),
          fetchImpl: () => Promise.resolve(reply(503)),
        })
        current = await reload(subscription.id)
      }

      const state = await rows(subscription.id)
      expect(state[0]?.status).toBe('dead')
      expect(state[0]?.attemptCount).toBe(WEBHOOK_MAX_ATTEMPTS)
    })

    /**
     * A dead delivery is *stepped past*, not stopped on — which is what makes it
     * different from skipping a log event, where nothing is left behind.
     */
    it('delivers the next row after one dies', async () => {
      const subscription = await subscribe()
      await queue(subscription.id, 2)
      const sent: Array<number> = []

      // A 404 is terminal on the first attempt, so the first row dies at once.
      await deliverForSubscription(concurrent.db, subscription, 10, {
        assertHost: allow,
        fetchImpl: (_url, init) => {
          const seq = (JSON.parse(init.body) as { seq: number }).seq
          sent.push(seq)
          return Promise.resolve(reply(seq === 1 ? 404 : 200))
        },
      })

      expect(sent).toEqual([1, 2])
      expect((await rows(subscription.id)).map((r) => r.status)).toEqual([
        'dead',
        'delivered',
      ])
    })
  })

  describe('response classification', () => {
    it('fails a 404 at the first attempt rather than retrying for hours', async () => {
      const subscription = await subscribe()
      await queue(subscription.id, 1)

      await deliverNextForSubscription(concurrent.db, subscription, {
        assertHost: allow,
        fetchImpl: () => Promise.resolve(reply(404)),
      })

      const [row] = await rows(subscription.id)
      expect(row?.status).toBe('dead')
      expect(row?.attemptCount).toBe(1)
    })

    it('leaves a 503 pending with a future next attempt', async () => {
      const subscription = await subscribe()
      await queue(subscription.id, 1)

      const before = Date.now()
      await deliverNextForSubscription(concurrent.db, subscription, {
        assertHost: allow,
        fetchImpl: () => Promise.resolve(reply(503)),
      })

      const [row] = await rows(subscription.id)
      expect(row?.status).toBe('pending')
      expect(row?.nextAttemptAt?.getTime() ?? 0).toBeGreaterThan(before)
    })

    it('retries a 429 rather than killing it like other 4xx', async () => {
      const subscription = await subscribe()
      await queue(subscription.id, 1)

      await deliverNextForSubscription(concurrent.db, subscription, {
        assertHost: allow,
        fetchImpl: () => Promise.resolve(reply(429)),
      })

      expect((await rows(subscription.id))[0]?.status).toBe('pending')
    })

    /**
     * Following a redirect is what turns a validated public host into an
     * internal-network read primitive, so `redirect: 'manual'` is set and a 3xx
     * is a permanent, recorded failure.
     */
    it('refuses a redirect permanently', async () => {
      const subscription = await subscribe()
      await queue(subscription.id, 1)

      // That the request is made with `redirect: 'manual'` is pinned by the
      // `FetchLike` type, which declares that field as the literal — a compile-
      // time guarantee, and a stronger one than an assertion here could be. What
      // this asserts is the half a type cannot: that a 3xx is treated as
      // permanent rather than retried, and that the location is never followed.
      await deliverNextForSubscription(concurrent.db, subscription, {
        assertHost: allow,
        fetchImpl: () =>
          Promise.resolve(reply(302, { location: 'http://169.254.169.254/' })),
      })

      const [row] = await rows(subscription.id)
      expect(row?.status).toBe('dead')
      expect(row?.attemptCount).toBe(1)
    })

    it('disables the subscription on 410 Gone', async () => {
      const subscription = await subscribe()
      await queue(subscription.id, 1)

      await deliverNextForSubscription(concurrent.db, subscription, {
        assertHost: allow,
        fetchImpl: () => Promise.resolve(reply(410)),
      })

      const after = await reload(subscription.id)
      expect(after.disabledAt).not.toBeNull()
      expect(after.disabledReason).toContain('410')
    })
  })

  describe('the breaker', () => {
    /** Counted per dead delivery, not per failed attempt — one flaky minute must not trip it. */
    it('does not count a retryable failure', async () => {
      const subscription = await subscribe()
      await queue(subscription.id, 1)

      await deliverNextForSubscription(concurrent.db, subscription, {
        assertHost: allow,
        fetchImpl: () => Promise.resolve(reply(503)),
      })

      expect((await reload(subscription.id)).consecutiveFailures).toBe(0)
    })

    it('disables the subscription at the threshold', async () => {
      const subscription = await subscribe()
      await queue(subscription.id, WEBHOOK_FAILURE_THRESHOLD)

      // Every 404 is terminal on its first attempt, so each row dies at once.
      await deliverForSubscription(
        concurrent.db,
        subscription,
        WEBHOOK_FAILURE_THRESHOLD,
        { assertHost: allow, fetchImpl: () => Promise.resolve(reply(404)) },
      )

      const after = await reload(subscription.id)
      expect(after.consecutiveFailures).toBe(WEBHOOK_FAILURE_THRESHOLD)
      expect(after.disabledAt).not.toBeNull()
    })

    it('one success resets it', async () => {
      const subscription = await subscribe({ consecutiveFailures: 3 })
      await queue(subscription.id, 1)

      await deliverNextForSubscription(concurrent.db, subscription, {
        assertHost: allow,
        fetchImpl: () => Promise.resolve(reply(200)),
      })

      const after = await reload(subscription.id)
      expect(after.consecutiveFailures).toBe(0)
      expect(after.lastSuccessAt).not.toBeNull()
    })
  })

  describe('error hygiene', () => {
    /**
     * The API error builder returns a message verbatim to the HTTP client, the
     * error-log table stores context unredacted, and the logger has no redaction
     * paths. So a delivery failure that carried the target URL or the upstream
     * body would be an SSRF read primitive that is both API-readable and
     * permanently logged.
     */
    it('throws nothing, and records neither the URL nor the response body', async () => {
      const subscription = await subscribe({
        targetUrl: 'https://secret-internal-name.example.test/private/path',
      })
      await queue(subscription.id, 1)

      await expect(
        deliverNextForSubscription(concurrent.db, subscription, {
          assertHost: allow,
          fetchImpl: () =>
            Promise.resolve(
              new Response('SECRET-UPSTREAM-BODY', { status: 500 }),
            ),
        }),
      ).resolves.not.toThrow()

      const [row] = await rows(subscription.id)
      expect(row?.error).not.toContain('secret-internal-name')
      expect(row?.error).not.toContain('private/path')
      expect(row?.error).not.toContain('SECRET-UPSTREAM-BODY')
      // It does name the subscription, which is what an operator needs.
      expect(row?.error).toContain(subscription.id)
      // The body is kept as a bounded snippet, on its own column, deliberately.
      expect(row?.responseSnippet).toBe('SECRET-UPSTREAM-BODY')
    })

    it('records an egress refusal as data rather than throwing', async () => {
      const subscription = await subscribe()
      await queue(subscription.id, 1)

      const outcome = await deliverNextForSubscription(
        concurrent.db,
        subscription,
        {
          assertHost: () => {
            const error = new Error(
              'Delivery target resolves to a loopback address',
            )
            error.name = 'EgressBlockedError'
            return Promise.reject(error)
          },
          fetchImpl: () => {
            throw new Error('fetch must not be reached')
          },
        },
      )

      // Terminal: the name will resolve there again on the next attempt.
      expect(outcome?.status).toBe('dead')
      const [row] = await rows(subscription.id)
      expect(row?.error).toContain('egress guard')
      expect(row?.error).toContain(subscription.id)
    })

    /**
     * A name that did not resolve is no verdict on its address. Treating it as
     * a block killed every delivery a DNS outage touched, for good.
     */
    it('retries a target whose host did not resolve, rather than killing it', async () => {
      const subscription = await subscribe()
      await queue(subscription.id, 1)

      const outcome = await deliverNextForSubscription(
        concurrent.db,
        subscription,
        {
          assertHost: () => {
            const error = new Error(
              'Delivery target is a host that does not resolve',
            )
            error.name = 'EgressResolutionError'
            return Promise.reject(error)
          },
          fetchImpl: () => {
            throw new Error('fetch must not be reached')
          },
        },
      )

      expect(outcome?.status).toBe('pending')
      const [row] = await rows(subscription.id)
      expect(row?.error).toContain('resolve')
      expect(row?.nextAttemptAt).not.toBeNull()
    })

    /**
     * The snippet used to be `response.text()` sliced afterwards — the whole
     * body buffered first, after decompression. An endless body is the proof:
     * that call never returns.
     */
    it('keeps a bounded snippet without reading the rest of the body', async () => {
      const subscription = await subscribe()
      await queue(subscription.id, 1)
      let pulls = 0
      const endless = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1
          controller.enqueue(new Uint8Array(64 * 1024).fill(0x61))
        },
      })

      await deliverNextForSubscription(concurrent.db, subscription, {
        assertHost: allow,
        fetchImpl: () =>
          Promise.resolve(new Response(endless, { status: 500 })),
      })

      const [row] = await rows(subscription.id)
      expect(row?.responseSnippet?.length).toBe(WEBHOOK_RESPONSE_SNIPPET_BYTES)
      expect(pulls).toBeLessThan(5)
    })
  })

  describe('expiry', () => {
    /**
     * Re-enabling a long-disabled subscription must not flood its receiver with
     * a week of backlog in one sweep — which looks exactly like an attack from
     * their side.
     */
    it('expires a pending delivery older than the maximum age instead of sending it', async () => {
      const subscription = await subscribe()
      const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      await queue(subscription.id, 1, old)
      let called = false

      await deliverNextForSubscription(concurrent.db, subscription, {
        assertHost: allow,
        fetchImpl: () => {
          called = true
          return Promise.resolve(reply(200))
        },
      })

      expect(called).toBe(false)
      const [row] = await rows(subscription.id)
      expect(row?.status).toBe('expired')
      expect(row?.error).toContain('maximum pending age')
    })
  })

  /**
   * Gates 1 and 3 for the claim, and the leg of the ordering promise most easily
   * broken by a later refactor of the query. Asserted on the rows the claiming
   * update returns, never on a spy.
   */
  describe('retention', () => {
    /**
     * The pump never visits a deleted subscription and retention prunes only
     * settled rows, so a pending row a deleted subscription still held stayed
     * pending forever — and kept "is the pump running?" firing for a healthy
     * pump. A cutoff at the epoch deletes nothing, so no other suite's settled
     * rows are touched.
     */
    it("expires a deleted subscription's pending deliveries so they can age out", async () => {
      const subscription = await subscribe({ deletedAt: new Date() })
      await queue(subscription.id, 2)

      const result = await pruneWebhookDeliveries(concurrent.db, {
        cutoff: new Date(0),
      })

      expect(result.expired).toBeGreaterThanOrEqual(2)
      const state = await rows(subscription.id)
      expect(state.map((row) => row.status)).toEqual(['expired', 'expired'])
      expect(state[0]?.error).toContain('deleted')
    })
  })

  describe('the pump lease claim', () => {
    it('two concurrent ticks claim disjoint sets whose union is everything', async () => {
      const first = await subscribe()
      const second = await subscribe()
      const third = await subscribe()
      const fourth = await subscribe()
      for (const s of [first, second, third, fourth]) {
        await queue(s.id, 1)
      }

      const seen: Array<string> = []
      const tick = () =>
        runWebhookPumpOnce({
          database: concurrent.db,
          concurrency: 4,
          subscriptionIds: [first.id, second.id, third.id, fourth.id],
          delivery: {
            assertHost: allow,
            fetchImpl: (_url, init) => {
              seen.push(init.headers['x-cascadia-event-id'] ?? '')
              return Promise.resolve(reply(200))
            },
          },
        })

      const [a, b] = await Promise.all([tick(), tick()])

      // Disjoint: nothing was claimed twice, so nothing was sent twice.
      expect(seen).toHaveLength(new Set(seen).size)
      // And their union is the whole due set — exactly these four, since the
      // claim is scoped to them rather than to whatever other suites queued.
      expect(a.claimed + b.claimed).toBe(4)
      expect(new Set(seen).size).toBe(4)
    })

    it('does not claim a subscription whose lease is still live', async () => {
      const subscription = await subscribe({
        deliveryLeaseUntil: new Date(Date.now() + 60_000),
      })
      await queue(subscription.id, 1)

      const result = await runWebhookPumpOnce({
        database: concurrent.db,
        subscriptionIds: [subscription.id],
        delivery: {
          assertHost: allow,
          fetchImpl: () => {
            throw new Error('must not deliver under a live lease')
          },
        },
      })

      expect(result.claimed).toBe(0)
    })

    it('reaps an expired lease and claims it exactly once', async () => {
      const subscription = await subscribe({
        deliveryLeaseUntil: new Date(Date.now() - 60_000),
      })
      await queue(subscription.id, 1)

      const sent: Array<string> = []
      const tick = () =>
        runWebhookPumpOnce({
          database: concurrent.db,
          subscriptionIds: [subscription.id],
          delivery: {
            assertHost: allow,
            fetchImpl: (_url, init) => {
              sent.push(init.headers['x-cascadia-event-id'] ?? '')
              return Promise.resolve(reply(200))
            },
          },
        })

      const [a, b] = await Promise.all([tick(), tick()])

      expect(a.claimed + b.claimed).toBe(1)
      expect(sent).toHaveLength(1)
    })

    it('releases the lease when the run is over', async () => {
      const subscription = await subscribe()
      await queue(subscription.id, 1)

      await runWebhookPumpOnce({
        database: concurrent.db,
        subscriptionIds: [subscription.id],
        delivery: {
          assertHost: allow,
          fetchImpl: () => Promise.resolve(reply(200)),
        },
      })

      expect((await reload(subscription.id)).deliveryLeaseUntil).toBeNull()
    })

    /**
     * A healthy subscription must deliver fully in the same sweep as a failing
     * one: there is no cross-subscription ordering promise, and one bad receiver
     * holding up another is the failure mode the whole design avoids.
     */
    it('delivers a healthy subscription fully alongside a failing one', async () => {
      // Distinct targets, so the injected fetch can tell them apart. Both are
      // public names the guard would accept; delivery is stubbed either way.
      const healthy = await subscribe({
        targetUrl: 'https://healthy.example.test/hook',
      })
      const broken = await subscribe({
        targetUrl: 'https://broken.example.test/hook',
      })
      await queue(healthy.id, 3)
      await queue(broken.id, 3)

      await runWebhookPumpOnce({
        database: concurrent.db,
        concurrency: 4,
        subscriptionIds: [healthy.id, broken.id],
        delivery: {
          assertHost: allow,
          fetchImpl: (url) =>
            Promise.resolve(reply(url.includes('broken') ? 503 : 200)),
        },
      })

      // The healthy one drained completely in the same sweep.
      expect((await rows(healthy.id)).map((r) => r.status)).toEqual([
        'delivered',
        'delivered',
        'delivered',
      ])

      // The failing one blocked on its own first row and got no further — its
      // head-of-line block is its own, not everybody's.
      const brokenRows = await rows(broken.id)
      expect(brokenRows.map((r) => r.status)).toEqual([
        'pending',
        'pending',
        'pending',
      ])
      expect(brokenRows[0]?.attemptCount).toBe(1)
      expect(brokenRows[1]?.attemptCount).toBe(0)
    })

    /**
     * The claim ordered by `last_failure_at`, which sorts nulls last and is never
     * cleared, so blocked subscriptions with a failure history filled every
     * tick's budget and one that had never failed was not claimed at all.
     */
    it('claims a subscription that has never failed ahead of blocked ones', async () => {
      const blocked: Array<WebhookSubscriptionRow> = []
      for (let i = 0; i < 4; i += 1) {
        const subscription = await subscribe({
          lastFailureAt: new Date(Date.now() - 60 * 60 * 1000),
        })
        const [deliveryId] = await queue(subscription.id, 1)
        // Head of line in backoff: pending, attempted, not due for an hour.
        await concurrent.db
          .update(webhookDeliveries)
          .set({
            attemptCount: 1,
            nextAttemptAt: new Date(Date.now() + 60 * 60 * 1000),
          })
          .where(eq(webhookDeliveries.id, deliveryId ?? ''))
        blocked.push(subscription)
      }
      const healthy = await subscribe()
      await queue(healthy.id, 1)

      const result = await runWebhookPumpOnce({
        database: concurrent.db,
        concurrency: 4,
        subscriptionIds: [...blocked.map((s) => s.id), healthy.id],
        delivery: {
          assertHost: allow,
          fetchImpl: () => Promise.resolve(reply(200)),
        },
      })

      // Only the one with due work was claimed, and it was delivered.
      expect(result.claimed).toBe(1)
      expect((await rows(healthy.id))[0]?.status).toBe('delivered')
    })

    /**
     * A run outlasting its lease let a second worker claim the subscription and
     * send the same rows. The lease is renewed before every delivery, and a run
     * that finds it taken stops — without clearing the other worker's lease.
     */
    it('stops a run whose lease another worker has taken', async () => {
      const subscription = await subscribe()
      await queue(subscription.id, 3)
      const sent: Array<number> = []

      await runWebhookPumpOnce({
        database: concurrent.db,
        subscriptionIds: [subscription.id],
        delivery: {
          assertHost: allow,
          fetchImpl: async (_url, init) => {
            sent.push((JSON.parse(init.body) as { seq: number }).seq)
            // Another worker claims the subscription mid-run, as one could
            // once a slow receiver had outlasted the lease.
            await concurrent.db
              .update(webhookSubscriptions)
              .set({ deliveryLeaseUntil: new Date(Date.now() + 120_000) })
              .where(eq(webhookSubscriptions.id, subscription.id))
            return reply(200)
          },
        },
      })

      expect(sent).toEqual([1])
      expect((await reload(subscription.id)).deliveryLeaseUntil).not.toBeNull()
    })
  })
})
