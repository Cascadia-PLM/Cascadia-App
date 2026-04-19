import { Hono } from 'hono'
import { adapt } from '../adapter'
import { JobService } from '@/lib/jobs/JobService'
import { apiHandler } from '@/lib/api/handler'
import { NotFoundError } from '@/lib/errors'

const app = new Hono()

// GET /api/jobs/:id
app.get(
  '/:id',
  adapt(
    apiHandler({}, async ({ params }) => {
      const job = await JobService.get(params.id)
      if (!job) {
        throw new NotFoundError('Job', params.id)
      }

      return {
        id: job.id,
        type: job.type,
        status: job.status,
        progress: job.progress,
        progressMessage: job.progressMessage,
        result: job.result,
        error: job.error,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
      }
    }),
  ),
)

export default app
