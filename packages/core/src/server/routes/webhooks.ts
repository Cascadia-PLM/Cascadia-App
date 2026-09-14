// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { z } from 'zod'
import { and, desc, eq, isNull, lt, max } from 'drizzle-orm'
import { tagged } from '../adapter'
import { apiHandler, parseQuery } from '@/lib/api/handler'
import { db } from '@/lib/db'
import {
  domainEvents,
  webhookDeliveries,
  webhookSubscriptions,
} from '@/lib/db/schema'
import { NotFoundError, ValidationError } from '@/lib/errors'
import { EventTypeRegistry } from '@/lib/events'
import {
  assertTargetResolvesPublic,
  validateEgressUrl,
} from '@/lib/net/egress-guard'
import { DELETED_SUBSCRIPTION_EXPIRY_ERROR } from '@/lib/webhooks/retention'
import { generateWebhookSecret } from '@/lib/webhooks/secret'
import { takeFirst } from '@/lib/db/take-first'

const adapt = tagged('Webhooks')

const app = new Hono()

/**
 * The columns a subscription is ever read back with.
 *
 * **Neither secret column is here, and nothing may read a subscription without
 * going through it.** There is no shared public-projection helper in this
 * codebase and no CI gate for one, so an ordinary `select()` in a list route
 * returns a live HMAC signing key to any Administrator session — or to an
 * unscoped Administrator API key — and the permission checker passes happily,
 * because the caller genuinely holds the permission. The only thing that catches
 * that is the projection assertion in this file's test suite.
 */
const PUBLIC_COLUMNS = {
  id: webhookSubscriptions.id,
  name: webhookSubscriptions.name,
  targetUrl: webhookSubscriptions.targetUrl,
  eventTypes: webhookSubscriptions.eventTypes,
  programId: webhookSubscriptions.programId,
  secretPrefix: webhookSubscriptions.secretPrefix,
  enabled: webhookSubscriptions.enabled,
  disabledAt: webhookSubscriptions.disabledAt,
  disabledReason: webhookSubscriptions.disabledReason,
  consecutiveFailures: webhookSubscriptions.consecutiveFailures,
  lastSuccessAt: webhookSubscriptions.lastSuccessAt,
  lastFailureAt: webhookSubscriptions.lastFailureAt,
  createdFromSeq: webhookSubscriptions.createdFromSeq,
  createdAt: webhookSubscriptions.createdAt,
  updatedAt: webhookSubscriptions.updatedAt,
  rotatedAt: webhookSubscriptions.rotatedAt,
} as const

const subscriptionSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  targetUrl: z.string(),
  /** Empty means every type. */
  eventTypes: z.array(z.string()),
  programId: z.string().uuid().nullable(),
  /**
   * Identification only — the first characters of the plaintext secret. Null on
   * an explicitly unsigned subscription. The secret itself is returned exactly
   * once, at creation and at rotation, and is never readable afterwards.
   */
  secretPrefix: z.string().nullable(),
  enabled: z.boolean(),
  /** Set when the breaker or a 410 Gone switched this off by itself. */
  disabledAt: z.string().nullable(),
  disabledReason: z.string().nullable(),
  consecutiveFailures: z.number(),
  lastSuccessAt: z.string().nullable(),
  lastFailureAt: z.string().nullable(),
  createdFromSeq: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  rotatedAt: z.string().nullable(),
})

const deliverySchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  eventSeq: z.number(),
  eventType: z.string(),
  status: z.string(),
  attemptCount: z.number(),
  nextAttemptAt: z.string().nullable(),
  responseStatus: z.number().nullable(),
  responseSnippet: z.string().nullable(),
  error: z.string().nullable(),
  deliveredAt: z.string().nullable(),
  createdAt: z.string(),
})

const subscriptionParams = z.object({ id: z.string().uuid() })

/**
 * Event types a subscription may name.
 *
 * Validated against the catalog rather than accepted as free text: a typo in an
 * event type produces a subscription that silently never fires, and there is no
 * later signal that would tell an operator why.
 */
