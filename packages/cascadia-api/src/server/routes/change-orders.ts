// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { z } from 'zod'
import { tagged } from '../adapter'
import type { ChangeOrder } from '@/lib/items/types/change-order'
import type { SessionUser } from '@/lib/auth/session'
import { ApprovalRegistry } from '@/lib/lifecycles/approval-registry'
import { changeActionSchema } from '@/lib/items/types/change-order'
import { ItemService } from '@/lib/items/services/ItemService'
import { LifecycleService } from '@/lib/services/LifecycleService'
import { ChangeOrderService } from '@/lib/items/services/ChangeOrderService'
import { ChangeOrderMergeService } from '@/lib/services/ChangeOrderMergeService'
import { ImpactAssessmentService } from '@/lib/items/services/ImpactAssessmentService'
import { ConflictDetectionService } from '@/lib/services/ConflictDetectionService'
import { ConflictReviewService } from '@/lib/services/ConflictReviewService'
import { ChangeOrderBranchHistoryService } from '@/lib/services/ChangeOrderBranchHistoryService'
import { ChangeOrderStructureService } from '@/lib/services/ChangeOrderStructureService'
import { LifecycleDefinitionService } from '@/lib/lifecycles/LifecycleDefinitionService'
import { LifecycleInstanceService } from '@/lib/lifecycles/LifecycleInstanceService'
import { ApprovalService } from '@/lib/lifecycles/ApprovalService'
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
import {
  requireChangeOrderAccess,
  requireDesignAccess,
  resolveChangeOrderDesignScope,
} from '@/lib/auth/access'
import { markConflictReviewedRequestSchema } from '@/lib/services/types/conflict-review'
import {
  changeOrderUpdateSchema,
  stateApproverInputSchema,
  workflowStateSchema,
  workflowTransitionSchema,
} from '@/lib/api/schemas'
import '@/lib/items/registerItemTypes.server'

const adapt = tagged('Change Orders')

const app = new Hono()

/**
 * Assert the caller reaches the *whole* change order, not merely part of it.
 *
 * For the views that can be redacted — affected items, the design list, the
 * summary — a partial reader gets their share plus a flag. These are the ones
 * that cannot: an impact report and a conflict set are generated structures
 * that name items from every design the ECO touches, in shapes that grow as
 * the analysis grows. Redacting them field by field would be a guess about
 * what the next field contains, so they are refused whole instead.
 *
 * Not silent: the detail page already knows from `hasRestricted` that part of
 * this ECO is out of reach, so a refusal here reads as that same boundary
 * rather than as a malfunction.
 */
async function requireWholeChangeOrder(
  userId: string,
  changeOrderId: string,
): Promise<void> {
  const { hasRestricted } = await requireChangeOrderAccess(
    userId,
    changeOrderId,
  )
  if (hasRestricted) {
    throw new PermissionDeniedError('the whole change order', 'read')
  }
}

/**
 * Program-membership gate for approval votes.
 *
 * RBAC (change_orders:update on the route) says the user may vote on change
 * orders in general; this says they may vote on *this* one. A change order
 * spans designs, each resolving to a program, and the designs are equal —
 * so voting requires membership with `canApproveEco` in *every* program the
 * ECO touches. Approving half a change order is not a thing: the vote carries
 * the whole ECO towards a release that merges every design's branch.
 *
 * Designs outside any program impose no gate — nothing to be a member of.
 * Cross-program authority bypasses. An ECO with no design links at all is
 * reachable by cross-program authority alone, matching the list rule in
 * `accessScopeCondition`.
 *
 * This used to read `eco.designId`, a single design, and return early when it
 * was NULL. Every ECO the application creates leaves that column NULL — the
 * designs live in `change_order_designs` — so the gate admitted everyone on
 * every real change order, and the test covering it passed only because it
 * built an ECO shape the app never produces.
 *
 * Runs before the workflow-instance lookup so a denial is a clean 403
 * regardless of workflow configuration.
 */
