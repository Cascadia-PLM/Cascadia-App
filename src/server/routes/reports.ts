import { Hono } from 'hono'
import { adapt } from '../adapter'
import { ReportService } from '@/lib/reports/ReportService'
import { reportExecutionOptionsSchema, reportSchema } from '@/lib/reports/types'
import { NotFoundError } from '@/lib/errors'
import { apiHandler, created } from '@/lib/api/handler'

const app = new Hono()

// GET /api/reports
app.get(
  '/',
  adapt(
    apiHandler({}, async ({ request, user }) => {
      const url = new URL(request.url)
      const itemType = url.searchParams.get('itemType')
      const limit = Math.min(
        parseInt(url.searchParams.get('limit') || '100', 10),
        500,
      )
      const offset = parseInt(url.searchParams.get('offset') || '0', 10)

      const result = itemType
        ? await ReportService.listByItemType(itemType, user.id, [], {
            limit,
            offset,
          })
        : await ReportService.list(user.id, [], { limit, offset })

      return { reports: result.reports, total: result.total }
    }),
  ),
)

// POST /api/reports
app.post(
  '/',
  adapt(
    apiHandler({}, async ({ request, user }) => {
      const data = await request.json()

      // Validate input
      const validatedData = reportSchema.parse(data)

      const report = await ReportService.create(validatedData, user.id)

      return created({ report })
    }),
  ),
)

// GET /api/reports/:id
app.get(
  '/:id',
  adapt(
    apiHandler({}, async ({ params }) => {
      const report = await ReportService.findById(params.id)

      if (!report) {
        throw new NotFoundError('Report', params.id)
      }

      return { report }
    }),
  ),
)

// PUT /api/reports/:id
app.put(
  '/:id',
  adapt(
    apiHandler({}, async ({ params, request, user }) => {
      const data = await request.json()

      // Validate input (partial validation for update)
      const validatedData = reportSchema.partial().parse(data)

      const report = await ReportService.update(
        params.id,
        validatedData,
        user.id,
      )

      return { report }
    }),
  ),
)

// DELETE /api/reports/:id
app.delete(
  '/:id',
  adapt(
    apiHandler({}, async ({ params }) => {
      await ReportService.delete(params.id)

      return { success: true }
    }),
  ),
)

// POST /api/reports/:id/execute
app.post(
  '/:id/execute',
  adapt(
    apiHandler({}, async ({ params, request, user }) => {
      const { id } = params as { id: string }

      let options = {}
      try {
        const body = await request.json()
        options = reportExecutionOptionsSchema.parse(body)
      } catch {
        // Use default options if body is empty or invalid
      }

      const result = await ReportService.execute(id, options, user.id)

      return { result }
    }),
  ),
)

// POST /api/reports/:id/export
app.post(
  '/:id/export',
  adapt(
    apiHandler({}, async ({ params, request, user }) => {
      const { id } = params as { id: string }

      let options = {}
      try {
        const body = await request.json()
        options = reportExecutionOptionsSchema.parse(body)
      } catch {
        // Use default options if body is empty or invalid
      }

      // Execute the report first
      const result = await ReportService.execute(id, options, user.id)

      // Convert to CSV
      const csv = ReportService.exportToCSV(result)

      // Generate filename
      const filename = `report-${id}-${new Date().toISOString().split('T')[0]}.csv`

      return new Response(csv, {
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
      })
    }),
  ),
)

export default app
