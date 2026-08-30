// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { z } from 'zod'
import { tagged } from '../../adapter'
import type { items } from '@/lib/db/schema'
import { NotFoundError, ValidationError } from '@/lib/errors'
import { ItemService } from '@/lib/items/services/ItemService'
import { isBranchProtectionExempt } from '@/lib/items/branch-protection'
import { BranchService } from '@/lib/services/BranchService'
import { CheckoutService } from '@/lib/services/CheckoutService'
import { apiHandler, created, jsonResponse } from '@/lib/api/handler'
import { requireBranchAccess, requireItemAccess } from '@/lib/auth/access'
import {
  batchCheckinRequestSchema,
  batchCheckoutRequestSchema,
} from '@/lib/api/schemas'

const adapt = tagged('Items')

const app = new Hono()

/** Body of the single-item checkout lifecycle routes. */
const checkoutBranchBodySchema = z.object({
  branchId: z.string().uuid(),
})

interface BatchCheckinResult {
  checkedIn: Array<{
    itemId: string
    masterId: string
  }>
  errors: Array<{
    itemId: string
    error: string
    details?: string
  }>
}

interface BatchCheckoutResult {
  checkedOut: Array<{
    itemId: string
    masterId: string
    branchItemId: string
  }>
  errors: Array<{
    itemId: string
    error: string
    details?: string
  }>
}

// POST /api/items/batch-checkin
app.post(
  '/batch-checkin',
  adapt(
    apiHandler({ body: batchCheckinRequestSchema }, async ({ body, user }) => {
      const { itemIds, branchId } = body

      // Limit batch size to prevent abuse
      if (itemIds.length > 100) {
        throw new ValidationError('Batch size limited to 100 items')
      }

      // Verify branch exists and user has access
      await requireBranchAccess(user.id, branchId)

      const checkedIn: Array<{ itemId: string; masterId: string }> = []
      const errors: Array<{
        itemId: string
        error: string
        details?: string
      }> = []

      // Process each item
      for (const itemId of itemIds) {
        try {
          // Get the item to retrieve masterId
          const item = await ItemService.findById(itemId)
          if (!item) {
            errors.push({
              itemId,
              error: 'Item not found',
            })
            continue
          }

          if (!item.masterId) {
            errors.push({
              itemId,
              error: 'Item has no masterId',
            })
            continue
          }

          // Check in the item (release checkout but keep changes)
          await CheckoutService.checkin(item.masterId, branchId, user.id)

          checkedIn.push({
            itemId,
            masterId: item.masterId,
          })
        } catch (error) {
          errors.push({
            itemId,
            error: 'Failed to checkin item',
            details: (error as Error).message,
          })
        }
      }

      const result: BatchCheckinResult = {
        checkedIn,
        errors,
      }

      // Return 207 Multi-Status if there are both successes and errors
      // Return 200 OK if all succeeded
      // Return 400 Bad Request if all failed
      let status = 200
      if (errors.length > 0 && checkedIn.length > 0) {
        status = 207 // Multi-Status
      } else if (errors.length > 0 && checkedIn.length === 0) {
        status = 400
      }

      return jsonResponse(result, status)
    }),
  ),
)

