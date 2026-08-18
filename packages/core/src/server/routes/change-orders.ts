// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { z } from 'zod'
import { and, eq, inArray } from 'drizzle-orm'
import { tagged } from '../adapter'
import type { ChangeOrder } from '@/lib/items/types/change-order'
import type { ConflictResolution } from '@/components/change-orders/MergeConflictDialog'
import type {
  InstanceWorkflowTransition,
  WorkflowState,
} from '@/lib/workflows/types'
import type { SessionUser } from '@/lib/auth/session'
import { ApprovalRegistry } from '@/lib/workflows/approval-registry'
import { changeActionSchema } from '@/lib/items/types/change-order'
import { ItemService } from '@/lib/items/services/ItemService'
import { LifecycleService } from '@/lib/services/LifecycleService'
import { ChangeOrderService } from '@/lib/items/services/ChangeOrderService'
import { ChangeOrderMergeService } from '@/lib/services/ChangeOrderMergeService'
import { ImpactAssessmentService } from '@/lib/items/services/ImpactAssessmentService'
import { ItemRelationshipService } from '@/lib/items/services/ItemRelationshipService'
import { BranchService } from '@/lib/services/BranchService'
import { CheckoutService } from '@/lib/services/CheckoutService'
import { ConflictDetectionService } from '@/lib/services/ConflictDetectionService'
import { ConflictReviewService } from '@/lib/services/ConflictReviewService'
import { EcoBranchHistoryService } from '@/lib/services/EcoBranchHistoryService'
import { EcoStructureService } from '@/lib/services/EcoStructureService'
import { WorkflowService } from '@/lib/workflows/WorkflowService'
import { WorkflowApprovalService } from '@/lib/workflows/WorkflowApprovalService'
import { UserService } from '@/lib/auth/UserService'
import { apiHandler, created, jsonResponse } from '@/lib/api/handler'
import {
  AlreadyExistsError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from '@/lib/errors'
import { AccessControlService } from '@/lib/auth/AccessControlService'
import { ProgramService } from '@/lib/services/ProgramService'
import { DesignService } from '@/lib/services/DesignService'
import { requireDesignAccess } from '@/lib/auth/access'
import { markConflictReviewedRequestSchema } from '@/lib/services/types/conflict-review'
import { db } from '@/lib/db'
import { branchItems } from '@/lib/db/schema'
import {
  changeOrderDesigns,
  changeOrders,
  itemRelationships,
  items,
} from '@/lib/db/schema/items'
import { designs } from '@/lib/db/schema/designs'
import '@/lib/items/registerItemTypes.server'

const adapt = tagged('Change Orders')

const app = new Hono()

/**
 * A change order accepts structural edits until its workflow completes.
 *
 * Resolved from the workflow instance rather than by comparing the item's
 * state against the default workflow's state names - those names are one
 * workflow's choice, not a property of change orders, and flexible instances
 * legitimately use entirely different ones.
 */
async function assertChangeOrderEditable(changeOrderId: string): Promise<void> {
  const instance = await WorkflowService.getInstanceByItemId(changeOrderId)
  if (instance?.completedAt) {
    throw new ValidationError(
      'Cannot modify this change order: its workflow has been completed',
    )
  }
}

/**
 * Program-membership gate for approval votes.
 *
 * RBAC (change_orders:update on the route) says the user may vote on change
 * orders in general; this says they may vote on *this* one. The ECO's design
 * resolves to a program; voting requires membership there with the
 * canApproveEco flag on. Cross-program authority bypasses, and an ECO outside
 * any program (no design, or an unassigned design) falls back to RBAC alone.
 *
 * Runs before the workflow-instance lookup so a denial is a clean 403
 * regardless of workflow configuration.
 */
async function requireEcoApprovalAccess(
  userId: string,
  changeOrderItemId: string,
): Promise<void> {
  const eco = await ItemService.findById(changeOrderItemId)
  if (!eco) throw new NotFoundError('ChangeOrder', changeOrderItemId)
  if (!eco.designId) return

  const design = await DesignService.getById(eco.designId)
  if (!design?.programId) return

  if (await AccessControlService.hasCrossProgramAccess(userId)) return

  const member = await ProgramService.getMember(design.programId, userId)
  if (!member || !member.canApproveEco) {
    throw new PermissionDeniedError('change order approval', 'submit')
  }
}

/**
 * Collect whatever the licensed modules want carried into an approval vote.
 *
 * Always called, and empty unless a module contributes — which is what lets
 * this route compile and run with the optional packages absent entirely. What
 * ends up inside is the module's business; this layer only forwards the
 * request, since that is what carries things like a client certificate.
 */
function approvalExtras(
  request: Request,
  user: SessionUser,
  requestId: string,
  body: Record<string, unknown>,
) {
  return ApprovalRegistry.buildExtras({ request, user, requestId, body })
}

/**
 * Affected-item intake.
 *
 * Target state and revision are deliberately **not** accepted: they are
 * resolved server-side from the item's lifecycle. The body used to be passed
 * to the service unvalidated, which let a dialog's client-side revision guess
 * become the stored target — and, on one release path, the released revision.
 * Unknown keys are stripped rather than rejected so a form echoing a whole
 * item back still works.
 */
const affectedItemInputSchema = z.object({
  affectedItemId: z.string().uuid().nullish(),
  affectedItemMasterId: z.string().uuid().nullish(),
  changeAction: changeActionSchema,
  currentState: z.string().max(100).nullish(),
  currentRevision: z.string().max(50).nullish(),
  replacementItemId: z.string().uuid().nullish(),
  newItemData: z.record(z.string(), z.unknown()).nullish(),
  newItemType: z.string().max(50).nullish(),
  changeDescription: z.string().max(10000).nullish(),
})

const addAffectedItemsRequestSchema = z.union([
  affectedItemInputSchema,
  z.object({ items: z.array(affectedItemInputSchema).min(1).max(500) }),
])

// ============================================
// Static routes (MUST come before /:id)
// ============================================

// GET /api/change-orders - List change orders with optional design/program
// filtering. Query params: designId, programId, limit, offset, includeCounts.
app.get(
  '/',
  adapt(
    apiHandler(
      { permission: ['change_orders', 'read'] },
      async ({ request, user }) => {
        const url = new URL(request.url)
        const designId = url.searchParams.get('designId')
        const programId = url.searchParams.get('programId')

        // Scope filters are program-scoped reads: require access to the
        // program/design being asked about, not just change_orders:read
        // (which every role has). NOTE: the unfiltered branch below still
        // returns change orders across all programs — see the it.fails test
        // in program-isolation.access.test.ts pinning that known gap.
        if (designId) {
          await requireDesignAccess(user.id, designId)
        }
        if (programId) {
          const canAccess = await AccessControlService.canAccessProgram(
            user.id,
            programId,
          )
          if (!canAccess) {
            throw new PermissionDeniedError('program change orders', 'read')
          }
        }
        const limit = parseInt(url.searchParams.get('limit') || '50', 10)
        const offset = parseInt(url.searchParams.get('offset') || '0', 10)
        const includeCounts = url.searchParams.get('includeCounts') === 'true'

        // The unfiltered list below is bounded by nothing else, so the
        // caller's own reach is what bounds it. Resolved once and shared with
        // the counts, which must agree with the rows they sit above.
        const accessDesignIds =
          await AccessControlService.getAccessibleDesignIds(user.id)

        const getStateCounts = async (changeOrderIds?: Array<string>) => {
          if (changeOrderIds && changeOrderIds.length > 0) {
            const allItems = await db
              .select()
              .from(items)
              .where(inArray(items.id, changeOrderIds))
            return {
              Draft: allItems.filter((c) => c.state === 'Draft').length,
              InReview: allItems.filter((c) => c.state === 'InReview').length,
              Released: allItems.filter((c) => c.state === 'Released').length,
            }
          }
          const [draft, inReview, released] = await Promise.all([
            ItemService.search('ChangeOrder', {
              limit: 1,
              state: 'Draft',
              accessDesignIds,
            }),
            ItemService.search('ChangeOrder', {
              limit: 1,
              state: 'InReview',
              accessDesignIds,
            }),
            ItemService.search('ChangeOrder', {
              limit: 1,
              state: 'Released',
              accessDesignIds,
            }),
          ])
          return {
            Draft: draft.total,
            InReview: inReview.total,
            Released: released.total,
          }
        }

        if (designId) {
          const ecoDesignRecords = await db
            .select({ changeOrderId: changeOrderDesigns.changeOrderId })
            .from(changeOrderDesigns)
            .where(eq(changeOrderDesigns.designId, designId))

          const changeOrderIds = ecoDesignRecords.map((r) => r.changeOrderId)

          if (changeOrderIds.length === 0) {
            return {
              changeOrders: [],
              total: 0,
              ...(includeCounts
                ? { counts: { Draft: 0, InReview: 0, Released: 0 } }
                : {}),
            }
          }

          const paginatedIds = changeOrderIds.slice(offset, offset + limit)
          const records = await Promise.all(
            paginatedIds.map((id) => ItemService.findById(id)),
          )

          const response: Record<string, unknown> = {
            changeOrders: records.filter(Boolean),
            total: changeOrderIds.length,
          }
          if (includeCounts)
            response.counts = await getStateCounts(changeOrderIds)
          return response
        }

        if (programId) {
          const programDesigns = await db
            .select({ id: designs.id })
            .from(designs)
            .where(eq(designs.programId, programId))

          const designIds = programDesigns.map((d) => d.id)

          if (designIds.length === 0) {
            return {
              changeOrders: [],
              total: 0,
              ...(includeCounts
                ? { counts: { Draft: 0, InReview: 0, Released: 0 } }
                : {}),
            }
          }

          const ecoDesignRecords = await db
            .select({ changeOrderId: changeOrderDesigns.changeOrderId })
            .from(changeOrderDesigns)
            .where(inArray(changeOrderDesigns.designId, designIds))

          const changeOrderIds = [
            ...new Set(ecoDesignRecords.map((r) => r.changeOrderId)),
          ]

          if (changeOrderIds.length === 0) {
            return {
              changeOrders: [],
              total: 0,
              ...(includeCounts
                ? { counts: { Draft: 0, InReview: 0, Released: 0 } }
                : {}),
            }
          }

          const paginatedIds = changeOrderIds.slice(offset, offset + limit)
          const records = await Promise.all(
            paginatedIds.map((id) => ItemService.findById(id)),
          )

          const response: Record<string, unknown> = {
            changeOrders: records.filter(Boolean),
            total: changeOrderIds.length,
          }
          if (includeCounts)
            response.counts = await getStateCounts(changeOrderIds)
          return response
        }

        const result = await ItemService.search('ChangeOrder', {
          limit,
          offset,
          accessDesignIds,
        })

        const response: Record<string, unknown> = {
          changeOrders: result.items,
          total: result.total,
        }
        if (includeCounts) response.counts = await getStateCounts()
        return response
      },
    ),
  ),
)

// GET /api/change-orders/editable
app.get(
  '/editable',
  adapt(
    apiHandler(
      { permission: ['change_orders', 'read'] },
      async ({ request }) => {
        const url = new URL(request.url)
        const designId = url.searchParams.get('designId') ?? undefined

        const editable = await ChangeOrderService.getEditableChangeOrders({
          designId,
        })

        return { changeOrders: editable }
      },
    ),
  ),
)

// ============================================
// Parameterized routes (/:id)
// ============================================

// GET /api/change-orders/:id
app.get(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['change_orders', 'read'] },
      async ({ params }) => {
        const changeOrder = await ItemService.findById(params.id)
        if (!changeOrder) throw new NotFoundError('Change order', params.id)
        return { changeOrder }
      },
    ),
  ),
)

