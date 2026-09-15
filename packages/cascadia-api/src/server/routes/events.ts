// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { z } from 'zod'
import { and, desc, eq, isNotNull, lt, max } from 'drizzle-orm'
import { tagged } from '../adapter'
import { apiHandler, parseQuery } from '@/lib/api/handler'
import { db } from '@/lib/db'
import { domainEvents, eventConsumers } from '@/lib/db/schema'
import {
  EventTypeRegistry,
  forgetEventConsumer,
  resumeEventConsumer,
  skipPoisonEvent,
} from '@/lib/events'
import { NotFoundError } from '@/lib/errors'
import { ExtensionRegistry } from '@/lib/extensions'

const adapt = tagged('Events')

const app = new Hono()

const domainEventSchema = z.object({
  id: z.string().uuid(),
  seq: z.number(),
  type: z.string(),
  schemaVersion: z.number(),
  occurredAt: z.string(),
  actorId: z.string().uuid().nullable(),
  subjectType: z.string().nullable(),
  subjectId: z.string().uuid().nullable(),
  subjectMasterId: z.string().uuid().nullable(),
  programId: z.string().uuid().nullable(),
  designId: z.string().uuid().nullable(),
  branchId: z.string().uuid().nullable(),
  payload: z.record(z.string(), z.unknown()),
  correlationId: z.string().uuid().nullable(),
  causationId: z.string().uuid().nullable(),
})

const consumerSchema = z.object({
  id: z.string(),
  lastSeq: z.number(),
  lag: z.number(),
  failureCount: z.number(),
  lastError: z.string().nullable(),
  lastErrorAt: z.string().nullable(),
  lastErrorSeq: z.number().nullable(),
  nextAttemptAt: z.string().nullable(),
  parkedAt: z.string().nullable(),
  /** Set when retention gave up on a long-parked consumer; backlog forfeit. */
  abandonedAt: z.string().nullable(),
  updatedAt: z.string(),
  registeredHere: z.boolean(),
})

const listQuerySchema = z.object({
  type: z.string().optional(),
  /** Return events with seq strictly below this (backward pagination). */
  // Coerced and checked, not `Number()`-ed: `beforeSeq=abc` used to reach
  // Postgres as NaN and come back a 500 rather than a 400.
  beforeSeq: z.coerce.number().int().optional(),
  limit: z.coerce
    .number()
    .int()
    .optional()
    .transform((v) => Math.min(200, Math.max(1, v ?? 50))),
})

// GET /api/v1/events — newest first, for the ops/debug view
app.get(
  '/',
  adapt(
    apiHandler(
      {
        permission: ['system', 'manage'],
        openapi: {
          summary: 'List domain events (newest first)',
          description:
            'The append-only log of committed business facts. Filter by type; page backward with beforeSeq.',
          request: {
            query: z.object({
              type: z.string().optional(),
              beforeSeq: z.string().optional(),
              limit: z.string().optional(),
            }),
          },
          responses: {
            200: { schema: z.object({ events: z.array(domainEventSchema) }) },
          },
        },
      },
      async ({ request }) => {
        const query = parseQuery(request, listQuerySchema)
        // A null seq is a row of the reader's own uncommitted transaction,
        // which an API handler never has — but the predicate is what makes
        // the response type honest.
        const conditions = [isNotNull(domainEvents.seq)]
        if (query.type) conditions.push(eq(domainEvents.type, query.type))
        if (query.beforeSeq !== undefined)
          conditions.push(lt(domainEvents.seq, query.beforeSeq))

        const rows = await db
          .select()
          .from(domainEvents)
          .where(and(...conditions))
          .orderBy(desc(domainEvents.seq))
          .limit(query.limit)

        return {
          events: rows.flatMap((row) =>
            row.seq === null ? [] : [{ ...row, seq: row.seq }],
          ),
        }
      },
    ),
  ),
)

// GET /api/v1/events/types — the registered catalog
app.get(
  '/types',
  adapt(
    apiHandler(
      {
        permission: ['system', 'manage'],
        openapi: {
          summary: 'List registered domain event types',
          responses: {
            200: {
              schema: z.object({
                types: z.array(
                  z.object({
                    type: z.string(),
                    schemaVersion: z.number(),
                    description: z.string(),
                    subjectType: z.string().nullable(),
                  }),
                ),
              }),
            },
          },
        },
      },
      () =>
        Promise.resolve({
          types: EventTypeRegistry.list().map((def) => ({
            type: def.type,
            schemaVersion: def.schemaVersion,
            description: def.description,
            subjectType: def.subjectType ?? null,
          })),
        }),
    ),
  ),
)