// POST /api/items/batch-checkout
app.post(
  '/batch-checkout',
  adapt(
    apiHandler({ body: batchCheckoutRequestSchema }, async ({ body, user }) => {
      const { itemIds, branchId } = body

      // Limit batch size to prevent abuse
      if (itemIds.length > 100) {
        throw new ValidationError('Batch size limited to 100 items')
      }

      // Verify branch exists and user has access
      await requireBranchAccess(user.id, branchId)

      const checkedOut: Array<{
        itemId: string
        masterId: string
        branchItemId: string
      }> = []
      const errors: Array<{
        itemId: string
        error: string
        details?: string
      }> = []

      // Process each item
      for (const itemId of itemIds) {
        try {
          // Get the item to retrieve masterId
          const item = await ItemService.findById(itemId)
          if (!item) {
            errors.push({
              itemId,
              error: 'Item not found',
            })
            continue
          }

          if (!item.masterId) {
            errors.push({
              itemId,
              error: 'Item has no masterId',
            })
            continue
          }

          // Released items get a branch working copy up front, same as the
          // single-item checkout route — edits must never target the shared
          // released row, and the copy lands in the change order's reviewed
          // scope (or is refused once that scope is locked).
          await CheckoutService.ensureRevisionWorkingCopy(
            item as unknown as typeof items.$inferSelect,
            branchId,
            user.id,
          )

          // Checkout the item
          const branchItem = await CheckoutService.checkout(
            { itemMasterId: item.masterId, branchId },
            user.id,
          )

          checkedOut.push({
            itemId,
            masterId: item.masterId,
            branchItemId: branchItem.id,
          })
        } catch (error) {
          errors.push({
            itemId,
            error: 'Failed to checkout item',
            details: (error as Error).message,
          })
        }
      }

      const result: BatchCheckoutResult = {
        checkedOut,
        errors,
      }

      // Return 207 Multi-Status if there are both successes and errors
      // Return 201 Created if all succeeded
      // Return 400 Bad Request if all failed
      let status = 201
      if (errors.length > 0 && checkedOut.length > 0) {
        status = 207 // Multi-Status
      } else if (errors.length > 0 && checkedOut.length === 0) {
        status = 400
      }

      return jsonResponse(result, status)
    }),
  ),
)

// POST /api/items/:id/cancel-checkout
app.post(
  '/:id/cancel-checkout',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof checkoutBranchBodySchema>>(
      { body: checkoutBranchBodySchema },
      async ({ params, user, body }) => {
        // The body schema rejects first, but that 400 is decided by the body
        // alone — identical for any caller and any item id, so it discloses
        // nothing. With a valid body, whether the item in the path is
        // reachable is still the first per-item answer: without that, these
        // routes told an outsider what to send next.
        await requireItemAccess(user.id, params.id)

        const { branchId } = body

        // Get the item to get its masterId
        const item = await ItemService.findById(params.id)
        if (!item) {
          throw new NotFoundError('Item', params.id)
        }

        // Check access to branch/design
        await requireBranchAccess(user.id, branchId)

        await CheckoutService.cancelCheckout(item.masterId, branchId, user.id)

        return { success: true }
      },
    ),
  ),
)

// POST /api/items/:id/checkin
app.post(
  '/:id/checkin',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof checkoutBranchBodySchema>>(
      { body: checkoutBranchBodySchema },
      async ({ params, user, body }) => {
        // The body schema rejects first, but that 400 is decided by the body
        // alone — identical for any caller and any item id, so it discloses
        // nothing. With a valid body, whether the item in the path is
        // reachable is still the first per-item answer: without that, these
        // routes told an outsider what to send next.
        await requireItemAccess(user.id, params.id)

        const { branchId } = body

        // Get the item to get its masterId
        const item = await ItemService.findById(params.id)
        if (!item) {
          throw new NotFoundError('Item', params.id)
        }

        // Check access to branch/design
        await requireBranchAccess(user.id, branchId)

        await CheckoutService.checkin(item.masterId, branchId, user.id)

        return { success: true }
      },
    ),
  ),
)

// GET /api/items/:id/checkout
app.get(
  '/:id/checkout',
  adapt(
    apiHandler<{ id: string }>({}, async ({ request, params, user }) => {
      // The item in the path is reachable or it is not, whatever branch the
      // caller names — so that answer comes first. Without it these four
      // routes refused an outsider with a 400 about a missing branchId, which
      // both leaks that the item exists and tells them what to send next.
      await requireItemAccess(user.id, params.id)

      const url = new URL(request.url)
      const branchId = url.searchParams.get('branchId')

      if (!branchId) {
        throw new ValidationError('branchId query parameter is required')
      }

      // Get the item to get its masterId
      const item = await ItemService.findById(params.id)
      if (!item) {
        throw new NotFoundError('Item', params.id)
      }

      // Check access to branch/design
      await requireBranchAccess(user.id, branchId)

      const status = await CheckoutService.getCheckoutStatus(
        item.masterId,
        branchId,
      )

      return { status }
    }),
  ),
)