// PUT /api/change-orders/:id
app.put(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['change_orders', 'update'] },
      async ({ params, request, user }) => {
        const data = await request.json()
        const changeOrder = await ItemService.update<ChangeOrder>(
          params.id,
          data,
          user.id,
        )
        return { changeOrder }
      },
    ),
  ),
)

// DELETE /api/change-orders/:id
app.delete(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['change_orders', 'delete'] },
      async ({ params, user }) => {
        await ItemService.delete(params.id, user.id)
        return { success: true }
      },
    ),
  ),
)

// ============================================
// Affected items
// ============================================

// GET /api/change-orders/:id/affected-items
app.get(
  '/:id/affected-items',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['change_orders', 'read'] },
      async ({ params }) => {
        const { id } = params

        const affectedItems = await ChangeOrderService.getAffectedItems(id)

        return { affectedItems }
      },
    ),
  ),
)

// POST /api/change-orders/:id/affected-items
app.post(
  '/:id/affected-items',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['change_orders', 'update'],
        openapi: {
          summary: 'Add one or more affected items to a change order',
          request: { body: { schema: addAffectedItemsRequestSchema } },
        },
      },
      async ({ params, request, user }) => {
        const { id } = params
        const data = addAffectedItemsRequestSchema.parse(await request.json())

        if ('items' in data) {
          const affectedItems = await ChangeOrderService.addAffectedItemsBatch(
            id,
            data.items,
            user.id,
          )

          return created({ affectedItems })
        }

        const affectedItem = await ChangeOrderService.addAffectedItem(
          id,
          data,
          user.id,
        )

        return created({ affectedItem })
      },
    ),
  ),
)

