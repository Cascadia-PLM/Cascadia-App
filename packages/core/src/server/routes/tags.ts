// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { tagged } from '../adapter'
import { DesignService } from '@/lib/services/DesignService'
import {
  requireDesignAccess,
  requireDesignManageAuthority,
} from '@/lib/auth/access'
import { NotFoundError } from '@/lib/errors'
import { apiHandler } from '@/lib/api/handler'

const adapt = tagged('Tags')

const app = new Hono()

// GET /api/tags/:id
app.get(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      {
        // A tag names a commit in a design, so reaching it is reaching the
        // design. This route had no instance gate at all: any authenticated
        // caller could read any tag on the instance by id, which discloses
        // another program's release and baseline names.
        access: async ({ params, user }) => {
          const tag = await DesignService.getTag(params.id)
          if (!tag) throw new NotFoundError('Tag', params.id)
          await requireDesignAccess(user.id, tag.designId)
        },
      },
      async ({ params }) => {
        const { id } = params
        const tag = await DesignService.getTag(id)
        if (!tag) throw new NotFoundError('Tag', id)
        return { tag }
      },
    ),
  ),
)

// DELETE /api/tags/:id
app.delete(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      {
        // Destroying a release or baseline pointer takes cross-program
        // authority or program admin/lead — and, on a design carrying no
        // program, cross-program authority alone. The check used to sit inside
        // `if (design.programId)` with no else, so an unassigned design's tags
        // could be deleted by anyone signed in. See
        // `requireDesignManageAuthority`.
        access: async ({ params, user }) => {
          const tag = await DesignService.getTag(params.id)
          if (!tag) throw new NotFoundError('Tag', params.id)
          await requireDesignManageAuthority(user.id, tag.designId, 'delete')
        },
      },
      async ({ params }) => {
        const { id } = params
        const tag = await DesignService.getTag(id)
        if (!tag) throw new NotFoundError('Tag', id)

        await DesignService.deleteTag(id)
        return { success: true }
      },
    ),
  ),
)

export default app
