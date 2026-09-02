// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { tagged } from '../adapter'
import type { ThreadDomain } from '@/lib/services/ThreadService'
import { db } from '@/lib/db'
import { items } from '@/lib/db/schema'
import { ThreadService } from '@/lib/services/ThreadService'
import { NotFoundError } from '@/lib/errors'
import { requireItemAccess } from '@/lib/auth/access'
import {
  ThreadComparisonService,
  threadComparisonRequestSchema,
} from '@/lib/services/ThreadComparisonService'
import { apiHandler } from '@/lib/api/handler'

const adapt = tagged('Thread')

const app = new Hono()

const THREAD_DOMAINS = [
  'requirements',
  'engineering',
  'manufacturing',
  'validation',
  'physical',
] as const satisfies ReadonlyArray<ThreadDomain>

/**
 * Query contract for GET /thread/:itemId.
 *
 * This schema was declared, published in OpenAPI, and never applied: the
 * handler read the raw search params and ran each depth through
 * `parseInt(... || '5', 10)`, so `?upstreamDepth=abc` walked the graph with
 * NaN and `?upstreamDepth=99` ignored the max this object states. It reaches
 * the request now because the route declares it as `query:` rather than
 * documenting it, so the bounds below are the bounds enforced.
 *
 * Defaults live here rather than in the handler for the same reason — they
 * were the `|| '5'` half of those parseInts, which is to say they were the
 * contract and were not written down.
 */
const threadQuerySchema = z.object({
  domains: z
    .string()
    .optional()
    .transform((value) => value?.split(',') ?? ['engineering', 'manufacturing'])
    .pipe(z.array(z.enum(THREAD_DOMAINS)).min(1))
    .describe(
      "Comma-separated thread domains: 'requirements' | 'engineering' | 'manufacturing' | 'validation' | 'physical'",
    ),
  upstreamDepth: z.coerce.number().int().min(0).max(10).default(5),
  downstreamDepth: z.coerce.number().int().min(0).max(10).default(5),
  bomDepth: z.coerce.number().int().min(0).max(10).default(3),
  physicalDepth: z.coerce.number().int().min(0).max(10).default(4),
})

// GET /api/thread/:itemId
app.get(
  '/:itemId',
  adapt(
    apiHandler<{ itemId: string }, unknown, z.infer<typeof threadQuerySchema>>(
      {
        // The widest read in the API — an item's relationships across every
        // domain, its BOM and its unit genealogy — and it had no instance gate
        // at all, so any authenticated caller could walk another program's
        // graph from one id. `requireItemAccess` is the same gate the item
        // routes use, and it dispatches the four types whose `items.designId`
        // is NULL rather than passing vacuously on them.
        access: ({ params, user }) => requireItemAccess(user.id, params.itemId),
        query: threadQuerySchema,
        openapi: {
          summary: 'Get the digital thread graph for an item',
          request: { params: z.object({ itemId: z.string().uuid() }) },
        },
      },
      async ({ params, query }) => {
        const thread = await ThreadService.getThread({
          itemId: params.itemId,
          ...query,
        })

        return thread
      },
    ),
  ),
)

// POST /api/thread/:itemId/compare
app.post(
  '/:itemId/compare',
  adapt(
    apiHandler<
      { itemId: string },
      z.infer<typeof threadComparisonRequestSchema>
    >(
      {
        // Same graph as the read above, at two version contexts. `access` runs
        // before the body is parsed, so a caller with no reach learns nothing
        // about the request shape from a 400.
        access: ({ params, user }) => requireItemAccess(user.id, params.itemId),
        body: threadComparisonRequestSchema,
        openapi: {
          summary: 'Compare threads at two version contexts',
          // Body schema deliberately not annotated: the discriminated-union
          // context selectors do not survive the zod→OpenAPI conversion
          // (they render as a vendor placeholder). Validation still runs.
          request: {
            params: z.object({ itemId: z.string().uuid() }),
          },
        },
      },
      async ({ body, params }) => {
        const { itemId } = params

        // Run comparison
        const comparison = await ThreadComparisonService.compare(itemId, body)

        return comparison
      },
    ),
  ),
)

// GET /api/thread/:itemId/comparison-targets
app.get(
  '/:itemId/comparison-targets',
  adapt(
    apiHandler<{ itemId: string }>(
      {
        access: ({ params, user }) => requireItemAccess(user.id, params.itemId),
      },
      async ({ params }) => {
        const { itemId } = params

        // Get item to find its designId and masterId
        const [item] = await db
          .select()
          .from(items)
          .where(eq(items.id, itemId))
          .limit(1)

        if (!item) {
          throw new NotFoundError('Item', itemId, {
            operation: 'getComparisonTargets',
          })
        }

        if (!item.designId) {
          throw new NotFoundError('Design', 'null', {
            operation: 'getComparisonTargets',
            detail: 'Item has no associated design',
          })
        }

        const targets = await ThreadComparisonService.getComparisonTargets(
          item.masterId,
          item.designId,
        )

        return targets
      },
    ),
  ),
)

export default app