// POST /api/change-orders/:id/affected-items/preview - what adding these
// items would do, resolved from each item's lifecycle. Read-only; POST so a
// large selection is not squeezed into a query string.
app.post(
  '/:id/affected-items/preview',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['change_orders', 'read'],
        openapi: {
          summary: 'Preview the change actions available for items',
          request: {
            body: {
              schema: z.object({
                itemIds: z.array(z.string().uuid()).min(1).max(500),
              }),
            },
          },
        },
      },
      async ({ params, request }) => {
        const { itemIds } = z
          .object({ itemIds: z.array(z.string().uuid()).min(1).max(500) })
          .parse(await request.json())

        const options = await ChangeOrderService.getChangeActionOptions(
          params.id,
          itemIds,
        )

        return { options }
      },
    ),
  ),
)

// DELETE /api/change-orders/:id/affected-items
app.delete(
  '/:id/affected-items',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['change_orders', 'update'] },
      async ({ params, request }) => {
        const url = new URL(request.url)
        const affectedItemId = url.searchParams.get('itemId')

        if (!affectedItemId) {
          throw new ValidationError('Missing itemId parameter')
        }

        // Scoped to the ECO in the path: the row id alone is not authority
        await ChangeOrderService.removeAffectedItem(params.id, affectedItemId, {
          discardBranchChanges:
            url.searchParams.get('discardBranchChanges') === 'true',
        })

        return { success: true }
      },
    ),
  ),
)

// ============================================
// Approvals
// ============================================

// GET /api/change-orders/:id/approvals/can-approve
app.get(
  '/:id/approvals/can-approve',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['change_orders', 'read'] },
      async ({ params, user }) => {
        // Get the workflow instance for this change order
        const instance = await WorkflowService.getInstanceByItemId(params.id)

        if (!instance) {
          throw new NotFoundError(
            'Workflow instance for change order',
            params.id,
          )
        }

        // Check if user can approve
        const canApprove = await WorkflowApprovalService.canUserApprove(
          instance.id,
          instance.currentState,
          user.id,
        )

        return {
          instanceId: instance.id,
          currentState: instance.currentState,
          ...canApprove,
        }
      },
    ),
  ),
)

// GET /api/change-orders/:id/approvals
app.get(
  '/:id/approvals',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['change_orders', 'read'] },
      async ({ params, user }) => {
        // Get the workflow instance for this change order
        const instance = await WorkflowService.getInstanceByItemId(params.id)

        if (!instance) {
          throw new NotFoundError(
            'Workflow instance for change order',
            params.id,
          )
        }

        // Get all approvals for this instance
        const approvals = await WorkflowApprovalService.getApprovals(
          instance.id,
        )

        // Check if current user can approve at current state
        const canApprove = await WorkflowApprovalService.canUserApprove(
          instance.id,
          instance.currentState,
          user.id,
        )

        return {
          instanceId: instance.id,
          currentState: instance.currentState,
          approvals,
          canApprove,
        }
      },
    ),
  ),
)

// POST /api/change-orders/:id/approvals
app.post(
  '/:id/approvals',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['change_orders', 'update'] },
      async ({ request, params, user, requestId }) => {
        const data = await request.json()

        if (!data.vote || !['approved', 'rejected'].includes(data.vote)) {
          throw new ValidationError("vote must be 'approved' or 'rejected'")
        }

        await requireEcoApprovalAccess(user.id, params.id)

        // Get the workflow instance for this change order
        const instance = await WorkflowService.getInstanceByItemId(params.id)

        if (!instance) {
          throw new NotFoundError(
            'Workflow instance for change order',
            params.id,
          )
        }

        // Submit the approval
        const result = await WorkflowApprovalService.submitApproval(
          instance.id,
          instance.currentState,
          user.id,
          data.vote,
          data.roleId,
          data.comments,
          await approvalExtras(request, user, requestId, data),
        )

        // Get updated approval status
        const approvalStatus = await WorkflowApprovalService.getStateApprovals(
          instance.id,
          instance.currentState,
        )

        return created({ vote: result, approvalStatus })
      },
    ),
  ),
)

// GET /api/change-orders/:id/approvals/:stateId
app.get(
  '/:id/approvals/:stateId',
  adapt(
    apiHandler<{ id: string; stateId: string }>(
      { permission: ['change_orders', 'read'] },
      async ({ params, user }) => {
        // Get the workflow instance for this change order
        const instance = await WorkflowService.getInstanceByItemId(params.id)

        if (!instance) {
          throw new NotFoundError(
            'Workflow instance for change order',
            params.id,
          )
        }

        // Get approval status for the specific state
        const approvalStatus = await WorkflowApprovalService.getStateApprovals(
          instance.id,
          params.stateId,
        )

        // Check if current user can approve at this state
        const canApprove = await WorkflowApprovalService.canUserApprove(
          instance.id,
          params.stateId,
          user.id,
        )

        return {
          approvalStatus,
          canApprove,
          isCurrentState: instance.currentState === params.stateId,
        }
      },
    ),
  ),
)

// POST /api/change-orders/:id/approvals/:stateId
app.post(
  '/:id/approvals/:stateId',
  adapt(
    apiHandler<{ id: string; stateId: string }>(
      { permission: ['change_orders', 'update'] },
      async ({ request, params, user, requestId }) => {
        const data = await request.json()

        if (!data.vote || !['approved', 'rejected'].includes(data.vote)) {
          throw new ValidationError("vote must be 'approved' or 'rejected'")
        }

        await requireEcoApprovalAccess(user.id, params.id)

        // Get the workflow instance for this change order
        const instance = await WorkflowService.getInstanceByItemId(params.id)

        if (!instance) {
          throw new NotFoundError(
            'Workflow instance for change order',
            params.id,
          )
        }

        // Submit the approval for the specified state
        const result = await WorkflowApprovalService.submitApproval(
          instance.id,
          params.stateId,
          user.id,
          data.vote,
          data.roleId,
          data.comments,
          await approvalExtras(request, user, requestId, data),
        )

        // Get updated approval status
        const approvalStatus = await WorkflowApprovalService.getStateApprovals(
          instance.id,
          params.stateId,
        )

        return created({ vote: result, approvalStatus })
      },
    ),
  ),
)

// ============================================
// BOM changes
// ============================================

// Request body schema for adding BOM change
const addBomChangeSchema = z.object({
  parentItemId: z.string().uuid(),
  childItemId: z.string().uuid(),
  quantity: z.number().min(1).optional().default(1),
  findNumber: z.number().min(1).optional(),
  action: z.enum(['add', 'remove', 'modify']).default('add'),
})