function assertKnownEventTypes(types: Array<string>): void {
  if (types.length === 0) return
  const known = new Set(EventTypeRegistry.list().map((d) => d.type))
  const unknown = types.filter((type) => !known.has(type))
  if (unknown.length > 0) {
    throw new ValidationError(
      `Unknown event type(s): ${unknown.join(', ')}. ` +
        'GET /api/v1/events/types lists what this build emits.',
    )
  }
}

/** A type filter as stored: each type once, in the order first named. */
function uniqueEventTypes(types: Array<string>): Array<string> {
  return [...new Set(types)]
}

const createSubscriptionSchema = z.object({
  name: z.string().trim().min(1).max(255),
  targetUrl: z.string().min(1),
  /** Omit or pass an empty array to receive every type. */
  eventTypes: z.array(z.string()).optional(),
  programId: z.string().uuid().nullable().optional(),
  /**
   * Sign deliveries with an HMAC secret. Defaults to true, and creation is
   * refused when `ENCRYPTION_KEY` is unset rather than storing a key in the
   * clear — see `lib/webhooks/secret.ts`.
   */
  signed: z.boolean().optional(),
  /** Allow an `http:` target. Off by default. */
  allowInsecure: z.boolean().optional(),
})

const updateSubscriptionSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  targetUrl: z.string().min(1).optional(),
  eventTypes: z.array(z.string()).optional(),
  programId: z.string().uuid().nullable().optional(),
  allowInsecure: z.boolean().optional(),
})

/**
 * Coerced and checked rather than cast. `Number('abc')` is NaN, and a NaN seq
 * reached Postgres as an invalid bigint — a 500 for a typo in a query string,
 * where the caller is owed a 400 saying what was wrong.
 */
const deliveryQuerySchema = z.object({
  status: z.enum(['pending', 'delivered', 'dead', 'expired']).optional(),
  /** Return deliveries with seq strictly below this (backward pagination). */
  beforeSeq: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce
    .number()
    .int()
    .optional()
    .transform((v) => Math.min(200, Math.max(1, v ?? 50))),
})

/** The head of the log, so a new subscription starts there rather than at zero. */
async function currentHeadSeq(): Promise<number> {
  const [row] = await db
    .select({ seq: max(domainEvents.seq) })
    .from(domainEvents)
  return row?.seq ?? 0
}

// GET /api/v1/webhooks — every live subscription
app.get(
  '/',
  adapt(
    apiHandler(
      {
        permission: ['system', 'manage'],
        openapi: {
          summary: 'List webhook subscriptions',
          description:
            'Soft-deleted subscriptions are omitted. Neither the encrypted ' +
            'secret nor anything derived from it beyond a short display prefix ' +
            'is ever returned.',
          responses: {
            200: {
              schema: z.object({
                subscriptions: z.array(subscriptionSchema),
              }),
            },
          },
        },
      },
      async () => {
        const rows = await db
          .select(PUBLIC_COLUMNS)
          .from(webhookSubscriptions)
          .where(isNull(webhookSubscriptions.deletedAt))
          .orderBy(webhookSubscriptions.name, webhookSubscriptions.id)

        return { subscriptions: rows }
      },
    ),
  ),
)

