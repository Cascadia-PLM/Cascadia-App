// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { z } from 'zod'
import { eq, sql } from 'drizzle-orm'
import { tagged } from '../adapter'
import type { ChangeOrder } from '@/lib/items/types/change-order'
import { changeOrderTypeSchema } from '@/lib/items/types/change-order'
import { db } from '@/lib/db'
import { branchItems, designs, items } from '@/lib/db/schema'
import { BranchService } from '@/lib/services/BranchService'
import { ItemService } from '@/lib/items/services/ItemService'
import { ChangeOrderService } from '@/lib/items/services/ChangeOrderService'
import { apiHandler, created } from '@/lib/api/handler'
import { requireBranchAccess, requireDesignAccess } from '@/lib/auth/access'
import {
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from '@/lib/errors'

const adapt = tagged('Workspaces')

const app = new Hono()

const createWorkspaceSchema = z.object({
  designId: z.string().uuid(),
  // Branch names are varchar(100) and carry the 'workspace/' prefix
  workspaceName: z.string().trim().min(1, 'Workspace name is required').max(80),
})

const convertToEcoSchema = z.object({
  ecoTitle: z.string().trim().min(1, 'ECO title is required').max(500),
  ecoDescription: z.string().max(10_000).optional(),
  changeType: changeOrderTypeSchema.default('ECO'),
  deleteWorkspace: z.boolean().default(false),
})

const mergeToEcoSchema = z.object({
  ecoId: z.string().uuid(),
  deleteWorkspace: z.boolean().default(false),
})

const workspaceResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  designId: z.string().uuid(),
  designName: z.string(),
  designCode: z.string(),
  createdAt: z.string(),
  isLocked: z.boolean().nullable(),
  isArchived: z.boolean().nullable(),
  ownerId: z.string().uuid().nullable(),
  headCommitId: z.string().uuid().nullable(),
  baseCommitId: z.string().uuid().nullable(),
  itemCount: z.number(),
  workspaceOnlyItemCount: z.number(),
})

/**
 * The workspace branch behind an id, after verifying it exists, is a
 * workspace, is not archived (deleted, from the user's point of view), and
 * that the caller can access its design. Archived and non-workspace branches
 * 404 rather than 400: the resource this API serves is "a live workspace",
 * and a branch that is not one simply is not here.
 */
async function requireWorkspace(userId: string, branchId: string) {
  const { branch } = await requireBranchAccess(userId, branchId)
  if (branch.branchType !== 'workspace' || branch.isArchived) {
    throw new NotFoundError('Workspace', branchId)
  }
  return branch
}

/** Same, but for mutations: only the owner may change a workspace. */
async function requireOwnedWorkspace(userId: string, branchId: string) {
  const branch = await requireWorkspace(userId, branchId)
  if (branch.ownerId !== userId) {
    throw new PermissionDeniedError('workspace', 'modify')
  }
  return branch
}

// GET /api/workspaces
app.get(
  '/',
  adapt(
    apiHandler(
      {
        openapi: {
          summary: 'List the current user’s workspace branches',
        },
      },
      async ({ user }) => {
        const workspaces = await BranchService.listByUser(user.id)

        return { workspaces }
      },
    ),
  ),
)

// POST /api/workspaces
app.post(
  '/',
  adapt(
    apiHandler(
      {
        body: createWorkspaceSchema,
        openapi: {
          summary: 'Create a workspace branch on a design',
        },
      },
      async ({ body: { designId, workspaceName }, user }) => {
        // A workspace branch can only be opened on a design the user can access
        await requireDesignAccess(user.id, designId)

        const branch = await BranchService.createWorkspaceBranch(
          designId,
          user.id,
          workspaceName,
        )

        return created({
          workspaceId: branch.id,
          branchName: branch.name,
        })
      },
    ),
  ),
)

// GET /api/workspaces/:id
app.get(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      {
        openapi: {
          summary: 'Get a workspace with its design and item counts',
          request: { params: z.object({ id: z.string().uuid() }) },
          responses: { 200: { schema: workspaceResponseSchema } },
        },
      },
      async ({ params, user }) => {
        const branch = await requireWorkspace(user.id, params.id)

        const design = await db
          .select({ name: designs.name, code: designs.code })
          .from(designs)
          .where(eq(designs.id, branch.designId))
          .limit(1)
          .then((r) => r.at(0))

        const counts = await BranchService.getWorkspaceItemCounts(branch.id)

        return {
          id: branch.id,
          name: branch.name,
          designId: branch.designId,
          designName: design?.name ?? '',
          designCode: design?.code ?? '',
          createdAt: branch.createdAt,
          isLocked: branch.isLocked,
          isArchived: branch.isArchived,
          ownerId: branch.ownerId,
          headCommitId: branch.headCommitId,
          baseCommitId: branch.baseCommitId,
          itemCount: counts.total,
          workspaceOnlyItemCount: counts.workspaceOnly,
        }
      },
    ),
  ),
)

// DELETE /api/workspaces/:id
app.delete(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      {
        openapi: {
          summary:
            'Delete a workspace, and with it any drafts that exist only there',
          request: { params: z.object({ id: z.string().uuid() }) },
        },
      },
      async ({ params, user }) => {
        await requireOwnedWorkspace(user.id, params.id)
        await BranchService.deleteWorkspaceBranch(params.id, user.id)

        return { success: true }
      },
    ),
  ),
)