// POST /api/change-orders/:id/bom-changes
app.post(
  '/:id/bom-changes',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['change_orders', 'update'] },
      async ({ params, request, user }) => {
        const changeOrderId = params.id

        // Parse and validate request body
        const body = await request.json()
        const data = addBomChangeSchema.parse(body)

        // Verify the ECO exists
        const eco = await db
          .select({
            itemId: changeOrders.itemId,
            state: items.state,
          })
          .from(changeOrders)
          .innerJoin(items, eq(changeOrders.itemId, items.id))
          .where(eq(changeOrders.itemId, changeOrderId))
          .limit(1)

        if (!eco[0]) {
          throw new NotFoundError('Change Order', changeOrderId)
        }

        // Editable means the workflow has not completed. The previous check
        // compared against the literal state names of the default workflow,
        // so a flexible change order (states 'start'/'complete') could never
        // edit its BOM at all, and any custom workflow was locked out too.
        await assertChangeOrderEditable(changeOrderId)

        // Verify the parent item is an affected item in this ECO
        // Match by affectedItemId, workingCopyId, or masterId since the tree
        // view may pass a branch-resolved working copy ID rather than the
        // original item ID stored in the affected items table
        const affectedItems =
          await ChangeOrderService.getAffectedItems(changeOrderId)

        // Look up the parent item's masterId for stable matching
        const parentItem = await ItemService.findById(data.parentItemId)
        const parentMasterId = parentItem?.masterId

        const parentAffectedItem = affectedItems.find(
          (ai) =>
            ai.affectedItemId === data.parentItemId ||
            (parentMasterId && ai.affectedItemMasterId === parentMasterId),
        )

        if (!parentAffectedItem) {
          throw new ValidationError(
            'Parent item must be an affected item in this ECO. BOM changes require a revision on the parent item.',
          )
        }

        // Write to the ECO's working copy of the parent, never to the row on
        // main. The affected item is matched by masterId, so the client can
        // legitimately pass the released item's id - and writing the
        // relationship against that id edited the released baseline in place,
        // outside the branch and outside the change order entirely.
        const parentTargetId =
          parentAffectedItem.workingCopyId ?? data.parentItemId

        // Verify the child item exists
        const childItem = await ItemService.findById(data.childItemId)
        if (!childItem) {
          throw new NotFoundError('Item', data.childItemId)
        }

        // The ECO BOM editor edits the parent's working copy on the ECO
        // branch, and checkout-to-ECO is the edit intent here: acquire (or
        // verify) the edit lock for this user before mutating. A lock held
        // by another user rejects with 423. requireContentEditable also
        // rejects the released main version if the caller passed the
        // original item ID instead of the branch working copy.
        if (parentItem?.designId) {
          const [ecoDesign] = await db
            .select({ branchId: changeOrderDesigns.branchId })
            .from(changeOrderDesigns)
            .where(
              and(
                eq(changeOrderDesigns.changeOrderId, changeOrderId),
                eq(changeOrderDesigns.designId, parentItem.designId),
              ),
            )
            .limit(1)
          if (ecoDesign?.branchId) {
            await CheckoutService.checkout(
              {
                itemMasterId: parentItem.masterId,
                branchId: ecoDesign.branchId,
              },
              user.id,
            )
          }
          await ItemService.requireContentEditable(parentItem, user.id)
        }

        if (data.action === 'add') {
          // Create the BOM relationship
          await ItemService.addRelationship(
            parentTargetId,
            data.childItemId,
            'BOM',
            user.id,
            {
              quantity: String(data.quantity),
              findNumber: data.findNumber,
            },
          )

          return created({ success: true, message: 'BOM relationship added.' })
        } else if (data.action === 'remove') {
          // Through the audited service, so the removal is recorded in branch
          // history like every other structural edit
          const existing = await db
            .select({ id: itemRelationships.id })
            .from(itemRelationships)
            .where(
              and(
                eq(itemRelationships.sourceId, parentTargetId),
                eq(itemRelationships.targetId, data.childItemId),
                eq(itemRelationships.relationshipType, 'BOM'),
              ),
            )

          for (const relationship of existing) {
            await ItemRelationshipService.removeRelationship(
              relationship.id,
              user.id,
            )
          }

          return {
            success: true,
            message: 'BOM relationship removed.',
          }
        } else {
          // Update existing BOM relationship
          await db
            .update(itemRelationships)
            .set({
              quantity: String(data.quantity),
              findNumber: data.findNumber,
            })
            .where(
              and(
                eq(itemRelationships.sourceId, parentTargetId),
                eq(itemRelationships.targetId, data.childItemId),
                eq(itemRelationships.relationshipType, 'BOM'),
              ),
            )

          return {
            success: true,
            message: 'BOM relationship updated.',
          }
        }

        throw new ValidationError('Invalid action')
      },
    ),
  ),
)

// DELETE /api/change-orders/:id/bom-changes
app.delete(
  '/:id/bom-changes',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['change_orders', 'update'] },
      async ({ params, request, user }) => {
        const changeOrderId = params.id

        // Parse query params for relationshipId
        const url = new URL(request.url, 'http://localhost')
        const relationshipId = url.searchParams.get('relationshipId')

        if (!relationshipId) {
          throw new ValidationError(
            'relationshipId query parameter is required',
          )
        }

        // Verify the ECO exists and is editable
        const eco = await db
          .select({
            itemId: changeOrders.itemId,
            state: items.state,
          })
          .from(changeOrders)
          .innerJoin(items, eq(changeOrders.itemId, items.id))
          .where(eq(changeOrders.itemId, changeOrderId))
          .limit(1)

        if (!eco[0]) {
          throw new NotFoundError('Change Order', changeOrderId)
        }

        await assertChangeOrderEditable(changeOrderId)

        // Get the relationship to verify the parent is an affected item
        const [relationship] = await db
          .select()
          .from(itemRelationships)
          .where(eq(itemRelationships.id, relationshipId))
          .limit(1)

        if (!relationship) {
          throw new NotFoundError('Relationship', relationshipId)
        }

        // Verify the parent (source) is an affected item
        // Match by affectedItemId or masterId (working copy IDs differ from originals)
        const affectedItems =
          await ChangeOrderService.getAffectedItems(changeOrderId)
        const sourceItem = await ItemService.findById(relationship.sourceId)
        const sourceMasterId = sourceItem?.masterId

        const parentAffectedItem = affectedItems.find(
          (ai) =>
            ai.affectedItemId === relationship.sourceId ||
            (sourceMasterId && ai.affectedItemMasterId === sourceMasterId),
        )

        if (!parentAffectedItem) {
          throw new ValidationError(
            'Parent item must be an affected item in this ECO to remove BOM relationships.',
          )
        }

        // Acquire (or verify) the edit lock on the parent's working copy —
        // same edit-intent semantics as adding a BOM change above.
        if (sourceItem?.designId) {
          const [ecoDesign] = await db
            .select({ branchId: changeOrderDesigns.branchId })
            .from(changeOrderDesigns)
            .where(
              and(
                eq(changeOrderDesigns.changeOrderId, changeOrderId),
                eq(changeOrderDesigns.designId, sourceItem.designId),
              ),
            )
            .limit(1)
          if (ecoDesign?.branchId) {
            await CheckoutService.checkout(
              {
                itemMasterId: sourceItem.masterId,
                branchId: ecoDesign.branchId,
              },
              user.id,
            )
          }
        }

        // Delete the relationship (via service for audit trail — the service
        // enforces the edit-lock policy on the source item)
        await ItemRelationshipService.removeRelationship(
          relationshipId,
          user.id,
        )

        return {
          success: true,
          message: 'BOM relationship removed.',
        }
      },
    ),
  ),
)

