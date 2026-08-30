// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { tagged } from '../../adapter'
import type { ResourceType } from '@/lib/auth/permissions'
import type { BaseItem } from '@/lib/items/types/base'
import { requirePermission } from '@/lib/auth/server'
import { ValidationError } from '@/lib/errors'
import {
  getResourceType,
  itemTypeToResource,
} from '@/lib/items/item-type-resources'
import { ItemService } from '@/lib/items/services/ItemService'
import { apiHandler, jsonResponse } from '@/lib/api/handler'
import { requireBranchAccess, requireDesignAccess } from '@/lib/auth/access'
import { batchCreateRequestSchema } from '@/lib/api'
import {
  batchDeleteRequestSchema,
  batchUpdateRequestSchema,
} from '@/lib/api/schemas'

const adapt = tagged('Items')

const app = new Hono()

interface BatchCreateResponse {
  created: Array<BaseItem>
  errors: Array<{
    itemNumber: string
    error: string
    details?: string
  }>
}

interface BatchDeleteResult {
  deleted: Array<{
    id: string
    masterId: string
  }>
  errors: Array<{
    id: string
    error: string
    details?: string
  }>
}

interface BatchUpdateResult {
  updated: Array<BaseItem>
  errors: Array<{
    id: string
    error: string
    details?: string
  }>
}

// POST /api/items/batch-create
app.post(
  '/batch-create',
  adapt(
    apiHandler(
      { body: batchCreateRequestSchema },
      async ({ request, user, body }) => {
        const userId = user.id

        const { items: requestItems, bypassBranchProtection } = body

        if (requestItems.length > 100) {
          throw new ValidationError('Batch size limited to 100 items')
        }

        // Gate every distinct item type up front, before any row is written —
        // a mixed batch must not half-apply and then 403.
        const requiredResources = new Set(
          requestItems.map((i) => getResourceType(i.itemType)),
        )
        for (const resource of requiredResources) {
          await requirePermission(request, resource, 'create')
        }

        // Writing directly to a protected branch is an admin override, not a
        // caller-supplied option.
        if (bypassBranchProtection) {
          await requirePermission(request, 'system', 'manage')
        }

        // A change order is defined by the designs it touches and this route
        // has no way to take them, so one created here would be linked to
        // nothing — outside every program and therefore visible to everyone.
        // `POST /api/v1/items` refuses it for that reason; this was the last
        // live path to the same link-less ECO.
        if (requestItems.some((i) => i.itemType === 'ChangeOrder')) {
          throw new ValidationError(
            'Create change orders via POST /api/v1/change-orders, which takes the designs they affect',
          )
        }

        // The type verb above is instance-blind: it answers "may this caller
        // create parts", never "here". Program membership is what answers
        // that, and this route had no such check on either write path — a
        // caller holding the type verb could write into any program's design
        // or branch by knowing an id. Same pre-flight shape as the RBAC loop
        // and for the same reason: a mixed batch must fail whole.
        //
        // `data` is `z.record(z.string(), z.unknown())`, so nothing narrows
        // for free — read both ids defensively, or a branchId that arrived as
        // a number slips past the gate into `createOnBranch`.
        //
        // `branchId` wins over `designId` on a row that carries both, because
        // `createOnBranch` takes the design from the branch and ignores what
        // the body says — checking the id it will actually use is the only
        // check worth making.
        //
        // A row carrying neither is admitted, exactly as `POST /api/v1/items`
        // admits one at its `if (itemData.designId)`. With ChangeOrder gone
        // above, none of the types left here legitimately lacks a design, so
        // such a row is the open design-less-item-type question rather than
        // this route's to settle.
        const branchIds = new Set<string>()
        const designIds = new Set<string>()
        for (const { data } of requestItems) {
          const { branchId, designId } = data as {
            branchId?: unknown
            designId?: unknown
          }
          if (typeof branchId === 'string') {
            branchIds.add(branchId)
          } else if (typeof designId === 'string') {
            designIds.add(designId)
          }
        }
        for (const branchId of branchIds) {
          await requireBranchAccess(userId, branchId)
        }
        for (const designId of designIds) {
          await requireDesignAccess(userId, designId)
        }

        const createdItems: Array<BaseItem> = []
        const errors: Array<{
          itemNumber: string
          error: string
          details?: string
        }> = []

        for (const itemRequest of requestItems) {
          try {
            const { itemType, data } = itemRequest

            // Create the item using ItemService
            // Use createOnBranch if branchId is provided (for ECO/workspace branches)
            let createdItem: BaseItem
            const itemData = data as unknown as BaseItem & {
              branchId?: string
              commitMessage?: string
            }

            if (itemData.branchId) {
              const result = await ItemService.createOnBranch(
                itemType,
                itemData,
                itemData.branchId,
                itemData.commitMessage || `Created ${itemType}`,
                userId,
              )
              createdItem = result.item
            } else {
              createdItem = await ItemService.create(
                itemType,
                itemData,
                userId,
                {
                  bypassBranchProtection,
                },
              )
            }
            createdItems.push(createdItem)
          } catch (error) {
            const itemData = itemRequest.data as { itemNumber?: string }
            errors.push({
              itemNumber: itemData.itemNumber || 'unknown',
              error: 'Failed to create item',
              details: (error as Error).message,
            })
          }
        }

        const response: BatchCreateResponse = {
          created: createdItems,
          errors,
        }

        let status = 201
        if (errors.length > 0 && createdItems.length > 0) {
          status = 207
        } else if (errors.length > 0 && createdItems.length === 0) {
          status = 400
        }

        return jsonResponse(response, status)
      },
    ),
  ),
)

