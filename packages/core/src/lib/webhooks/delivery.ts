// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import {
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_EVENT_TYPE_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  signWebhookBody,
} from './signing'
import {
  WEBHOOK_FAILURE_THRESHOLD,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_MAX_PENDING_AGE_MS,
  WEBHOOK_REQUEST_TIMEOUT_MS,
  WEBHOOK_RESPONSE_SNIPPET_BYTES,
  WEBHOOK_RETRY_DELAYS_MS,
} from './config'
import type { DbInstance } from '@/lib/db'
import type {
  WebhookDeliveryRow,
  WebhookSubscriptionRow,
} from '@/lib/db/schema'
import { webhookDeliveries, webhookSubscriptions } from '@/lib/db/schema'
import { decryptSecret } from '@/lib/crypto/encryption'
import { SecretDecryptionError } from '@/lib/errors'
import { assertPublicHost } from '@/lib/net/egress-guard'
import { webhookLogger } from '@/lib/logging/logger'

/**
 * Sending one subscription's pending deliveries, in order.
 *
 * **The ordering promise.** Within one subscription, deliveries go out in seq
 * order, at least once. Four things buy it together and removing any one breaks
 * it: the dispatcher writes rows in seq order in one transaction; at most one
 * delivery run per subscription happens at a time (the pump's lease, renewed
 * and compared before every delivery); this
 * executor stops at the first failure that is not terminal; and the claim rule
 * below. There is deliberately **no cross-subscription ordering promise** and
 * none is wanted — one slow receiver must not hold up another.
 *
 * **The claim rule is the part that is easy to get wrong.** Selecting "the next
 * *due* pending row" preserves order within a run and breaks it across runs: the
 * row that just failed has had its next attempt pushed into the future while
 * every row behind it is due immediately, so the following sweep delivers them
 * out of order. So this selects the **oldest pending row unconditionally**, and
 * stops the subscription's run without sending anything if that row is not yet
 * due. Head-of-line blocking is the cost of the ordering promise, and it is
 * bounded by the attempt budget: a dead delivery is stepped past.
 *
 * **A failure is data, not an exception.** The API error builder returns an
 * error's message verbatim to the HTTP client, the error-log service inserts its
 * context and stack into a table with no redaction, and the logger has no
 * redaction paths — so an error carrying the target URL or the upstream body
 * would turn an SSRF probe into a read primitive that is both API-readable and
 * permanently logged. Nothing here throws on a delivery failure: the response
 * status, a bounded snippet and a fixed-shape error string naming ids only go on
 * the row.
 */

/** The HTTP boundary, injected so a test never patches the global. */
export type FetchLike = (
  url: string,
  init: {
    method: string
    headers: Record<string, string>
    body: string
    redirect: 'manual'
    signal: AbortSignal
  },
) => Promise<Response>

export interface DeliveryOutcome {
  /** What happened to the row: sent, still pending, or out of attempts. */
  status: 'delivered' | 'pending' | 'dead' | 'expired'
  responseStatus: number | null
  /** True when the executor must stop this subscription's run here. */
  stop: boolean
  /** Set when the receiver told us to stop sending entirely. */
  disable?: string
}

/**
 * How one response decides a delivery's fate.
 *
 * This table is part of the external contract — it is what a receiver's status
 * code *means* to us — so it lives here as a function of the response rather
 * than being implied by which error got thrown where.
 *
 * | Response                                | Outcome                                    |
 * | --------------------------------------- | ------------------------------------------ |
 * | 2xx                                     | delivered; the failure counter resets      |
 * | 410 Gone                                | failed, and the subscription is disabled   |
 * | other 4xx except 408 and 429            | failed permanently on the first attempt    |
 * | 3xx under manual redirect               | failed permanently, carrying the location  |
 * | 408, 429, any 5xx, network error, timeout | retried with backoff until the budget goes |
 *
 * A permanent rejection is not worth hours of retries, which is why an ordinary
 * 4xx dies immediately rather than consuming its budget. A 3xx is permanent for
 * a different reason: following it is what turns a validated public host into an
 * internal-network read primitive, so the redirect is refused and recorded.
 */
function classifyResponse(status: number): {
  terminal: boolean
  delivered: boolean
  disable?: string
} {
  if (status >= 200 && status < 300) return { terminal: true, delivered: true }
  if (status === 410) {
    return {
      terminal: true,
      delivered: false,
      disable: 'The receiver answered 410 Gone',
    }
  }
  if (status >= 300 && status < 400) return { terminal: true, delivered: false }
  if (status === 408 || status === 429) {
    return { terminal: false, delivered: false }
  }
  if (status >= 400 && status < 500) return { terminal: true, delivered: false }
  return { terminal: false, delivered: false }
}

