import { Hono } from 'hono'
import { adapt } from '../adapter'
import { VerificationService } from '@/lib/services/VerificationService'
import { ValidationError } from '@/lib/errors'
import { apiHandler, created } from '@/lib/api/handler'
import '@/lib/items/registerItemTypes.server'

const app = new Hono()

// POST /api/test-cases/:id/execute
app.post(
  '/:id/execute',
  adapt(
    apiHandler({}, async ({ request, params, user }) => {
      const body = await request.json()
      const { status, duration, environment, actualResults, notes } = body

      if (!status) {
        throw new ValidationError('status is required')
      }

      const execution = await VerificationService.recordExecution(
        params.id,
        {
          status,
          duration,
          environment,
          actualResults,
          notes,
        },
        user.id,
      )

      return created({ execution })
    }),
  ),
)

// GET /api/test-cases/:id/executions
app.get(
  '/:id/executions',
  adapt(
    apiHandler({}, async ({ request, params }) => {
      const url = new URL(request.url)
      const limit = parseInt(url.searchParams.get('limit') || '20', 10)

      const executions = await VerificationService.getExecutionHistory(
        params.id,
        limit,
      )

      return { executions }
    }),
  ),
)

export default app