async function requireChangeOrderApprovalAccess(
  userId: string,
  changeOrderItemId: string,
): Promise<void> {
  const changeOrder = await ItemService.findById(changeOrderItemId)
  if (!changeOrder) {
    throw new NotFoundError('ChangeOrder', changeOrderItemId)
  }

  if (await AccessControlService.hasCrossProgramAccess(userId)) return

  const { linked } = await resolveChangeOrderDesignScope(
    userId,
    changeOrderItemId,
  )
  if (linked.length === 0) {
    throw new PermissionDeniedError('change order approval', 'submit')
  }

  for (const designId of linked) {
    const design = await DesignService.getById(designId)
    if (!design?.programId) continue

    const member = await ProgramService.getMember(design.programId, userId)
    if (!member || !member.canApproveEco) {
      throw new PermissionDeniedError('change order approval', 'submit')
    }
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
// filtering. Query params: designId, programId, limit, offset.
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
        // (which every role has). The unfiltered list is bounded by the
        // caller's own reach, below.
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

        // The unfiltered list below is bounded by nothing else, so the
        // caller's own reach is what bounds it. Resolved once and shared with
        // the counts, which must agree with the rows they sit above.
        const accessScope = await AccessControlService.getAccessScope(user.id)

        // One ordered query for the page and its total; a design filter
        // wins when both are given, as it always has
        if (designId) {
          return ChangeOrderService.listByScope({ designId }, { limit, offset })
        }
        if (programId) {
          return ChangeOrderService.listByScope(
            { programId },
            { limit, offset },
          )
        }

        const result = await ItemService.search('ChangeOrder', {
          limit,
          offset,
          accessScope,
        })

        const response: Record<string, unknown> = {
          changeOrders: result.items,
          total: result.total,
        }
        return response
      },
    ),
  ),
)

// GET /api/change-orders/editable
//
// The ECO picker's feed — the change orders still accepting affected items.
// Scoped on the same axis, and with the same two moves, as the sibling list
// above: a named `designId` is a design-scoped read and is gated as one, and
// the query is bounded by the caller's accessible designs whether or not a
// filter is given, so omitting every parameter cannot mean "no scoping at
// all". Until this landed the route took no user at all and answered with
// every editable ECO on the instance to anyone holding `change_orders:read`,
// which every built-in role does.
//
// The `designId` gate is `requireDesignAccess`, not an empty list, and that
// differs from the reasoning `GET /api/v1/physical-parts` records for its
// `partMasterId` filter. There the refusal would have been an existence
// oracle, because the by-id gate answers NotFound for a lineage that does not
// exist and PermissionDenied for one that does. `requireDesignAccess` has no
// such split — it throws PermissionDeniedError identically for a design that
// is absent and one that is merely out of reach — so the refusal discloses
// nothing, and matching the sibling matters more than matching the other
// route's shape.
app.get(
  '/editable',
  adapt(
    apiHandler(
      { permission: ['change_orders', 'read'] },
      async ({ request, user }) => {
        const url = new URL(request.url)
        const designId = url.searchParams.get('designId') ?? undefined

        if (designId) {
          await requireDesignAccess(user.id, designId)
        }

        const editable = await ChangeOrderService.getEditableChangeOrders({
          designId,
          accessDesignIds: await AccessControlService.getAccessibleDesignIds(
            user.id,
          ),
        })

        return { changeOrders: editable }
      },
    ),
  ),
)

// POST /api/change-orders - the one door for creating a change order.
//
// `POST /api/v1/items` refuses itemType 'ChangeOrder' and points here, because
// an ECO is not created until its designs are attached, and a two-request
// create cannot promise that.
const createChangeOrderSchema = z
  .object({
    designIds: z.array(z.string().uuid()).min(1, {
      message: 'A change order must be created against at least one design',
    }),
  })
  .passthrough()

