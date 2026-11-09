// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC
import { Hono } from 'hono'
import { z } from 'zod'
import { tagged } from '../adapter'
import type { SystemElement } from '@cascadia/commons/items/types/system-element'
import { ItemService } from '@/items/services/ItemService'
import { SystemElementService } from '@/services/SystemElementService'
import { NotFoundError } from '@/errors'
import {
  requireBranchAccess,
  requireItemAccess,
  requireItemsAccess,
} from '@/auth/access'
import { apiHandler, created } from '@/api/handler'
import { itemReadEchoFields } from '@/api/item-read-echo'
import { systemElementUpdateSchema } from '@/api/schemas'

// Register item types (server-side version)
import '@/items/registerItemTypes.server'

const adapt = tagged('System Elements')

/**
 * The branch an architecture write lands on — the same rule as the
 * requirement links: both ends resolve to the rows that branch is working
 * from, so a caller inside an ECO keeps naming items by the ids it holds.
 * Omitted, the write goes to the rows named, and is refused once the design
 * has released items.
 */
const branchIdField = z.string().uuid().optional()

const linkItemsSchema = z.object({
  itemIds: z.array(z.string().uuid()).min(1),
  branchId: branchIdField,
})
const unlinkItemSchema = z.object({
  itemId: z.string().uuid(),
  branchId: branchIdField,
})

const relatedElementSchema = z.object({
  id: z.string().uuid(),
  masterId: z.string().uuid(),
  itemNumber: z.string(),
  name: z.string().nullable(),
  revision: z.string(),
  state: z.string(),
  elementKind: z.string().nullable(),
  relationshipId: z.string().uuid(),
})
const linkedItemSchema = z.object({
  id: z.string().uuid(),
  itemNumber: z.string(),
  name: z.string().nullable(),
  itemType: z.string(),
  revision: z.string(),
  state: z.string(),
  relationshipId: z.string().uuid(),
  suspect: z.boolean(),
  suspectReasons: z.array(z.enum(['source_revised', 'target_revised'])),
})

const app = new Hono()

// GET /api/system-elements/:id
app.get(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['system_elements', 'read'] },
      async ({ params, user }) => {
        await requireItemAccess(user.id, params.id)
        const systemElement = await ItemService.findById(params.id)
        if (!systemElement) throw new NotFoundError('SystemElement', params.id)
        return { systemElement }
      },
    ),
  ),
)

// PUT /api/system-elements/:id
app.put(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['system_elements', 'update'],
        access: ({ params, user }) => requireItemAccess(user.id, params.id),
        body: systemElementUpdateSchema,
        ignoreKeys: () => itemReadEchoFields('SystemElement'),
      },
      async ({ params, body, user }) => {
        // The schema permits `null` where the column is nullable, which the
        // interface spells as an absent optional; the type handler reads null
        // as "clear the column".
        const systemElement = await ItemService.update<SystemElement>(
          params.id,
          body as Partial<SystemElement>,
          user.id,
        )
        return { systemElement }
      },
    ),
  ),
)

// DELETE /api/system-elements/:id
app.delete(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['system_elements', 'delete'] },
      async ({ params, user }) => {
        await requireItemAccess(user.id, params.id)
        await ItemService.delete(params.id, user.id)
        return { success: true }
      },
    ),
  ),
)

// ---- The tree: DECOMPOSES ----------------------------------------------

// GET /api/system-elements/:id/children
app.get(
  '/:id/children',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['system_elements', 'read'],
        openapi: {
          summary: 'List the elements a system element decomposes into',
          request: { params: z.object({ id: z.string().uuid() }) },
          responses: {
            200: { schema: z.object({ items: z.array(relatedElementSchema) }) },
          },
        },
      },
      async ({ params, user }) => {
        await requireItemAccess(user.id, params.id)
        return { items: await SystemElementService.getChildren(params.id) }
      },
    ),
  ),
)

// POST /api/system-elements/:id/children
app.post(
  '/:id/children',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof linkItemsSchema>>(
      {
        // Reshaping the architecture is an edit of the element the edges hang
        // off, so it charges the element's own resource with `update`.
        permission: ['system_elements', 'update'],
        body: linkItemsSchema,
        openapi: {
          summary: 'Place system elements under this one',
          description:
            'Creates DECOMPOSES links from this element to each child. Both ' +
            'ends must be system elements of one design, and a link that ' +
            'would close a loop is refused. Pass branchId to write inside an ' +
            'ECO; without it the write lands on the rows named and is refused ' +
            'once the design has released items.',
          request: { params: z.object({ id: z.string().uuid() }) },
          responses: {
            201: { schema: z.object({ success: z.boolean() }) },
          },
        },
      },
      async ({ body: { itemIds, branchId }, params, user }) => {
        await requireItemAccess(user.id, params.id)
        await requireItemsAccess(user.id, itemIds)
        if (branchId) await requireBranchAccess(user.id, branchId)
        await SystemElementService.addChildren(params.id, itemIds, user.id, {
          branchId,
        })
        return created({ success: true })
      },
    ),
  ),
)

