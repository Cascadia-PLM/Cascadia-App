// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { tagged } from '../adapter'
import { DesignService } from '@/lib/services/DesignService'
import { ProgramService } from '@/lib/services/ProgramService'
import { permissionService } from '@/lib/auth/permission-service'
import { NotFoundError, PermissionDeniedError } from '@/lib/errors'
import { apiHandler } from '@/lib/api/handler'

const adapt = tagged('Tags')

const app = new Hono()

// GET /api/tags/:id
app.get(
  '/:id',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params }) => {
      const { id } = params
      const tag = await DesignService.getTag(id)
      if (!tag) throw new NotFoundError('Tag', id)
      return { tag }
    }),
  ),
)

// DELETE /api/tags/:id
app.delete(
  '/:id',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params, user }) => {
      const { id } = params
      const tag = await DesignService.getTag(id)
      if (!tag) throw new NotFoundError('Tag', id)

      const design = await DesignService.getById(tag.designId)
      if (!design) throw new NotFoundError('Design', tag.designId)

      // Check permission - Global Admin or program admin/lead can delete tags
      if (design.programId) {
        const isGlobalAdmin = await permissionService.hasRole(
          user.id,
          'Global Admin',
        )
        if (!isGlobalAdmin) {
          const role = await ProgramService.getUserRole(
            user.id,
            design.programId,
          )
          if (role !== 'admin' && role !== 'lead') {
            throw new PermissionDeniedError('design tags', 'delete')
          }
        }
      }

      await DesignService.deleteTag(id)
      return { success: true }
    }),
  ),
)

export default app