// POST /api/items/batch-delete
app.post(
  '/batch-delete',
  adapt(
    apiHandler(
      { body: batchDeleteRequestSchema },
      async ({ request, user, body }) => {
        const userId = user.id
        const { itemIds, branchId, commitMessage } = body

        // Limit batch size to prevent abuse
        if (itemIds.length > 100) {
          throw new ValidationError('Batch size limited to 100 items')
        }

        // Verify branch exists and user has access
        await requireBranchAccess(user.id, branchId)

        // Resolve items first so type permissions are checked before any
        // deletion — a mixed batch must not half-apply and then 403.
        const resolvedItems = new Map<
          string,
          Awaited<ReturnType<typeof ItemService.findById>>
        >()
        const requiredResources = new Set<ResourceType>()
        for (const itemId of itemIds) {
          const item = await ItemService.findById(itemId)
          resolvedItems.set(itemId, item)
          if (item) {
            const resource = itemTypeToResource(item.itemType)
            if (resource) requiredResources.add(resource)
          }
        }
        for (const resource of requiredResources) {
          await requirePermission(request, resource, 'delete')
        }

        const deleted: Array<{ id: string; masterId: string }> = []
        const errors: Array<{ id: string; error: string; details?: string }> =
          []

        // Process each item
        for (const itemId of itemIds) {
          try {
            const item = resolvedItems.get(itemId) ?? null
            if (!item) {
              errors.push({
                id: itemId,
                error: 'Item not found',
              })
              continue
            }

            if (!item.masterId) {
              errors.push({
                id: itemId,
                error: 'Item has no masterId',
              })
              continue
            }

            // Delete the item on the branch
            await ItemService.deleteOnBranch(
              item.masterId,
              branchId,
              commitMessage || `Batch delete: ${item.itemNumber}`,
              userId,
            )

            deleted.push({
              id: itemId,
              masterId: item.masterId,
            })
          } catch (error) {
            errors.push({
              id: itemId,
              error: 'Failed to delete item',
              details: (error as Error).message,
            })
          }
        }

        const result: BatchDeleteResult = {
          deleted,
          errors,
        }

        // Return 207 Multi-Status if there are both successes and errors
        // Return 200 OK if all succeeded
        // Return 400 Bad Request if all failed
        let status = 200
        if (errors.length > 0 && deleted.length > 0) {
          status = 207 // Multi-Status
        } else if (errors.length > 0 && deleted.length === 0) {
          status = 400
        }

        return jsonResponse(result, status)
      },
    ),
  ),
)

// POST /api/items/batch-update
app.post(
  '/batch-update',
  adapt(
    apiHandler(
      { body: batchUpdateRequestSchema },
      async ({ request, user, body }) => {
        const userId = user.id
        const { items: requestItems, commitMessage } = body

        if (requestItems.length > 100) {
          throw new ValidationError('Batch size limited to 100 items')
        }

        // Resolve item types first so permissions are checked before any
        // update — a mixed batch must not half-apply and then 403.
        const requiredResources = new Set<ResourceType>()
        for (const itemRequest of requestItems) {
          const item = await ItemService.findById(itemRequest.id)
          if (item) {
            const resource = itemTypeToResource(item.itemType)
            if (resource) requiredResources.add(resource)
          }
        }
        for (const resource of requiredResources) {
          await requirePermission(request, resource, 'update')
        }

        const updated: Array<BaseItem> = []
        const errors: Array<{ id: string; error: string; details?: string }> =
          []

        for (const itemRequest of requestItems) {
          try {
            const { id, data } = itemRequest

            // Build update data - spread item data and add commit message if provided
            const updateData: Record<string, unknown> = { ...data }
            if (commitMessage) {
              updateData.commitMessage = commitMessage
            }

            // Update the item using ItemService
            const updatedItem = await ItemService.update(id, updateData, userId)
            updated.push(updatedItem)
          } catch (error) {
            errors.push({
              id: itemRequest.id,
              error: 'Failed to update item',
              details: (error as Error).message,
            })
          }
        }

        const result: BatchUpdateResult = {
          updated,
          errors,
        }

        // Return 207 Multi-Status if there are both successes and errors
        // Return 200 OK if all succeeded
        // Return 400 Bad Request if all failed
        let status = 200
        if (errors.length > 0 && updated.length > 0) {
          status = 207 // Multi-Status
        } else if (errors.length > 0 && updated.length === 0) {
          status = 400
        }

        return jsonResponse(result, status)
      },
    ),
  ),
)

export default app
