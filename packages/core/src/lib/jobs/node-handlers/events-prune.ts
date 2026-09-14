// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import type { JobContext, JobHandler } from '../types'
import type {
  EventsPrunePayload,
  EventsPruneResult,
} from '../definitions/events-prune/types'
import { db } from '@/lib/db'
import {
  abandonLongParkedConsumers,
  computeRetentionHorizon,
  pruneDomainEvents,
} from '@/lib/events/retention'
import {
  DEFAULT_DELIVERY_RETENTION_DAYS,
  pruneWebhookDeliveries,
} from '@/lib/webhooks/retention'

/** Days of history kept (`EVENT_RETENTION_DAYS`, default 90). */
const DEFAULT_RETENTION_DAYS = 90

/** Read the same way as the retention window, and for the same reason. */
function configuredDays(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw ?? fallback)
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * Prune the webhook delivery log on the same run.
 *
 * A pending row is never deleted whatever its age: expiry is the pump's
 * decision and carries its own status and reason, so deleting one here would
 * drop a delivery a receiver is still owed with no record of it. The exception
 * is a deleted subscription's pending row, owed to nobody, which is expired.
 */
async function pruneDeliveries(
  payload: EventsPrunePayload,
  context: JobContext,
): Promise<EventsPruneResult['deliveries']> {
  const days =
    payload.deliveryRetentionDays ??
    configuredDays(
      process.env.WEBHOOK_DELIVERY_RETENTION_DAYS,
      DEFAULT_DELIVERY_RETENTION_DAYS,
    )

  if (days <= 0) {
    await context.log.info(
      'Webhook delivery retention is switched off (WEBHOOK_DELIVERY_RETENTION_DAYS <= 0)',
    )
    return {
      deleted: 0,
      batches: 0,
      hasMore: false,
      expired: 0,
      pendingSkipped: 0,
      skipped: true,
    }
  }

  const result = await pruneWebhookDeliveries(db, {
    cutoff: new Date(Date.now() - days * 24 * 60 * 60 * 1000),
    batchSize: payload.batchSize,
    maxBatches: payload.maxBatches,
    signal: context.signal,
  })

  await context.log.info('Webhook delivery log pruned', { ...result })
  return { ...result, skipped: false }
}

/**
 * Delete events older than the retention window that every consumer has passed.
 *
 * **Zod defaults never reach a handler**, which is why the destructuring default
 * below is the real one: `JobService.submit` parses the payload and discards the
 * result, and the worker hands the handler the raw stored payload. The
 * environment variable is read here for the same reason.
 *
 * A non-positive retention is the documented opt-out — retain forever — mirroring
 * the non-positive period convention the maintenance sweep already uses.
 */
export const eventsPruneHandler: JobHandler<
  EventsPrunePayload,
  EventsPruneResult
> = {
  type: 'maintenance.events.prune',

  async execute(
    payload: EventsPrunePayload,
    context: JobContext,
  ): Promise<EventsPruneResult> {
    const retentionDays =
      payload.retentionDays ??
      configuredDays(process.env.EVENT_RETENTION_DAYS, DEFAULT_RETENTION_DAYS)

    if (retentionDays <= 0) {
      await context.log.info(
        'Event retention is switched off (EVENT_RETENTION_DAYS <= 0); keeping everything',
      )
      // The delivery log still gets pruned: the two windows are independent,
      // and switching off event retention is not a statement about webhooks.
      return {
        deleted: 0,
        batches: 0,
        hasMore: false,
        horizonSeq: null,
        pinnedBy: [],
        abandoned: [],
        unsequenced: 0,
        skipped: true,
        deliveries: await pruneDeliveries(payload, context),
      }
    }

    await context.updateProgress(10, 'Computing the retention horizon…')
    // A consumer is given up on once it has been parked for as long as the log
    // keeps events: from then on the events from when it parked are old enough
    // to prune, so waiting longer only grows the log.
    const abandonAfterDays = retentionDays
    await abandonLongParkedConsumers(db, { abandonAfterDays })
    const horizon = await computeRetentionHorizon(db, { abandonAfterDays })
    await context.log.info('Retention horizon computed', {
      horizonSeq: horizon.horizonSeq,
      pinnedBy: horizon.pinnedBy,
      abandoned: horizon.abandoned,
      unsequenced: horizon.unsequenced,
    })

    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
    const result = await pruneDomainEvents(db, {
      cutoff,
      // Read again inside every batch's transaction: a prune can run for
      // minutes, and a cursor created meanwhile must hold the floor for every
      // batch that follows it.
      horizonSeq: async (tx) =>
        (
          await computeRetentionHorizon(tx, {
            abandonAfterDays,
            countUnsequenced: false,
          })
        ).horizonSeq,
      batchSize: payload.batchSize,
      maxBatches: payload.maxBatches,
      signal: context.signal,
      onBatch: async (batches, deleted) => {
        await context.updateProgress(
          Math.min(90, 10 + batches * 5),
          `Pruned ${deleted} events in ${batches} batches…`,
        )
      },
    })

    await context.log.info('Event log pruned', {
      deleted: result.deleted,
      batches: result.batches,
      hasMore: result.hasMore,
      unsequenced: result.unsequenced,
    })
    return {
      ...result,
      horizonSeq: horizon.horizonSeq,
      pinnedBy: horizon.pinnedBy,
      abandoned: horizon.abandoned,
      skipped: false,
      deliveries: await pruneDeliveries(payload, context),
    }
  },
}
