// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm'
import { WEBHOOK_DELIVERY_CONCURRENCY } from '@cascadia/commons/lib/webhooks/config'
import { deliverForSubscription } from './delivery'
import type { DbInstance } from '@/lib/db'
import type { DeliverOptions, DeliveryLease } from './delivery'
import { db as defaultDb } from '@/lib/db'
import { webhookDeliveries, webhookSubscriptions } from '@/lib/db/schema'
import { isEncryptionConfigured } from '@/lib/crypto/encryption'
import { webhookLogger } from '@/lib/logging/logger'

/**
 * The thing that picks pending deliveries up and sends them.
 *
 * **Why not the maintenance sweep.** That submits exactly one job per registered
 * *type*, guarded against a recent run over a period defaulting to twenty-four
 * hours. A webhook would fire at most once a day.
 *
 * **A time lease, not a row lock.** A `FOR UPDATE SKIP LOCKED` claim would hold
 * a database lock across every socket in the batch — the same reason the
 * dispatcher may not do HTTP. Instead each tick claims subscriptions with a
 * compare-and-set on `delivery_lease_until`, and **only the rows the update
 * returns are owned by this process**. A crashed worker simply lets its lease
 * expire; nothing has to reap a lock.
 */

/**
 * How long a claim is held before another tick may take it. Renewed before
 * every delivery, so it bounds one delivery rather than a whole run.
 */
const LEASE_MS = 60_000

/** Default tick interval. */
const DEFAULT_INTERVAL_MS = 5_000

/** How long `stop()` waits for deliveries in flight before giving up on them. */
const STOP_DRAIN_MS = 15_000

/** Deliveries one subscription may send in one tick. */
const MAX_PER_SUBSCRIPTION_PER_TICK = 20

export interface WebhookPumpHandle {
  /** False when the pump refused to start; see `startWebhookDeliveryPump`. */
  readonly running: boolean
  /**
   * Stop ticking, abort the requests in flight and wait, bounded, for the tick
   * to finish its bookkeeping. An interrupted delivery gives its attempt back.
   */
  stop: () => Promise<void>
}

export interface StartWebhookPumpOptions {
  intervalMs?: number
  database?: DbInstance
  /** Injected HTTP and egress boundaries, for tests. */
  delivery?: Pick<DeliverOptions, 'fetchImpl' | 'assertHost' | 'now' | 'signal'>
  concurrency?: number
  /**
   * Restrict claims to these subscriptions. A test seam, and only that: the
   * suites share one database, and a pump claiming every subscription would
   * deliver another suite's rows. A production pump never sets it.
   */
  subscriptionIds?: ReadonlyArray<string>
}

/**
 * Whether at least one enabled, signed subscription exists.
 *
 * Asked at boot, because the failure it guards against is invisible at runtime:
 * `ENCRYPTION_KEY` reaches the app service in `docker-compose.yml` and nowhere
 * else — not the worker service, not the demo compose file, not the distributed
 * jobs pair — so in every containerised deployment as it stood before this stage
 * the pump would come up with no key at all.
 */
async function hasSignedSubscriptions(database: DbInstance): Promise<boolean> {
  const [row] = await database
    .select({ id: webhookSubscriptions.id })
    .from(webhookSubscriptions)
    .where(
      and(
        isNull(webhookSubscriptions.deletedAt),
        eq(webhookSubscriptions.enabled, true),
        isNotNull(webhookSubscriptions.encryptedSecret),
      ),
    )
    .limit(1)
  return row !== undefined
}

/**
 * When a subscription's next delivery is due: its oldest pending row — the one
 * the executor takes unconditionally — at that row's next attempt, or at its
 * creation when it has not been attempted. Null when nothing is pending.
 */
const headDueAt = sql`(
  SELECT coalesce(${webhookDeliveries.nextAttemptAt}, ${webhookDeliveries.createdAt})
    FROM ${webhookDeliveries}
   WHERE ${webhookDeliveries.subscriptionId} = ${webhookSubscriptions.id}
     AND ${webhookDeliveries.status} = 'pending'
   ORDER BY ${webhookDeliveries.eventSeq}, ${webhookDeliveries.id}
   LIMIT 1
)`

/** The head delivery's next attempt, or `-infinity` when it has never been tried. */
const headNextAttemptAt = sql`(
  SELECT coalesce(${webhookDeliveries.nextAttemptAt}, '-infinity'::timestamptz)
    FROM ${webhookDeliveries}
   WHERE ${webhookDeliveries.subscriptionId} = ${webhookSubscriptions.id}
     AND ${webhookDeliveries.status} = 'pending'
   ORDER BY ${webhookDeliveries.eventSeq}, ${webhookDeliveries.id}
   LIMIT 1
)`

