// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { tagged } from '../adapter'
import type { z } from 'zod'
import { ReportService } from '@/lib/reports/ReportService'
import { reportExecutionOptionsSchema, reportSchema } from '@/lib/reports/types'
import { NotFoundError } from '@/lib/errors'
import { apiHandler, created } from '@/lib/api/handler'

const adapt = tagged('Reports')

/** Update takes the same shape, all optional. */
const reportUpdateSchema = reportSchema.partial()

const app = new Hono()

// GET /api/reports
app.get(
  '/',
  adapt(
    apiHandler(
      { permission: ['reports', 'read'] },
      async ({ request, user }) => {
        const url = new URL(request.url)
        const itemType = url.searchParams.get('itemType')
        const limit = Math.min(
          parseInt(url.searchParams.get('limit') || '100', 10),
          500,
        )
        const offset = parseInt(url.searchParams.get('offset') || '0', 10)

        const result = itemType
          ? await ReportService.listByItemType(itemType, user.id, {
              limit,
              offset,
            })
          : await ReportService.list(user.id, { limit, offset })

        return { reports: result.reports, total: result.total }
      },
    ),
  ),
)

// POST /api/reports
app.post(
  '/',
  adapt(
    apiHandler(
      { permission: ['reports', 'create'], body: reportSchema },
      async ({ body, user }) => {
        const report = await ReportService.create(body, user.id)

        return created({ report })
      },
    ),
  ),
)

// GET /api/reports/:id
app.get(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['reports', 'read'] },
      async ({ params, user }) => {
        const { id } = params
        // `reports:read` says the caller may read reports at all; the sharing
        // rule on the row says which ones. A miss is a 404 rather than a 403
        // so an ID probe cannot confirm the report exists.
        const report = await ReportService.findByIdForUser(id, user.id)

        if (!report) {
          throw new NotFoundError('Report', id)
        }

        return { report }
      },
    ),
  ),
)

// PUT /api/reports/:id
app.put(
  '/:id',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof reportUpdateSchema>>(
      { permission: ['reports', 'update'], body: reportUpdateSchema },
      async ({ params, body, user }) => {
        await ReportService.requireWritable(params.id, user.id, 'update')

        const report = await ReportService.update(params.id, body, user.id)

        return { report }
      },
    ),
  ),
)

// DELETE /api/reports/:id
app.delete(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['reports', 'delete'] },
      async ({ params, user }) => {
        await ReportService.requireWritable(params.id, user.id, 'delete')
        await ReportService.delete(params.id)

        return { success: true }
      },
    ),
  ),
)

// POST /api/reports/:id/execute
app.post(
  '/:id/execute',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['reports', 'read'],
        // Optional, because running a report with no options is the ordinary
        // case. A *malformed* body is now a 400 rather than being swallowed
        // into the defaults, which is the point of validating it at all.
        body: reportExecutionOptionsSchema.optional(),
      },
      async ({ params, body, user }) => {
        const result = await ReportService.execute(
          params.id,
          body ?? {},
          user.id,
        )

        return { result }
      },
    ),
  ),
)

// POST /api/reports/:id/export
app.post(
  '/:id/export',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['reports', 'read'],
        body: reportExecutionOptionsSchema.optional(),
      },
      async ({ params, body, user }) => {
        const { id } = params

        // Execute the report first
        const result = await ReportService.execute(id, body ?? {}, user.id)

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
      },
    ),
  ),
)

export default app
