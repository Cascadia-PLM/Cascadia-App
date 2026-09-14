// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { registerCoreExtensions } from './core/register'
import { startEventConsumerPolling } from './consumers'
import { eventLogger } from '@/lib/logging/logger'

/**
 * Whether the app server runs event consumers itself (`EVENT_CONSUMERS_IN_APP`,
 * default **on**).
 *
 * Default on, because the alternative is worse in the common case: a
 * single-server install that never started a jobs worker would register
 * extensions nobody drains, and the symptom — a release that quietly never
 * alerts a work instruction — is indistinguishable from the feature not
 * existing. Off is for the topology that runs a worker and wants exactly one
 * poller, which is the deployment most likely to have someone available to set
 * a variable.
 *
 * Running it in both is safe and deliberately so: `FOR UPDATE SKIP LOCKED` on
 * the cursor row makes concurrent pollers mutually exclusive per consumer, so
 * the second one finds the row locked and moves on.
 */
function enabledInApp(): boolean {
  const raw = process.env.EVENT_CONSUMERS_IN_APP
  if (raw === undefined || raw === '') return true
  return raw !== 'false' && raw !== '0'
}

/** Poll interval for the app server (`EVENT_POLL_INTERVAL_MS`, default 2 s). */
function intervalMs(): number {
  const configured = Number(process.env.EVENT_POLL_INTERVAL_MS)
  return Number.isFinite(configured) && configured > 0 ? configured : 2000
}

/**
 * Start core's extensions and the consumer poller inside an app server.
 *
 * Three costs are budgeted here rather than discovered in production.
 *
 * **1. How long one run may hold a pooled connection.** A consumer run is one
 * transaction over a batch, so the worst case is `batchSize × handlerTimeoutMs`
 * — with the shipped defaults, a hundred events at thirty seconds each, which
 * is fifty minutes on a connection the app also serves requests from. That is
 * fine on a worker and unacceptable in an API process, so this path drains
 * **one batch per tick** rather than up to ten, and core's own extensions
 * declare small batches. A deployment whose extensions do slow work wants the
 * worker topology, not a bigger number here.
 *
 * **2. Jitter.** The shipped Kubernetes deployment carries an autoscaler, so
 * replicas start together and, on a fixed interval, poll together forever
 * after — every one of them waking to contend for the same cursor rows at the
 * same instant. The interval is jittered per tick so they spread out instead.
 *
 * **3. Some platforms throttle CPU outside a request.** On a
 * scale-to-zero or request-scoped runtime an interval poller is not reliably
 * scheduled at all: the timer fires when the platform feels like running it,
 * which can be never between requests. That topology keeps the jobs worker and
 * sets `EVENT_CONSUMERS_IN_APP=false`; this is not something the app process
 * can detect or work around, so it is documented rather than guarded.
 *
 * Returns a stop function that resolves once any run in flight has finished,
 * or null when the flag is off.
 */
export function startAppEventConsumers(): (() => Promise<void>) | null {
  registerCoreExtensions()

  if (!enabledInApp()) {
    eventLogger.info(
      'Event consumers disabled in the app server (EVENT_CONSUMERS_IN_APP); ' +
        'the jobs worker is expected to drain them',
    )
    return null
  }

  return startEventConsumerPolling({
    intervalMs: intervalMs(),
    // One batch per tick: see cost 1 above.
    maxBatches: 1,
    // Spread replicas that started together: see cost 2.
    jitterRatio: 0.2,
  })
}
