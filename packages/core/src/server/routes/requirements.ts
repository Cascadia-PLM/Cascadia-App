// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { z } from 'zod'
import { tagged } from '../adapter'
import type { Requirement } from '@/lib/items/types/requirement'
import { ItemService } from '@/lib/items/services/ItemService'
import { RequirementService } from '@/lib/services/RequirementService'
import { NotFoundError, ValidationError } from '@/lib/errors'
import {
  requireBranchAccess,
  requireDesignAccess,
  requireItemAccess,
  requireItemsAccess,
} from '@/lib/auth/access'
import { apiHandler, created } from '@/lib/api/handler'
import { requirementUpdateSchema } from '@/lib/api/schemas'
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
      { permission: ['requirements', 'read'] },
      async ({ params, user }) => {
        await requireItemAccess(user.id, params.id)
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
      {
        permission: ['requirements', 'update'],
        access: ({ params, user }) => requireItemAccess(user.id, params.id),
        body: requirementUpdateSchema,
      },
      async ({ params, body, user }) => {
        // The schema permits `null` where the column is nullable, which the
        // Requirement interface spells as an absent optional; the service and
        // the type handler both read null as "clear the column".
        const requirement = await ItemService.update<Requirement>(
          params.id,
          body as Partial<Requirement>,
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
      { permission: ['requirements', 'delete'] },
      async ({ params, user }) => {
        await requireItemAccess(user.id, params.id)
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
    apiHandler<{ id: string }>(
      { permission: ['requirements', 'read'] },
      async ({ params, user }) => {
        await requireItemAccess(user.id, params.id)
        const { id } = params
        const childRequirements =
          await RequirementService.getChildRequirements(id)

        return { requirements: childRequirements }
      },
    ),
  ),
)

// POST /api/requirements/:id/derive
app.post(
  '/:id/derive',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof deriveRequirementSchema>>(
      {
        // Deriving a child is an item *create*, so it owes the same RBAC verb
        // the generic item-create route charges for a Requirement. Left off,
        // this handler was auth-only: role permissions were skipped entirely
        // and an API key's scope narrowing had nothing to intersect against.
        permission: ['requirements', 'create'],
        body: deriveRequirementSchema,
        openapi: {
          summary: 'Derive a child requirement from a requirement',
        },
      },
      async ({
        body: { branchId, commitMessage, ...childData },
        params,
        user,
      }) => {
        const { id } = params

        // This route creates an item, so it owes the same design check the
        // item routes do — reaching the parent's design is what entitles a
        // caller to add a requirement to it. apiHandler validates the body
        // after auth and permission but before the handler, so a caller who
        // cannot reach the parent is still refused rather than told what a
        // well-formed derive request would have looked like.
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
    apiHandler<{ id: string }>(
      { permission: ['requirements', 'read'] },
      async ({ params, user }) => {
        await requireItemAccess(user.id, params.id)
        const { id } = params
        const parentRequirement =
          await RequirementService.getParentRequirement(id)

        return { parent: parentRequirement }
      },
    ),
  ),
)

// GET /api/requirements/:id/satisfy
app.get(
  '/:id/satisfy',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['requirements', 'read'] },
      async ({ params, user }) => {
        await requireItemAccess(user.id, params.id)
        const { id } = params
        const satisfyingItems = await RequirementService.getSatisfyingItems(id)

        return { items: satisfyingItems }
      },
    ),
  ),
)

// POST /api/requirements/:id/satisfy
app.post(
  '/:id/satisfy',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof linkSatisfactionSchema>>(
      {
        // Rewiring the traceability graph is an edit of the requirement the
        // links hang off, so it charges the requirement's own resource with
        // `update` — the treatment relationship edge writes already get. Left
        // off, these handlers were auth-only: role RBAC was skipped wholesale
        // and an API key's scope narrowing had nothing to intersect against,
        // so a View Only program member could link and unlink at will.
        permission: ['requirements', 'update'],
        access: ({ params, user }) => requireItemAccess(user.id, params.id),
        body: linkSatisfactionSchema,
      },
      async ({ params, body: { itemIds, branchId }, user }) => {
        const { id } = params

        // The far end of every link, which `access:` cannot reach — it runs
        // before the body is read.
        await requireItemsAccess(user.id, itemIds)
        if (branchId) await requireBranchAccess(user.id, branchId)

        await RequirementService.linkSatisfaction(id, itemIds, user.id, {
          branchId,
        })

        return { success: true }
      },
    ),
  ),
)