/**
 * Reap expired leases and claim the subscriptions whose next delivery is due,
 * in two statements.
 *
 * Two rather than one, because bounding the claim is the point. `UPDATE … LIMIT`
 * does not exist in Postgres, and an `IN (SELECT … LIMIT n)` over the same table
 * picks its n *before* the lease predicate is applied — so a tick could spend its
 * whole budget on subscriptions another tick already holds and claim none of the
 * ones with work.
 *
 * So: a plain read picks candidates, then **the update is the claim**. Only the
 * rows the update returns are owned by this process. Two concurrent ticks may
 * read the same candidates — that read is not a lock and does not pretend to be —
 * and the compare-and-set on `delivery_lease_until` is what makes their claims
 * disjoint: after the first commits, the second's `where` no longer matches.
 *
 * **A candidate is a subscription whose head delivery is due, oldest due
 * first.** The executor takes the oldest pending row unconditionally and stops
 * if it is not yet due — that is the ordering promise — so claiming a
 * subscription whose head is in backoff buys nothing but a wasted slot. This
 * used to claim any subscription with a pending row, ordered by
 * `last_failure_at`: a column that sorts nulls last and is never cleared. A few
 * broken receivers, each blocked on a row in backoff, filled every tick's budget
 * ahead of a subscription that had never failed, which then waited until one of
 * them was disabled — hours for a dead receiver, forever for a flaky one.
 *
 * On a process that cannot sign, a signed subscription is not a candidate
 * either: every claim of one would stop at the secret and hold a slot for
 * nothing.
 */
async function claimDueSubscriptions(
  database: DbInstance,
  now: Date,
  limit: number,
  subscriptionIds: ReadonlyArray<string> | undefined,
) {
  const leaseFree = or(
    isNull(webhookSubscriptions.deliveryLeaseUntil),
    lte(webhookSubscriptions.deliveryLeaseUntil, now),
  )

  const live = and(
    isNull(webhookSubscriptions.deletedAt),
    eq(webhookSubscriptions.enabled, true),
    isNull(webhookSubscriptions.disabledAt),
  )

  // Due when never attempted, or when its next attempt has arrived. Never
  // attempted reads as `-infinity` rather than as the row's creation time: the
  // database clock is finer than this one, so a row written in the same
  // millisecond as the claim would otherwise look not yet due. Passed as text
  // with a cast, because a raw template's parameters are untyped and the driver
  // cannot serialise a Date it has no column type for.
  const headIsDue = sql`${headNextAttemptAt} <= ${now.toISOString()}::timestamptz`
  const signable = isEncryptionConfigured()
    ? undefined
    : isNull(webhookSubscriptions.encryptedSecret)
  const scoped = subscriptionIds
    ? inArray(webhookSubscriptions.id, [...subscriptionIds])
    : undefined

  const candidates = await database
    .select({ id: webhookSubscriptions.id })
    .from(webhookSubscriptions)
    .where(and(live, leaseFree, headIsDue, signable, scoped))
    // Oldest due work first. Id breaks the tie.
    .orderBy(headDueAt, webhookSubscriptions.id)
    .limit(limit)

  if (candidates.length === 0) return []

  return database
    .update(webhookSubscriptions)
    .set({ deliveryLeaseUntil: new Date(now.getTime() + LEASE_MS) })
    .where(
      and(
        inArray(
          webhookSubscriptions.id,
          candidates.map((row) => row.id),
        ),
        live,
        leaseFree,
        headIsDue,
      ),
    )
    .returning()
}

/**
 * The lease one run holds on one subscription.
 *
 * **Renewed before every delivery, and compared rather than assumed.** The
 * lease is a minute; one run may send twenty deliveries of up to ten seconds
 * each. Claimed once and never renewed, it expired mid-run, a second worker
 * claimed the same subscription, and the two executors sent the same rows and
 * wrote conflicting outcomes onto them. Each renewal is a compare-and-set on
 * the value this run last wrote, so a run that finds it changed has lost the
 * lease and stops before sending anything more; and release clears the lease
 * only while it is still this run's, so a run that lost it cannot free a lease
 * another worker now holds.
 */
function leaseFor(
  database: DbInstance,
  subscriptionId: string,
  claimedUntil: Date,
  now: () => Date,
): DeliveryLease {
  let held = claimedUntil
  return {
    async renew() {
      const next = new Date(now().getTime() + LEASE_MS)
      const [renewed] = await database
        .update(webhookSubscriptions)
        .set({ deliveryLeaseUntil: next })
        .where(
          and(
            eq(webhookSubscriptions.id, subscriptionId),
            eq(webhookSubscriptions.deliveryLeaseUntil, held),
          ),
        )
        .returning({ id: webhookSubscriptions.id })
      if (!renewed) return false
      held = next
      return true
    },
    async release() {
      await database
        .update(webhookSubscriptions)
        .set({ deliveryLeaseUntil: null })
        .where(
          and(
            eq(webhookSubscriptions.id, subscriptionId),
            eq(webhookSubscriptions.deliveryLeaseUntil, held),
          ),
        )
    },
  }
}

