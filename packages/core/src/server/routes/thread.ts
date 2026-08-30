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
import {
  ThreadComparisonService,
  threadComparisonRequestSchema,
} from '@/lib/services/ThreadComparisonService'
import { apiHandler } from '@/lib/api/handler'

const adapt = tagged('Thread')

const app = new Hono()

/** Query contract for GET /thread/:itemId (comma-separated domains). */
const threadQuerySchema = z.object({
  domains: z
    .string()
    .optional()
    .describe(
      "Comma-separated thread domains: 'requirements' | 'engineering' | 'manufacturing' | 'validation' | 'physical'",
    ),
  upstreamDepth: z.coerce.number().int().min(0).max(10).optional(),
  downstreamDepth: z.coerce.number().int().min(0).max(10).optional(),
  bomDepth: z.coerce.number().int().min(0).max(10).optional(),
  physicalDepth: z.coerce.number().int().min(0).max(10).optional(),
})

// GET /api/thread/:itemId
app.get(
  '/:itemId',
  adapt(
    apiHandler<{ itemId: string }>(
      {
        openapi: {
          summary: 'Get the digital thread graph for an item',
          request: {
            params: z.object({ itemId: z.string().uuid() }),
            query: threadQuerySchema,
          },
        },
      },
      async ({ request, params }) => {
        const { itemId } = params

        const url = new URL(request.url, 'http://localhost')

        // Parse query parameters
        const domainsParam = url.searchParams.get('domains')
        const domains: Array<ThreadDomain> = domainsParam
          ? (domainsParam.split(',') as Array<ThreadDomain>)
          : ['engineering', 'manufacturing']

        const upstreamDepth = parseInt(
          url.searchParams.get('upstreamDepth') || '5',
          10,
        )
        const downstreamDepth = parseInt(
          url.searchParams.get('downstreamDepth') || '5',
          10,
        )
        const bomDepth = parseInt(url.searchParams.get('bomDepth') || '3', 10)
        const physicalDepth = parseInt(
          url.searchParams.get('physicalDepth') || '4',
          10,
        )

        const thread = await ThreadService.getThread({
          itemId,
          domains,
          upstreamDepth,
          downstreamDepth,
          bomDepth,
          physicalDepth,
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
    apiHandler<{ itemId: string }>({}, async ({ params }) => {
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
    }),
  ),
)

export default app
