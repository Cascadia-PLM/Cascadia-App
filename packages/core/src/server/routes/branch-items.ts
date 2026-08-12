// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { tagged } from '../adapter'
import { ConflictDetectionService } from '@/lib/services/ConflictDetectionService'
import { apiHandler } from '@/lib/api/handler'
import { db } from '@/lib/db'
import { branchItems } from '@/lib/db/schema'
import { requireBranchAccess } from '@/lib/auth/access'
import { NotFoundError } from '@/lib/errors'

const adapt = tagged('Branch Items')

/**
 * Rebase and pull rewrite branch working copies, so they carry the same
 * design-membership requirement as every other branch mutation. The route
 * param is a branch_items id, so the branch has to be resolved before the
 * program boundary can be checked.
 */
async function requireAccessToBranchItem(
  userId: string,
  branchItemId: string,
): Promise<void> {
  const branchItem = await db
    .select({ branchId: branchItems.branchId })
    .from(branchItems)
    .where(eq(branchItems.id, branchItemId))
    .limit(1)
    .then((r) => r.at(0))

  if (!branchItem) {
    throw new NotFoundError('Branch item', branchItemId)
  }

  await requireBranchAccess(userId, branchItem.branchId)
}

const pullFromMainSchema = z.object({
  mainItemId: z.string().uuid(),
})

const rebaseSchema = z.object({
  newBaseItemId: z.string().uuid(),
  resolutions: z.record(z.string(), z.unknown()).optional(),
})

const app = new Hono()

// POST /api/branch-items/:id/pull-from-main
app.post(
  '/:id/pull-from-main',
  adapt(
    apiHandler<{ id: string }>({}, async ({ request, params, user }) => {
      await requireAccessToBranchItem(user.id, params.id)

      const body = await request.json()
      const validated = pullFromMainSchema.parse(body)

      const result = await ConflictDetectionService.pullChangesFromMain(
        params.id,
        validated.mainItemId,
        user.id,
      )

      if (!result.success) {
        return new Response(
          JSON.stringify({
            error: result.error || 'Pull from main failed',
            data: result,
          }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          },
        )
      }

      return result
    }),
  ),
)

// POST /api/branch-items/:id/rebase
app.post(
  '/:id/rebase',
  adapt(
    apiHandler<{ id: string }>({}, async ({ request, params, user }) => {
      await requireAccessToBranchItem(user.id, params.id)

      const body = await request.json()
      const validated = rebaseSchema.parse(body)

      const result = await ConflictDetectionService.rebaseItem(
        params.id,
        validated.newBaseItemId,
        user.id,
        validated.resolutions,
      )

      if (!result.success && result.manualResolutionRequired) {
        // Return 409 Conflict with the field conflicts that need resolution
        return new Response(
          JSON.stringify({
            error: 'Manual resolution required',
            fieldConflicts: result.fieldConflicts,
            data: result,
          }),
          {
            status: 409,
            headers: { 'Content-Type': 'application/json' },
          },
        )
      }

      if (!result.success) {
        return new Response(
          JSON.stringify({
            error: result.error || 'Rebase failed',
            data: result,
          }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          },
        )
      }

      return result
    }),
  ),
)

export default app