// POST /api/v1/webhooks — create one, returning its secret exactly once
app.post(
  '/',
  adapt(
    apiHandler<Record<string, never>, z.infer<typeof createSubscriptionSchema>>(
      {
        permission: ['system', 'manage'],
        body: createSubscriptionSchema,
        openapi: {
          summary: 'Create a webhook subscription',
          description:
            'The signing secret is returned **once**, in this response, exactly ' +
            'as an API key is. It is stored encrypted and cannot be read back ' +
            'afterwards; a lost secret is rotated, not recovered.\n\n' +
            'The subscription starts at the current head of the event log, so ' +
            'creating one on an instance with a long history delivers nothing ' +
            'retrospectively.',
          request: { body: { schema: createSubscriptionSchema } },
          responses: {
            201: {
              schema: z.object({
                subscription: subscriptionSchema,
                secret: z.string().nullable(),
              }),
            },
          },
        },
      },
      async ({ body, user }) => {
        const eventTypes = uniqueEventTypes(body.eventTypes ?? [])
        assertKnownEventTypes(eventTypes)

        // The guard, not `z.string().url()`: that accepts `file:`,
        // `javascript:`, and a loopback address with a database port.
        const target = validateEgressUrl(body.targetUrl, {
          allowInsecure: body.allowInsecure ?? false,
        })
        // And where the name points now, so a private target is refused on
        // save rather than discovered from a dead delivery. Best-effort: a name
        // that does not resolve yet is accepted, and every send checks again.
        await assertTargetResolvesPublic(target)

        const secret = (body.signed ?? true) ? generateWebhookSecret() : null

        const row = takeFirst(
          await db
            .insert(webhookSubscriptions)
            .values({
              name: body.name,
              targetUrl: body.targetUrl,
              eventTypes,
              programId: body.programId ?? null,
              encryptedSecret: secret?.encrypted ?? null,
              secretPrefix: secret?.prefix ?? null,
              createdFromSeq: await currentHeadSeq(),
              createdBy: user.id,
            })
            .returning(PUBLIC_COLUMNS),
        )

        return new Response(
          JSON.stringify({
            data: { subscription: row, secret: secret?.plaintext ?? null },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        )
      },
    ),
  ),
)

// GET /api/v1/webhooks/:id — one subscription
app.get(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['system', 'manage'],
        openapi: {
          summary: 'Get a webhook subscription',
          request: { params: subscriptionParams },
          responses: {
            200: { schema: z.object({ subscription: subscriptionSchema }) },
          },
        },
      },
      async ({ params }) => {
        const [row] = await db
          .select(PUBLIC_COLUMNS)
          .from(webhookSubscriptions)
          .where(
            and(
              eq(webhookSubscriptions.id, params.id),
              isNull(webhookSubscriptions.deletedAt),
            ),
          )
        if (!row) throw new NotFoundError('Webhook subscription', params.id)
        return { subscription: row }
      },
    ),
  ),
)

// PATCH /api/v1/webhooks/:id — rename, retarget or re-filter
app.patch(
  '/:id',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof updateSubscriptionSchema>>(
      {
        permission: ['system', 'manage'],
        body: updateSubscriptionSchema,
        openapi: {
          summary: 'Update a webhook subscription',
          description:
            'The secret is not updatable here — rotate it instead, which is the ' +
            'only operation that returns a new one.',
          request: {
            params: subscriptionParams,
            body: { schema: updateSubscriptionSchema },
          },
          responses: {
            200: { schema: z.object({ subscription: subscriptionSchema }) },
          },
        },
      },
      async ({ params, body }) => {
        const eventTypes =
          body.eventTypes !== undefined
            ? uniqueEventTypes(body.eventTypes)
            : undefined
        if (eventTypes) assertKnownEventTypes(eventTypes)
        if (body.targetUrl !== undefined) {
          const target = validateEgressUrl(body.targetUrl, {
            allowInsecure: body.allowInsecure ?? false,
          })
          await assertTargetResolvesPublic(target)
        }

        const [row] = await db
          .update(webhookSubscriptions)
          .set({
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.targetUrl !== undefined
              ? { targetUrl: body.targetUrl }
              : {}),
            ...(eventTypes !== undefined ? { eventTypes } : {}),
            ...(body.programId !== undefined
              ? { programId: body.programId }
              : {}),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(webhookSubscriptions.id, params.id),
              isNull(webhookSubscriptions.deletedAt),
            ),
          )
          .returning(PUBLIC_COLUMNS)

        if (!row) throw new NotFoundError('Webhook subscription', params.id)
        return { subscription: row }
      },
    ),
  ),
)