/** Backoff for the attempt about to be made, repeating the last entry. */
function retryDelayMs(attemptCount: number): number {
  const index = Math.min(attemptCount - 1, WEBHOOK_RETRY_DELAYS_MS.length - 1)
  return WEBHOOK_RETRY_DELAYS_MS[Math.max(0, index)] ?? 30_000
}

/**
 * Honour a `Retry-After` only when it is sane.
 *
 * A receiver asking for a week is either confused or hostile, and either way a
 * pending row that far out is worse than our own backoff. A date is read
 * against the delivery's own clock, like every other time in this file.
 */
function retryAfterMs(header: string | null, at: Date): number | null {
  if (!header) return null
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000 <= WEBHOOK_MAX_PENDING_AGE_MS ? seconds * 1000 : null
  }
  const when = Date.parse(header)
  if (Number.isNaN(when)) return null
  const delta = when - at.getTime()
  if (delta < 0) return 0
  return delta <= WEBHOOK_MAX_PENDING_AGE_MS ? delta : null
}

/**
 * Keep at most `WEBHOOK_RESPONSE_SNIPPET_BYTES` of a response body, reading no
 * more of the body than that.
 *
 * **Read, then bounded, is not bounded.** This used to call `response.text()`
 * and slice the result, which buffers the whole body first — after transparent
 * decompression — so a receiver answering with a few kilobytes of gzip that
 * inflate to gigabytes could exhaust the jobs worker's memory inside the request
 * deadline, and take every other subscription, the job consumer and the event
 * pollers down with it. The target is a URL a user chose, so a hostile or
 * compromised receiver is squarely in the threat model. The body is now read a
 * chunk at a time and cancelled as soon as enough has arrived.
 */
async function readSnippet(response: Response): Promise<string | null> {
  const body = response.body
  if (!body) return ''
  const reader = body.getReader()
  const chunks: Array<Uint8Array> = []
  let received = 0
  try {
    while (received < WEBHOOK_RESPONSE_SNIPPET_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      received += value.byteLength
    }
  } catch {
    // A body that fails mid-read keeps what had arrived.
  } finally {
    await reader.cancel().catch(() => undefined)
  }

  const bytes = new Uint8Array(
    Math.min(received, WEBHOOK_RESPONSE_SNIPPET_BYTES),
  )
  let offset = 0
  for (const chunk of chunks) {
    const take = Math.min(chunk.byteLength, bytes.byteLength - offset)
    if (take <= 0) break
    bytes.set(chunk.subarray(0, take), offset)
    offset += take
  }
  return new TextDecoder().decode(bytes)
}

/** The run's hold on its subscription, as the pump grants it. */
export interface DeliveryLease {
  /** Extend the lease; false when another run has taken it. */
  renew: () => Promise<boolean>
  /** Clear the lease, if it is still this run's. */
  release: () => Promise<void>
}

export interface DeliverOptions {
  fetchImpl?: FetchLike
  /** Injectable resolver for the send-time egress check. */
  assertHost?: (hostname: string) => Promise<void>
  /** The pump's signal, combined with this delivery's timeout. */
  signal?: AbortSignal
  now?: () => Date
  /** The pump's lease on the subscription, renewed before each delivery. */
  lease?: DeliveryLease
}

/**
 * Subscriptions whose secret this process has already reported as
 * undecryptable, so that error is loud once per subscription rather than once
 * per tick. A subscription leaves the set the moment its secret decrypts.
 */
const reportedUndecryptable = new Set<string>()

/** Settle with `promise`, or reject with the signal's reason if it aborts first. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  const reason = (): Error =>
    signal.reason instanceof Error ? signal.reason : new Error('Aborted')
  if (signal.aborted) return Promise.reject(reason())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(reason())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/**
 * Claim and send the oldest pending delivery for one subscription.
 *
 * Returns null when there is nothing to do — no pending row, the oldest one is
 * not due yet (the head-of-line block that buys ordering), or another executor
 * stamped it first.
 */
