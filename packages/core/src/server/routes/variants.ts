// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Product variants, read side. Mounted under `/api/v1/parts` beside the part
 * routes. Writes to the option model and makes go through the ordinary
 * `PUT /api/v1/parts/:id`, so they inherit checkout and branch protection;
 * writes to a line's condition go through `PUT /api/v1/relationships/:id`.
 */

import { Hono } from 'hono'
import { z } from 'zod'
import { tagged } from '../adapter'
import { apiHandler, parseQuery } from '@/lib/api/handler'
import { requireItemAccess } from '@/lib/auth/access'
import { VariantService } from '@/lib/services/VariantService'

const adapt = tagged('Variants')

const app = new Hono()

const partIdParamSchema = z.object({ id: z.string().uuid() })

const selectionsSchema = z.record(z.string(), z.string())

const validateBodySchema = z.object({
  selections: selectionsSchema.describe('Option family code → value code'),
})

const issueSchema = z.object({
  severity: z.enum(['error', 'warning']),
  family: z.string().optional(),
  message: z.string(),
})

const lintQuerySchema = z.object({
  branchId: z.string().uuid().optional(),
})

// POST /api/v1/parts/:id/variants/validate
app.post(
  '/:id/variants/validate',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof validateBodySchema>>(
      {
        permission: ['parts', 'read'],
        body: validateBodySchema,
        openapi: {
          summary: 'Validate option selections against a configurable part',
          request: { params: partIdParamSchema },
          responses: {
            200: {
              schema: z.object({
                valid: z.boolean(),
                errors: z.array(issueSchema),
                warnings: z.array(issueSchema),
              }),
            },
          },
        },
      },
      async ({ params, body, user }) => {
        await requireItemAccess(user.id, params.id)
        return VariantService.validateSelections(params.id, body.selections)
      },
    ),
  ),
)

const resolveBodySchema = z
  .object({
    selections: selectionsSchema.optional(),
    makeCode: z.string().optional().describe('A named make on the part'),
    branchId: z.string().uuid().optional(),
  })
  .refine((b) => b.selections !== undefined || b.makeCode !== undefined, {
    message: 'Give selections or a makeCode',
  })

// POST /api/v1/parts/:id/variants/resolve
app.post(
  '/:id/variants/resolve',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof resolveBodySchema>>(
      {
        permission: ['parts', 'read'],
        body: resolveBodySchema,
        openapi: {
          summary: 'Resolve a configuration to a 100 % BOM',
          description:
            'Keeps the fixed lines and the lines whose option condition the ' +
            'selections satisfy, recursively. Pass `makeCode` to use a ' +
            "named make's selections.",
          request: { params: partIdParamSchema },
          responses: {
            200: {
              schema: z.object({
                root: z.object({
                  itemId: z.string(),
                  itemNumber: z.string(),
                  name: z.string().nullable(),
                  revision: z.string(),
                }),
                selections: selectionsSchema,
                validation: z.object({
                  valid: z.boolean(),
                  errors: z.array(issueSchema),
                  warnings: z.array(issueSchema),
                }),
                children: z.array(z.unknown()),
                droppedLines: z.number().int(),
                findings: z.array(
                  z.object({ itemNumber: z.string(), message: z.string() }),
                ),
              }),
            },
          },
        },
      },
      async ({ params, body, user }) => {
        await requireItemAccess(user.id, params.id)
        const selections =
          body.selections ??
          (await VariantService.selectionsForMake(params.id, body.makeCode!))
        return VariantService.resolve(params.id, selections, {
          branchId: body.branchId,
        })
      },
    ),
  ),
)

// GET /api/v1/parts/:id/variants/lint
app.get(
  '/:id/variants/lint',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['parts', 'read'],
        openapi: {
          summary: "Check a part's variant data for inconsistencies",
          request: { params: partIdParamSchema, query: lintQuerySchema },
          responses: {
            200: {
              schema: z.object({
                findings: z.array(
                  z.object({
                    code: z.string(),
                    severity: z.enum(['error', 'warning']),
                    message: z.string(),
                    relationshipId: z.string().optional(),
                    makeCode: z.string().optional(),
                    family: z.string().optional(),
                    value: z.string().optional(),
                  }),
                ),
              }),
            },
          },
        },
      },
      async ({ params, request, user }) => {
        await requireItemAccess(user.id, params.id)
        const { branchId } = parseQuery(request, lintQuerySchema)
        const findings = await VariantService.lint(params.id, { branchId })
        return { findings }
      },
    ),
  ),
)

export default app
