// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The numbers behind the webhook contract, in one place.
 *
 * Several `webhook_deliveries` and `webhook_subscriptions` columns are only
 * meaningful with respect to a policy — "the attempt budget is spent", "older
 * than the maximum age", "the breaker threshold" — so the policy lives here
 * rather than being spelled out at each of the places that enforces it.
 *
 * These are deliberately constants and not environment variables. Every one of
 * them bounds outbound traffic to somebody else's server, and there is no
 * egress rate limiter anywhere in this repository — the existing limiter is
 * inbound-only. One release on the demonstration dataset emits roughly ninety
 * events in a handful of transactions, fanned across every matching
 * subscription, so these caps are the only brakes that exist. Making them
 * operator-tunable would make raising them the first thing anybody tries.
 */

/**
 * The dispatcher's consumer id. Renaming it starts the cursor over from zero,
 * which for a `'head'` consumer means treating the whole log as delivered.
 */
export const WEBHOOK_DISPATCHER_CONSUMER_ID = 'webhooks.dispatch'

/**
 * Envelope version in the delivery body. Bumped when the *envelope* shape
 * changes — not when an event payload does, which carries its own
 * `schemaVersion`.
 */
export const WEBHOOK_PAYLOAD_VERSION = 1

/**
 * Attempts one delivery gets before it is marked dead.
 *
 * A dead delivery is not the same as a skipped event: a skipped log event is
 * lost with no record, while a dead delivery *is* its own permanent record,
 * carrying its attempts, the last response status and the error. The hole is
 * visible, which is what makes stepping past it acceptable.
 */
export const WEBHOOK_MAX_ATTEMPTS = 6

/**
 * Backoff before each retry, in milliseconds — roughly six hours of patience
 * in total. The last entry repeats if the budget ever exceeds this list.
 */
export const WEBHOOK_RETRY_DELAYS_MS = [
  30_000, 120_000, 600_000, 1_800_000, 7_200_000,
] as const

/**
 * Consecutive dead deliveries that disable a subscription.
 *
 * Counted per dead delivery rather than per failed attempt, so one flaky minute
 * does not trip it — a receiver has to fail an entire attempt budget, this many
 * times in a row, which is hours of sustained failure.
 */
export const WEBHOOK_FAILURE_THRESHOLD = 5

/**
 * How long a pending delivery may wait before the pump expires it rather than
 * sending it.
 *
 * Without this, re-enabling a subscription that was off for a week floods the
 * receiver with a week of backlog in one sweep — which looks exactly like an
 * attack from their side.
 */
export const WEBHOOK_MAX_PENDING_AGE_MS = 3 * 24 * 60 * 60 * 1000

/** Response bytes kept on the delivery row for diagnosis. */
export const WEBHOOK_RESPONSE_SNIPPET_BYTES = 2048

/** Wall-clock budget for one delivery request. */
export const WEBHOOK_REQUEST_TIMEOUT_MS = 10_000

/**
 * Subscriptions delivered concurrently by one pump tick. Within a subscription
 * delivery is strictly serial — that is what buys the ordering promise.
 */
export const WEBHOOK_DELIVERY_CONCURRENCY = 4
