import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
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

// GET /api/thread/:itemId
app.get(
  '/:itemId',
  adapt(
    apiHandler({}, async ({ request, params }) => {
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

      const thread = await ThreadService.getThread({
        itemId,
        domains,
        upstreamDepth,
        downstreamDepth,
        bomDepth,
      })

      return thread
    }),
  ),
)

// POST /api/thread/:itemId/compare
app.post(
  '/:itemId/compare',
  adapt(
    apiHandler({}, async ({ request, params }) => {
      const { itemId } = params
      const body = await request.json()

      // Parse and validate request body
      const validated = threadComparisonRequestSchema.parse(body)

      // Run comparison
      const comparison = await ThreadComparisonService.compare(
        itemId,
        validated,
      )

      return comparison
    }),
  ),
)

// GET /api/thread/:itemId/comparison-targets
app.get(
  '/:itemId/comparison-targets',
  adapt(
    apiHandler({}, async ({ params }) => {
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