// DELETE /api/system-elements/:id/children
app.delete(
  '/:id/children',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof unlinkItemSchema>>(
      {
        permission: ['system_elements', 'update'],
        body: unlinkItemSchema,
        openapi: {
          summary: 'Remove a system element from under this one',
          request: { params: z.object({ id: z.string().uuid() }) },
          responses: {
            200: { schema: z.object({ success: z.boolean() }) },
          },
        },
      },
      async ({ body: { itemId, branchId }, params, user }) => {
        await requireItemAccess(user.id, params.id)
        await requireItemsAccess(user.id, [itemId])
        if (branchId) await requireBranchAccess(user.id, branchId)
        await SystemElementService.removeChild(params.id, itemId, user.id, {
          branchId,
        })
        return { success: true }
      },
    ),
  ),
)

// GET /api/system-elements/:id/parent
app.get(
  '/:id/parent',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['system_elements', 'read'],
        openapi: {
          summary: 'The system element this one sits under, if any',
          request: { params: z.object({ id: z.string().uuid() }) },
          responses: {
            200: {
              schema: z.object({ item: relatedElementSchema.nullable() }),
            },
          },
        },
      },
      async ({ params, user }) => {
        await requireItemAccess(user.id, params.id)
        return { item: await SystemElementService.getParent(params.id) }
      },
    ),
  ),
)

// ---- The hop to the physical item: REALIZED_BY --------------------------

// GET /api/system-elements/:id/realized-by
app.get(
  '/:id/realized-by',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['system_elements', 'read'],
        openapi: {
          summary: 'List the items that realize a system element',
          request: { params: z.object({ id: z.string().uuid() }) },
          responses: {
            200: { schema: z.object({ items: z.array(linkedItemSchema) }) },
          },
        },
      },
      async ({ params, user }) => {
        await requireItemAccess(user.id, params.id)
        return { items: await SystemElementService.getRealizedBy(params.id) }
      },
    ),
  ),
)

// POST /api/system-elements/:id/realized-by
app.post(
  '/:id/realized-by',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof linkItemsSchema>>(
      {
        permission: ['system_elements', 'update'],
        body: linkItemsSchema,
        openapi: {
          summary: 'Record the items that realize a system element',
          description:
            'Creates REALIZED_BY links from the element to each item — a ' +
            'part or software item. The link is a trace claim: it reads ' +
            'suspect once either end revises until it is affirmed again. ' +
            'Pass branchId to write inside an ECO.',
          request: { params: z.object({ id: z.string().uuid() }) },
          responses: {
            201: { schema: z.object({ success: z.boolean() }) },
          },
        },
      },
      async ({ body: { itemIds, branchId }, params, user }) => {
        await requireItemAccess(user.id, params.id)
        await requireItemsAccess(user.id, itemIds)
        if (branchId) await requireBranchAccess(user.id, branchId)
        await SystemElementService.realize(params.id, itemIds, user.id, {
          branchId,
        })
        return created({ success: true })
      },
    ),
  ),
)

// DELETE /api/system-elements/:id/realized-by
app.delete(
  '/:id/realized-by',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof unlinkItemSchema>>(
      {
        permission: ['system_elements', 'update'],
        body: unlinkItemSchema,
        openapi: {
          summary: 'Remove a realization of a system element',
          request: { params: z.object({ id: z.string().uuid() }) },
          responses: {
            200: { schema: z.object({ success: z.boolean() }) },
          },
        },
      },
      async ({ body: { itemId, branchId }, params, user }) => {
        await requireItemAccess(user.id, params.id)
        await requireItemsAccess(user.id, [itemId])
        if (branchId) await requireBranchAccess(user.id, branchId)
        await SystemElementService.unrealize(params.id, itemId, user.id, {
          branchId,
        })
        return { success: true }
      },
    ),
  ),
)

// GET /api/system-elements/:id/allocated-requirements
app.get(
  '/:id/allocated-requirements',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['system_elements', 'read'],
        openapi: {
          summary: 'List the requirements allocated to a system element',
          description:
            'The incoming ALLOCATED_TO links, inherited from the rows this ' +
            'element succeeded. Allocation is written from the requirement ' +
            '(POST /requirements/{id}/allocate).',
          request: { params: z.object({ id: z.string().uuid() }) },
          responses: {
            200: { schema: z.object({ items: z.array(linkedItemSchema) }) },
          },
        },
      },
      async ({ params, user }) => {
        await requireItemAccess(user.id, params.id)
        return {
          items: await SystemElementService.getAllocatedRequirements(params.id),
        }
      },
    ),
  ),
)

export default app