export async function deliverNextForSubscription(
  database: DbInstance,
  subscription: WebhookSubscriptionRow,
  options: DeliverOptions = {},
): Promise<DeliveryOutcome | null> {
  const now = options.now ?? (() => new Date())
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init))
  const assertHost =
    options.assertHost ?? ((hostname: string) => assertPublicHost(hostname))

  // The oldest pending row UNCONDITIONALLY — not the oldest *due* row. See the
  // claim-rule note in this file's header: filtering on due-ness here is what
  // reorders deliveries across runs.
  const [row] = await database
    .select()
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.subscriptionId, subscription.id),
        eq(webhookDeliveries.status, 'pending'),
      ),
    )
    .orderBy(asc(webhookDeliveries.eventSeq), asc(webhookDeliveries.id))
    .limit(1)

  if (!row) return null

  const at = now()
  // Every settling write below is conditional on the row still being pending:
  // an outcome another executor already recorded stands.
  const stillPending = and(
    eq(webhookDeliveries.id, row.id),
    eq(webhookDeliveries.status, 'pending'),
  )

  // A long-disabled subscription must not flood its receiver with a week of
  // backlog the moment it is switched on. Expiry is the pump's decision and
  // carries its own reason; retention never touches a pending row.
  if (at.getTime() - row.createdAt.getTime() > WEBHOOK_MAX_PENDING_AGE_MS) {
    await database
      .update(webhookDeliveries)
      .set({
        status: 'expired',
        error: `Expired unsent: older than the maximum pending age (subscription ${subscription.id})`,
        updatedAt: at,
      })
      .where(stillPending)
    return { status: 'expired', responseStatus: null, stop: false }
  }

  if (row.nextAttemptAt && row.nextAttemptAt.getTime() > at.getTime()) {
    // Not due. Stopping here rather than skipping past it is the ordering
    // promise: the row behind this one must not overtake it.
    return null
  }

  // The signing secret, before anything is spent on this attempt. A secret
  // this process cannot decrypt — ENCRYPTION_KEY unset here, or not the value
  // it was encrypted under — is our configuration fault, not the receiver's: it
  // spends no attempt, charges no breaker, and stops the run, and it is
  // reported once by name. It used to be booked as "failed to connect" six
  // times over three hours before disabling a subscription whose receiver was
  // never contacted.
  let secret: string | null = null
  if (subscription.encryptedSecret) {
    try {
      secret = decryptSecret(subscription.encryptedSecret)
      reportedUndecryptable.delete(subscription.id)
    } catch (error) {
      if (!(error instanceof SecretDecryptionError)) throw error
      if (!reportedUndecryptable.has(subscription.id)) {
        reportedUndecryptable.add(subscription.id)
        webhookLogger.error(
          { subscriptionId: subscription.id },
          "Webhook deliveries paused: this process cannot decrypt the subscription's signing secret. " +
            'Set ENCRYPTION_KEY on the jobs worker to the value the app tier uses; delivery resumes, ' +
            'with no attempt spent, once it can.',
        )
      }
      return { status: 'pending', responseStatus: null, stop: true }
    }
  }

  const attempt = row.attemptCount + 1

  // Incremented and stamped BEFORE the request goes out. A worker that dies
  // mid-flight then costs one attempt from the budget rather than losing the
  // record entirely, and the worst case is one duplicate delivery — which
  // at-least-once already permits.
  //
  // And compared rather than assumed: the stamp matches only the attempt count
  // this executor read, so an executor that finds the row already stamped by
  // another stops without sending.
  const [stamped] = await database
    .update(webhookDeliveries)
    .set({
      attemptCount: attempt,
      nextAttemptAt: new Date(at.getTime() + retryDelayMs(attempt)),
      updatedAt: at,
    })
    .where(
      and(stillPending, eq(webhookDeliveries.attemptCount, row.attemptCount)),
    )
    .returning({ id: webhookDeliveries.id })
  if (!stamped) return null

  const timeout = AbortSignal.timeout(WEBHOOK_REQUEST_TIMEOUT_MS)
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout

  let responseStatus: number | null = null
  let snippet: string | null = null
  let classified: { terminal: boolean; delivered: boolean; disable?: string }
  let failureText: string | null = null
  let overrideNextAttempt: number | null = null

  try {
    const target = new URL(subscription.targetUrl)

    // Re-resolved on every delivery, not trusted from write time: a stored
    // target is re-fetched forever and DNS can change under it. And under this
    // delivery's deadline: a resolver that stalls must not hold the run, and
    // the lease with it, past the request's own budget.
    await abortable(assertHost(target.hostname), signal)

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': 'Cascadia-Webhooks/1',
      [WEBHOOK_EVENT_ID_HEADER]: row.eventId,
      [WEBHOOK_EVENT_TYPE_HEADER]: row.eventType,
    }

    if (secret !== null) {
      headers[WEBHOOK_SIGNATURE_HEADER] = signWebhookBody(
        row.body,
        secret,
        Math.floor(at.getTime() / 1000),
      )
    }

    const response = await fetchImpl(subscription.targetUrl, {
      method: 'POST',
      headers,
      body: row.body,
      // Not a detail. Following a redirect is what turns a validated public host
      // into an internal-network read primitive, so a 3xx is a recorded
      // non-retryable failure carrying its location.
      redirect: 'manual',
      signal,
    })

    responseStatus = response.status
    snippet = await readSnippet(response)
    classified = classifyResponse(response.status)

    if (!classified.delivered) {
      const location =
        response.status >= 300 && response.status < 400
          ? ` (refused redirect to ${response.headers.get('location') ? 'another host' : 'an unnamed location'})`
          : ''
      failureText = `HTTP ${response.status} on attempt ${attempt}${location} (subscription ${subscription.id})`
    }

    if (!classified.terminal) {
      overrideNextAttempt = retryAfterMs(
        response.headers.get('retry-after'),
        at,
      )
    }
  } catch (error) {
    // The pump is stopping. The request may or may not have reached the
    // receiver — at-least-once already allows a duplicate — but being cut off
    // is not a failure of the receiver's, so the attempt is given back and
    // nothing is recorded against the row or the breaker.
    if (
      options.signal?.aborted &&
      error instanceof Error &&
      error.name === 'AbortError'
    ) {
      await database
        .update(webhookDeliveries)
        .set({
          attemptCount: row.attemptCount,
          nextAttemptAt: row.nextAttemptAt,
          updatedAt: at,
        })
        .where(and(stillPending, eq(webhookDeliveries.attemptCount, attempt)))
      return { status: 'pending', responseStatus: null, stop: true }
    }

    // A network error, a DNS refusal or a timeout. Nothing from `error` reaches
    // the row or the log beyond its class — not the URL, not a response body.
    const blocked =
      error instanceof Error && error.name === 'EgressBlockedError'
    const unresolved =
      error instanceof Error && error.name === 'EgressResolutionError'
    const kind =
      error instanceof Error && error.name === 'TimeoutError'
        ? 'timed out'
        : blocked
          ? 'refused by the egress guard'
          : unresolved
            ? 'failed to resolve its host'
            : 'failed to connect'
    failureText = `Delivery ${kind} on attempt ${attempt} (subscription ${subscription.id})`
    // A target that resolves to an address the guard refuses will resolve there
    // on the next attempt too: terminal, rather than six more lookups over three
    // hours before anyone hears of it. The breaker counts it like any other dead
    // delivery. A host that did not resolve at all is no verdict on its address
    // and is retried like a connection failure.
    classified = { terminal: blocked, delivered: false }
  }

  if (classified.delivered) {
    const [settled] = await database
      .update(webhookDeliveries)
      .set({
        status: 'delivered',
        responseStatus,
        responseSnippet: snippet,
        error: null,
        nextAttemptAt: null,
        deliveredAt: at,
        updatedAt: at,
      })
      .where(stillPending)
      .returning({ id: webhookDeliveries.id })

    // One success resets the breaker: the counter is about *consecutive* dead
    // deliveries, so a receiver that comes back gets its budget back.
    if (settled) {
      await database
        .update(webhookSubscriptions)
        .set({ consecutiveFailures: 0, lastSuccessAt: at, updatedAt: at })
        .where(eq(webhookSubscriptions.id, subscription.id))
    }

    return { status: 'delivered', responseStatus, stop: false }
  }

  const budgetSpent = classified.terminal || attempt >= WEBHOOK_MAX_ATTEMPTS

  if (!budgetSpent) {
    const [kept] = await database
      .update(webhookDeliveries)
      .set({
        responseStatus,
        responseSnippet: snippet,
        error: failureText,
        nextAttemptAt: new Date(
          at.getTime() + (overrideNextAttempt ?? retryDelayMs(attempt)),
        ),
        updatedAt: at,
      })
      .where(stillPending)
      .returning({ id: webhookDeliveries.id })

    if (kept) {
      await database
        .update(webhookSubscriptions)
        .set({ lastFailureAt: at, updatedAt: at })
        .where(eq(webhookSubscriptions.id, subscription.id))

      webhookLogger.warn(
        {
          subscriptionId: subscription.id,
          deliveryId: row.id,
          attempt,
          responseStatus,
        },
        'Webhook delivery failed; will retry',
      )
    }

    // Stop this subscription's run: the row behind this one must not overtake
    // it. The next sweep retries this one first.
    return { status: 'pending', responseStatus, stop: true }
  }

  // Out of attempts, or rejected permanently. The row becomes its own permanent
  // record — attempts, status and error — which is what makes stepping past it
  // different from skipping a log event, where nothing is left behind.
  const [died] = await database
    .update(webhookDeliveries)
    .set({
      status: 'dead',
      responseStatus,
      responseSnippet: snippet,
      error: failureText,
      nextAttemptAt: null,
      updatedAt: at,
    })
    .where(stillPending)
    .returning({ id: webhookDeliveries.id })

  if (!died) {
    // Another executor settled this row first. Its outcome stands, and the
    // breaker is not charged for a delivery that did not die here.
    return { status: 'dead', responseStatus, stop: false }
  }

  // The breaker counts dead deliveries, not failed attempts: counting attempts
  // trips it on one flaky minute.
  const [updated] = await database
    .update(webhookSubscriptions)
    .set({
      consecutiveFailures: sql`${webhookSubscriptions.consecutiveFailures} + 1`,
      lastFailureAt: at,
      updatedAt: at,
    })
    .where(eq(webhookSubscriptions.id, subscription.id))
    .returning({
      consecutiveFailures: webhookSubscriptions.consecutiveFailures,
    })

  const reason =
    classified.disable ??
    (updated && updated.consecutiveFailures >= WEBHOOK_FAILURE_THRESHOLD
      ? `${updated.consecutiveFailures} consecutive deliveries exhausted their attempts`
      : undefined)

  if (reason) {
    await database
      .update(webhookSubscriptions)
      .set({ disabledAt: at, disabledReason: reason, updatedAt: at })
      .where(eq(webhookSubscriptions.id, subscription.id))

    webhookLogger.warn(
      { subscriptionId: subscription.id, reason },
      'Webhook subscription disabled',
    )
  }

  webhookLogger.warn(
    {
      subscriptionId: subscription.id,
      deliveryId: row.id,
      attempt,
      responseStatus,
    },
    'Webhook delivery is dead',
  )

  return {
    status: 'dead',
    responseStatus,
    // A dead delivery is stepped past, not stopped on: ordering of what is
    // delivered is preserved and the hole is visible on the row.
    stop: false,
    disable: reason,
  }
}

