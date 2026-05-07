import { Hono } from 'hono'
import { z } from 'zod'
import { tagged } from '../adapter'
import { ConflictDetectionService } from '@/lib/services/ConflictDetectionService'
import { apiHandler } from '@/lib/api/handler'

const adapt = tagged('Branch Items')

const pullFromMainSchema = z.object({
  mainItemId: z.string().uuid(),
})

const rebaseSchema = z.object({
  newBaseItemId: z.string().uuid(),
  resolutions: z.record(z.string(), z.unknown()).optional(),
})

const app = new Hono()

// POST /api/branch-items/:id/pull-from-main
app.post(
  '/:id/pull-from-main',
  adapt(
    apiHandler({}, async ({ request, params, user }) => {
      const body = await request.json()
      const validated = pullFromMainSchema.parse(body)

      const result = await ConflictDetectionService.pullChangesFromMain(
        params.id,
        validated.mainItemId,
        user.id,
      )

      if (!result.success) {
        return new Response(
          JSON.stringify({
            error: result.error || 'Pull from main failed',
            data: result,
          }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          },
        )
      }

      return result
    }),
  ),
)

// POST /api/branch-items/:id/rebase
app.post(
  '/:id/rebase',
  adapt(
    apiHandler({}, async ({ request, params, user }) => {
      const body = await request.json()
      const validated = rebaseSchema.parse(body)

      const result = await ConflictDetectionService.rebaseItem(
        params.id,
        validated.newBaseItemId,
        user.id,
        validated.resolutions,
      )

      if (!result.success && result.manualResolutionRequired) {
        // Return 409 Conflict with the field conflicts that need resolution
        return new Response(
          JSON.stringify({
            error: 'Manual resolution required',
            fieldConflicts: result.fieldConflicts,
            data: result,
          }),
          {
            status: 409,
            headers: { 'Content-Type': 'application/json' },
          },
        )
      }

      if (!result.success) {
        return new Response(
          JSON.stringify({
            error: result.error || 'Rebase failed',
            data: result,
          }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          },
        )
      }

      return result
    }),
  ),
)

export default app