app.post(
  '/',
  adapt(
    apiHandler(
      {
        body: createChangeOrderSchema,
        permission: ['change_orders', 'create'],
        openapi: {
          summary: 'Create a change order against one or more designs',
        },
      },
      async ({ body: { designIds, ...data }, user }) => {
        // Per design, not once for a nominated one: the designs are equal, so
        // creating an ECO that reaches into a program means being entitled to
        // create there. The equivalent check on the items route hung off
        // `itemData.designId` and so never ran for a real ECO.
        for (const designId of designIds) {
          await requireDesignAccess(user.id, designId)

          const design = await DesignService.getById(designId)
          if (!design?.programId) continue

          const member = await ProgramService.getMember(
            design.programId,
            user.id,
          )
          if (member && !member.canCreateEco) {
            throw new PermissionDeniedError('change order', 'create')
          }
        }

        // Designs, branches and the running workflow are all part of the
        // creation; a failure in any of them leaves no change order behind
        const changeOrder = await ChangeOrderService.create(
          data,
          designIds,
          user.id,
        )

        return created({ changeOrder })
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
      async ({ params, user }) => {
        const changeOrder = await ItemService.findById(params.id)
        if (!changeOrder) throw new NotFoundError('Change order', params.id)

        // The list is bounded by the caller's designs; the point read has to
        // draw the same boundary or the id is the whole authorization.
        // `hasRestricted` tells the detail view that this ECO reaches beyond
        // what the caller may see — see the redaction note on
        // `getAffectedItemsForViewer`.
        const { hasRestricted } = await requireChangeOrderAccess(
          user.id,
          params.id,
        )
        return { changeOrder, hasRestricted }
      },
    ),
  ),
)

// PUT /api/change-orders/:id
app.put(
  '/:id',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof changeOrderUpdateSchema>>(
      {
        permission: ['change_orders', 'update'],
        body: changeOrderUpdateSchema,
        access: ({ params, user }) =>
          requireChangeOrderAccess(user.id, params.id),
      },
      async ({ params, body, user }) => {
        // The schema permits `null` where the column is nullable, which the
        // ChangeOrder interface spells as an absent optional. `ItemService`
        // and the type handler both read null as "clear the column".
        const changeOrder = await ItemService.update<ChangeOrder>(
          params.id,
          body as Partial<ChangeOrder>,
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
        await requireChangeOrderAccess(user.id, params.id)
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
      async ({ params, user }) => {
        const { id } = params

        await requireChangeOrderAccess(user.id, id)
        const { affectedItems, hasRestricted } =
          await ChangeOrderService.getAffectedItemsForViewer(
            id,
            await AccessControlService.getAccessibleDesignIds(user.id),
          )

        return { affectedItems, hasRestricted }
      },
    ),
  ),
)

// POST /api/change-orders/:id/affected-items
app.post(
  '/:id/affected-items',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof addAffectedItemsRequestSchema>>(
      {
        body: addAffectedItemsRequestSchema,
        permission: ['change_orders', 'update'],
        openapi: {
          summary: 'Add one or more affected items to a change order',
        },
        access: ({ params, user }) =>
          requireChangeOrderAccess(user.id, params.id),
      },
      async ({ body: data, params, user }) => {
        const { id } = params

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

/**
 * Body of the affected-items preview. It was written out twice — once in the
 * annotation and once in the handler — which is the drift this option exists
 * to make impossible.
 */
const previewActionsSchema = z.object({
  itemIds: z.array(z.string().uuid()).min(1).max(500),
})

// POST /api/change-orders/:id/affected-items/preview - what adding these
// items would do, resolved from each item's lifecycle. Read-only; POST so a
// large selection is not squeezed into a query string.
app.post(
  '/:id/affected-items/preview',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof previewActionsSchema>>(
      {
        body: previewActionsSchema,
        permission: ['change_orders', 'read'],
        openapi: {
          summary: 'Preview the change actions available for items',
        },
        access: ({ params, user }) =>
          requireChangeOrderAccess(user.id, params.id),
      },
      async ({ body: { itemIds }, params }) => {
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
      async ({ params, request, user }) => {
        await requireChangeOrderAccess(user.id, params.id)
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
        await requireChangeOrderAccess(user.id, params.id)
        // Get the workflow instance for this change order
        const instance = await LifecycleInstanceService.getInstanceByItemId(
          params.id,
        )

        if (!instance) {
          throw new NotFoundError(
            'Workflow instance for change order',
            params.id,
          )
        }

        // Check if user can approve
        const canApprove = await ApprovalService.canUserApprove(
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
        await requireChangeOrderAccess(user.id, params.id)
        // Get the workflow instance for this change order
        const instance = await LifecycleInstanceService.getInstanceByItemId(
          params.id,
        )

        if (!instance) {
          throw new NotFoundError(
            'Workflow instance for change order',
            params.id,
          )
        }

        // Get all approvals for this instance
        const approvals = await ApprovalService.getApprovals(instance.id)

        // Check if current user can approve at current state
        const canApprove = await ApprovalService.canUserApprove(
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

/**
 * An approval vote.
 *
 * **Passthrough, deliberately.** `ApprovalRegistry.buildExtras` hands the raw
 * body to every registered interceptor, and the advanced-auditing module reads
 * `password` and `signatureMeaning` off it to build the digital signature. A
 * schema that stripped unknown keys would leave a signed instance quietly
 * unable to sign — the vote would land, unsigned, with no error anywhere. Core
 * validates what core reads and lets the modules' own fields through.
 */
const approvalVoteSchema = z
  .object({
    vote: z.enum(['approved', 'rejected'], {
      message: "vote must be 'approved' or 'rejected'",
    }),
    roleId: z.string().uuid().optional(),
    comments: z.string().max(10000).optional(),
  })
  .passthrough()

// POST /api/change-orders/:id/approvals
app.post(
  '/:id/approvals',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof approvalVoteSchema>>(
      {
        permission: ['change_orders', 'update'],
        body: approvalVoteSchema,
        access: ({ params, user }) =>
          requireChangeOrderApprovalAccess(user.id, params.id),
      },
      async ({ request, body: data, params, user, requestId }) => {
        // Reach before body. A caller outside every design this ECO touches
        // gets 403, not a 400 telling them what a valid vote looks like.
        // The body schema runs first now, so a malformed vote from someone
        // with no reach answers 400 rather than 403 — the access check still
        // runs before anything is written, which is what it guards.

        // Get the workflow instance for this change order
        const instance = await LifecycleInstanceService.getInstanceByItemId(
          params.id,
        )

        if (!instance) {
          throw new NotFoundError(
            'Workflow instance for change order',
            params.id,
          )
        }

        // Submit the approval
        const result = await ApprovalService.submitApproval(
          instance.id,
          instance.currentState,
          user.id,
          data.vote,
          data.roleId,
          data.comments,
          await approvalExtras(request, user, requestId, data),
        )

        // Get updated approval status
        const approvalStatus = await ApprovalService.getStateApprovals(
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
        await requireChangeOrderAccess(user.id, params.id)
        // Get the workflow instance for this change order
        const instance = await LifecycleInstanceService.getInstanceByItemId(
          params.id,
        )

        if (!instance) {
          throw new NotFoundError(
            'Workflow instance for change order',
            params.id,
          )
        }

        // Get approval status for the specific state
        const approvalStatus = await ApprovalService.getStateApprovals(
          instance.id,
          params.stateId,
        )

        // Check if current user can approve at this state
        const canApprove = await ApprovalService.canUserApprove(
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
    apiHandler<
      { id: string; stateId: string },
      z.infer<typeof approvalVoteSchema>
    >(
      {
        permission: ['change_orders', 'update'],
        body: approvalVoteSchema,
        access: ({ params, user }) =>
          requireChangeOrderApprovalAccess(user.id, params.id),
      },
      async ({ request, body: data, params, user, requestId }) => {
        // Reach before write; see the sibling route above.

        // Get the workflow instance for this change order
        const instance = await LifecycleInstanceService.getInstanceByItemId(
          params.id,
        )

        if (!instance) {
          throw new NotFoundError(
            'Workflow instance for change order',
            params.id,
          )
        }

        // Submit the approval for the specified state
        const result = await ApprovalService.submitApproval(
          instance.id,
          params.stateId,
          user.id,
          data.vote,
          data.roleId,
          data.comments,
          await approvalExtras(request, user, requestId, data),
        )

        // Get updated approval status
        const approvalStatus = await ApprovalService.getStateApprovals(
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
    apiHandler<{ id: string }, z.infer<typeof addBomChangeSchema>>(
      {
        permission: ['change_orders', 'update'],
        body: addBomChangeSchema,
        access: ({ params, user }) =>
          requireChangeOrderAccess(user.id, params.id),
      },
      async ({ params, body: data, user }) => {
        const { message } = await ChangeOrderService.applyBomChange(
          params.id,
          data,
          user.id,
        )
        // A new relationship is a created resource; the other two edit one
        return data.action === 'add'
          ? created({ success: true, message })
          : { success: true, message }
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
        await requireChangeOrderAccess(user.id, params.id)

        const url = new URL(request.url, 'http://localhost')
        const relationshipId = url.searchParams.get('relationshipId')
        if (!relationshipId) {
          throw new ValidationError(
            'relationshipId query parameter is required',
          )
        }

        await ChangeOrderService.removeBomRelationship(
          params.id,
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
      async ({ params, user }) => {
        await requireChangeOrderAccess(user.id, params.id)
        return ChangeOrderBranchHistoryService.getTimeline(params.id)
      },
    ),
  ),
)

// GET /api/change-orders/:id/branch-history/graph
app.get(
  '/:id/branch-history/graph',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['change_orders', 'read'] },
      async ({ request, params, user }) => {
        await requireChangeOrderAccess(user.id, params.id)
        const url = new URL(request.url, 'http://localhost')
        const limitParam = url.searchParams.get('limit')
        return ChangeOrderBranchHistoryService.getGraph(params.id, {
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
    apiHandler<{ id: string }, { itemId: string }>(
      {
        permission: ['change_orders', 'update'],
        body: z.object({ itemId: z.string().uuid() }),
        access: ({ params, user }) =>
          requireChangeOrderAccess(user.id, params.id),
      },
      async ({ body, params, user }) => {
        const { itemId } = body

        const result = await ChangeOrderService.checkoutItem(
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
      async ({ params, user }) => {
        await requireChangeOrderAccess(user.id, params.id)
        const reviews = await ConflictReviewService.getReviewsForChangeOrder(
          params.id,
        )

        return reviews
      },
    ),
  ),
)

// POST /api/change-orders/:id/conflict-reviews
app.post(
  '/:id/conflict-reviews',
  adapt(
    apiHandler<
      { id: string },
      z.infer<typeof markConflictReviewedRequestSchema>
    >(
      {
        permission: ['change_orders', 'update'],
        body: markConflictReviewedRequestSchema,
        access: ({ params, user }) =>
          requireChangeOrderAccess(user.id, params.id),
      },
      async ({ body: parsed, params, user }) => {
        // Get the current conflict to compute signature
        const conflictResult =
          await ConflictDetectionService.detectConflictsForChangeOrder(
            params.id,
          )

        // Find the matching conflict
        const conflict = conflictResult.conflicts.find((c) => {
          const matchesMasterId = c.itemMasterId === parsed.itemMasterId
          const matchesType = c.conflictType === parsed.conflictType
          const matchesTheirChangeOrder =
            (c.theirEcoId || null) === (parsed.theirEcoId || null)
          return matchesMasterId && matchesType && matchesTheirChangeOrder
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
      async ({ params, request, user }) => {
        await requireChangeOrderAccess(user.id, params.id)
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
      async ({ params, user }) => {
        await requireWholeChangeOrder(user.id, params.id)
        const result =
          await ConflictDetectionService.detectConflictsForChangeOrder(
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
      async ({ params, user }) => {
        await requireChangeOrderAccess(user.id, params.id)
        const { designs: changeOrderDesigns, hasRestricted } =
          await ChangeOrderService.getChangeOrderDesignsForViewer(
            params.id,
            await AccessControlService.getAccessibleDesignIds(user.id),
          )

        return { designs: changeOrderDesigns, hasRestricted }
      },
    ),
  ),
)

// POST /api/change-orders/:id/designs
app.post(
  '/:id/designs',
  adapt(
    apiHandler<{ id: string }, { designId: string }>(
      {
        permission: ['change_orders', 'update'],
        body: z.object({ designId: z.string().uuid() }),
        access: ({ params, user }) =>
          requireChangeOrderAccess(user.id, params.id),
      },
      async ({ body, params, user }) => {
        const { designId } = body

        const changeOrderDesign = await ChangeOrderService.addDesign(
          params.id,
          designId,
          user.id,
        )

        return created({ ecoDesign: changeOrderDesign })
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
      async ({ request, params, user }) => {
        // The design comes straight off the URL, so this is the whole gate:
        // without it a caller who reaches one of the ECO's designs could ask
        // for any other design's structure and get its full BOM tree back.
        await requireDesignAccess(user.id, params.designId)

        const url = new URL(request.url, 'http://localhost')
        return ChangeOrderStructureService.getDesignStructure(
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
      async ({ params, user }) => {
        const { id } = params

        await requireWholeChangeOrder(user.id, id)
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
    apiHandler<
      { id: string },
      {
        maxDepth: number
        includeDocuments: boolean
        includeCrossChanges: boolean
      }
    >(
      {
        permission: ['change_orders', 'update'],
        // An empty body is the ordinary case: every field has a default, and
        // the traversal depth is capped so a request cannot ask for a walk of
        // the whole graph.
        body: z.object({
          maxDepth: z.number().int().min(1).max(50).default(15),
          includeDocuments: z.boolean().default(true),
          includeCrossChanges: z.boolean().default(true),
        }),
        access: ({ params, user }) =>
          requireWholeChangeOrder(user.id, params.id),
      },
      async ({ params, body: options }) => {
        const impactAnalysis = await ImpactAssessmentService.analyzeImpact(
          params.id,
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
      async ({ params, request, user }) => {
        await requireChangeOrderAccess(user.id, params.id)
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
        const changeOrderBranchIds = (
          await ChangeOrderService.getChangeOrderDesigns(changeOrderId)
        )
          .map((d) => d.branchId)
          .filter((id): id is string => id !== null)

        const allAncestors = await ImpactAssessmentService.findAncestorChain(
          itemId,
          designId,
          { branchIds: changeOrderBranchIds },
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

        // Count released-lineage vs initial-state ancestors (only those not
        // already in the ECO), per each ancestor's own lifecycle
        const ancestorFlags = await Promise.all(
          ancestors.map(async (a) => ({
            released: await LifecycleService.isReleasedFamilyState(
              a.itemType,
              a.state,
            ),
            initial: await LifecycleService.isInitialState(a.itemType, a.state),
          })),
        )
        const releasedCount = ancestorFlags.filter((f) => f.released).length
        const draftCount = ancestorFlags.filter((f) => f.initial).length

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
      async ({ params, user }) => {
        await requireChangeOrderAccess(user.id, params.id)
        const preview = await ChangeOrderMergeService.previewMerge(params.id)

        return preview
      },
    ),
  ),
)

// ============================================
// Resolve conflicts
// ============================================

const resolveConflictsSchema = z.object({
  resolutions: z
    .array(
      z.object({
        // itemMasterId, despite the name the dialog sends.
        itemId: z.string().uuid(),
        resolution: z.enum(['keep_ours', 'keep_theirs', 'skip']),
        // Per-field overrides of the item-level choice, keyed by field name
        fieldResolutions: z
          .record(z.string(), z.enum(['ours', 'theirs']))
          .optional(),
      }),
    )
    .max(1000),
})

// POST /api/change-orders/:id/resolve-conflicts
//
// The arms live in `ChangeOrderService.resolveConflicts`: a three-way rebase
// onto main for keep-ours / keep-theirs, and removal from scope for skip.
// They were raw `branch_items` writes here, which the release then misread
// — see the service for what each one did.
app.post(
  '/:id/resolve-conflicts',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof resolveConflictsSchema>>(
      {
        permission: ['change_orders', 'update'],
        body: resolveConflictsSchema,
        access: ({ params, user }) =>
          requireChangeOrderAccess(user.id, params.id),
      },
      async ({ body, params, user }) => {
        const results = await ChangeOrderService.resolveConflicts(
          params.id,
          body.resolutions,
          user.id,
        )
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
      async ({ params, user }) => {
        await requireChangeOrderAccess(user.id, params.id)
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
        await requireChangeOrderAccess(user.id, params.id)
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
      async ({ params, user }) => {
        await requireChangeOrderAccess(user.id, params.id)
        const summary = await ChangeOrderService.getSummary(
          params.id,
          await AccessControlService.getAccessibleDesignIds(user.id),
        )

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
      async ({ params, user }) => {
        await requireChangeOrderAccess(user.id, params.id)
        const instance = await LifecycleInstanceService.getInstanceByItemId(
          params.id,
        )

        if (!instance) {
          throw new NotFoundError('Workflow for change order', params.id)
        }

        const history = await LifecycleInstanceService.getHistory(instance.id)

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
      async ({ params, user }) => {
        await requireChangeOrderAccess(user.id, params.id)
        const instance = await LifecycleInstanceService.getInstanceByItemId(
          params.id,
        )
        if (!instance) {
          throw new NotFoundError('Workflow instance', params.id)
        }

        const structure = await LifecycleInstanceService.getEffectiveStructure(
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

/**
 * A flexible instance's own states and transitions. Instance states add
 * reviewer `instructions` to the definition shape; instance transitions carry
 * the same fields as definition ones.
 */
const instanceStructureSchema = z.object({
  states: z.array(workflowStateSchema).max(500),
  transitions: z.array(workflowTransitionSchema).max(500),
})

// PUT /api/change-orders/:id/workflow/structure
app.put(
  '/:id/workflow/structure',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof instanceStructureSchema>>(
      {
        permission: ['change_orders', 'update'],
        body: instanceStructureSchema,
        access: ({ params, user }) =>
          requireChangeOrderAccess(user.id, params.id),
      },
      async ({ body, params, user }) => {
        const instance = await LifecycleInstanceService.getInstanceByItemId(
          params.id,
        )
        if (!instance) {
          throw new NotFoundError('Workflow instance', params.id)
        }

        // Check if workflow is flexible and editable
        const isEditable = await LifecycleInstanceService.isFlexibleAndEditable(
          instance.id,
        )
        if (!isEditable) {
          throw new ValidationError(
            'Workflow is not flexible or is already completed',
          )
        }

        const result = await LifecycleInstanceService.updateInstanceStructure(
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
      async ({ params, user }) => {
        await requireChangeOrderAccess(user.id, params.id)
        const instance = await LifecycleInstanceService.getInstanceByItemId(
          params.id,
        )
        if (!instance) {
          throw new NotFoundError('Workflow instance', params.id)
        }

        const approvers = await ApprovalService.getInstanceApprovers(
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
    apiHandler<
      { id: string; stateId: string },
      { approvers: Array<z.infer<typeof stateApproverInputSchema>> }
    >(
      {
        permission: ['change_orders', 'update'],
        body: z.object({
          approvers: z.array(stateApproverInputSchema).max(100),
        }),
        access: ({ params, user }) =>
          requireChangeOrderAccess(user.id, params.id),
      },
      async ({ body, params, user }) => {
        const instance = await LifecycleInstanceService.getInstanceByItemId(
          params.id,
        )
        if (!instance) {
          throw new NotFoundError('Workflow instance', params.id)
        }

        // Same editability gate as the structure endpoint: approvers are
        // part of the instance-level workflow configuration
        const isEditable = await LifecycleInstanceService.isFlexibleAndEditable(
          instance.id,
        )
        if (!isEditable) {
          throw new ValidationError(
            'Workflow is not flexible or is already completed',
          )
        }

        // The state must exist on the instance's effective structure
        const structure = await LifecycleInstanceService.getEffectiveStructure(
          instance.id,
        )
        if (!structure.states.some((s) => s.id === params.stateId)) {
          throw new ValidationError(
            `State "${params.stateId}" does not exist on this workflow`,
          )
        }

        const approvers = await ApprovalService.setInstanceApprovers(
          instance.id,
          params.stateId,
          body.approvers,
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
        await requireChangeOrderAccess(user.id, params.id)
        const instance = await LifecycleInstanceService.getInstanceByItemId(
          params.id,
        )

        if (!instance) {
          throw new NotFoundError('Workflow', params.id, {
            detail: 'No workflow found for this change order',
          })
        }

        // The service loads the change order and the caller's roles itself;
        // this used to hand it an empty item, so field guards failed here
        // and passed on execution
        const availableTransitions =
          await LifecycleInstanceService.getAvailableTransitions(instance.id, {
            user: { id: user.id },
          })

        return { transitions: availableTransitions }
      },
    ),
  ),
)

/**
 * A workflow transition request. Both the executing and the validating route
 * take the same body — the second is the dry run of the first, and a schema
 * they did not share would let the preview accept what the execution rejects.
 */
const transitionSchema = z.object({
  toStateId: z.string().min(1).max(100),
  comments: z.string().max(10000).optional(),
})

// POST /api/change-orders/:id/workflow/transition
app.post(
  '/:id/workflow/transition',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof transitionSchema>>(
      {
        permission: ['change_orders', 'update'],
        body: transitionSchema,
        access: ({ params, user }) =>
          requireChangeOrderAccess(user.id, params.id),
      },
      async ({ params, body: data, user }) => {
        // All orchestration (finalKind resolution, release claim, merge or
        // cancel interlock) lives in the service so every entry point — this
        // route and the AI tools — shares one behavior
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
    apiHandler<{ id: string }, z.infer<typeof transitionSchema>>(
      {
        permission: ['change_orders', 'read'],
        body: transitionSchema,
        access: ({ params, user }) =>
          requireChangeOrderAccess(user.id, params.id),
      },
      async ({ body: data, params, user }) =>
        // The dry run of the transition route, in the service beside the
        // execution it predicts
        ChangeOrderService.validateTransition(
          params.id,
          data.toStateId,
          user.id,
        ),
    ),
  ),
)

// GET /api/change-orders/:id/workflow
app.get(
  '/:id/workflow',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['change_orders', 'read'] },
      async ({ params, user }) => {
        await requireChangeOrderAccess(user.id, params.id)
        const instance = await LifecycleInstanceService.getInstanceByItemId(
          params.id,
        )

        if (!instance) {
          return { instance: null }
        }

        // Get the workflow definition for context
        const definition = await LifecycleDefinitionService.getById(
          instance.workflowDefinitionId,
        )

        // For flexible workflows, get effective structure with instance-level states
        const effectiveStructure =
          await LifecycleInstanceService.getEffectiveStructure(instance.id)

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
    apiHandler<{ id: string }, { workflowDefinitionId: string }>(
      {
        permission: ['change_orders', 'update'],
        body: z.object({ workflowDefinitionId: z.string().uuid() }),
        access: ({ params, user }) =>
          requireChangeOrderAccess(user.id, params.id),
      },
      async ({ body: data, params, user }) => {
        // Check if workflow already exists
        const existingInstance =
          await LifecycleInstanceService.getInstanceByItemId(params.id)
        if (existingInstance) {
          throw new AlreadyExistsError('Workflow', params.id)
        }

        // The repair door for a change order that lost its instance. Through
        // the service, which refuses anything but a Driving definition and
        // stamps the change order's state from the instance it starts; this
        // used to hand `startInstance` whatever id it was given, so a Free
        // item lifecycle could be attached to a change order.
        const instance = await ChangeOrderService.startWorkflow(
          params.id,
          data.workflowDefinitionId,
          user.id,
        )

        return created({ instance })
      },
    ),
  ),
)

export default app
