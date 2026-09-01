// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { tagged } from '../adapter'
import { JobService } from '@/lib/jobs/JobService'
import { apiHandler } from '@/lib/api/handler'
import { permissionService } from '@/lib/auth/permission-service'
import { resolveCredentials } from '@/lib/auth/credentials'
import { intersectPermissions } from '@/lib/auth/api-key-utils'
import { hasPermission } from '@/lib/auth/permissions'
import { NotFoundError } from '@/lib/errors'

const adapt = tagged('Jobs')

const app = new Hono()

/**
 * Does *this request* carry `system:manage`?
 *
 * `permissionService.canUser` on its own would not answer that: it reads the
 * owner's roles, and a scoped API key narrows them. `apiHandler` applies that
 * narrowing only inside its declared-permission branch, and the gate below
 * cannot be a declared tuple — it admits the submitter *or* an administrator.
 * Unintersected, an administrator's key scoped `{ parts: ['read'] }` would
 * read every job on the instance here while `/api/v1/admin/jobs/:id`, which
 * does declare the tuple, refuses the same key. `requirePermission` makes the
 * same intersection, but answers 403; this route answers 404 (see below), so
 * it needs the predicate rather than the guard.
 */
async function requestHasSystemManage(
  request: Request,
  userId: string,
): Promise<boolean> {
  const credentials = await resolveCredentials(request)

  if (credentials?.scope) {
    const rolePermissions = await permissionService.getUserPermissions(userId)
    return hasPermission(
      intersectPermissions(rolePermissions, credentials.scope),
      'system',
      'manage',
    )
  }

  return permissionService.canUser(userId, 'manage', 'system')
}

// GET /api/jobs/:id
app.get(
  '/:id',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params, request, user }) => {
      const { id } = params
      const job = await JobService.get(id)
      if (!job) {
        throw new NotFoundError('Job', id)
      }

      // This is the poll every submitter runs against the job it was just
      // handed, and nothing more: the row carries the job's result and error
      // payloads, so being authenticated is not on its own a reason to read
      // one. A job belongs to whoever submitted it, plus `system:manage` —
      // the same permission its admin siblings under /api/v1/admin/jobs
      // require. `createdBy` is null on a system-submitted maintenance job,
      // which makes those administrator-only, as they should be.
      //
      // The refusal is the 404 a missing row gets rather than a 403, so the
      // route cannot be used to learn which job ids exist — the same
      // by-id-enumeration hardening the item routes carry.
      if (
        job.createdBy !== user.id &&
        !(await requestHasSystemManage(request, user.id))
      ) {
        throw new NotFoundError('Job', id)
      }

      return {
        id: job.id,
        type: job.type,
        status: job.status,
        progress: job.progress,
        progressMessage: job.progressMessage,
        result: job.result,
        error: job.error,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
      }
    }),
  ),
)

export default app