/** The subscription as it stands now, or null once it is no longer live. */
async function reloadLive(
  database: DbInstance,
  subscriptionId: string,
): Promise<WebhookSubscriptionRow | null> {
  const [row] = await database
    .select()
    .from(webhookSubscriptions)
    .where(
      and(
        eq(webhookSubscriptions.id, subscriptionId),
        isNull(webhookSubscriptions.deletedAt),
        eq(webhookSubscriptions.enabled, true),
        isNull(webhookSubscriptions.disabledAt),
      ),
    )
    .limit(1)
  return row ?? null
}

/**
 * Drain one subscription, in order, until it blocks or runs out.
 *
 * `maxPerRun` bounds one subscription's share of a tick so a long backlog cannot
 * starve the others.
 *
 * The subscription is re-read before each delivery after the first, not trusted
 * from the claim: a secret rotated, or a subscription disabled or deleted,
 * mid-run takes effect on the next delivery rather than after up to twenty more
 * sent on the old terms. And the lease is renewed before each one — a run that
 * has lost it stops.
 */
export async function deliverForSubscription(
  database: DbInstance,
  subscription: WebhookSubscriptionRow,
  maxPerRun: number,
  options: DeliverOptions = {},
): Promise<Array<DeliveryOutcome>> {
  const outcomes: Array<DeliveryOutcome> = []
  let current = subscription

  for (let sent = 0; sent < maxPerRun; sent += 1) {
    if (options.signal?.aborted) break
    if (options.lease && !(await options.lease.renew())) break
    if (sent > 0) {
      const reloaded = await reloadLive(database, subscription.id)
      if (!reloaded) break
      current = reloaded
    }
    const outcome = await deliverNextForSubscription(database, current, options)
    if (!outcome) break
    outcomes.push(outcome)
    if (outcome.stop || outcome.disable) break
  }

  return outcomes
}

export type { WebhookDeliveryRow }