// DELETE /api/v1/webhooks/:id — soft delete
app.delete(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['system', 'manage'],
        openapi: {
          summary: 'Delete a webhook subscription',
          description:
            'A **soft** delete, and deliberately so: a hard delete racing the ' +
            "dispatcher's fan-out insert fails the foreign key check and throws " +
            'inside the one component that must never take a per-subscription ' +
            'fault. The row stops matching immediately and its delivery history ' +
            'stays readable until retention prunes it.\n\n' +
            'Deliveries still pending are **expired** in the same transaction, ' +
            'since nothing will ever send them. A delivery already in flight ' +
            'when the delete lands may still arrive.',
          request: { params: subscriptionParams },
          responses: { 200: { schema: z.object({ deleted: z.boolean() }) } },
        },
      },
      async ({ params }) => {
        const deleted = await db.transaction(async (tx) => {
          const now = new Date()
          const [row] = await tx
            .update(webhookSubscriptions)
            .set({ deletedAt: now, updatedAt: now })
            .where(
              and(
                eq(webhookSubscriptions.id, params.id),
                isNull(webhookSubscriptions.deletedAt),
              ),
            )
            .returning({ id: webhookSubscriptions.id })
          if (!row) return false

          // Owed to nobody from here on: the pump never visits a deleted
          // subscription and retention prunes only settled rows, so a pending
          // row left behind stayed pending forever — and kept retention's
          // "is the pump running?" warning firing for a healthy pump.
          await tx
            .update(webhookDeliveries)
            .set({
              status: 'expired',
              error: DELETED_SUBSCRIPTION_EXPIRY_ERROR,
              nextAttemptAt: null,
              updatedAt: now,
            })
            .where(
              and(
                eq(webhookDeliveries.subscriptionId, row.id),
                eq(webhookDeliveries.status, 'pending'),
              ),
            )
          return true
        })
        if (!deleted) {
          throw new NotFoundError('Webhook subscription', params.id)
        }
        return { deleted: true }
      },
    ),
  ),
)

// POST /api/v1/webhooks/:id/enable — turn it back on, clearing an auto-disable
app.post(
  '/:id/enable',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['system', 'manage'],
        openapi: {
          summary: 'Enable a webhook subscription',
          description:
            'Clears both the operator flag and any automatic disable, and ' +
            'resets the failure counter so the breaker starts from zero.\n\n' +
            'Deliveries queued while it was off are sent if they are still ' +
            'within the maximum pending age and **expired** if not, so ' +
            're-enabling a long-dead subscription does not flood its receiver ' +
            'with a week of backlog.',
          request: { params: subscriptionParams },
          responses: {
            200: { schema: z.object({ subscription: subscriptionSchema }) },
          },
        },
      },
      async ({ params }) => {
        const [row] = await db
          .update(webhookSubscriptions)
          .set({
            enabled: true,
            disabledAt: null,
            disabledReason: null,
            consecutiveFailures: 0,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(webhookSubscriptions.id, params.id),
              isNull(webhookSubscriptions.deletedAt),
            ),
          )
          .returning(PUBLIC_COLUMNS)
        if (!row) throw new NotFoundError('Webhook subscription', params.id)
        return { subscription: row }
      },
    ),
  ),
)

// POST /api/v1/webhooks/:id/disable — operator pause
app.post(
  '/:id/disable',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['system', 'manage'],
        openapi: {
          summary: 'Disable a webhook subscription',
          description:
            'Stops delivery and stops matching new events. Pending deliveries ' +
            'stay pending rather than being discarded.',
          request: { params: subscriptionParams },
          responses: {
            200: { schema: z.object({ subscription: subscriptionSchema }) },
          },
        },
      },
      async ({ params }) => {
        const [row] = await db
          .update(webhookSubscriptions)
          .set({ enabled: false, updatedAt: new Date() })
          .where(
            and(
              eq(webhookSubscriptions.id, params.id),
              isNull(webhookSubscriptions.deletedAt),
            ),
          )
          .returning(PUBLIC_COLUMNS)
        if (!row) throw new NotFoundError('Webhook subscription', params.id)
        return { subscription: row }
      },
    ),
  ),
)