/** One tick: claim, deliver, release. Exported so a test can drive it directly. */
export async function runWebhookPumpOnce(
  options: StartWebhookPumpOptions = {},
): Promise<{ claimed: number; delivered: number }> {
  const database = options.database ?? defaultDb
  const concurrency = options.concurrency ?? WEBHOOK_DELIVERY_CONCURRENCY
  const now = options.delivery?.now ?? (() => new Date())

  const claimed = await claimDueSubscriptions(
    database,
    now(),
    concurrency,
    options.subscriptionIds,
  )
  if (claimed.length === 0) return { claimed: 0, delivered: 0 }

  let delivered = 0

  // Concurrent across subscriptions, strictly serial within one. The serial half
  // is a leg of the ordering promise, not an implementation convenience.
  await Promise.all(
    claimed.map(async (subscription) => {
      // The claim wrote the lease, so a claimed row always carries one.
      const lease = leaseFor(
        database,
        subscription.id,
        subscription.deliveryLeaseUntil ?? now(),
        now,
      )
      try {
        const outcomes = await deliverForSubscription(
          database,
          subscription,
          MAX_PER_SUBSCRIPTION_PER_TICK,
          { ...options.delivery, lease },
        )
        delivered += outcomes.filter((o) => o.status === 'delivered').length
      } catch (error) {
        // Reaching here means a bug or a database fault, not a delivery
        // failure — those are recorded on the row and never thrown. Logged with
        // ids only, like everything else in this area.
        webhookLogger.error(
          { err: error, subscriptionId: subscription.id },
          'Webhook delivery run failed',
        )
      } finally {
        await lease.release()
      }
    }),
  )

  return { claimed: claimed.length, delivered }
}

/**
 * Start the delivery pump, or refuse to.
 *
 * **It refuses rather than coming up silently unsigned.** If at least one
 * enabled signed subscription exists and `ENCRYPTION_KEY` is unset, every
 * delivery would either go out unsigned or fail on decryption — and combined
 * with the legacy-plaintext fallback in `decryptSecret`, the first of those is
 * the likelier one. A customer discovering that their verification has been
 * failing, or worse passing against nothing, is not an acceptable way to find a
 * missing environment variable. So: loud, once, at boot — and `running: false`
 * on the handle, which the worker's health endpoint reports.
 */
export async function startWebhookDeliveryPump(
  options: StartWebhookPumpOptions = {},
): Promise<WebhookPumpHandle> {
  const database = options.database ?? defaultDb
  const configured = Number(process.env.WEBHOOK_PUMP_INTERVAL_MS)
  // A value that is not a positive number falls back to the default. It is not
  // passed on: `setInterval` reads NaN as zero and ticks as fast as it can.
  const intervalMs =
    options.intervalMs ??
    (Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_INTERVAL_MS)

  if (!isEncryptionConfigured() && (await hasSignedSubscriptions(database))) {
    webhookLogger.error(
      'Refusing to start the webhook delivery pump: ENCRYPTION_KEY is not ' +
        'set, and at least one enabled subscription has a signing secret. ' +
        'Every delivery would go out unsigned or fail to decrypt. Set ' +
        'ENCRYPTION_KEY on this process, or disable the signed subscriptions.',
    )
    return { running: false, stop: () => Promise.resolve() }
  }

  const controller = new AbortController()
  let inFlight: Promise<void> | null = null

  const timer = setInterval(() => {
    if (inFlight) return
    inFlight = runWebhookPumpOnce({
      ...options,
      // The pump's own signal reaches `fetch` through the executor, combined
      // there with a per-request timeout. Without this, `stop()` would end the
      // ticking and leave every in-flight socket running to its own deadline.
      delivery: { ...options.delivery, signal: controller.signal },
    })
      .then(() => undefined)
      .catch((error: unknown) => {
        webhookLogger.error({ err: error }, 'Webhook pump tick failed')
      })
      .finally(() => {
        inFlight = null
      })
  }, intervalMs)
  timer.unref()

  webhookLogger.info({ intervalMs }, 'Webhook delivery pump started')

  return {
    running: true,
    stop: async () => {
      clearInterval(timer)
      controller.abort()
      if (inFlight) {
        await Promise.race([
          inFlight,
          new Promise<void>((resolve) =>
            setTimeout(resolve, STOP_DRAIN_MS).unref(),
          ),
        ])
      }
      webhookLogger.info('Webhook delivery pump stopped')
    },
  }
}