// ============================================
// Branch history
// ============================================

// GET /api/change-orders/:id/branch-history
app.get(
  '/:id/branch-history',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['change_orders', 'read'] },
      async ({ params }) => EcoBranchHistoryService.getTimeline(params.id),
    ),
  ),
)

// GET /api/change-orders/:id/branch-history/graph
app.get(
  '/:id/branch-history/graph',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['change_orders', 'read'] },
      async ({ request, params }) => {
        const url = new URL(request.url, 'http://localhost')
        const limitParam = url.searchParams.get('limit')
        return EcoBranchHistoryService.getGraph(params.id, {
          designId: url.searchParams.get('designId'),
          limit: limitParam ? parseInt(limitParam, 10) : undefined,
        })
      },
    ),
  ),
)

// ============================================
// Checkout
// ============================================

// POST /api/change-orders/:id/checkout
app.post(
  '/:id/checkout',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['change_orders', 'update'] },
      async ({ request, params, user }) => {
        const { itemId } = await request.json()

        if (!itemId) {
          throw new ValidationError('itemId is required')
        }

        const result = await ChangeOrderService.checkoutItemToEco(
          params.id,
          itemId,
          user.id,
        )

        return created(result)
      },
    ),
  ),
)

// ============================================
// Conflict reviews
// ============================================

// GET /api/change-orders/:id/conflict-reviews
app.get(
  '/:id/conflict-reviews',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['change_orders', 'read'] },
      async ({ params }) => {
        const reviews = await ConflictReviewService.getReviewsForEco(params.id)

        return reviews
      },
    ),
  ),
)

// POST /api/change-orders/:id/conflict-reviews
app.post(
  '/:id/conflict-reviews',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['change_orders', 'update'] },
      async ({ request, params, user }) => {
        const body = await request.json()
        const parsed = markConflictReviewedRequestSchema.parse(body)

        // Get the current conflict to compute signature
        const conflictResult =
          await ConflictDetectionService.detectConflictsForEco(params.id)

        // Find the matching conflict
        const conflict = conflictResult.conflicts.find((c) => {
          const matchesMasterId = c.itemMasterId === parsed.itemMasterId
          const matchesType = c.conflictType === parsed.conflictType
          const matchesTheirEco =
            (c.theirEcoId || null) === (parsed.theirEcoId || null)
          return matchesMasterId && matchesType && matchesTheirEco
        })

        if (!conflict) {
          throw new NotFoundError('Conflict')
        }

        // Only allow reviewing warning-level conflicts
        if (conflict.severity === 'error') {
          throw new ValidationError(
            'Cannot mark blocking conflicts as reviewed',
          )
        }

        const review = await ConflictReviewService.markAsReviewed(
          params.id,
          conflict,
          user.id,
          parsed.notes,
        )

        return created(review)
      },
    ),
  ),
)

// DELETE /api/change-orders/:id/conflict-reviews
app.delete(
  '/:id/conflict-reviews',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['change_orders', 'update'] },
      async ({ params, request }) => {
        // Get review ID from query params
        const url = new URL(request.url)
        const reviewId = url.searchParams.get('reviewId')

        if (!reviewId) {
          throw new ValidationError('reviewId query parameter required')
        }

        await ConflictReviewService.unmarkReview(reviewId, params.id)

        return { success: true }
      },
    ),
  ),
)

// ============================================
// Conflicts
// ============================================

// GET /api/change-orders/:id/conflicts
app.get(
  '/:id/conflicts',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['change_orders', 'read'] },
      async ({ params }) => {
        const result = await ConflictDetectionService.detectConflictsForEco(
          params.id,
        )

        // Enrich conflicts with review status
        const enrichedConflicts =
          await ConflictReviewService.enrichConflictsWithReviewStatus(
            params.id,
            result.conflicts,
          )

        // Calculate reviewed/unreviewed counts for warnings
        const warningConflicts = enrichedConflicts.filter(
          (c) => c.severity === 'warning',
        )
        const reviewedWarnings = warningConflicts.filter(
          (c) => c.isReviewed && !c.needsReReview,
        ).length
        const unreviewedWarnings = warningConflicts.length - reviewedWarnings

        return {
          ...result,
          conflicts: enrichedConflicts,
          summary: {
            ...result.summary,
            reviewedWarnings,
            unreviewedWarnings,
          },
        }
      },
    ),
  ),
)

// ============================================
// Designs
// ============================================

// GET /api/change-orders/:id/designs
app.get(
  '/:id/designs',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['change_orders', 'read'] },
      async ({ params }) => {
        const ecoDesigns = await ChangeOrderService.getEcoDesigns(params.id)

        return { designs: ecoDesigns }
      },
    ),
  ),
)

// POST /api/change-orders/:id/designs
app.post(
  '/:id/designs',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['change_orders', 'update'] },
      async ({ request, params, user }) => {
        const { designId } = await request.json()

        if (!designId) {
          throw new ValidationError('designId is required')
        }

        const ecoDesign = await ChangeOrderService.addDesignToEco(
          params.id,
          designId,
          user.id,
        )

        return created({ ecoDesign })
      },
    ),
  ),
)

// ============================================
// Design structure
// ============================================

// GET /api/change-orders/:id/designs/:designId/structure
app.get(
  '/:id/designs/:designId/structure',
  adapt(
    apiHandler<{ id: string; designId: string }>(
      { permission: ['change_orders', 'read'] },
      async ({ request, params }) => {
        const url = new URL(request.url, 'http://localhost')
        return EcoStructureService.getDesignStructure(
          params.id,
          params.designId,
          {
            expandExternal: url.searchParams.get('expandExternal') !== 'false',
          },
        )
      },
    ),
  ),
)

// ============================================
// Impact assessment
// ============================================

// GET /api/change-orders/:id/impact-assessment
app.get(
  '/:id/impact-assessment',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['change_orders', 'read'] },
      async ({ params }) => {
        const { id } = params

        const impactReport = await ChangeOrderService.getImpactReport(id)

        if (!impactReport) {
          throw new NotFoundError('Impact assessment', id)
        }

        // Flatten reportData so it matches the ImpactAnalysis shape
        const reportData = impactReport.reportData as {
          summary?: { totalImpactedItems?: number; maxDepth?: number }
          [key: string]: unknown
        }
        return {
          impactReport: {
            ...impactReport,
            reportData: {
              ...reportData,
              totalImpactedItems:
                reportData.summary?.totalImpactedItems ??
                impactReport.totalImpactedItems,
              maxDepth:
                reportData.summary?.maxDepth ?? impactReport.maxBOMDepth,
            },
          },
        }
      },
    ),
  ),
)