// POST /api/items/:id/checkout
app.post(
  '/:id/checkout',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof checkoutBranchBodySchema>>(
      { body: checkoutBranchBodySchema },
      async ({ params, user, body }) => {
        // The body schema rejects first, but that 400 is decided by the body
        // alone — identical for any caller and any item id, so it discloses
        // nothing. With a valid body, whether the item in the path is
        // reachable is still the first per-item answer: without that, these
        // routes told an outsider what to send next.
        await requireItemAccess(user.id, params.id)

        const { branchId } = body

        // Get the item to get its masterId
        const item = await ItemService.findById(params.id)
        if (!item) {
          throw new NotFoundError('Item', params.id)
        }

        // Check access to branch/design
        await requireBranchAccess(user.id, branchId)

        // Checking out a Released item to a branch creates the working copy
        // up front, so every subsequent content edit (fields, relationships,
        // work-instruction steps) targets the branch-local copy — never the
        // shared released row. The service also registers the copy on the
        // owning change order and refuses new scope once the change order
        // leaves Draft: this call pre-empts the checkout path that would
        // otherwise do both, so it must not do less.
        await CheckoutService.ensureRevisionWorkingCopy(
          item as unknown as typeof items.$inferSelect,
          branchId,
          user.id,
        )

        const branchItem = await CheckoutService.checkout(
          { itemMasterId: item.masterId, branchId },
          user.id,
        )

        return created({ branchItem })
      },
    ),
  ),
)

// GET /api/items/:id/edit-context
// Where does the edit lock for this item version live? Returns the branch
// carrying the lock (the working-copy branch, or unprotected main), current
// lock holder, and protection state — everything a detail page needs to
// drive its Edit button.
app.get(
  '/:id/edit-context',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params, user }) => {
      await requireItemAccess(user.id, params.id)
      const item = await ItemService.findById(params.id)
      if (!item) {
        throw new NotFoundError('Item', params.id)
      }

      const branchInfo = await ItemService.getItemBranchInfo(params.id)
      let lockBranchId: string | null = branchInfo?.branchId ?? null
      let branchType: string | null = branchInfo?.branchType ?? null
      let isMainProtected = false

      if (!branchInfo && item.designId) {
        // Exempt types (work instructions) take the lock on main regardless of
        // protection — they are editable there by design, so reporting main as
        // protected would push the client into a revise-through-an-ECO dialog
        // for an item that needs no ECO.
        isMainProtected = (await isBranchProtectionExempt(item.itemType))
          ? false
          : await BranchService.isMainBranchProtected(item.designId)
        if (!isMainProtected) {
          const mainBranch = await BranchService.getMainBranch(item.designId)
          lockBranchId = mainBranch?.id ?? null
          branchType = lockBranchId ? 'main' : null
        }
      }

      let checkedOutBy: {
        id: string
        name: string | null
        email: string
      } | null = null
      if (lockBranchId) {
        const status = await CheckoutService.getCheckoutStatus(
          item.masterId,
          lockBranchId,
        )
        checkedOutBy = status.checkedOutBy ?? null
      }

      return {
        editContext: {
          lockBranchId,
          branchType,
          isBranchLocked: branchInfo?.isLocked ?? false,
          isMainProtected,
          checkedOutBy,
          state: item.state,
          designId: item.designId ?? null,
        },
      }
    }),
  ),
)

// DELETE /api/items/:id/checkout
app.delete(
  '/:id/checkout',
  adapt(
    apiHandler<{ id: string }>({}, async ({ request, params, user }) => {
      // The item in the path is reachable or it is not, whatever branch the
      // caller names — so that answer comes first. Without it these four
      // routes refused an outsider with a 400 about a missing branchId, which
      // both leaks that the item exists and tells them what to send next.
      await requireItemAccess(user.id, params.id)

      const url = new URL(request.url)
      const branchId = url.searchParams.get('branchId')

      if (!branchId) {
        throw new ValidationError('branchId query parameter is required')
      }

      // Get the item to get its masterId
      const item = await ItemService.findById(params.id)
      if (!item) {
        throw new NotFoundError('Item', params.id)
      }

      // Check access to branch/design (parity with the other checkout routes)
      await requireBranchAccess(user.id, branchId)

      await CheckoutService.cancelCheckout(item.masterId, branchId, user.id)

      return { success: true }
    }),
  ),
)

export default app
