// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { tagged } from '../adapter'
import type { RebaseResult } from '@/lib/services/ConflictDetectionService'
import type { ErrorResponse } from '@/lib/errors/api'
import { ConflictDetectionService } from '@/lib/services/ConflictDetectionService'
import { apiHandler } from '@/lib/api/handler'
import { db } from '@/lib/db'
import { branchItems } from '@/lib/db/schema'
import { requireBranchAccess } from '@/lib/auth/access'
import { ErrorCode, NotFoundError, ValidationError } from '@/lib/errors'

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
    apiHandler<{ id: string }, z.infer<typeof pullFromMainSchema>>(
      {
        access: ({ params, user }) =>
          requireAccessToBranchItem(user.id, params.id),
        body: pullFromMainSchema,
      },
      async ({ params, body, user }) => {
        const result = await ConflictDetectionService.pullChangesFromMain(
          params.id,
          body.mainItemId,
          user.id,
        )

        if (!result.success) {
          // Thrown, not hand-written: `apiHandler` turns an `AppError` into
          // the documented envelope, and this response used to be a bare
          // `{ error: '<message>' }` — the one shape a client reading
          // `error.code` gets `undefined` from. The service's failures here
          // ("Could not find required items") are the caller naming a row
          // that is not there, so they are the caller's fault and stay 400.
          throw new ValidationError(result.error ?? 'Pull from main failed')
        }

        return result
      },
    ),
  ),
)

// POST /api/branch-items/:id/rebase
app.post(
  '/:id/rebase',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof rebaseSchema>>(
      {
        access: ({ params, user }) =>
          requireAccessToBranchItem(user.id, params.id),
        body: rebaseSchema,
      },
      async ({ params, body, user, requestId }) => {
        const result = await ConflictDetectionService.rebaseItem(
          params.id,
          body.newBaseItemId,
          user.id,
          body.resolutions,
        )

        if (!result.success && result.manualResolutionRequired) {
          // The one rejection here that cannot simply throw: the field
          // conflicts *are* the answer — a resolution UI handed only a
          // message would have to re-run the rebase to learn what to show,
          // and `createErrorResponse` writes the envelope and nothing else.
          // So the envelope is built by hand and the payload rides beside it
          // in the same `data` sibling a success would use. Typed as
          // `ErrorResponse` so it cannot drift from what
          // `errorResponseSchema` documents, and MERGE_CONFLICT is already
          // the 409 in the status map.
          const conflictBody: ErrorResponse & { data: RebaseResult } = {
            error: {
              code: ErrorCode.MERGE_CONFLICT,
              message: 'Manual resolution required',
              requestId,
              timestamp: new Date().toISOString(),
            },
            data: result,
          }

          return new Response(JSON.stringify(conflictBody), {
            status: 409,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        if (!result.success) {
          // Same reasoning as pull-from-main above.
          throw new ValidationError(result.error ?? 'Rebase failed')
        }

        return result
      },
    ),
  ),
)

export default app