// POST /api/change-orders/:id/impact-assessment
app.post(
  '/:id/impact-assessment',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['change_orders', 'update'] },
      async ({ params, request }) => {
        const { id } = params
        const body = await request.json().catch(() => ({}))

        const options = {
          maxDepth: body.maxDepth || 15,
          includeDocuments: body.includeDocuments !== false,
          includeCrossChanges: body.includeCrossChanges !== false,
        }

        const impactAnalysis = await ImpactAssessmentService.analyzeImpact(
          id,
          options,
        )

        return { impactAnalysis }
      },
    ),
  ),
)

// ============================================
// Items / ancestors
// ============================================

// GET /api/change-orders/:id/items/:itemId/ancestors
app.get(
  '/:id/items/:itemId/ancestors',
  adapt(
    apiHandler<{ id: string; itemId: string }>(
      { permission: ['change_orders', 'read'] },
      async ({ params, request }) => {
        const { id: changeOrderId, itemId } = params

        // Get designId from query params
        const url = new URL(request.url)
        const designId = url.searchParams.get('designId')

        if (!designId) {
          throw new ValidationError('designId query parameter is required')
        }

        // Get the target item details
        const item = await ItemService.findById(itemId)
        if (!item) {
          throw new NotFoundError('Item', itemId)
        }

        // Find ancestors within the design, as the change order's own branches
        // see it — a parent added to the assembly on this branch is a parent
        // the user needs to decide about
        const ecoBranchIds = (
          await ChangeOrderService.getEcoDesigns(changeOrderId)
        )
          .map((d) => d.branchId)
          .filter((id): id is string => id !== null)

        const allAncestors = await ImpactAssessmentService.findAncestorChain(
          itemId,
          designId,
          { branchIds: ecoBranchIds },
        )

        // Filter out ancestors already in this change order
        const affectedItems =
          await ChangeOrderService.getAffectedItems(changeOrderId)
        const affectedItemIds = new Set(
          affectedItems.map((ai) => ai.affectedItemId),
        )
        const ancestors = allAncestors.filter(
          (a) => !affectedItemIds.has(a.itemId),
        )

        // Count released vs draft ancestors (only those not already in ECO)
        const releasedCount = ancestors.filter(
          (a) => a.state === 'Released',
        ).length
        const draftCount = ancestors.filter((a) => a.state === 'Draft').length

        return {
          item: {
            id: item.id,
            itemNumber: item.itemNumber,
            name: item.name,
            revision: item.revision,
            state: item.state,
            itemType: item.itemType,
          },
          ancestors,
          releasedCount,
          draftCount,
        }
      },
    ),
  ),
)

// ============================================
// Release
// ============================================

// GET /api/change-orders/:id/release
app.get(
  '/:id/release',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['change_orders', 'read'] },
      async ({ params }) => {
        const preview = await ChangeOrderMergeService.previewMerge(params.id)

        return preview
      },
    ),
  ),
)

// ============================================
// Resolve conflicts
// ============================================

interface ResolveConflictRequest {
  resolutions: Array<{
    itemId: string // itemMasterId
    resolution: ConflictResolution
  }>
}

// POST /api/change-orders/:id/resolve-conflicts
app.post(
  '/:id/resolve-conflicts',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['change_orders', 'update'] },
      async ({ request, params }) => {
        const changeOrderId = params.id

        const body: ResolveConflictRequest = await request.json()

        if (!Array.isArray(body.resolutions)) {
          throw new ValidationError('resolutions array is required')
        }

        // Get all ECO designs with branches
        const ecoDesigns = await ChangeOrderService.getEcoDesigns(changeOrderId)
        const designsWithBranches = ecoDesigns.filter((d) => d.branchId)

        const results: Array<{
          itemId: string
          resolution: ConflictResolution
          success: boolean
          error?: string
        }> = []

        for (const { itemId, resolution } of body.resolutions) {
          try {
            switch (resolution) {
              case 'keep_ours':
                // Update the ECO branch's baseItemId to main's current
                // This acknowledges the conflict but keeps our changes
                for (const ecoDesign of designsWithBranches) {
                  if (!ecoDesign.branchId) continue

                  const mainBranch = await BranchService.getMainBranch(
                    ecoDesign.designId,
                  )
                  if (!mainBranch) continue

                  // Get main's current item for this itemMasterId
                  const mainBranchItem = await db
                    .select()
                    .from(branchItems)
                    .where(
                      and(
                        eq(branchItems.branchId, mainBranch.id),
                        eq(branchItems.itemMasterId, itemId),
                      ),
                    )
                    .limit(1)
                    .then((r) => r.at(0))

                  if (mainBranchItem?.currentItemId) {
                    // Update our branch's baseItemId to match main's current
                    // This "rebases" our changes on top of the new main
                    await db
                      .update(branchItems)
                      .set({
                        baseItemId: mainBranchItem.currentItemId,
                      })
                      .where(
                        and(
                          eq(branchItems.branchId, ecoDesign.branchId),
                          eq(branchItems.itemMasterId, itemId),
                        ),
                      )
                  }
                }
                results.push({ itemId, resolution, success: true })
                break

              case 'keep_theirs':
                // Discard our changes and use main's version
                for (const ecoDesign of designsWithBranches) {
                  if (!ecoDesign.branchId) continue

                  const mainBranch = await BranchService.getMainBranch(
                    ecoDesign.designId,
                  )
                  if (!mainBranch) continue

                  // Get main's current item
                  const mainBranchItem = await db
                    .select()
                    .from(branchItems)
                    .where(
                      and(
                        eq(branchItems.branchId, mainBranch.id),
                        eq(branchItems.itemMasterId, itemId),
                      ),
                    )
                    .limit(1)
                    .then((r) => r.at(0))

                  if (mainBranchItem?.currentItemId) {
                    // Update our branch to use main's version
                    // Clear changeType since we're not actually changing anything
                    await db
                      .update(branchItems)
                      .set({
                        currentItemId: mainBranchItem.currentItemId,
                        baseItemId: mainBranchItem.currentItemId,
                        changeType: null, // No longer a change
                      })
                      .where(
                        and(
                          eq(branchItems.branchId, ecoDesign.branchId),
                          eq(branchItems.itemMasterId, itemId),
                        ),
                      )
                  }
                }
                results.push({ itemId, resolution, success: true })
                break

              case 'skip':
                // Remove this item from the ECO entirely
                for (const ecoDesign of designsWithBranches) {
                  if (!ecoDesign.branchId) continue

                  // Delete the branch item record for this item on the ECO branch
                  await db
                    .delete(branchItems)
                    .where(
                      and(
                        eq(branchItems.branchId, ecoDesign.branchId),
                        eq(branchItems.itemMasterId, itemId),
                      ),
                    )
                }
                results.push({ itemId, resolution, success: true })
                break

              default:
                results.push({
                  itemId,
                  resolution,
                  success: false,
                  error: `Unknown resolution type: ${resolution}`,
                })
            }
          } catch (error) {
            results.push({
              itemId,
              resolution,
              success: false,
              error: (error as Error).message,
            })
          }
        }

        const allSuccess = results.every((r) => r.success)

        // 207 Multi-Status when only some resolutions applied
        return jsonResponse(
          { success: allSuccess, results },
          allSuccess ? 200 : 207,
        )
      },
    ),
  ),
)

