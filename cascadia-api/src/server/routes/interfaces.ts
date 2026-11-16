// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC
import { Hono } from 'hono'
import { tagged } from '../adapter'
import type { InterfaceItem } from '@cascadia/commons/items/types/interface'
import { ItemService } from '@/items/services/ItemService'
import { NotFoundError } from '@/errors'
import { requireItemAccess } from '@/auth/access'
import { apiHandler } from '@/api/handler'
import { itemReadEchoFields } from '@/api/item-read-echo'
import { interfaceUpdateSchema } from '@/api/schemas'

// Register item types (server-side version)
import '@/items/registerItemTypes.server'

const adapt = tagged('Interfaces')

const app = new Hono()

// An interface is architecture, so it is held against the resource of the
// elements it joins: every handler here charges `system_elements`.

// GET /api/interfaces/:id
app.get(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['system_elements', 'read'] },
      async ({ params, user }) => {
        await requireItemAccess(user.id, params.id)
        const iface = await ItemService.findById(params.id)
        if (!iface) throw new NotFoundError('Interface', params.id)
        return { interface: iface }
      },
    ),
  ),
)

// PUT /api/interfaces/:id
app.put(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['system_elements', 'update'],
        access: ({ params, user }) => requireItemAccess(user.id, params.id),
        body: interfaceUpdateSchema,
        ignoreKeys: () => itemReadEchoFields('Interface'),
      },
      async ({ params, body, user }) => {
        // The schema permits `null` where the column is nullable, which the
        // interface spells as an absent optional; the type handler reads null
        // as "clear the column".
        const iface = await ItemService.update<InterfaceItem>(
          params.id,
          body as Partial<InterfaceItem>,
          user.id,
        )
        return { interface: iface }
      },
    ),
  ),
)

// DELETE /api/interfaces/:id
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

export default app
