// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { tagged } from '../adapter'
import type { Part } from '@/lib/items/types/part'
import type { PermissionAction } from '@/lib/auth/permissions'
import type { ItemAccessScope } from '@/lib/auth/access'
import { ItemService } from '@/lib/items/services/ItemService'
import { VerificationService } from '@/lib/services/VerificationService'
import { ParametricResolutionService } from '@/lib/services/ParametricResolutionService'
import { NotFoundError, ValidationError } from '@/lib/errors'
import { apiHandler, created } from '@/lib/api/handler'
import {
  requireItemDesignAccess,
  requireItemIdsDesignAccess,
} from '@/lib/auth/access'
import { requirePermission } from '@/lib/auth/server'
import { mountRoutes } from '@/lib/api/route-registry'
import { partUpdateSchema } from '@/lib/api/schemas'
import { getResourceType } from '@/lib/items/item-type-resources'
import { db } from '@/lib/db'
import {
  items,
  workInstructionPartAttachments,
  workInstructions,
} from '@/lib/db/schema'
// Register item types (server-side version)
import '@/lib/items/registerItemTypes.server'

const adapt = tagged('Parts')

const app = new Hono()

const partIdParamSchema = z.object({ id: z.string().uuid() })
const partValidationSchema = z.object({
  testCaseIds: z.array(z.string().uuid()).min(1),
})
const partResponseSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().nullable(),
    partType: z.string().nullable(),
  })
  .passthrough()

async function requirePartAccess(userId: string, id: string) {
  z.string().uuid().parse(id)
  const part = await ItemService.findById(id)
  if (!part || part.itemType !== 'Part') throw new NotFoundError('Part', id)
  await requireItemDesignAccess(userId, part)
  return part
}

async function requireItemResourcePermissions(
  request: Request,
  itemScopes: Iterable<ItemAccessScope>,
  action: PermissionAction,
): Promise<void> {
  const resources = new Set(
    [...itemScopes].map((item) => getResourceType(item.itemType)),
  )
  for (const resource of resources) {
    await requirePermission(request, resource, action)
  }
}

// GET /api/parts/:id
app.get(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['parts', 'read'],
        openapi: {
          summary: 'Get a part by ID',
          request: { params: partIdParamSchema },
          responses: {
            200: { schema: z.object({ part: partResponseSchema }) },
          },
        },
      },
      async ({ params, user }) => {
        const part = await requirePartAccess(user.id, params.id)
        return { part }
      },
    ),
  ),
)

// PUT /api/parts/:id
app.put(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['parts', 'update'],
        openapi: {
          summary: 'Update a part',
          request: {
            params: partIdParamSchema,
            body: { schema: partUpdateSchema },
          },
          responses: {
            200: { schema: z.object({ part: partResponseSchema }) },
          },
        },
      },
      async ({ params, request, user }) => {
        const { id } = params
        const data = await request.json()
        await requirePartAccess(user.id, id)
        const part = await ItemService.update<Part>(id, data, user.id)
        return { part }
      },
    ),
  ),
)

// DELETE /api/parts/:id
app.delete(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['parts', 'delete'],
        openapi: {
          summary: 'Delete a part',
          request: { params: partIdParamSchema },
          responses: {
            200: { schema: z.object({ success: z.boolean() }) },
          },
        },
      },
      async ({ params, user }) => {
        const { id } = params
        await requirePartAccess(user.id, id)
        await ItemService.delete(id, user.id)
        return { success: true }
      },
    ),
  ),
)

// Generative CAD actions on a part are contributed by an optional package and
// mount here. Nothing is registered on a core-only build. Placed ahead of the
// remaining /:id/* routes for readability; the paths do not overlap.
mountRoutes(app, 'parts')

// GET /api/parts/:id/resolvable-attributes
app.get(
  '/:id/resolvable-attributes',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['parts', 'read'] },
      async ({ params, user }) => {
        const { id } = params
        await requirePartAccess(user.id, id)
        const attributes =
          await ParametricResolutionService.getResolvableAttributes(id)

        return { attributes }
      },
    ),
  ),
)