// ============================================
// Risks
// ============================================

// GET /api/change-orders/:id/risks
app.get(
  '/:id/risks',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['change_orders', 'read'] },
      async ({ params }) => {
        const { id } = params

        const risks = await ChangeOrderService.getRisks(id)

        return { risks }
      },
    ),
  ),
)

// POST /api/change-orders/:id/risks
app.post(
  '/:id/risks',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['change_orders', 'update'] },
      async ({ params, request, user }) => {
        const url = new URL(request.url)
        const riskId = url.searchParams.get('riskId')

        if (!riskId) {
          throw new ValidationError('Missing riskId parameter')
        }

        await ChangeOrderService.acknowledgeRiskForChangeOrder(
          params.id,
          riskId,
          user.id,
        )

        return { success: true }
      },
    ),
  ),
)

// ============================================
// Summary
// ============================================

// GET /api/change-orders/:id/summary
app.get(
  '/:id/summary',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['change_orders', 'read'] },
      async ({ params }) => {
        const summary = await ChangeOrderService.getEcoSummary(params.id)

        return summary
      },
    ),
  ),
)

// ============================================
// Workflow
// ============================================

// GET /api/change-orders/:id/workflow/history
app.get(
  '/:id/workflow/history',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['change_orders', 'read'] },
      async ({ params }) => {
        const instance = await WorkflowService.getInstanceByItemId(params.id)

        if (!instance) {
          throw new NotFoundError('Workflow for change order', params.id)
        }

        const history = await WorkflowService.getHistory(instance.id)

        return { history }
      },
    ),
  ),
)

// GET /api/change-orders/:id/workflow/structure
app.get(
  '/:id/workflow/structure',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['change_orders', 'read'] },
      async ({ params }) => {
        const instance = await WorkflowService.getInstanceByItemId(params.id)
        if (!instance) {
          throw new NotFoundError('Workflow instance', params.id)
        }

        const structure = await WorkflowService.getEffectiveStructure(
          instance.id,
        )

        return {
          ...structure,
          currentState: instance.currentState,
          instanceId: instance.id,
        }
      },
    ),
  ),
)

// PUT /api/change-orders/:id/workflow/structure
app.put(
  '/:id/workflow/structure',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['change_orders', 'update'] },
      async ({ request, params, user }) => {
        const instance = await WorkflowService.getInstanceByItemId(params.id)
        if (!instance) {
          throw new NotFoundError('Workflow instance', params.id)
        }

        // Check if workflow is flexible and editable
        const isEditable = await WorkflowService.isFlexibleAndEditable(
          instance.id,
        )
        if (!isEditable) {
          throw new ValidationError(
            'Workflow is not flexible or is already completed',
          )
        }

        const body = (await request.json()) as Partial<{
          states: Array<WorkflowState>
          transitions: Array<InstanceWorkflowTransition>
        }>

        if (!body.states || !body.transitions) {
          throw new ValidationError('states and transitions are required')
        }

        const result = await WorkflowService.updateInstanceStructure(
          instance.id,
          body.states,
          body.transitions,
          user.id,
        )

        if (!result.success) {
          throw new ValidationError(result.error || 'Failed to update')
        }

        return { success: true }
      },
    ),
  ),
)

// GET /api/change-orders/:id/workflow/states/:stateId/approvers
// Instance-level approvers for one state (WI-4.2) — the editable set for
// flexible workflows; definition-level approvers ride along read-only via
// the /approvals endpoints.
app.get(
  '/:id/workflow/states/:stateId/approvers',
  adapt(
    apiHandler<{ id: string; stateId: string }>(
      { permission: ['change_orders', 'read'] },
      async ({ params }) => {
        const instance = await WorkflowService.getInstanceByItemId(params.id)
        if (!instance) {
          throw new NotFoundError('Workflow instance', params.id)
        }

        const approvers = await WorkflowApprovalService.getInstanceApprovers(
          instance.id,
          params.stateId,
        )

        return { approvers }
      },
    ),
  ),
)

// PUT /api/change-orders/:id/workflow/states/:stateId/approvers
app.put(
  '/:id/workflow/states/:stateId/approvers',
  adapt(
    apiHandler<{ id: string; stateId: string }>(
      { permission: ['change_orders', 'update'] },
      async ({ request, params, user }) => {
        const instance = await WorkflowService.getInstanceByItemId(params.id)
        if (!instance) {
          throw new NotFoundError('Workflow instance', params.id)
        }

        // Same editability gate as the structure endpoint: approvers are
        // part of the instance-level workflow configuration
        const isEditable = await WorkflowService.isFlexibleAndEditable(
          instance.id,
        )
        if (!isEditable) {
          throw new ValidationError(
            'Workflow is not flexible or is already completed',
          )
        }

        const body = (await request.json()) as {
          approvers?: Array<{
            type?: string
            id?: string
            isRequired?: boolean
          }>
        }
        if (!Array.isArray(body.approvers)) {
          throw new ValidationError('approvers must be an array')
        }
        for (const approver of body.approvers) {
          if (
            (approver.type !== 'user' && approver.type !== 'role') ||
            !approver.id
          ) {
            throw new ValidationError(
              "each approver needs a type of 'user' or 'role' and an id",
            )
          }
        }

        // The state must exist on the instance's effective structure
        const structure = await WorkflowService.getEffectiveStructure(
          instance.id,
        )
        if (!structure.states.some((s) => s.id === params.stateId)) {
          throw new ValidationError(
            `State "${params.stateId}" does not exist on this workflow`,
          )
        }

        const approvers = await WorkflowApprovalService.setInstanceApprovers(
          instance.id,
          params.stateId,
          body.approvers.map((a) => ({
            type: a.type as 'user' | 'role',
            id: a.id!,
            isRequired: a.isRequired ?? true,
          })),
          user.id,
        )

        return { approvers }
      },
    ),
  ),
)

// GET /api/change-orders/:id/workflow/transition
app.get(
  '/:id/workflow/transition',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['change_orders', 'read'] },
      async ({ params, user }) => {
        const instance = await WorkflowService.getInstanceByItemId(params.id)

        if (!instance) {
          throw new NotFoundError('Workflow', params.id, {
            detail: 'No workflow found for this change order',
          })
        }

        // Fetch actual user roles for guard evaluation
        const userWithRoles = await UserService.getUserById(user.id)
        const userRoleNames = userWithRoles?.roles.map((r) => r.name) ?? []

        // Build context for guard evaluation
        const context = {
          item: {}, // Will be populated by the service
          user: { id: user.id, roles: userRoleNames },
        }

        const availableTransitions =
          await WorkflowService.getAvailableTransitions(instance.id, context)

        return { transitions: availableTransitions }
      },
    ),
  ),
)