// GET /api/workspaces/:id/items
app.get(
  '/:id/items',
  adapt(
    apiHandler<{ id: string }>(
      {
        openapi: {
          summary: 'List the items on a workspace branch',
          request: { params: z.object({ id: z.string().uuid() }) },
        },
      },
      async ({ params, user }) => {
        await requireWorkspace(user.id, params.id)

        // COALESCE so a row staged as deleted (currentItemId cleared) still
        // resolves the item it deletes instead of joining to nothing
        const workspaceItems = await db
          .select({
            id: branchItems.id,
            itemId: branchItems.currentItemId,
            itemMasterId: branchItems.itemMasterId,
            itemNumber: items.itemNumber,
            itemName: items.name,
            itemType: items.itemType,
            revision: items.revision,
            state: items.state,
            changeType: branchItems.changeType,
            checkedOutBy: branchItems.checkedOutBy,
            checkedOutAt: branchItems.checkedOutAt,
          })
          .from(branchItems)
          .leftJoin(
            items,
            sql`${items.id} = coalesce(${branchItems.currentItemId}, ${branchItems.baseItemId})`,
          )
          .where(eq(branchItems.branchId, params.id))

        return { items: workspaceItems }
      },
    ),
  ),
)

// DELETE /api/workspaces/:id/items/:masterId
app.delete(
  '/:id/items/:masterId',
  adapt(
    apiHandler<{ id: string; masterId: string }>(
      {
        openapi: {
          summary:
            'Remove an item from a workspace, discarding the workspace’s changes to it',
          request: {
            params: z.object({
              id: z.string().uuid(),
              masterId: z.string().uuid(),
            }),
          },
        },
      },
      async ({ params, user }) => {
        await requireOwnedWorkspace(user.id, params.id)
        await BranchService.removeWorkspaceItem(
          params.id,
          params.masterId,
          user.id,
        )

        return { success: true }
      },
    ),
  ),
)

// POST /api/workspaces/:id/convert-to-eco
app.post(
  '/:id/convert-to-eco',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof convertToEcoSchema>>(
      {
        body: convertToEcoSchema,
        permission: ['change_orders', 'create'],
        openapi: {
          summary: 'Create a new ECO carrying this workspace’s content',
          request: {
            params: z.object({ id: z.string().uuid() }),
          },
        },
      },
      async ({
        body: { ecoTitle, ecoDescription, changeType, deleteWorkspace },
        params,
        user,
      }) => {
        const workspace = await requireOwnedWorkspace(user.id, params.id)

        // Refuse before creating the ECO, not after
        const counts = await BranchService.getWorkspaceItemCounts(workspace.id)
        if (counts.total === 0) {
          throw new ValidationError('Workspace has no items to convert')
        }

        // TODO: route this through `ChangeOrderService.create`, which is the
        // one door for change orders — it takes the designs and refuses to
        // make one without them. This path still writes `items.designId`,
        // which on a change order is the "primary design" that is not
        // supposed to exist: an ECO spans designs and none of them leads.
        // Not a leak — `adoptWorkspaceItems` links the design properly and
        // access control reads only the link table now — but the column is
        // still read by `ChangeOrderDetail`'s version-context selector, so
        // ECOs made here behave differently from ECOs made anywhere else.
        // Deferred because the switch reorders branch and workflow creation
        // in this path.
        const eco = await ItemService.create<ChangeOrder>(
          'ChangeOrder',
          {
            itemNumber: '', // Will be auto-generated
            revision: '-',
            name: ecoTitle,
            designId: workspace.designId,
            changeType,
            reasonForChange: ecoDescription || '',
          } as ChangeOrder,
          user.id,
          { bypassBranchProtection: true },
        )

        if (!eco.id) {
          throw new Error('Failed to create ECO')
        }

        // Move the workspace's branch content onto the new ECO's branch, so
        // the merge pipeline releases exactly what the workspace drafted
        const { itemsAdopted, itemsSkipped } =
          await ChangeOrderService.adoptWorkspaceItems(
            eco.id,
            workspace.id,
            user.id,
          )

        // Safe now: adoption moved the content off this branch
        if (deleteWorkspace) {
          await BranchService.deleteWorkspaceBranch(workspace.id, user.id)
        }

        return created({
          ecoId: eco.id,
          ecoNumber: eco.itemNumber,
          itemsConverted: itemsAdopted,
          itemsSkipped,
          workspaceDeleted: deleteWorkspace,
        })
      },
    ),
  ),
)

// POST /api/workspaces/:id/merge-to-eco
app.post(
  '/:id/merge-to-eco',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof mergeToEcoSchema>>(
      {
        body: mergeToEcoSchema,
        permission: ['change_orders', 'update'],
        openapi: {
          summary: 'Move this workspace’s content into an existing ECO',
          request: {
            params: z.object({ id: z.string().uuid() }),
          },
        },
      },
      async ({ body: { ecoId, deleteWorkspace }, params, user }) => {
        const workspace = await requireOwnedWorkspace(user.id, params.id)

        const eco = await ItemService.findById(ecoId)
        if (!eco || eco.itemType !== 'ChangeOrder') {
          throw new NotFoundError('ECO', ecoId)
        }

        // Re-homes the workspace's branch items onto the ECO branch and
        // registers them in the reviewed scope. Also enforces that the ECO
        // still accepts items (scope not locked, workflow not completed).
        const { itemsAdopted, itemsSkipped } =
          await ChangeOrderService.adoptWorkspaceItems(
            ecoId,
            workspace.id,
            user.id,
          )

        if (deleteWorkspace) {
          await BranchService.deleteWorkspaceBranch(workspace.id, user.id)
        }

        return {
          ecoId,
          itemsAdded: itemsAdopted,
          itemsSkipped,
          workspaceDeleted: deleteWorkspace,
        }
      },
    ),
  ),
)

export default app