// POST /api/parts/:id/validate
app.post(
  '/:id/validate',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['parts', 'update'] },
      async ({ request, params, user }) => {
        const { id } = params
        const { testCaseIds } = partValidationSchema.parse(await request.json())
        await requirePartAccess(user.id, id)
        const itemsById = await requireItemIdsDesignAccess(user.id, testCaseIds)
        await requireItemResourcePermissions(
          request,
          itemsById.values(),
          'update',
        )

        // Link each test case to this part (testCase -> part)
        for (const testCaseId of testCaseIds) {
          await VerificationService.linkValidation(testCaseId, [id], user.id)
        }

        return created({ success: true })
      },
    ),
  ),
)

// DELETE /api/parts/:id/validate
app.delete(
  '/:id/validate',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['parts', 'update'] },
      async ({ request, params, user }) => {
        const { id } = params
        const url = new URL(request.url)
        const testCaseId = url.searchParams.get('testCaseId')

        if (!testCaseId) {
          throw new ValidationError('testCaseId query parameter is required')
        }
        z.string().uuid().parse(testCaseId)

        await requirePartAccess(user.id, id)
        const itemsById = await requireItemIdsDesignAccess(user.id, [
          testCaseId,
        ])
        await requireItemResourcePermissions(
          request,
          itemsById.values(),
          'update',
        )
        await VerificationService.unlinkValidation(testCaseId, id, user.id)

        return { success: true }
      },
    ),
  ),
)

// GET /api/parts/:id/validating-tests
app.get(
  '/:id/validating-tests',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['parts', 'read'] },
      async ({ params, request, user }) => {
        const { id } = params
        await requirePartAccess(user.id, id)
        const tests = await VerificationService.getValidatingTests(id)
        const itemsById = await requireItemIdsDesignAccess(
          user.id,
          tests.map((test) => test.id),
        )
        await requireItemResourcePermissions(
          request,
          itemsById.values(),
          'read',
        )

        return { tests }
      },
    ),
  ),
)

// GET /api/parts/:id/work-instructions
app.get(
  '/:id/work-instructions',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['parts', 'read'] },
      async ({ params, request, user }) => {
        const { id } = params
        await requirePartAccess(user.id, id)

        // Get work instructions attached to this part
        const attachedWIs = await db
          .select({
            attachmentId: workInstructionPartAttachments.id,
            inheritToMBOM: workInstructionPartAttachments.inheritToMBOM,
            createdAt: workInstructionPartAttachments.createdAt,
            workInstruction: {
              id: items.id,
              itemNumber: items.itemNumber,
              name: items.name,
              revision: items.revision,
              state: items.state,
            },
            workInstructionDetails: {
              description: workInstructions.description,
              estimatedTime: workInstructions.estimatedTime,
              difficulty: workInstructions.difficulty,
            },
          })
          .from(workInstructionPartAttachments)
          .innerJoin(
            items,
            eq(workInstructionPartAttachments.workInstructionId, items.id),
          )
          .innerJoin(
            workInstructions,
            eq(
              workInstructionPartAttachments.workInstructionId,
              workInstructions.itemId,
            ),
          )
          .where(eq(workInstructionPartAttachments.partId, id))

        // Flatten the response
        const workInstructionsList = attachedWIs.map((row) => ({
          attachmentId: row.attachmentId,
          inheritToMBOM: row.inheritToMBOM,
          attachedAt: row.createdAt,
          id: row.workInstruction.id,
          itemNumber: row.workInstruction.itemNumber,
          name: row.workInstruction.name,
          revision: row.workInstruction.revision,
          state: row.workInstruction.state,
          description: row.workInstructionDetails.description,
          estimatedTime: row.workInstructionDetails.estimatedTime,
          difficulty: row.workInstructionDetails.difficulty,
        }))

        const itemsById = await requireItemIdsDesignAccess(
          user.id,
          workInstructionsList.map((instruction) => instruction.id),
        )
        await requireItemResourcePermissions(
          request,
          itemsById.values(),
          'read',
        )

        return { workInstructions: workInstructionsList }
      },
    ),
  ),
)

export default app