// GET /api/v1/events/consumers — cursor positions and lag
app.get(
  '/consumers',
  adapt(
    apiHandler(
      {
        permission: ['system', 'manage'],
        openapi: {
          summary: 'List event consumers, their cursors and lag',
          description:
            "Durable cursor rows, with each consumer's lag behind the head of " +
            'the log.\n\n`registeredHere` says whether *this* process ' +
            'registers the consumer, and **false is a normal reading rather ' +
            'than a fault**: each process runs only its own consumers, and ' +
            'the RabbitMQ relay and the webhook dispatcher run in the jobs ' +
            'worker alone. What actually says "no poller is running anywhere" ' +
            'is lag that grows while `updatedAt` stays stale.',
          responses: {
            200: {
              schema: z.object({
                latestSeq: z.number(),
                consumers: z.array(consumerSchema),
              }),
            },
          },
        },
      },
      async () => {
        const latestRow = await db
          .select({ latest: max(domainEvents.seq) })
          .from(domainEvents)
        const latestSeq = latestRow.at(0)?.latest ?? 0
        const rows = await db.select().from(eventConsumers)
        const registered = new Set(
          ExtensionRegistry.consumed().map((e) => e.id),
        )

        return {
          latestSeq,
          consumers: rows.map((row) => ({
            id: row.id,
            lastSeq: row.lastSeq,
            lag: Math.max(0, latestSeq - row.lastSeq),
            failureCount: row.failureCount,
            lastError: row.lastError,
            lastErrorAt: row.lastErrorAt,
            lastErrorSeq: row.lastErrorSeq,
            nextAttemptAt: row.nextAttemptAt,
            parkedAt: row.parkedAt,
            abandonedAt: row.abandonedAt,
            updatedAt: row.updatedAt,
            registeredHere: registered.has(row.id),
          })),
        }
      },
    ),
  ),
)

const consumerParams = z.object({ id: z.string() })

// POST /api/v1/events/consumers/:id/resume — clear failure state and retry
app.post(
  '/consumers/:id/resume',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['system', 'manage'],
        openapi: {
          summary: 'Resume a parked or backing-off event consumer',
          description:
            'Clears the failure count, backoff and parked flag of the consumer so the next poll runs it again from the same cursor. Use once the cause of the failures is fixed. Refused with 409 for a consumer retention abandoned, whose backlog may already be pruned: forget its cursor instead.',
          request: { params: consumerParams },
          responses: {
            200: {
              schema: consumerSchema.omit({ lag: true, registeredHere: true }),
            },
          },
        },
      },
      async ({ params }) => resumeEventConsumer(params.id),
    ),
  ),
)

// DELETE /api/v1/events/consumers/:id — forget the cursor entirely
app.delete(
  '/consumers/:id',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['system', 'manage'],
        openapi: {
          summary: "Forget an event consumer's cursor",
          description:
            "Deletes the cursor row. **This abandons that consumer's backlog " +
            'permanently** — exactly as skip does, but for all of it rather than ' +
            'one event. A consumer re-registered afterwards restarts at whatever ' +
            "its `startAt` declares, so anything declaring 'head' treats " +
            'everything currently in the log as delivered.\n\n' +
            'It exists because neither resume nor skip removes a cursor, and a ' +
            'cursor nobody owns pins the retention horizon forever — so without ' +
            'this the only fix for an ERP consumer on an instance that dropped ' +
            'the package, or a webhook dispatcher on one that abandoned webhooks, ' +
            'is manual SQL.',
          request: { params: consumerParams },
          responses: {
            200: { schema: z.object({ forgotten: z.boolean() }) },
          },
        },
      },
      async ({ params }) => {
        const forgotten = await forgetEventConsumer(db, params.id)
        if (!forgotten) throw new NotFoundError('Event consumer', params.id)
        return { forgotten }
      },
    ),
  ),
)

// POST /api/v1/events/consumers/:id/skip — move past the poison event
app.post(
  '/consumers/:id/skip',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['system', 'manage'],
        openapi: {
          summary: 'Skip the event a consumer keeps failing on',
          description:
            'Advances the cursor of the consumer past its last failed event and clears its failure state. Deliberate and logged: that event is never delivered to this consumer. Refused when no failure is on record, and with 409 for a consumer retention abandoned.',
          request: { params: consumerParams },
          responses: {
            200: {
              schema: consumerSchema.omit({ lag: true, registeredHere: true }),
            },
          },
        },
      },
      async ({ params }) => skipPoisonEvent(params.id),
    ),
  ),
)

export default app
