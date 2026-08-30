// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { z } from 'zod'
import { tagged } from '../adapter'
import { VerificationService } from '@/lib/services/VerificationService'
import { apiHandler, created, parseQuery } from '@/lib/api/handler'
import { requireItemAccess } from '@/lib/auth/access'
import '@/lib/items/registerItemTypes.server'

const adapt = tagged('Test Cases')

const app = new Hono()

const executionSchema = z.object({
  id: z.string().uuid(),
  testCaseId: z.string().uuid(),
  executorId: z.string().uuid(),
  executorName: z.string(),
  executedAt: z.date(),
  status: z.string(),
  duration: z.number().nullable(),
  environment: z.string().nullable(),
  actualResults: z.string().nullable(),
  notes: z.string().nullable(),
})

const executeBodySchema = z.object({
  status: z.enum(['Passed', 'Failed', 'Blocked']),
  duration: z.number().int().nonnegative().optional(),
  environment: z.string().max(100).optional(),
  actualResults: z.string().optional(),
  notes: z.string().optional(),
})

const executionsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(20),
})

// POST /api/v1/test-cases/:id/execute
app.post(
  '/:id/execute',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof executeBodySchema>>(
      {
        // Recording a run is runtime metadata rather than content authoring,
        // so it needs `update` but deliberately bypasses the edit lock in
        // VerificationService — a Released test case is still runnable.
        body: executeBodySchema,
        permission: ['test_cases', 'update'],
        openapi: {
          summary: 'Record a test case execution',
          request: {
            params: z.object({ id: z.string().uuid() }),
          },
          responses: {
            201: { schema: z.object({ execution: executionSchema }) },
          },
        },
      },
      async ({ body, params, user }) => {
        // The access check still runs first. apiHandler validates the body
        // after auth and permission but before the handler, so an outsider
        // never sees the 400 either way.
        await requireItemAccess(user.id, params.id)

        const execution = await VerificationService.recordExecution(
          params.id,
          body,
          user.id,
        )

        return created({ execution })
      },
    ),
  ),
)

// GET /api/v1/test-cases/:id/executions
app.get(
  '/:id/executions',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['test_cases', 'read'],
        openapi: {
          summary: 'List execution history for a test case',
          request: {
            params: z.object({ id: z.string().uuid() }),
            query: executionsQuerySchema,
          },
          responses: {
            200: {
              schema: z.object({ executions: z.array(executionSchema) }),
            },
          },
        },
      },
      async ({ request, params, user }) => {
        await requireItemAccess(user.id, params.id)
        const { limit } = parseQuery(request, executionsQuerySchema)

        const executions = await VerificationService.getExecutionHistory(
          params.id,
          limit,
        )

        return { executions }
      },
    ),
  ),
)

export default app