// POST /api/change-orders/:id/workflow/transition
app.post(
  '/:id/workflow/transition',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['change_orders', 'update'] },
      async ({ params, request, user }) => {
        const data = await request.json()

        if (!data.toStateId) {
          throw new ValidationError('toStateId is required')
        }

        // All orchestration (finalKind resolution, release claim, merge or
        // cancel interlock) lives in the service so every entry point — this
        // route, the AI tools, submit/approve/reject — shares one behavior
        const outcome = await ChangeOrderService.executeWorkflowTransition(
          params.id,
          data.toStateId,
          user.id,
          data.comments,
        )

        if (!outcome.result.success) {
          throw new ValidationError(outcome.result.error || 'Transition failed')
        }

        if (outcome.cancelled) {
          return {
            success: true,
            fromState: outcome.result.fromState,
            toState: data.toStateId,
            cancelled: true,
          }
        }

        if (outcome.mergeResult) {
          return {
            success: true,
            fromState: outcome.result.fromState,
            toState: data.toStateId,
            mergeResult: outcome.mergeResult,
          }
        }

        return outcome.result
      },
    ),
  ),
)

// POST /api/change-orders/:id/workflow/validate-transition
app.post(
  '/:id/workflow/validate-transition',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['change_orders', 'read'] },
      async ({ request, params, user }) => {
        const data = await request.json()

        if (!data.toStateId) {
          throw new ValidationError('toStateId is required')
        }

        // Get workflow instance
        const instance = await WorkflowService.getInstanceByItemId(params.id)
        if (!instance) {
          throw new NotFoundError('Workflow for change order', params.id)
        }

        // Get effective structure (handles flexible workflows with instance-level overrides)
        const effectiveStructure = await WorkflowService.getEffectiveStructure(
          instance.id,
        )

        // Find the transition from effective structure
        const transition = effectiveStructure.transitions.find(
          (t) =>
            t.fromStateId === instance.currentState &&
            t.toStateId === data.toStateId,
        )

        if (!transition) {
          return {
            valid: false,
            error: 'No valid transition from current state to target state',
          }
        }

        // Get actual user roles for guard evaluation
        const userWithRoles = await UserService.getUserById(user.id)
        const userRoleNames = userWithRoles?.roles.map((r) => r.name) ?? []

        // Check basic transition possibility (guards)
        const canTransitionResult = await WorkflowService.canTransition(
          instance.id,
          data.toStateId,
          {
            item: {},
            user: { id: user.id, roles: userRoleNames },
            workflowInstance: instance,
          },
        )

        if (!canTransitionResult.allowed) {
          return {
            valid: false,
            workflowGuardErrors: canTransitionResult.reasons,
            lifecycleEffectErrors: [],
            affectedItemsPreview: [],
          }
        }

        // Preview what completing this transition will do to affected items.
        // changeActionMappings are the single mechanism for ECO-driven state
        // change, applied by the merge — so a meaningful preview exists only
        // when the target state releases (finalKind 'release').
        const targetState = effectiveStructure.states.find(
          (s) => s.id === data.toStateId,
        )
        const isReleaseTarget =
          targetState?.isFinal === true && targetState.finalKind === 'release'

        const affectedItems = await ChangeOrderService.getAffectedItems(
          params.id,
        )
        // Kept under its historical name for API/UI compatibility; now
        // sourced from the mappings the merge will actually apply
        const lifecycleEffectErrors: Array<string> = []
        const affectedItemsPreview = await Promise.all(
          affectedItems.map(async (affected) => {
            const item = affected.affectedItemDetails
            if (!item) {
              return {
                itemId: affected.affectedItemId,
                itemNumber: null,
                changeAction: affected.changeAction,
                currentState: null,
                predictedTransitions: [],
              }
            }

            const predictedTransitions: Array<{
              fromState: string
              toState: string
              lifecycleName: string
            }> = []

            if (isReleaseTarget) {
              const validation = await LifecycleService.canApplyAction(
                item.itemType,
                item.state || '',
                affected.changeAction,
                { drivingLifecycleId: instance.workflowDefinitionId },
              )
              if (!validation.valid) {
                lifecycleEffectErrors.push(
                  `${item.itemNumber}: ${validation.error}`,
                )
              } else {
                const target = await LifecycleService.getTargetState(
                  item.itemType,
                  affected.changeAction,
                )
                if (target && target !== item.state) {
                  const lifecycle =
                    await LifecycleService.getLifecycleForItemType(
                      item.itemType,
                    )
                  predictedTransitions.push({
                    fromState: item.state || '',
                    toState: target,
                    lifecycleName:
                      lifecycle?.name || `${item.itemType} lifecycle`,
                  })
                }
              }
            }

            return {
              itemId: affected.affectedItemId,
              itemNumber: item.itemNumber,
              changeAction: affected.changeAction,
              currentState: item.state,
              predictedTransitions,
            }
          }),
        )

        // Guard failures already returned above; what remains is whether the
        // mappings would accept the release — a release they would reject is
        // not a valid transition, and the preview says so up front instead
        // of discovering it at merge time
        const valid = lifecycleEffectErrors.length === 0

        return {
          valid,
          workflowGuardErrors: [],
          lifecycleEffectErrors,
          affectedItemsPreview: affectedItemsPreview.filter(
            (p) => p.predictedTransitions.length > 0,
          ),
          transitionName: transition.name,
          fromState: instance.currentState,
          toState: data.toStateId,
        }
      },
    ),
  ),
)

// GET /api/change-orders/:id/workflow
app.get(
  '/:id/workflow',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['change_orders', 'read'] },
      async ({ params }) => {
        const instance = await WorkflowService.getInstanceByItemId(params.id)

        if (!instance) {
          return { instance: null }
        }

        // Get the workflow definition for context
        const definition = await WorkflowService.getById(
          instance.workflowDefinitionId,
        )

        // For flexible workflows, get effective structure with instance-level states
        const effectiveStructure = await WorkflowService.getEffectiveStructure(
          instance.id,
        )

        // Create an "effective definition" that uses instance-level states if available
        const effectiveDefinition = definition
          ? {
              ...definition,
              states: effectiveStructure.states,
              transitions: effectiveStructure.transitions,
            }
          : null

        return {
          instance,
          definition: effectiveDefinition,
          isFlexible: definition?.workflowType === 'flexible',
        }
      },
    ),
  ),
)

// POST /api/change-orders/:id/workflow
app.post(
  '/:id/workflow',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['change_orders', 'update'] },
      async ({ request, params, user }) => {
        const data = await request.json()

        // Check if workflow already exists
        const existingInstance = await WorkflowService.getInstanceByItemId(
          params.id,
        )
        if (existingInstance) {
          throw new AlreadyExistsError('Workflow', params.id)
        }

        const instance = await WorkflowService.startInstance(
          data.workflowDefinitionId,
          params.id,
          { actorId: user.id },
        )

        return created({ instance })
      },
    ),
  ),
)

export default app
