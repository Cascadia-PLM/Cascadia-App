import { Hono } from 'hono'
import { tagged } from '../adapter'
import { apiHandler } from '@/lib/api/handler'

const adapt = tagged('Health')

const app = new Hono()

// GET /api/health
app.get(
  '/',
  adapt(
    // eslint-disable-next-line @typescript-eslint/require-await -- apiHandler signature requires async
    apiHandler({ public: true }, async () => {
      return { status: 'ok', timestamp: new Date().toISOString() }
    }),
  ),
)

export default app
