// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { z } from 'zod'
import { tagged } from '../adapter'
import type { Requirement } from '@/lib/items/types/requirement'
import { ItemService } from '@/lib/items/services/ItemService'
import { RequirementService } from '@/lib/services/RequirementService'
import { NotFoundError, ValidationError } from '@/lib/errors'
import { requireBranchAccess, requireDesignAccess } from '@/lib/auth/access'
import { apiHandler, created } from '@/lib/api/handler'
// Register item types (server-side version)
import '@/lib/items/registerItemTypes.server'

const adapt = tagged('Requirements')

/**
 * The branch a traceability write lands on. Both ends of the link resolve to
 * the rows that branch is working from, so a caller inside an ECO can keep
 * naming items by the ids it already has. Omitted, the write goes to the rows
 * named — on a design with released items that is main, and it is refused
 * with the ECO hint.
 */
const branchIdField = z.string().uuid().optional()

const deriveRequirementSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  type: z
    .enum([
      'Functional',
      'Non-Functional',
      'Performance',
      'Security',
      'Usability',
      'Business',
    ])
    .optional(),
  priority: z
    .enum(['MustHave', 'ShouldHave', 'CouldHave', 'WontHave'])
    .optional(),
  acceptanceCriteria: z.string().optional(),
  source: z.string().optional(),
  category: z.string().optional(),
  verificationMethod: z
    .enum(['Analysis', 'Inspection', 'Demonstration', 'Test', 'Documentation'])
    .optional(),
  // Requirements are ECO-driven: once the design has released anything, main
  // is protected and the child can only be committed to a branch. Omitted, the
  // child follows its parent onto whatever branch the parent is being edited
  // on, and falls back to main for a pre-release design.
  branchId: z.string().uuid().optional(),
  commitMessage: z.string().optional(),
})

const linkSatisfactionSchema = z.object({
  itemIds: z.array(z.string().uuid()),
  branchId: branchIdField,
})

const unlinkSatisfactionSchema = z.object({
  itemId: z.string().uuid(),
  branchId: branchIdField,
})

const linkVerificationSchema = z.object({
  testCaseIds: z.array(z.string().uuid()),
  branchId: branchIdField,
})

const allocateSchema = z.object({
  itemIds: z.array(z.string().uuid()),
  branchId: branchIdField,
})

const deallocateSchema = z.object({
  itemId: z.string().uuid(),
  branchId: branchIdField,
})

const allocatedItemSchema = z.object({
  id: z.string().uuid(),
  itemNumber: z.string(),
  name: z.string().nullable(),
  itemType: z.string(),
  revision: z.string(),
  state: z.string(),
  relationshipId: z.string().uuid(),
})

const app = new Hono()

// GET /api/requirements/:id
app.get(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['parts', 'read'] },
      async ({ params }) => {
        const { id } = params
        const requirement = await ItemService.findById(id)
        if (!requirement) throw new NotFoundError('Requirement', id)
        return { requirement }
      },
    ),
  ),
)

// PUT /api/requirements/:id
app.put(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['parts', 'update'] },
      async ({ params, request, user }) => {
        const data = await request.json()
        const { id } = params
        const requirement = await ItemService.update<Requirement>(
          id,
          data,
          user.id,
        )
        return { requirement }
      },
    ),
  ),
)

// DELETE /api/requirements/:id
app.delete(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['parts', 'delete'] },
      async ({ params, user }) => {
        const { id } = params
        await ItemService.delete(id, user.id)
        return { success: true }
      },
    ),
  ),
)

// GET /api/requirements/:id/derive
app.get(
  '/:id/derive',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params }) => {
      const { id } = params
      const childRequirements =
        await RequirementService.getChildRequirements(id)

      return { requirements: childRequirements }
    }),
  ),
)

// POST /api/requirements/:id/derive
app.post(
  '/:id/derive',
  adapt(
    apiHandler<{ id: string }>(
      {
        openapi: {
          summary: 'Derive a child requirement from a requirement',
          request: { body: { schema: deriveRequirementSchema } },
        },
      },
      async ({ params, request, user }) => {
        const body = await request.json()
        const { branchId, commitMessage, ...childData } =
          deriveRequirementSchema.parse(body)
        const { id } = params

        // This route creates an item, so it owes the same design check the
        // item routes do — reaching the parent's design is what entitles a
        // caller to add a requirement to it.
        const parent = await ItemService.findById(id)
        if (!parent || parent.itemType !== 'Requirement') {
          throw new NotFoundError('Requirement', id)
        }
        if (parent.designId) {
          await requireDesignAccess(user.id, parent.designId)
        }
        if (branchId) {
          await requireBranchAccess(user.id, branchId)
        }

        const derivedRequirement = await RequirementService.deriveRequirement(
          id,
          {
            ...childData,
            itemType: 'Requirement',
          },
          user.id,
          { branchId, commitMessage },
        )

        return created({ requirement: derivedRequirement })
      },
    ),
  ),
)