// POST /api/v1/webhooks/:id/rotate-secret — new secret, same subscription
app.post(
  '/:id/rotate-secret',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['system', 'manage'],
        openapi: {
          summary: "Rotate a subscription's signing secret",
          description:
            'Returns the new secret **once**, like creation. The old secret ' +
            'stops working immediately — there is no overlap window on this ' +
            'side. A receiver bridges a rotation by verifying against both of ' +
            'its own secrets until it has switched.',
          request: { params: subscriptionParams },
          responses: {
            200: {
              schema: z.object({
                subscription: subscriptionSchema,
                secret: z.string(),
              }),
            },
          },
        },
      },
      async ({ params }) => {
        const secret = generateWebhookSecret()
        const [row] = await db
          .update(webhookSubscriptions)
          .set({
            encryptedSecret: secret.encrypted,
            secretPrefix: secret.prefix,
            rotatedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(webhookSubscriptions.id, params.id),
              isNull(webhookSubscriptions.deletedAt),
            ),
          )
          .returning(PUBLIC_COLUMNS)
        if (!row) throw new NotFoundError('Webhook subscription', params.id)
        return { subscription: row, secret: secret.plaintext }
      },
    ),
  ),
)

// GET /api/v1/webhooks/:id/deliveries — one subscription's delivery log
app.get(
  '/:id/deliveries',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['system', 'manage'],
        openapi: {
          summary: "A subscription's delivery log",
          description:
            'Newest first, ordered by seq **and id** — never by a timestamp ' +
            'alone: rows created in one transaction tie exactly, and paginating ' +
            'on a tying column repeats and skips rows.\n\n' +
            'Gated on `system:manage` like the rest of this router rather than ' +
            'something looser, because it carries response snippets from the ' +
            'receiver and is arguably more sensitive than the subscription ' +
            'list itself.',
          request: { params: subscriptionParams },
          responses: {
            200: {
              schema: z.object({
                deliveries: z.array(deliverySchema),
                nextBeforeSeq: z.number().nullable(),
              }),
            },
          },
        },
      },
      async ({ params, request }) => {
        const query = parseQuery(request, deliveryQuerySchema)

        const [subscription] = await db
          .select({ id: webhookSubscriptions.id })
          .from(webhookSubscriptions)
          .where(eq(webhookSubscriptions.id, params.id))
        if (!subscription) {
          throw new NotFoundError('Webhook subscription', params.id)
        }

        const rows = await db
          .select({
            id: webhookDeliveries.id,
            eventId: webhookDeliveries.eventId,
            eventSeq: webhookDeliveries.eventSeq,
            eventType: webhookDeliveries.eventType,
            status: webhookDeliveries.status,
            attemptCount: webhookDeliveries.attemptCount,
            nextAttemptAt: webhookDeliveries.nextAttemptAt,
            responseStatus: webhookDeliveries.responseStatus,
            responseSnippet: webhookDeliveries.responseSnippet,
            error: webhookDeliveries.error,
            deliveredAt: webhookDeliveries.deliveredAt,
            createdAt: webhookDeliveries.createdAt,
          })
          .from(webhookDeliveries)
          .where(
            and(
              eq(webhookDeliveries.subscriptionId, params.id),
              query.status
                ? eq(webhookDeliveries.status, query.status)
                : undefined,
              query.beforeSeq !== undefined
                ? lt(webhookDeliveries.eventSeq, query.beforeSeq)
                : undefined,
            ),
          )
          .orderBy(desc(webhookDeliveries.eventSeq), desc(webhookDeliveries.id))
          .limit(query.limit)

        return {
          deliveries: rows,
          nextBeforeSeq:
            rows.length === query.limit
              ? (rows.at(-1)?.eventSeq ?? null)
              : null,
        }
      },
    ),
  ),
)

export default app
