// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { z } from 'zod'
import { tagged } from '../adapter'
import { VerificationService } from '@/lib/services/VerificationService'
import { apiHandler } from '@/lib/api/handler'
import { requireItemAccess } from '@/lib/auth/access'
import '@/lib/items/registerItemTypes.server'

const adapt = tagged('Test Plans')

const app = new Hono()

const testCaseSummarySchema = z.object({
  id: z.string().uuid(),
  itemNumber: z.string(),
  name: z.string().nullable(),
  state: z.string(),
  testType: z.string().nullable(),
  executionStatus: z.string().nullable(),
  lastExecutedAt: z.date().nullable(),
})

// GET /api/v1/test-plans/:id/test-cases
app.get(
  '/:id/test-cases',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['test_plans', 'read'],
        openapi: {
          summary: 'List the test cases belonging to a test plan',
          request: { params: z.object({ id: z.string().uuid() }) },
          responses: {
            200: {
              schema: z.object({ testCases: z.array(testCaseSummarySchema) }),
            },
          },
        },
      },
      async ({ params, user }) => {
        await requireItemAccess(user.id, params.id)
        const testCases = await VerificationService.getTestCasesForPlan(
          params.id,
        )
        return { testCases }
      },
    ),
  ),
)

export default app
