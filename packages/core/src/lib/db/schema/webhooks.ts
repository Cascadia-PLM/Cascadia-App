// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users } from './users'

/**
 * An outbound HTTP subscription to the domain event log.
 *
 * This table is the *data* half of the code-and-data line: the webhook
 * dispatcher is one core-shipped `consumed` extension whose handler never
 * changes, and each row here is a selector an operator wrote at runtime. A new
 * subscriber is an insert, not a deploy.
 *
 * No foreign key to programs even though `programId` names one, and that is
 * deliberate for the same reason the delivery table has no key to
 * `domain_events`: a cascade from a program delete would reach into the
 * dispatcher, which is the one component that must never take a
 * per-subscription fault. An orphaned scope simply matches nothing.
 */
export const webhookSubscriptions = pgTable(
  'webhook_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    /**
     * Where deliveries go. Validated by the egress guard at write time, and
     * re-validated numerically at send time — a stored target is re-fetched
     * forever, so a write-time check alone would age into an internal-network
     * read primitive.
     */
    targetUrl: text('target_url').notNull(),
    /**
     * Event types this subscription wants. Empty means every type.
     *
     * A Postgres text array rather than JSONB so the dispatcher's fan-out
     * select can match with `= ANY(...)` in the database instead of filtering
     * every subscription in JavaScript on every event.
     */
    eventTypes: text('event_types')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /**
     * Optional program scope, resolved from the event's program id when the
     * emitter named one and through its design otherwise — see
     * `resolveEventProgram` in the dispatcher. Null means instance-wide.
     */
    programId: uuid('program_id'),
    /**
     * The HMAC signing secret, encrypted at rest. Null means an explicitly
     * unsigned subscription.
     *
     * An HMAC key must be recoverable, so the API-key pattern of storing a
     * one-way hash is unusable here — it produces a table you cannot sign
     * from. Encryption is the departure, and it is why a signed subscription
     * refuses to exist without `ENCRYPTION_KEY`.
     */
    encryptedSecret: text('encrypted_secret'),
    /** First few characters of the plaintext secret, for identification only. */
    secretPrefix: varchar('secret_prefix', { length: 12 }),
    /**
     * The operator's switch.
     *
     * Kept distinct from `disabledAt` on purpose. If automatic disabling wrote
     * this flag, an operator who left a subscription on would come back to
     * find it off with nothing saying who turned it off — "I left it enabled
     * and the system stopped it" and "someone disabled it" are different
     * facts, and only one of them needs explaining.
     */
    enabled: boolean('enabled').notNull().default(true),
    /** Set when the breaker or a 410 Gone disabled this subscription. */
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    disabledReason: text('disabled_reason'),
    /**
     * Consecutive *dead deliveries* — deliveries that exhausted their attempt
     * budget — not failed attempts. Counting attempts would trip the breaker
     * on one flaky minute.
     */
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
    /**
     * Lease held by the delivery pump tick currently sending for this
     * subscription. A time lease rather than a row lock: `FOR UPDATE SKIP
     * LOCKED` would hold a database lock across every socket in the batch,
     * and a crashed worker just lets this expire.
     */
    deliveryLeaseUntil: timestamp('delivery_lease_until', {
      withTimezone: true,
    }),
    /**
     * Soft delete. A hard delete racing the dispatcher's fan-out insert fails
     * the foreign key check and throws inside the one component that must
     * never take a per-subscription fault, so deletion marks instead.
     */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    /**
     * Where the log stood when this subscription was created. A subscription
     * never receives an event that predates it, which is what makes creating
     * one a safe operation on an instance with a long history.
     */
    createdFromSeq: bigint('created_from_seq', { mode: 'number' })
      .notNull()
      .default(0),
    createdBy: uuid('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
  },
  (table) => [
    // The dispatcher's fan-out select: live subscriptions only.
    index('idx_webhook_subscriptions_live').on(table.deletedAt, table.enabled),
  ],
)

/**
 * One intended HTTP delivery of one event to one subscription.
 *
 * Written by the dispatcher inside the consumer's transaction and sent later
 * by the delivery pump, which is what keeps HTTP out of a handler that holds
 * a cursor row.
 *
 * Two constraints carry the design:
 *
 * - **Unique on (subscription, event).** The log delivers at-least-once, so a
 *   redelivered consumer batch re-runs the fan-out; the unique key turns
 *   at-least-once *fan-out* into at-most-once, so a customer never sees a
 *   second HTTP request for an event they already got.
 * - **No foreign key to `domain_events`.** Retention prunes the log on its own
 *   schedule and a delivery must outlive the event it carries — which is also
 *   why the body is frozen here rather than re-read.
 *
 * `body` is text, not JSONB. The signature is over the exact bytes sent, and
 * re-serialising JSON is not byte-stable: a JSONB round trip reorders keys and
 * normalises numbers, so a receiver verifying the signature over what it
 * received would disagree with what we signed. Freezing the bytes also
 * decouples the delivery log from any later payload-shape change and makes the
 * log show exactly what the receiver got.
 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => webhookSubscriptions.id, { onDelete: 'cascade' }),
    /** The event this delivery carries. Deliberately not a foreign key. */
    eventId: uuid('event_id').notNull(),
    /** Ordering key within a subscription — seq order is commit order. */
    eventSeq: bigint('event_seq', { mode: 'number' }).notNull(),
    eventType: varchar('event_type', { length: 100 }).notNull(),
    /** The exact bytes to send, and the exact bytes signed. */
    body: text('body').notNull(),
    /**
     * `pending` → `delivered`, or `dead` once the attempt budget is spent, or
     * `expired` when the pump found it older than the maximum age and refused
     * to flood a receiver with a stale backlog.
     */
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    attemptCount: integer('attempt_count').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    responseStatus: integer('response_status'),
    /**
     * A bounded snippet of the response, for diagnosis. Never interpolated
     * into an error message or a log line: the API error builder returns
     * messages verbatim and the error-log table stores context unredacted, so
     * upstream text spliced into either turns an SSRF probe into a read
     * primitive.
     */
    responseSnippet: text('response_snippet'),
    /** Fixed-shape failure text naming ids only — never the URL, never the body. */
    error: text('error'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('webhook_deliveries_subscription_event_unique').on(
      table.subscriptionId,
      table.eventId,
    ),
    // The pump's claim: the oldest pending row for a subscription.
    index('idx_webhook_deliveries_pending').on(
      table.subscriptionId,
      table.status,
      table.eventSeq,
    ),
    // The delivery log's pages: one subscription's rows, newest first. The
    // pending index cannot serve them, because `status` sits between its
    // subscription and seq columns.
    index('idx_webhook_deliveries_log').on(
      table.subscriptionId,
      table.eventSeq,
      table.id,
    ),
    // Retention's delete scan, settled rows by age. Without it every run read
    // the whole table.
    index('idx_webhook_deliveries_settled_updated')
      .on(table.updatedAt)
      .where(sql`${table.status} <> 'pending'`),
    // Retention's report of pending rows by age.
    index('idx_webhook_deliveries_pending_created')
      .on(table.createdAt)
      .where(sql`${table.status} = 'pending'`),
  ],
)

export type WebhookSubscriptionRow = typeof webhookSubscriptions.$inferSelect
export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect
