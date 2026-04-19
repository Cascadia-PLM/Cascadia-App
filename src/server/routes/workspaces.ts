import { Hono } from 'hono'
import { and, eq, inArray } from 'drizzle-orm'
import { adapt } from '../adapter'
import type { ChangeOrder } from '@/lib/items/types/change-order'
import { db } from '@/lib/db'
import { branchItems, branches, items } from '@/lib/db/schema'
import { BranchService } from '@/lib/services/BranchService'
import { ItemService } from '@/lib/items/services/ItemService'
import { ChangeOrderService } from '@/lib/items/services/ChangeOrderService'
import { WorkflowService } from '@/lib/workflows/WorkflowService'
import { apiHandler, created } from '@/lib/api/handler'
import {
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from '@/lib/errors'

const app = new Hono()

// GET /api/workspaces
app.get(
  '/',
  adapt(
    apiHandler({}, async ({ user }) => {
      const workspaces = await BranchService.listByUser(user.id)

      return { workspaces }
    }),
  ),
)

// POST /api/workspaces
app.post(
  '/',
  adapt(
    apiHandler({}, async ({ request, user }) => {
      const body = await request.json()
      const { designId, workspaceName } = body

      if (!designId || !workspaceName) {
        throw new ValidationError(
          'Missing required fields: designId and workspaceName',
        )
      }

      const branch = await BranchService.createWorkspaceBranch(
        designId,
        user.id,
        workspaceName,
      )

      return created({
        workspaceId: branch.id,
        branchName: branch.name,
      })
    }),
  ),
)

// GET /api/workspaces/:id
app.get(
  '/:id',
  adapt(
    apiHandler({}, async ({ params }) => {
      const branch = await BranchService.getById(params.id)
      if (!branch) {
        throw new NotFoundError('Workspace', params.id)
      }

      if (branch.branchType !== 'workspace') {
        throw new ValidationError('Not a workspace branch')
      }

      const itemCount = await BranchService.getWorkspaceOnlyItemCount(params.id)

      return {
        id: branch.id,
        name: branch.name,
        designId: branch.designId,
        itemCount,
      }
    }),
  ),
)

// DELETE /api/workspaces/:id
app.delete(
  '/:id',
  adapt(
    apiHandler({}, async ({ params, user }) => {
      await BranchService.deleteWorkspaceBranch(params.id, user.id)

      return { success: true }
    }),
  ),
)

// POST /api/workspaces/:id/convert-to-eco
app.post(
  '/:id/convert-to-eco',
  adapt(
    apiHandler({}, async ({ request, params, user }) => {
      const workspaceId = params.id
      const body = await request.json()
      const {
        ecoTitle,
        ecoDescription,
        changeType = 'ECO',
        deleteWorkspace = false,
      } = body

      if (!ecoTitle) {
        throw new ValidationError('Missing required field: ecoTitle')
      }

      // Get workspace info
      const workspace = await db.query.branches.findFirst({
        where: and(
          eq(branches.id, workspaceId),
          eq(branches.branchType, 'workspace'),
        ),
      })

      if (!workspace) {
        throw new NotFoundError('Workspace', workspaceId)
      }

      // Verify user owns the workspace
      if (workspace.ownerId !== user.id) {
        throw new PermissionDeniedError('workspace', 'update')
      }

      // Get all branch items in the workspace
      const workspaceBranchItems = await db.query.branchItems.findMany({
        where: eq(branchItems.branchId, workspaceId),
      })

      if (workspaceBranchItems.length === 0) {
        throw new ValidationError('Workspace has no items to convert')
      }

      // Fetch the actual items for each branch item that has a currentItemId
      const currentItemIds = workspaceBranchItems
        .map((bi) => bi.currentItemId)
        .filter((id): id is string => id !== null)

      const currentItems =
        currentItemIds.length > 0
          ? await db
              .select()
              .from(items)
              .where(inArray(items.id, currentItemIds))
          : []

      // Create a map for quick lookup
      const itemMap = new Map(currentItems.map((item) => [item.id, item]))

      // Create the ECO
      const eco = await ItemService.create<ChangeOrder>(
        'ChangeOrder',
        {
          itemNumber: '', // Will be auto-generated
          revision: '-',
          name: ecoTitle,
          designId: workspace.designId,
          changeType,
          state: 'Draft',
          reasonForChange: ecoDescription || '',
        } as ChangeOrder,
        user.id,
        { bypassBranchProtection: true },
      )

      if (!eco.id) {
        throw new Error('Failed to create ECO')
      }

      // For each branch item in workspace, add to ECO
      for (const branchItem of workspaceBranchItems) {
        const currentItem = branchItem.currentItemId
          ? itemMap.get(branchItem.currentItemId)
          : null
        if (!currentItem) continue

        // Determine change action based on change type
        let changeAction: 'add' | 'revise' | 'release' | 'obsolete' = 'revise'
        if (branchItem.changeType === 'added') {
          changeAction = 'add'
        } else if (branchItem.changeType === 'deleted') {
          changeAction = 'obsolete'
        } else if (currentItem.state === 'Draft') {
          changeAction = 'release'
        }

        // Add item to ECO
        await ChangeOrderService.addAffectedItem(
          eco.id,
          {
            affectedItemId: currentItem.id,
            changeAction,
          },
          user.id,
        )
      }

      // Optionally delete the workspace
      if (deleteWorkspace) {
        await BranchService.deleteWorkspaceBranch(workspaceId, user.id)
      }

      return created({
        ecoId: eco.id,
        ecoNumber: eco.itemNumber,
        itemsConverted: workspaceBranchItems.length,
        workspaceDeleted: deleteWorkspace,
      })
    }),
  ),
)

// GET /api/workspaces/:id/items
app.get(
  '/:id/items',
  adapt(
    apiHandler({}, async ({ params }) => {
      const workspaceId = params.id

      // Fetch all items on this workspace branch
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
        .leftJoin(items, eq(branchItems.currentItemId, items.id))
        .where(eq(branchItems.branchId, workspaceId))

      return { items: workspaceItems }
    }),
  ),
)

// POST /api/workspaces/:id/merge-to-eco
app.post(
  '/:id/merge-to-eco',
  adapt(
    apiHandler({}, async ({ request, params, user }) => {
      const workspaceId = params.id
      const body = await request.json()
      const { ecoId, deleteWorkspace = false } = body

      if (!ecoId) {
        throw new ValidationError('Missing required field: ecoId')
      }

      // Get workspace info
      const workspace = await db.query.branches.findFirst({
        where: and(
          eq(branches.id, workspaceId),
          eq(branches.branchType, 'workspace'),
        ),
      })

      if (!workspace) {
        throw new NotFoundError('Workspace', workspaceId)
      }

      // Verify user owns the workspace
      if (workspace.ownerId !== user.id) {
        throw new PermissionDeniedError('workspace', 'update')
      }

      // Verify ECO exists and is editable
      const eco = await db.query.items.findFirst({
        where: eq(items.id, ecoId),
      })

      if (!eco) {
        throw new NotFoundError('ECO', ecoId)
      }

      // Verify ECO scope is not locked
      const workflowInstance = await WorkflowService.getInstanceByItemId(ecoId)
      if (workflowInstance?.scopeLocked) {
        throw new ValidationError(
          'Cannot merge to this ECO: scope is locked. The ECO can no longer accept new items.',
        )
      }
      if (workflowInstance?.completedAt) {
        throw new ValidationError(
          'Cannot merge to this ECO: the workflow has been completed.',
        )
      }

      // Get all branch items in the workspace
      const workspaceBranchItems = await db.query.branchItems.findMany({
        where: eq(branchItems.branchId, workspaceId),
      })

      if (workspaceBranchItems.length === 0) {
        throw new ValidationError('Workspace has no items to merge')
      }

      // For each branch item in workspace, checkout to ECO
      // Use checkoutItemToEco which creates branch items, working copies,
      // design associations, AND affected items records
      let itemsAdded = 0
      let itemsSkipped = 0

      for (const branchItem of workspaceBranchItems) {
        // Resolve to original item (prefer baseItemId for checked-out items)
        const itemId = branchItem.baseItemId || branchItem.currentItemId
        if (!itemId) continue

        try {
          await ChangeOrderService.checkoutItemToEco(ecoId, itemId, user.id)
          itemsAdded++
        } catch (error) {
          // checkoutItemToEco is idempotent for already-checked-out items
          const errorMsg =
            error instanceof Error ? error.message : String(error)
          if (errorMsg.includes('already')) {
            itemsSkipped++
          } else {
            console.log(
              `Failed to add item ${branchItem.itemMasterId}: ${errorMsg}`,
            )
            itemsSkipped++
          }
        }
      }

      // Optionally delete the workspace
      if (deleteWorkspace) {
        await BranchService.deleteWorkspaceBranch(workspaceId, user.id)
      }

      return {
        ecoId,
        itemsAdded,
        itemsSkipped,
        workspaceDeleted: deleteWorkspace,
      }
    }),
  ),
)

export default app
