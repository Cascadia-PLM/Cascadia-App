// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, eq, isNull, lt, or, sql } from 'drizzle-orm'
import {
  WEBHOOK_DISPATCHER_CONSUMER_ID,
  WEBHOOK_PAYLOAD_VERSION,
} from '@cascadia/commons/lib/webhooks/config'
import type { EveryEventConsumedExtension } from '@/lib/extensions/types'
import type { DomainEvent } from '@/lib/events/types'
import type { TransactionClient } from '@/lib/db'
import { EVERY_EVENT } from '@/lib/extensions/types'
import { defineExtension } from '@/lib/extensions/registry'
import { designs } from '@/lib/db/schema/designs'
import {
  webhookDeliveries,
  webhookSubscriptions,
} from '@/lib/db/schema/webhooks'

export interface WebhookDispatcherOptions {
  /**
   * Injectable clock for the body's `queuedAt` stamp. Tests pin it so two
   * deliveries of one event are byte-comparable.
   */
  now?: () => Date
}

/**
 * Resolve the program an event belongs to.
 *
 * From `context.programId` when the emitter named one — a program's own facts,
 * a design's creation, a change order whose designs all sit in one program —
 * and otherwise through `context.designId`, since a design knows its program.
 * At most one lookup per event, and only for one that names a design but not a
 * program.
 *
 * Returning null means "no program could be determined", and the caller fails
 * closed on it: a change order spanning programs, or a fact about something
 * outside any design, reaches unscoped subscriptions only.
 */
async function resolveEventProgram(
  tx: TransactionClient,
  context: DomainEvent['context'],
): Promise<string | null> {
  if (context.programId) return context.programId
  if (!context.designId) return null

  const [design] = await tx
    .select({ programId: designs.programId })
    .from(designs)
    .where(eq(designs.id, context.designId))
    .limit(1)
  return design?.programId ?? null
}

/**
 * The exact bytes a receiver gets, and the exact bytes that get signed.
 *
 * Serialised once per event rather than once per subscription, so every
 * subscription receiving one event receives identical bytes — which makes a
 * delivery log comparison across subscriptions meaningful.
 */
function buildDeliveryBody(event: DomainEvent, sentAt: Date): string {
  return JSON.stringify({
    version: WEBHOOK_PAYLOAD_VERSION,
    id: event.id,
    seq: event.seq,
    type: event.type,
    schemaVersion: event.schemaVersion,
    occurredAt: event.occurredAt.toISOString(),
    queuedAt: sentAt.toISOString(),
    actorId: event.actorId,
    subject: event.subject,
    context: event.context,
    payload: event.payload,
    correlationId: event.correlationId,
    causationId: event.causationId,
  })
}

/**
 * Fan every committed event out to the webhook subscriptions that want it.
 *
 * This is the worked example of the architecture's code-and-data line: one
 * core-shipped `consumed` extension whose handler never changes, selecting on
 * rows an operator wrote at runtime. Adding a subscriber is an insert.
 *
 * **The handler executes exactly two kinds of statement** — selects against
 * subscriptions and designs, and one multi-row insert into `webhook_deliveries`
 * with `ON CONFLICT DO NOTHING` — all on the run's transaction. Two things it
 * deliberately does not do:
 *
 * **No HTTP.** The runner holds this consumer's cursor row `FOR UPDATE` for the
 * whole run, so one slow or hostile endpoint would hold it for up to the handler
 * deadline per event across a full batch, and a single subscriber's failure
 * would be recorded as a *consumer* failure — backing the dispatcher off and
 * eventually parking it. That is precisely "one bad subscription stalls every
 * other subscription", which is the failure mode the delivery table exists to
 * prevent.
 *
 * **No job submission either.** `JobService.submit` writes through the
 * module-level connection and takes no transaction, so the job row and its
 * broker message would commit independently of the cursor: if a later handler in
 * the batch throws, or the worker dies before the cursor commits, the job is
 * already live and the event is redelivered. That is the dual write the log
 * exists to remove.
 *
 * What the fan-out insert being *inside* the consumer transaction buys is
 * ordering and at-least-once for free — rows land in seq order and cannot exist
 * without the cursor advance that produced them. The unique key on
 * `(subscription, event)` is what stops at-least-once before it reaches a
 * customer's server.
 */
export function createWebhookDispatcher(
  options: WebhookDispatcherOptions = {},
): EveryEventConsumedExtension {
  const now = options.now ?? (() => new Date())

  return {
    id: WEBHOOK_DISPATCHER_CONSUMER_ID,
    description:
      'Fans committed domain events out to matching webhook subscriptions',
    phase: 'consumed',
    on: EVERY_EVENT,
    // Registered after the log shipped. Without this the first run of a new
    // install's dispatcher would fan the entire retained log at every
    // subscription that existed — and `createdFromSeq` alone would not save
    // it, because a subscription created before the dispatcher first ran has
    // a seq below most of the log.
    startAt: 'head',
    handler: async ({ event, tx }) => {
      const programId = await resolveEventProgram(tx, event.context)

      // Fail closed on scope. An event with no resolvable program is
      // instance-wide and reaches only unscoped subscriptions; it must never
      // fall through to "every program-scoped subscriber", which is what a
      // null-means-all filter would do.
      const scopeMatches = programId
        ? or(
            isNull(webhookSubscriptions.programId),
            eq(webhookSubscriptions.programId, programId),
          )
        : isNull(webhookSubscriptions.programId)

      const matching = await tx
        .select({ id: webhookSubscriptions.id })
        .from(webhookSubscriptions)
        .where(
          and(
            isNull(webhookSubscriptions.deletedAt),
            eq(webhookSubscriptions.enabled, true),
            // A subscription never receives an event that predates it, which
            // is what makes creating one safe on an instance with history.
            lt(webhookSubscriptions.createdFromSeq, event.seq),
            // An empty filter means every type. Matched in the database rather
            // than in JavaScript so one event costs one statement regardless of
            // how many subscriptions exist.
            sql`(cardinality(${webhookSubscriptions.eventTypes}) = 0 OR ${event.type} = ANY(${webhookSubscriptions.eventTypes}))`,
            scopeMatches,
          ),
        )

      if (matching.length === 0) return

      const body = buildDeliveryBody(event, now())

      await tx
        .insert(webhookDeliveries)
        .values(
          matching.map((subscription) => ({
            subscriptionId: subscription.id,
            eventId: event.id,
            eventSeq: event.seq,
            eventType: event.type,
            body,
            status: 'pending' as const,
          })),
        )
        // At-least-once consumption means this handler can re-run over an
        // event it already fanned out. Without this, the second run would
        // either throw on the unique key — parking the dispatcher over a
        // duplicate that is expected — or, worse, send a customer a second
        // copy.
        .onConflictDoNothing({
          target: [webhookDeliveries.subscriptionId, webhookDeliveries.eventId],
        })
    },
  }
}

/**
 * Register the dispatcher.
 *
 * Called by the jobs worker rather than at import time, matching the relay: the
 * worker is the process that sends deliveries, and registering in a process
 * that will never run the pump would take the cursor row and advance it past
 * events whose deliveries nothing is draining.
 */
export function registerWebhookDispatcher(
  options: WebhookDispatcherOptions = {},
): void {
  defineExtension(createWebhookDispatcher(options))
}