// GET /api/requirements/:id/parent
app.get(
  '/:id/parent',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params }) => {
      const { id } = params
      const parentRequirement =
        await RequirementService.getParentRequirement(id)

      return { parent: parentRequirement }
    }),
  ),
)

// GET /api/requirements/:id/satisfy
app.get(
  '/:id/satisfy',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params }) => {
      const { id } = params
      const satisfyingItems = await RequirementService.getSatisfyingItems(id)

      return { items: satisfyingItems }
    }),
  ),
)

// POST /api/requirements/:id/satisfy
app.post(
  '/:id/satisfy',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params, request, user }) => {
      const body = await request.json()
      const { itemIds, branchId } = linkSatisfactionSchema.parse(body)
      const { id } = params

      await RequirementService.linkSatisfaction(id, itemIds, user.id, {
        branchId,
      })

      return { success: true }
    }),
  ),
)

// DELETE /api/requirements/:id/satisfy
app.delete(
  '/:id/satisfy',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params, request, user }) => {
      const body = await request.json()
      const { itemId, branchId } = unlinkSatisfactionSchema.parse(body)
      const { id } = params

      await RequirementService.unlinkSatisfaction(id, itemId, user.id, {
        branchId,
      })

      return { success: true }
    }),
  ),
)

// GET /api/requirements/:id/allocate
app.get(
  '/:id/allocate',
  adapt(
    apiHandler<{ id: string }>(
      {
        openapi: {
          summary: 'List the items a requirement is allocated to',
          request: { params: z.object({ id: z.string().uuid() }) },
          responses: {
            200: { schema: z.object({ items: z.array(allocatedItemSchema) }) },
          },
        },
      },
      async ({ params }) => {
        const items = await RequirementService.getAllocatedItems(params.id)

        return { items }
      },
    ),
  ),
)

// POST /api/requirements/:id/allocate
app.post(
  '/:id/allocate',
  adapt(
    apiHandler<{ id: string }>(
      {
        openapi: {
          summary: 'Allocate a requirement to design items',
          description:
            'Creates ALLOCATED_TO links from the requirement to each item, ' +
            'closing the unallocated_requirement gap. Pass branchId to write ' +
            'them inside an ECO; without it the write lands on the rows named ' +
            'and is refused once the design has released items.',
          request: {
            params: z.object({ id: z.string().uuid() }),
            body: { schema: allocateSchema },
          },
          responses: {
            201: { schema: z.object({ success: z.boolean() }) },
          },
        },
      },
      async ({ params, request, user }) => {
        const body = await request.json()
        const { itemIds, branchId } = allocateSchema.parse(body)

        for (const itemId of itemIds) {
          await RequirementService.allocateToDesign(
            params.id,
            itemId,
            user.id,
            { branchId },
          )
        }

        return created({ success: true })
      },
    ),
  ),
)

// DELETE /api/requirements/:id/allocate
app.delete(
  '/:id/allocate',
  adapt(
    apiHandler<{ id: string }>(
      {
        openapi: {
          summary: 'Remove a requirement allocation',
          request: {
            params: z.object({ id: z.string().uuid() }),
            body: { schema: deallocateSchema },
          },
          responses: {
            200: { schema: z.object({ success: z.boolean() }) },
          },
        },
      },
      async ({ params, request, user }) => {
        const body = await request.json()
        const { itemId, branchId } = deallocateSchema.parse(body)

        await RequirementService.removeAllocation(params.id, itemId, user.id, {
          branchId,
        })

        return { success: true }
      },
    ),
  ),
)

// POST /api/requirements/:id/verify
app.post(
  '/:id/verify',
  adapt(
    apiHandler<{ id: string }>({}, async ({ request, params, user }) => {
      const body = await request.json()
      const { testCaseIds, branchId } = linkVerificationSchema.parse(body)

      const { id } = params
      await RequirementService.linkVerification(id, testCaseIds, user.id, {
        branchId,
      })

      return created({ success: true })
    }),
  ),
)

// DELETE /api/requirements/:id/verify
app.delete(
  '/:id/verify',
  adapt(
    apiHandler<{ id: string }>({}, async ({ request, params, user }) => {
      const url = new URL(request.url)
      const testCaseId = url.searchParams.get('testCaseId')

      if (!testCaseId) {
        throw new ValidationError('testCaseId query parameter is required')
      }

      const { id } = params
      await RequirementService.unlinkVerification(id, testCaseId, user.id, {
        branchId: url.searchParams.get('branchId') ?? undefined,
      })

      return { success: true }
    }),
  ),
)

// GET /api/requirements/:id/verifying-tests
app.get(
  '/:id/verifying-tests',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params }) => {
      const { id } = params
      const tests = await RequirementService.getVerifyingTests(id)

      return { tests }
    }),
  ),
)

export default app