// DELETE /api/requirements/:id/satisfy
app.delete(
  '/:id/satisfy',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof unlinkSatisfactionSchema>>(
      {
        // `update`, not `delete`: removing a link edits the requirement, it
        // does not delete one. Charging `requirements:delete` would hand
        // requirement-deletion power to everyone who needs to unlink, and
        // would lock out the stock Approver role, which holds update but not
        // delete — while the same panel does both halves of the pair.
        permission: ['requirements', 'update'],
        access: ({ params, user }) => requireItemAccess(user.id, params.id),
        body: unlinkSatisfactionSchema,
      },
      async ({ params, body: { itemId, branchId }, user }) => {
        const { id } = params

        await requireItemsAccess(user.id, [itemId])
        if (branchId) await requireBranchAccess(user.id, branchId)

        await RequirementService.unlinkSatisfaction(id, itemId, user.id, {
          branchId,
        })

        return { success: true }
      },
    ),
  ),
)

// GET /api/requirements/:id/allocate
app.get(
  '/:id/allocate',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['requirements', 'read'],
        openapi: {
          summary: 'List the items a requirement is allocated to',
          request: { params: z.object({ id: z.string().uuid() }) },
          responses: {
            200: { schema: z.object({ items: z.array(allocatedItemSchema) }) },
          },
        },
      },
      async ({ params, user }) => {
        await requireItemAccess(user.id, params.id)
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
    apiHandler<{ id: string }, z.infer<typeof allocateSchema>>(
      {
        permission: ['requirements', 'update'],
        body: allocateSchema,
        openapi: {
          summary: 'Allocate a requirement to design items',
          description:
            'Creates ALLOCATED_TO links from the requirement to each item, ' +
            'closing the unallocated_requirement gap. Pass branchId to write ' +
            'them inside an ECO; without it the write lands on the rows named ' +
            'and is refused once the design has released items.',
          request: {
            params: z.object({ id: z.string().uuid() }),
          },
          responses: {
            201: { schema: z.object({ success: z.boolean() }) },
          },
        },
      },
      async ({ body: { itemIds, branchId }, params, user }) => {
        await requireItemAccess(user.id, params.id)
        await requireItemsAccess(user.id, itemIds)
        if (branchId) await requireBranchAccess(user.id, branchId)

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
    apiHandler<{ id: string }, z.infer<typeof deallocateSchema>>(
      {
        permission: ['requirements', 'update'],
        body: deallocateSchema,
        openapi: {
          summary: 'Remove a requirement allocation',
          request: {
            params: z.object({ id: z.string().uuid() }),
          },
          responses: {
            200: { schema: z.object({ success: z.boolean() }) },
          },
        },
      },
      async ({ body: { itemId, branchId }, params, user }) => {
        await requireItemAccess(user.id, params.id)
        await requireItemsAccess(user.id, [itemId])
        if (branchId) await requireBranchAccess(user.id, branchId)

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
    apiHandler<{ id: string }, z.infer<typeof linkVerificationSchema>>(
      {
        permission: ['requirements', 'update'],
        access: ({ params, user }) => requireItemAccess(user.id, params.id),
        body: linkVerificationSchema,
      },
      async ({ params, body: { testCaseIds, branchId }, user }) => {
        const { id } = params
        await requireItemsAccess(user.id, testCaseIds)
        if (branchId) await requireBranchAccess(user.id, branchId)

        await RequirementService.linkVerification(id, testCaseIds, user.id, {
          branchId,
        })

        return created({ success: true })
      },
    ),
  ),
)

// DELETE /api/requirements/:id/verify
app.delete(
  '/:id/verify',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['requirements', 'update'] },
      async ({ request, params, user }) => {
        await requireItemAccess(user.id, params.id)
        const url = new URL(request.url)
        const testCaseId = url.searchParams.get('testCaseId')

        if (!testCaseId) {
          throw new ValidationError('testCaseId query parameter is required')
        }

        const { id } = params
        const branchId = url.searchParams.get('branchId') ?? undefined
        await requireItemsAccess(user.id, [testCaseId])
        if (branchId) await requireBranchAccess(user.id, branchId)

        await RequirementService.unlinkVerification(id, testCaseId, user.id, {
          branchId,
        })

        return { success: true }
      },
    ),
  ),
)

// GET /api/requirements/:id/verifying-tests
app.get(
  '/:id/verifying-tests',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['requirements', 'read'] },
      async ({ params, user }) => {
        await requireItemAccess(user.id, params.id)
        const { id } = params
        const tests = await RequirementService.getVerifyingTests(id)

        return { tests }
      },
    ),
  ),
)

export default app
