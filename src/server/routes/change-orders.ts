import { Hono } from 'hono'
import { z } from 'zod'
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm'
import { tagged } from '../adapter'
import type { ChangeOrder } from '@/lib/items/types/change-order'
import type { VersionContext } from '@/lib/services/VersionResolver'
import type {
  CommitGraphData,
  CommitGraphEdge,
  CommitGraphNode,
  CommitNodeData,
} from '@/lib/versioning/graph-types'
import type { ConflictResolution } from '@/components/change-orders/MergeConflictDialog'
import type {
  InstanceWorkflowTransition,
  WorkflowState,
} from '@/lib/workflows/types'
import { ItemService } from '@/lib/items/services/ItemService'
import { ChangeOrderService } from '@/lib/items/services/ChangeOrderService'
import { ChangeOrderMergeService } from '@/lib/services/ChangeOrderMergeService'
import { ImpactAssessmentService } from '@/lib/items/services/ImpactAssessmentService'
import { ItemRelationshipService } from '@/lib/items/services/ItemRelationshipService'
import { BranchService } from '@/lib/services/BranchService'
import { CommitService } from '@/lib/services/CommitService'
import { ConflictDetectionService } from '@/lib/services/ConflictDetectionService'
import { ConflictReviewService } from '@/lib/services/ConflictReviewService'
import { CrossDesignReferenceService } from '@/lib/services/CrossDesignReferenceService'
import { DesignService } from '@/lib/services/DesignService'
import { VersionResolver } from '@/lib/services/VersionResolver'
import { WorkflowService } from '@/lib/workflows/WorkflowService'
import { WorkflowApprovalService } from '@/lib/workflows/WorkflowApprovalService'
import { UserService } from '@/lib/auth/UserService'
import { apiHandler, created } from '@/lib/api/handler'
import {
  AlreadyExistsError,
  NotFoundError,
  ValidationError,
} from '@/lib/errors'
import { markConflictReviewedRequestSchema } from '@/lib/services/types/conflict-review'
import { db } from '@/lib/db'
import { branchItems } from '@/lib/db/schema'
import {
  changeOrderDesigns,
  changeOrders,
  itemRelationships,
  items,
} from '@/lib/db/schema/items'
import { commits, itemVersions, tags } from '@/lib/db/schema/versioning'
import { designs } from '@/lib/db/schema/designs'
import { users } from '@/lib/db/schema/users'
import '@/lib/items/registerItemTypes.server'

const adapt = tagged('Change Orders')

const app = new Hono()

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
      async ({ request }) => {
        const url = new URL(request.url)
        const designId = url.searchParams.get('designId')
        const programId = url.searchParams.get('programId')
        const limit = parseInt(url.searchParams.get('limit') || '50', 10)
        const offset = parseInt(url.searchParams.get('offset') || '0', 10)
        const includeCounts =
          url.searchParams.get('includeCounts') === 'true'

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
            ItemService.search('ChangeOrder', { limit: 1, state: 'Draft' }),
            ItemService.search('ChangeOrder', {
              limit: 1,
              state: 'InReview',
            }),
            ItemService.search('ChangeOrder', {
              limit: 1,
              state: 'Released',
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
    apiHandler(
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
    apiHandler(
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
    apiHandler(
      { permission: ['change_orders', 'delete'] },
      async ({ params }) => {
        await ItemService.delete(params.id)
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
    apiHandler(
      { permission: ['change_orders', 'read'] },
      async ({ params }) => {
        const { id } = params as { id: string }

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
    apiHandler(
      { permission: ['change_orders', 'update'] },
      async ({ params, request, user }) => {
        const { id } = params as { id: string }
        const data = await request.json()

        // Check if this is a batch request
        if (Array.isArray(data.items)) {
          const affectedItems = await ChangeOrderService.addAffectedItemsBatch(
            id,
            data.items,
            user.id,
          )

          return created({ affectedItems })
        }

        // Single item request
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

// DELETE /api/change-orders/:id/affected-items
app.delete(
  '/:id/affected-items',
  adapt(
    apiHandler(
      { permission: ['change_orders', 'update'] },
      async ({ request }) => {
        const url = new URL(request.url)
        const affectedItemId = url.searchParams.get('itemId')

        if (!affectedItemId) {
          throw new ValidationError('Missing itemId parameter')
        }

        await ChangeOrderService.removeAffectedItem(affectedItemId)

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
    apiHandler(
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
    apiHandler(
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
    apiHandler(
      { permission: ['change_orders', 'update'] },
      async ({ request, params, user }) => {
        const data = await request.json()

        if (!data.vote || !['approved', 'rejected'].includes(data.vote)) {
          throw new ValidationError("vote must be 'approved' or 'rejected'")
        }

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
    apiHandler(
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
    apiHandler(
      { permission: ['change_orders', 'update'] },
      async ({ request, params, user }) => {
        const data = await request.json()

        if (!data.vote || !['approved', 'rejected'].includes(data.vote)) {
          return new Response(
            JSON.stringify({
              error: "vote must be 'approved' or 'rejected'",
            }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            },
          )
        }

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
        )

        // Get updated approval status
        const approvalStatus = await WorkflowApprovalService.getStateApprovals(
          instance.id,
          params.stateId,
        )

        return new Response(
          JSON.stringify({
            data: {
              vote: result,
              approvalStatus,
            },
          }),
          {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          },
        )
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
    apiHandler(
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

        // Verify ECO is in editable state (Draft or InReview)
        if (!['Draft', 'InReview'].includes(eco[0].state)) {
          throw new ValidationError(
            'Cannot modify BOM on a change order that is not in Draft or InReview state',
          )
        }

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

        // Verify the child item exists
        const childItem = await ItemService.findById(data.childItemId)
        if (!childItem) {
          throw new NotFoundError('Item', data.childItemId)
        }

        if (data.action === 'add') {
          // Create the BOM relationship
          await ItemService.addRelationship(
            data.parentItemId,
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
          // Remove BOM relationship between parent and child
          await db
            .delete(itemRelationships)
            .where(
              and(
                eq(itemRelationships.sourceId, data.parentItemId),
                eq(itemRelationships.targetId, data.childItemId),
                eq(itemRelationships.relationshipType, 'BOM'),
              ),
            )

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
                eq(itemRelationships.sourceId, data.parentItemId),
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
    apiHandler(
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

        if (!['Draft', 'InReview'].includes(eco[0].state)) {
          throw new ValidationError(
            'Cannot modify BOM on a change order that is not in Draft or InReview state',
          )
        }

        // Get the relationship to verify the parent is an affected item
        const relationship = await db
          .select()
          .from(itemRelationships)
          .where(eq(itemRelationships.id, relationshipId))
          .limit(1)

        if (!relationship[0]) {
          throw new NotFoundError('Relationship', relationshipId)
        }

        // Verify the parent (source) is an affected item
        // Match by affectedItemId or masterId (working copy IDs differ from originals)
        const affectedItems =
          await ChangeOrderService.getAffectedItems(changeOrderId)
        const sourceItem = await ItemService.findById(relationship[0].sourceId)
        const sourceMasterId = sourceItem?.masterId

        const parentAffectedItem = affectedItems.find(
          (ai) =>
            ai.affectedItemId === relationship[0].sourceId ||
            (sourceMasterId && ai.affectedItemMasterId === sourceMasterId),
        )

        if (!parentAffectedItem) {
          throw new ValidationError(
            'Parent item must be an affected item in this ECO to remove BOM relationships.',
          )
        }

        // Delete the relationship (via service for audit trail)
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

interface AffectedItemCommit {
  commitId: string
  itemId: string
  itemMasterId: string
  itemNumber: string
  itemName: string | null
  revision: string
  changeType: 'added' | 'modified' | 'deleted'
  message: string
  author: { id: string; name: string }
  date: string
  fieldChangesCount?: number
}

interface BranchTimeline {
  branchId: string
  branchName: string
  designId: string
  designName: string
  baseCommitId: string | null
  commits: Array<{
    id: string
    message: string
    author: { id: string; name: string }
    date: string
    changeStats: { added: number; modified: number; deleted: number }
    affectedItemChanges: Array<AffectedItemCommit>
  }>
}

interface EcoBranchHistory {
  ecoNumber: string
  ecoName: string
  mainBranch: {
    commits: Array<{
      id: string
      message: string
      author: { id: string; name: string }
      date: string
      changeStats: { added: number; modified: number; deleted: number }
    }>
  }
  ecoBranches: Array<BranchTimeline>
  splitPoints: Array<{
    designId: string
    designName: string
    baseCommitId: string | null
    baseCommitMessage: string | null
    baseCommitDate: string | null
  }>
}

// GET /api/change-orders/:id/branch-history
app.get(
  '/:id/branch-history',
  adapt(
    apiHandler(
      { permission: ['change_orders', 'read'] },
      async ({ params }) => {
        // Get the change order
        const eco = await ItemService.findById(params.id)
        if (!eco) {
          return new Response(
            JSON.stringify({ error: 'Change order not found' }),
            {
              status: 404,
              headers: { 'Content-Type': 'application/json' },
            },
          )
        }

        // Get all designs affected by this ECO
        const affectedDesigns = await db
          .select({
            designId: changeOrderDesigns.designId,
            branchId: changeOrderDesigns.branchId,
            designName: designs.name,
          })
          .from(changeOrderDesigns)
          .innerJoin(designs, eq(designs.id, changeOrderDesigns.designId))
          .where(eq(changeOrderDesigns.changeOrderId, params.id))

        if (affectedDesigns.length === 0) {
          return {
            ecoNumber: eco.itemNumber,
            ecoName: eco.name,
            mainBranch: { commits: [] },
            ecoBranches: [],
            splitPoints: [],
          }
        }

        const result: EcoBranchHistory = {
          ecoNumber: eco.itemNumber ?? '',
          ecoName: eco.name || '',
          mainBranch: { commits: [] },
          ecoBranches: [],
          splitPoints: [],
        }

        // Process each affected design's ECO branch
        for (const design of affectedDesigns) {
          if (!design.branchId) continue

          const branch = await BranchService.getById(design.branchId)
          if (!branch) continue

          // Get all commits on this ECO branch
          const branchCommits = await db
            .select({
              id: commits.id,
              message: commits.message,
              createdAt: commits.createdAt,
              createdById: commits.createdBy,
              itemsAdded: commits.itemsAdded,
              itemsChanged: commits.itemsChanged,
              itemsDeleted: commits.itemsDeleted,
            })
            .from(commits)
            .where(eq(commits.branchId, design.branchId))
            .orderBy(desc(commits.createdAt))

          // Get authors for all commits
          const authorIds = [
            ...new Set(branchCommits.map((c) => c.createdById).filter(Boolean)),
          ]
          let authorMap = new Map<string, string>()

          if (authorIds.length > 0) {
            const authors = await db
              .select({ id: users.id, name: users.name })
              .from(users)
              .where(inArray(users.id, authorIds))

            authorMap = new Map(authors.map((a) => [a.id, a.name || 'Unknown']))
          }

          // For each commit, get affected item changes
          const timelineCommits = []
          for (const commit of branchCommits) {
            // Get all item versions in this commit
            const itemChanges = await db
              .select({
                itemId: itemVersions.itemId,
                changeType: itemVersions.changeType,
                previousItemId: itemVersions.previousItemId,
              })
              .from(itemVersions)
              .where(eq(itemVersions.commitId, commit.id))

            // Get item details for all changed items
            const itemIds = itemChanges.map((ic) => ic.itemId).filter(Boolean)
            const itemDetails =
              itemIds.length > 0
                ? await db
                    .select({
                      id: items.id,
                      masterId: items.masterId,
                      itemNumber: items.itemNumber,
                      name: items.name,
                      revision: items.revision,
                    })
                    .from(items)
                    .where(inArray(items.id, itemIds))
                : []

            const itemDetailsMap = new Map(itemDetails.map((i) => [i.id, i]))

            const affectedItemChanges: Array<AffectedItemCommit> = itemChanges
              .map((ic) => {
                const itemDetail = itemDetailsMap.get(ic.itemId)
                if (!itemDetail) return null

                return {
                  commitId: commit.id,
                  itemId: ic.itemId,
                  itemMasterId: itemDetail.masterId || '',
                  itemNumber: itemDetail.itemNumber || '',
                  itemName: itemDetail.name,
                  revision: itemDetail.revision || '',
                  changeType: ic.changeType as 'added' | 'modified' | 'deleted',
                  message: commit.message || 'No message',
                  author: {
                    id: commit.createdById || '',
                    name: authorMap.get(commit.createdById || '') || 'System',
                  },
                  date: commit.createdAt.toISOString(),
                }
              })
              .filter((ic): ic is AffectedItemCommit => ic !== null)

            timelineCommits.push({
              id: commit.id,
              message: commit.message || 'No message',
              author: {
                id: commit.createdById || '',
                name: authorMap.get(commit.createdById || '') || 'System',
              },
              date: commit.createdAt.toISOString(),
              changeStats: {
                added: commit.itemsAdded || 0,
                modified: commit.itemsChanged || 0,
                deleted: commit.itemsDeleted || 0,
              },
              affectedItemChanges,
            })
          }

          result.ecoBranches.push({
            branchId: design.branchId,
            branchName: branch.name,
            designId: design.designId,
            designName: design.designName || '',
            baseCommitId: branch.baseCommitId,
            commits: timelineCommits,
          })

          // Add split point info
          if (branch.baseCommitId) {
            const baseCommit = await CommitService.getById(branch.baseCommitId)
            if (baseCommit) {
              result.splitPoints.push({
                designId: design.designId,
                designName: design.designName || '',
                baseCommitId: branch.baseCommitId,
                baseCommitMessage: baseCommit.message || null,
                baseCommitDate: baseCommit.createdAt.toISOString(),
              })
            }
          }
        }

        return result
      },
    ),
  ),
)

// ============================================
// Branch history graph
// ============================================

// Commit Consolidation helpers

/** Time window in milliseconds for consolidating commits (30 minutes) */
const CONSOLIDATION_TIME_WINDOW_MS = 30 * 60 * 1000

/** Minimum number of commits to trigger consolidation */
const MIN_COMMITS_TO_CONSOLIDATE = 2

/**
 * Check if a commit should NOT be consolidated (is "important")
 */
function isImportantCommit(data: CommitNodeData): boolean {
  // Merge commits are always important
  if (data.isMergeCommit) return true
  // ECO-related commits are always important
  if (data.changeOrderItemId || data.ecoNumber) return true
  // Commits with tags are always important
  if (data.tags && data.tags.length > 0) return true
  // Initial commits are important
  if (data.message === 'Initial commit') return true
  // ChangeOrder commits are important
  if (data.message.includes('ChangeOrder')) return true
  return false
}

/**
 * Extract the action type from a commit message
 */
function extractActionType(message: string): string {
  const lowerMsg = message.toLowerCase()
  if (lowerMsg.includes('created') || lowerMsg.includes('added'))
    return 'created'
  if (lowerMsg.includes('updated') || lowerMsg.includes('modified'))
    return 'updated'
  if (lowerMsg.includes('deleted') || lowerMsg.includes('removed'))
    return 'deleted'
  return 'other'
}

/**
 * Extract the item type from a commit message
 */
function extractItemType(message: string): string {
  const match = message.match(
    /^(Part|Document|ChangeOrder|Requirement|Task)\s+/i,
  )
  if (match) return match[1]
  return 'Item'
}

/**
 * Generate a consolidated message
 */
function generateConsolidatedMessage(
  count: number,
  actionType: string,
  itemType: string,
): string {
  const plural = count > 1 ? 's' : ''
  const verb =
    actionType === 'created'
      ? 'created'
      : actionType === 'updated'
        ? 'updated'
        : actionType === 'deleted'
          ? 'deleted'
          : 'modified'
  return `${count} ${itemType}${plural} ${verb}`
}

/**
 * Consolidate sequential similar commits into grouped nodes
 */
function consolidateCommits(
  nodes: Array<CommitGraphNode>,
  edges: Array<CommitGraphEdge>,
): { nodes: Array<CommitGraphNode>; edges: Array<CommitGraphEdge> } {
  if (nodes.length < MIN_COMMITS_TO_CONSOLIDATE) {
    return { nodes, edges }
  }

  // Sort nodes by date (oldest first) for processing
  const sortedNodes = [...nodes].sort(
    (a, b) => new Date(a.data.date).getTime() - new Date(b.data.date).getTime(),
  )

  const consolidatedNodes: Array<CommitGraphNode> = []
  const removedNodeIds = new Set<string>()
  let i = 0

  while (i < sortedNodes.length) {
    const currentNode = sortedNodes[i]

    // If this is an important commit, don't consolidate it
    if (isImportantCommit(currentNode.data)) {
      consolidatedNodes.push(currentNode)
      i++
      continue
    }

    // Try to find consecutive commits to consolidate
    const group: Array<CommitGraphNode> = [currentNode]
    const currentAction = extractActionType(currentNode.data.message)
    const currentItemType = extractItemType(currentNode.data.message)
    const currentTime = new Date(currentNode.data.date).getTime()

    let j = i + 1
    while (j < sortedNodes.length) {
      const nextNode = sortedNodes[j]

      // Stop if next commit is important
      if (isImportantCommit(nextNode.data)) break

      // Stop if different branch
      if (nextNode.data.branchId !== currentNode.data.branchId) break

      // Stop if different author
      if (nextNode.data.author.id !== currentNode.data.author.id) break

      // Stop if different action type
      if (extractActionType(nextNode.data.message) !== currentAction) break

      // Stop if different item type
      if (extractItemType(nextNode.data.message) !== currentItemType) break

      // Stop if outside time window
      const nextTime = new Date(nextNode.data.date).getTime()
      if (nextTime - currentTime > CONSOLIDATION_TIME_WINDOW_MS) break

      group.push(nextNode)
      j++
    }

    if (group.length >= MIN_COMMITS_TO_CONSOLIDATE) {
      // Create consolidated node
      const firstCommit = group[0]
      const lastCommit = group[group.length - 1]

      // Aggregate stats
      const totalStats = group.reduce(
        (acc, n) => ({
          added: acc.added + (n.data.changeStats?.added || 0),
          modified: acc.modified + (n.data.changeStats?.modified || 0),
          deleted: acc.deleted + (n.data.changeStats?.deleted || 0),
        }),
        { added: 0, modified: 0, deleted: 0 },
      )

      const consolidatedNode: CommitGraphNode = {
        id: `consolidated-${firstCommit.id}`,
        type: 'commitNode',
        position: { x: 0, y: 0 },
        data: {
          commitId: firstCommit.data.commitId,
          message: generateConsolidatedMessage(
            group.length,
            currentAction,
            currentItemType,
          ),
          author: firstCommit.data.author,
          date: lastCommit.data.date,
          branchId: firstCommit.data.branchId,
          branchName: firstCommit.data.branchName,
          branchType: firstCommit.data.branchType,
          isMergeCommit: false,
          changeStats: totalStats,
          tags: [],
          isConsolidated: true,
          consolidatedCount: group.length,
          consolidatedCommitIds: group.map((n) => n.data.commitId),
          dateRangeStart: firstCommit.data.date,
          dateRangeEnd: lastCommit.data.date,
        },
      }

      consolidatedNodes.push(consolidatedNode)

      // Mark original nodes as removed
      for (const node of group) {
        removedNodeIds.add(node.id)
      }

      i = j
    } else {
      // Not enough commits to consolidate, keep original
      consolidatedNodes.push(currentNode)
      i++
    }
  }

  // Update edges to point to consolidated nodes
  const nodeIdMapping = new Map<string, string>()
  for (const node of consolidatedNodes) {
    if (node.data.isConsolidated && node.data.consolidatedCommitIds) {
      for (const originalId of node.data.consolidatedCommitIds) {
        nodeIdMapping.set(originalId, node.id)
      }
    }
  }

  // Filter and remap edges
  const consolidatedEdges: Array<CommitGraphEdge> = []
  const seenEdges = new Set<string>()

  for (const edge of edges) {
    let sourceId = edge.source
    let targetId = edge.target

    // Skip edges between nodes that were consolidated together
    if (removedNodeIds.has(sourceId) && removedNodeIds.has(targetId)) {
      const newSourceId = nodeIdMapping.get(sourceId)
      const newTargetId = nodeIdMapping.get(targetId)
      if (newSourceId === newTargetId) continue
    }

    // Remap to consolidated node IDs
    if (nodeIdMapping.has(sourceId)) {
      sourceId = nodeIdMapping.get(sourceId)!
    }
    if (nodeIdMapping.has(targetId)) {
      targetId = nodeIdMapping.get(targetId)!
    }

    // Skip if source or target was removed and not remapped
    if (removedNodeIds.has(edge.source) && !nodeIdMapping.has(edge.source))
      continue
    if (removedNodeIds.has(edge.target) && !nodeIdMapping.has(edge.target))
      continue

    // Avoid duplicate edges
    const edgeKey = `${sourceId}-${targetId}-${edge.data?.edgeType || 'default'}`
    if (seenEdges.has(edgeKey)) continue
    seenEdges.add(edgeKey)

    consolidatedEdges.push({
      ...edge,
      id: `${sourceId}-${targetId}${edge.data?.edgeType === 'merge' ? '-merge' : ''}`,
      source: sourceId,
      target: targetId,
    })
  }

  return { nodes: consolidatedNodes, edges: consolidatedEdges }
}

export interface EcoGraphResponse {
  data: CommitGraphData & {
    ecoNumber: string
    ecoName: string
    affectedDesigns: Array<{
      designId: string
      designName: string
      branchId: string
      branchName: string
    }>
  }
}

/**
 * Build commit graph data for ECO branch visualization
 * Shows the main branch context around the fork point and all ECO branch commits
 */
async function buildEcoGraph(
  designId: string,
  ecoBranchId: string,
  limit: number,
): Promise<CommitGraphData> {
  // 1. Get the ECO branch and main branch
  const ecoBranch = await BranchService.getById(ecoBranchId)
  if (!ecoBranch) {
    return {
      nodes: [],
      edges: [],
      mainBranchId: '',
    }
  }

  const allBranches = await DesignService.getBranches(designId, false)
  const mainBranch = allBranches.find((b) => b.branchType === 'main')

  if (!mainBranch) {
    return {
      nodes: [],
      edges: [],
      mainBranchId: '',
    }
  }

  const forkPoint = ecoBranch.baseCommitId || undefined

  // 2. Get ECO branch commits
  const ecoBranchCommits = await db
    .select()
    .from(commits)
    .where(eq(commits.branchId, ecoBranchId))
    .orderBy(desc(commits.createdAt))
    .limit(limit)

  // 3. Get main branch commits (context around fork point)
  // We'll get commits before and after the fork point for context
  const mainCommits = await db
    .select()
    .from(commits)
    .where(eq(commits.branchId, mainBranch.id))
    .orderBy(desc(commits.createdAt))
    .limit(limit)

  // 4. Collect all commits
  const allCommits = [...mainCommits, ...ecoBranchCommits]
  const uniqueCommits = Array.from(
    new Map(allCommits.map((c) => [c.id, c])).values(),
  )
  const allCommitIds = uniqueCommits.map((c) => c.id)

  if (allCommitIds.length === 0) {
    return {
      nodes: [],
      edges: [],
      mainBranchId: mainBranch.id,
      selectedBranchId: ecoBranchId,
      selectedBranchName: ecoBranch.name,
      forkPoint,
    }
  }

  // 5. Get tags for these commits
  const commitTags = await db
    .select()
    .from(tags)
    .where(inArray(tags.commitId, allCommitIds))

  const tagsByCommit = new Map<
    string,
    Array<{ id: string; name: string; tagType: string }>
  >()
  for (const tag of commitTags) {
    const existing = tagsByCommit.get(tag.commitId) || []
    existing.push({
      id: tag.id,
      name: tag.name,
      tagType: tag.tagType || 'baseline',
    })
    tagsByCommit.set(tag.commitId, existing)
  }

  // 6. Get authors for all commits
  const authorIds = [
    ...new Set(uniqueCommits.map((c) => c.createdBy).filter(Boolean)),
  ]
  let authorMap = new Map<string, string>()

  if (authorIds.length > 0) {
    const authors = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, authorIds))

    authorMap = new Map(authors.map((a) => [a.id, a.name || 'Unknown']))
  }

  // 7. Get ECO item numbers for commits linked to change orders
  const changeOrderIds = [
    ...new Set(
      uniqueCommits
        .map((c) => c.changeOrderItemId)
        .filter((id): id is string => id !== null),
    ),
  ]
  let ecoNumberMap = new Map<string, string>()

  if (changeOrderIds.length > 0) {
    const ecoItems = await db
      .select({ id: items.id, itemNumber: items.itemNumber })
      .from(items)
      .where(inArray(items.id, changeOrderIds))

    ecoNumberMap = new Map(ecoItems.map((e) => [e.id, e.itemNumber]))
  }

  // 8. Build nodes and edges
  const nodes: Array<CommitGraphNode> = []
  const edges: Array<CommitGraphEdge> = []
  const includedCommitIds = new Set(allCommitIds)

  for (const commit of uniqueCommits) {
    const isMainBranch = commit.branchId === mainBranch.id

    const branchName = isMainBranch ? mainBranch.name : ecoBranch.name
    const branchType: 'main' | 'eco' | 'workspace' | 'release' = isMainBranch
      ? 'main'
      : 'eco'

    nodes.push({
      id: commit.id,
      type: 'commitNode',
      position: { x: 0, y: 0 },
      data: {
        commitId: commit.id,
        message: commit.message || 'No message',
        author: {
          id: commit.createdBy || '',
          name: authorMap.get(commit.createdBy || '') || 'Unknown',
        },
        date: commit.createdAt.toISOString(),
        branchId: commit.branchId,
        branchName,
        branchType,
        isMergeCommit: commit.mergeParentId !== null,
        changeStats: {
          added: commit.itemsAdded || 0,
          modified: commit.itemsChanged || 0,
          deleted: commit.itemsDeleted || 0,
        },
        tags: tagsByCommit.get(commit.id) || [],
        changeOrderItemId: commit.changeOrderItemId || undefined,
        ecoNumber: commit.changeOrderItemId
          ? ecoNumberMap.get(commit.changeOrderItemId)
          : undefined,
        revisionsAssigned: commit.revisionsAssigned as
          | Record<string, string>
          | undefined,
      },
    })

    // Parent edge
    if (commit.parentId && includedCommitIds.has(commit.parentId)) {
      edges.push({
        id: `${commit.parentId}-${commit.id}`,
        source: commit.parentId,
        target: commit.id,
        type: 'default',
        data: { edgeType: 'parent' },
      })
    }

    // Merge parent edge
    if (commit.mergeParentId && includedCommitIds.has(commit.mergeParentId)) {
      edges.push({
        id: `${commit.mergeParentId}-${commit.id}-merge`,
        source: commit.mergeParentId,
        target: commit.id,
        type: 'default',
        data: { edgeType: 'merge' },
        animated: true,
        style: { strokeDasharray: '5,5' },
      })
    }
  }

  // 9. Add edge from fork point to first ECO branch commit
  if (forkPoint && ecoBranchCommits.length > 0) {
    const sortedEcoCommits = [...ecoBranchCommits].sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    )
    const oldestEcoCommit = sortedEcoCommits[0]

    if (includedCommitIds.has(forkPoint)) {
      const edgeId = `${forkPoint}-${oldestEcoCommit.id}`
      if (!edges.find((e) => e.id === edgeId)) {
        edges.push({
          id: edgeId,
          source: forkPoint,
          target: oldestEcoCommit.id,
          type: 'default',
          data: { edgeType: 'parent' },
        })
      }
    }
  }

  // 10. Consolidate sequential similar commits
  const consolidated = consolidateCommits(nodes, edges)

  return {
    nodes: consolidated.nodes,
    edges: consolidated.edges,
    forkPoint,
    mainBranchId: mainBranch.id,
    selectedBranchId: ecoBranchId,
    selectedBranchName: ecoBranch.name,
  }
}

// GET /api/change-orders/:id/branch-history/graph
app.get(
  '/:id/branch-history/graph',
  adapt(
    apiHandler(
      { permission: ['change_orders', 'read'] },
      async ({ request, params }) => {
        // Get the change order
        const eco = await ItemService.findById(params.id)
        if (!eco) {
          return new Response(
            JSON.stringify({ error: 'Change order not found' }),
            {
              status: 404,
              headers: { 'Content-Type': 'application/json' },
            },
          )
        }

        // Parse query params
        const url = new URL(request.url, 'http://localhost')
        const selectedDesignId = url.searchParams.get('designId')
        const limit = parseInt(url.searchParams.get('limit') || '50', 10)

        // Get all designs affected by this ECO
        const affectedDesigns = await db
          .select({
            designId: changeOrderDesigns.designId,
            branchId: changeOrderDesigns.branchId,
            designName: designs.name,
          })
          .from(changeOrderDesigns)
          .innerJoin(designs, eq(designs.id, changeOrderDesigns.designId))
          .where(eq(changeOrderDesigns.changeOrderId, params.id))

        if (affectedDesigns.length === 0) {
          return {
            ecoNumber: eco.itemNumber ?? '',
            ecoName: eco.name || '',
            nodes: [],
            edges: [],
            mainBranchId: '',
            affectedDesigns: [],
          }
        }

        // Select which design to show (first one or specified)
        const targetDesign = selectedDesignId
          ? affectedDesigns.find((d) => d.designId === selectedDesignId) ||
            affectedDesigns[0]
          : affectedDesigns[0]

        if (!targetDesign.branchId) {
          return {
            ecoNumber: eco.itemNumber ?? '',
            ecoName: eco.name || '',
            nodes: [],
            edges: [],
            mainBranchId: '',
            affectedDesigns: affectedDesigns.map((d) => ({
              designId: d.designId,
              designName: d.designName || '',
              branchId: d.branchId || '',
              branchName: '',
            })),
          }
        }

        // Build graph data for the selected design
        const graphData = await buildEcoGraph(
          targetDesign.designId,
          targetDesign.branchId,
          limit,
        )

        // Get branch names for all affected designs
        const affectedDesignsWithBranches = await Promise.all(
          affectedDesigns.map(async (d) => {
            let branchName = ''
            if (d.branchId) {
              const branch = await BranchService.getById(d.branchId)
              branchName = branch?.name || ''
            }
            return {
              designId: d.designId,
              designName: d.designName || '',
              branchId: d.branchId || '',
              branchName,
            }
          }),
        )

        return {
          ...graphData,
          ecoNumber: eco.itemNumber ?? '',
          ecoName: eco.name || '',
          affectedDesigns: affectedDesignsWithBranches,
        }
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
    apiHandler(
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
    apiHandler(
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
    apiHandler(
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
    apiHandler(
      { permission: ['change_orders', 'update'] },
      async ({ request }) => {
        // Get review ID from query params
        const url = new URL(request.url)
        const reviewId = url.searchParams.get('reviewId')

        if (!reviewId) {
          throw new ValidationError('reviewId query parameter required')
        }

        await ConflictReviewService.unmarkReview(reviewId)

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
    apiHandler(
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
    apiHandler(
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
    apiHandler(
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

interface BOMTreeNode {
  itemId: string
  masterId: string
  itemNumber: string
  name: string | null
  revision: string
  state: string
  itemType: string
  designId: string | null
  quantity?: number
  findNumber?: number
  relationshipId?: string
  isInEco?: boolean
  isBranchChanged?: boolean
  changeAction?: string | null
  children?: Array<BOMTreeNode>
  designCode?: string
  designName?: string
  isExternal?: boolean
}

interface OrphanItem {
  id: string
  itemNumber: string
  name: string | null
  revision: string
  state: string
  itemType: string
  isInEco?: boolean
  isBranchChanged?: boolean
  changeAction?: string | null
}

// GET /api/change-orders/:id/designs/:designId/structure
app.get(
  '/:id/designs/:designId/structure',
  adapt(
    apiHandler(
      { permission: ['change_orders', 'read'] },
      async ({ request, params }) => {
        const { id: changeOrderId, designId } = params as {
          id: string
          designId: string
        }

        // Verify design exists
        const design = await DesignService.getById(designId)
        if (!design) {
          throw new NotFoundError('Design', designId)
        }

        // Get ALL ECO-Design associations (for multi-design ECOs)
        const allEcoDesigns = await db
          .select()
          .from(changeOrderDesigns)
          .where(eq(changeOrderDesigns.changeOrderId, changeOrderId))

        // Find the association for the current design
        const ecoDesignAssoc = allEcoDesigns.find(
          (ed) => ed.designId === designId,
        )

        const ecoBranch = ecoDesignAssoc
          ? {
              id: ecoDesignAssoc.branchId,
              mergeStatus: ecoDesignAssoc.mergeStatus,
              itemsAffected: ecoDesignAssoc.itemsAffected,
            }
          : null

        // Determine version context based on ECO state
        let versionContext: VersionContext
        if (
          ecoDesignAssoc?.mergeStatus === 'merged' &&
          ecoDesignAssoc.mergeCommitId
        ) {
          // Released ECO - show historical snapshot at merge
          versionContext = {
            type: 'commit',
            commitId: ecoDesignAssoc.mergeCommitId,
          }
        } else if (ecoDesignAssoc?.branchId) {
          // Active ECO - show branch view
          versionContext = {
            type: 'branch',
            branchId: ecoDesignAssoc.branchId,
          }
        } else {
          // No branch yet - fallback to released/current
          versionContext = { type: 'released', designId }
        }

        // Build context map for all designs affected by this ECO
        const ecoDesignContexts = new Map<string, VersionContext>()
        for (const ecoDesign of allEcoDesigns) {
          if (ecoDesign.mergeStatus === 'merged' && ecoDesign.mergeCommitId) {
            ecoDesignContexts.set(ecoDesign.designId, {
              type: 'commit',
              commitId: ecoDesign.mergeCommitId,
            })
          } else if (ecoDesign.branchId) {
            ecoDesignContexts.set(ecoDesign.designId, {
              type: 'branch',
              branchId: ecoDesign.branchId,
            })
          } else {
            ecoDesignContexts.set(ecoDesign.designId, {
              type: 'released',
              designId: ecoDesign.designId,
            })
          }
        }

        // Get items already affected by this ECO with their change actions
        const affectedItems =
          await ChangeOrderService.getAffectedItems(changeOrderId)
        // Track affected items by both ID and masterId for matching resolved items
        const affectedItemIds = new Set(
          affectedItems.map((a) => a.affectedItemId).filter(Boolean),
        )
        const affectedItemMasterIds = new Set(
          affectedItems
            .map((a) => a.affectedItemMasterId)
            .filter((id): id is string => Boolean(id)),
        )
        // Build maps of affected item ID/masterId -> change action
        const changeActionMap = new Map<string, string>()
        const changeActionByMasterIdMap = new Map<string, string>()
        for (const ai of affectedItems) {
          if (ai.affectedItemId) {
            changeActionMap.set(ai.affectedItemId, ai.changeAction)
          }
          if (ai.affectedItemMasterId) {
            changeActionByMasterIdMap.set(
              ai.affectedItemMasterId,
              ai.changeAction,
            )
          }
        }

        // For Library designs, also track items changed on the ECO branch
        const branchChangedMasterIds = new Set<string>()
        if (design.designType === 'Library' && ecoDesignAssoc?.branchId) {
          const changedItems = await db
            .select({ itemMasterId: branchItems.itemMasterId })
            .from(branchItems)
            .where(
              and(
                eq(branchItems.branchId, ecoDesignAssoc.branchId),
                isNotNull(branchItems.changeType),
              ),
            )
          for (const item of changedItems) {
            branchChangedMasterIds.add(item.itemMasterId)
          }
        }

        // Check if we should expand external items (default: true)
        const url = new URL(request.url, 'http://localhost')
        const expandExternal =
          url.searchParams.get('expandExternal') !== 'false'

        // Get all items in the design at the appropriate version context
        const { items: contextItems } = await VersionResolver.getItemsAtContext(
          designId,
          versionContext,
        )

        // Map to the structure we need
        const allItems = contextItems.map((i) => ({
          id: i.id,
          masterId: i.masterId,
          itemNumber: i.itemNumber,
          name: i.name,
          revision: i.revision,
          state: i.state,
          itemType: i.itemType,
          designId: i.designId,
          inDesignStructure: i.inDesignStructure,
        }))

        // Get BOM relationships where source is in this design
        // We need to query by the resolved item IDs
        const itemIds = allItems.map((i) => i.id)
        const masterIds = allItems.map((i) => i.masterId)

        // For relationships, we need to find relationships from ANY version of these items
        // then resolve targets at context
        let relationships =
          masterIds.length > 0
            ? await db
                .select({
                  rel: itemRelationships,
                  sourceMasterId: items.masterId,
                })
                .from(itemRelationships)
                .innerJoin(items, eq(itemRelationships.sourceId, items.id))
                .where(
                  and(
                    inArray(items.masterId, masterIds),
                    eq(itemRelationships.relationshipType, 'BOM'),
                  ),
                )
            : []

        // Deduplicate relationships by sourceMasterId + targetId to avoid duplicates from multiple revisions
        const seenRelationships = new Set<string>()
        const uniqueRelationships: Array<{
          rel: typeof itemRelationships.$inferSelect
          sourceMasterId: string
        }> = []
        for (const r of relationships) {
          const key = `${r.sourceMasterId}-${r.rel.targetId}`
          if (!seenRelationships.has(key)) {
            seenRelationships.add(key)
            uniqueRelationships.push(r)
          }
        }
        relationships = uniqueRelationships

        // Find external target IDs (items from other designs)
        const externalTargetIds = relationships
          .map((r) => r.rel.targetId)
          .filter((id) => !itemIds.includes(id))

        // Resolve external items at their appropriate context
        type ExternalItem = typeof items.$inferSelect & {
          designCode?: string | null
          designName?: string | null
        }
        let externalItems: Array<ExternalItem> = []

        if (externalTargetIds.length > 0) {
          // Resolve external targets using version resolution
          const resolvedTargets =
            await VersionResolver.resolveRelationshipTargets(
              externalTargetIds,
              versionContext,
              ecoDesignContexts,
            )

          // Get design info for external items
          const externalDesignIds = new Set<string>()
          for (const item of resolvedTargets.values()) {
            if (item.designId) {
              externalDesignIds.add(item.designId)
            }
          }

          const designInfoMap = new Map<
            string,
            { code: string | null; name: string }
          >()
          if (externalDesignIds.size > 0) {
            const designInfos = await db
              .select({
                id: designs.id,
                code: designs.code,
                name: designs.name,
              })
              .from(designs)
              .where(inArray(designs.id, Array.from(externalDesignIds)))
            for (const d of designInfos) {
              designInfoMap.set(d.id, { code: d.code, name: d.name })
            }
          }

          // Build external items with design info
          for (const [, resolved] of resolvedTargets) {
            const designInfo = resolved.designId
              ? designInfoMap.get(resolved.designId)
              : null
            externalItems.push({
              ...resolved,
              designCode: designInfo?.code ?? null,
              designName: designInfo?.name ?? null,
            })
          }
        }

        // Recursively expand external items' children (for cross-design BOM traversal)
        if (expandExternal && externalItems.length > 0) {
          const allExternalItemIds = new Set(externalItems.map((i) => i.id))
          const allExternalMasterIds = new Set(
            externalItems.map((i) => i.masterId),
          )
          const allExternalItems = [...externalItems]
          let currentExternalMasterIds = [
            ...externalItems.map((i) => i.masterId),
          ]
          const maxDepth = 10 // Prevent infinite loops
          let depth = 0

          while (currentExternalMasterIds.length > 0 && depth < maxDepth) {
            depth++

            // Fetch BOM relationships where source masterId is one of the current external items
            const externalRelationships = await db
              .select({
                rel: itemRelationships,
                sourceMasterId: items.masterId,
              })
              .from(itemRelationships)
              .innerJoin(items, eq(itemRelationships.sourceId, items.id))
              .where(
                and(
                  inArray(items.masterId, currentExternalMasterIds),
                  eq(itemRelationships.relationshipType, 'BOM'),
                ),
              )

            if (externalRelationships.length === 0) break

            // Deduplicate
            const newUniqueRelationships: Array<{
              rel: typeof itemRelationships.$inferSelect
              sourceMasterId: string
            }> = []
            for (const r of externalRelationships) {
              const key = `${r.sourceMasterId}-${r.rel.targetId}`
              if (!seenRelationships.has(key)) {
                seenRelationships.add(key)
                newUniqueRelationships.push(r)
              }
            }

            if (newUniqueRelationships.length === 0) break

            // Add these relationships to the main list
            relationships = [...relationships, ...newUniqueRelationships]

            // Find new external targets we haven't seen yet
            const newExternalTargetIds = newUniqueRelationships
              .map((r) => r.rel.targetId)
              .filter(
                (id) => !itemIds.includes(id) && !allExternalItemIds.has(id),
              )

            if (newExternalTargetIds.length === 0) break

            // Resolve new external items at context
            const newResolvedTargets =
              await VersionResolver.resolveRelationshipTargets(
                newExternalTargetIds,
                versionContext,
                ecoDesignContexts,
              )

            // Get design info for new external items
            const newDesignIds = new Set<string>()
            for (const item of newResolvedTargets.values()) {
              if (item.designId) {
                newDesignIds.add(item.designId)
              }
            }

            const newDesignInfoMap = new Map<
              string,
              { code: string | null; name: string }
            >()
            if (newDesignIds.size > 0) {
              const newDesignInfos = await db
                .select({
                  id: designs.id,
                  code: designs.code,
                  name: designs.name,
                })
                .from(designs)
                .where(inArray(designs.id, Array.from(newDesignIds)))
              for (const d of newDesignInfos) {
                newDesignInfoMap.set(d.id, { code: d.code, name: d.name })
              }
            }

            // Add to our collections
            const newMasterIds: Array<string> = []
            for (const [, resolved] of newResolvedTargets) {
              if (!allExternalMasterIds.has(resolved.masterId)) {
                allExternalMasterIds.add(resolved.masterId)
                allExternalItemIds.add(resolved.id)
                newMasterIds.push(resolved.masterId)

                const designInfo = resolved.designId
                  ? newDesignInfoMap.get(resolved.designId)
                  : null
                allExternalItems.push({
                  ...resolved,
                  designCode: designInfo?.code ?? null,
                  designName: designInfo?.name ?? null,
                })
              }
            }

            // Continue with these new external items in the next iteration
            currentExternalMasterIds = newMasterIds
          }

          // Update externalItems with all discovered external items
          externalItems = allExternalItems
        }

        // Build design map for external items
        const externalDesignMap = new Map(
          externalItems.map((item) => [
            item.id,
            { code: item.designCode, name: item.designName },
          ]),
        )

        // Build a map of children for each item (by masterId for local, by id for external)
        const childrenMap = new Map<
          string,
          Array<{
            childId: string
            childMasterId: string
            relationshipId: string
            quantity?: number
            findNumber?: number
          }>
        >()
        const hasParent = new Set<string>()

        // Create lookup maps for efficient access
        const localItemById = new Map(allItems.map((i) => [i.id, i]))
        const localItemByMasterId = new Map(
          allItems.map((i) => [i.masterId, i]),
        )
        const externalItemById = new Map(externalItems.map((i) => [i.id, i]))
        const externalItemByMasterId = new Map(
          externalItems.map((i) => [i.masterId, i]),
        )

        // Collect target IDs that aren't in local or external items for batch lookup
        const unknownTargetIds: Array<string> = []
        for (const r of relationships) {
          const targetId = r.rel.targetId
          if (!localItemById.has(targetId) && !externalItemById.has(targetId)) {
            unknownTargetIds.push(targetId)
          }
        }

        // Batch fetch masterIds for unknown targets
        const unknownTargetMasterIds = new Map<string, string>()
        if (unknownTargetIds.length > 0) {
          const targetLookups = await db
            .select({ id: items.id, masterId: items.masterId })
            .from(items)
            .where(inArray(items.id, unknownTargetIds))
          for (const t of targetLookups) {
            unknownTargetMasterIds.set(t.id, t.masterId)
          }
        }

        // Build children map using pre-fetched data
        for (const r of relationships) {
          const sourceMasterId = r.sourceMasterId
          if (!childrenMap.has(sourceMasterId)) {
            childrenMap.set(sourceMasterId, [])
          }

          // Find the target item - either from local items or external items
          const targetId = r.rel.targetId
          let targetMasterId: string | null = null
          let targetItem =
            localItemById.get(targetId) || externalItemById.get(targetId)

          if (targetItem) {
            targetMasterId = targetItem.masterId
          } else {
            // Use pre-fetched masterId lookup
            targetMasterId = unknownTargetMasterIds.get(targetId) ?? null
            if (targetMasterId) {
              // Try to find the resolved version by masterId
              targetItem =
                localItemByMasterId.get(targetMasterId) ||
                externalItemByMasterId.get(targetMasterId)
            }
          }

          if (targetMasterId && targetItem) {
            childrenMap.get(sourceMasterId)!.push({
              childId: targetItem.id,
              childMasterId: targetMasterId,
              relationshipId: r.rel.id,
              quantity: r.rel.quantity ? Number(r.rel.quantity) : undefined,
              findNumber: r.rel.findNumber ?? undefined,
            })
            hasParent.add(targetMasterId)
          }
        }

        // Create item lookup map by masterId (includes both local and external items)
        const itemByMasterIdMap = new Map([
          ...allItems.map(
            (i) =>
              [
                i.masterId,
                {
                  ...i,
                  designCode: undefined as string | undefined,
                  designName: undefined as string | undefined,
                },
              ] as const,
          ),
          ...externalItems.map(
            (i) =>
              [
                i.masterId,
                {
                  ...i,
                  designCode: i.designCode ?? undefined,
                  designName: i.designName ?? undefined,
                },
              ] as const,
          ),
        ])

        // Build tree nodes recursively (using masterId for traversal)
        const buildNode = (
          masterId: string,
          visited: Set<string>,
        ): BOMTreeNode | null => {
          if (visited.has(masterId)) return null // Prevent cycles
          const item = itemByMasterIdMap.get(masterId)
          if (!item) return null

          visited.add(masterId)

          // Check if this is an external item (from a different design)
          const isExternal = item.designId !== designId
          const designInfo = isExternal ? externalDesignMap.get(item.id) : null

          const children = childrenMap.get(masterId) || []
          const childNodes = children
            .map((c) => {
              const node = buildNode(c.childMasterId, new Set(visited))
              if (node) {
                node.quantity = c.quantity
                node.findNumber = c.findNumber
                node.relationshipId = c.relationshipId
              }
              return node
            })
            .filter((n): n is BOMTreeNode => n !== null)

          // Check if item is in ECO by ID or masterId (for revised items)
          const isInEco =
            affectedItemIds.has(item.id) || affectedItemMasterIds.has(masterId)
          const changeAction =
            changeActionMap.get(item.id) ??
            changeActionByMasterIdMap.get(masterId) ??
            null

          return {
            itemId: item.id,
            masterId, // Include for frontend deduplication across designs
            itemNumber: item.itemNumber,
            name: item.name,
            revision: item.revision,
            state: item.state,
            itemType: item.itemType,
            designId: item.designId,
            isInEco,
            isBranchChanged: branchChangedMasterIds.has(masterId),
            changeAction,
            children: childNodes.length > 0 ? childNodes : undefined,
            // Cross-design reference fields
            designCode:
              designInfo?.code ?? (item as any).designCode ?? undefined,
            designName:
              designInfo?.name ?? (item as any).designName ?? undefined,
            isExternal,
          }
        }

        // =====================================================================
        // Cross-design references: fetch and add as additional root items
        // =====================================================================
        const crossRefs =
          await CrossDesignReferenceService.getReferencesForDesign(
            designId,
            ecoDesignAssoc?.branchId,
          )

        const crossRefMasterIds = new Set<string>()

        if (crossRefs.length > 0) {
          const crossRefItemIdsToFetch = crossRefs
            .filter((ref) => ref.inDesignStructure !== false)
            .map((ref) => ref.referencedItemId)

          if (crossRefItemIdsToFetch.length > 0) {
            // Resolve cross-ref items to their latest version
            // For source designs in this ECO, resolve to ECO branch version
            const resolvedCrossRefItems =
              await VersionResolver.resolveRelationshipTargets(
                crossRefItemIdsToFetch,
                versionContext,
                ecoDesignContexts,
              )

            // Fetch design info for resolved items
            const resolvedDesignIds = new Set<string>()
            for (const item of resolvedCrossRefItems.values()) {
              if (item.designId) resolvedDesignIds.add(item.designId)
            }

            const crossRefDesignInfoMap = new Map<
              string,
              { code: string | null; name: string }
            >()
            if (resolvedDesignIds.size > 0) {
              const designInfos = await db
                .select({
                  id: designs.id,
                  code: designs.code,
                  name: designs.name,
                })
                .from(designs)
                .where(inArray(designs.id, Array.from(resolvedDesignIds)))
              for (const d of designInfos) {
                crossRefDesignInfoMap.set(d.id, { code: d.code, name: d.name })
              }
            }

            // Track cross-ref root masterIds and add items to maps
            for (const [, resolvedItem] of resolvedCrossRefItems) {
              crossRefMasterIds.add(resolvedItem.masterId)
              const designInfo = resolvedItem.designId
                ? crossRefDesignInfoMap.get(resolvedItem.designId)
                : null
              itemByMasterIdMap.set(resolvedItem.masterId, {
                ...resolvedItem,
                designCode: designInfo?.code ?? undefined,
                designName: designInfo?.name ?? undefined,
              })
              if (designInfo?.code || designInfo?.name) {
                externalDesignMap.set(resolvedItem.id, {
                  code: designInfo.code,
                  name: designInfo.name,
                })
              }
            }

            // Recursively expand BOM children of cross-ref items
            let currentMasterIds = [...crossRefMasterIds]
            const allDiscoveredMasterIds = new Set(crossRefMasterIds)
            let depth = 0

            while (currentMasterIds.length > 0 && depth < 10) {
              depth++

              // Get resolved item IDs for the current master IDs
              // Query by resolved sourceId to get only relationships from the correct version
              // (querying by masterId would find relationships from ALL revisions)
              const currentResolvedIds = currentMasterIds
                .map((mid) => itemByMasterIdMap.get(mid)?.id)
                .filter((id): id is string => id !== undefined)

              if (currentResolvedIds.length === 0) break

              const childRels = await db
                .select({
                  rel: itemRelationships,
                  sourceMasterId: items.masterId,
                })
                .from(itemRelationships)
                .innerJoin(items, eq(itemRelationships.sourceId, items.id))
                .where(
                  and(
                    inArray(itemRelationships.sourceId, currentResolvedIds),
                    eq(itemRelationships.relationshipType, 'BOM'),
                  ),
                )

              if (childRels.length === 0) break

              // Deduplicate and add to childrenMap
              const newTargetIds: Array<string> = []
              for (const r of childRels) {
                const key = `${r.sourceMasterId}-${r.rel.targetId}`
                if (seenRelationships.has(key)) continue
                seenRelationships.add(key)

                // Look up target item in existing maps or by ID
                const targetId = r.rel.targetId
                const targetMasterId =
                  localItemById.get(targetId)?.masterId ??
                  externalItemById.get(targetId)?.masterId ??
                  unknownTargetMasterIds.get(targetId) ??
                  null

                // Find target item from any map
                const targetItem = targetMasterId
                  ? itemByMasterIdMap.get(targetMasterId)
                  : undefined

                if (!targetMasterId || !targetItem) {
                  // Need to fetch this item
                  newTargetIds.push(targetId)
                } else {
                  // Add to childrenMap
                  if (!childrenMap.has(r.sourceMasterId)) {
                    childrenMap.set(r.sourceMasterId, [])
                  }
                  childrenMap.get(r.sourceMasterId)!.push({
                    childId: targetItem.id,
                    childMasterId: targetMasterId,
                    relationshipId: r.rel.id,
                    quantity: r.rel.quantity
                      ? Number(r.rel.quantity)
                      : undefined,
                    findNumber: r.rel.findNumber ?? undefined,
                  })
                  hasParent.add(targetMasterId)
                }
              }

              // Fetch unknown target items
              const uniqueNewTargetIds = [
                ...new Set(
                  newTargetIds.filter(
                    (id) => !localItemById.has(id) && !externalItemById.has(id),
                  ),
                ),
              ]

              if (uniqueNewTargetIds.length > 0) {
                const newItems = await db
                  .select({
                    id: items.id,
                    itemNumber: items.itemNumber,
                    name: items.name,
                    revision: items.revision,
                    state: items.state,
                    itemType: items.itemType,
                    inDesignStructure: items.inDesignStructure,
                    designId: items.designId,
                    masterId: items.masterId,
                    designCode: designs.code,
                    designName: designs.name,
                  })
                  .from(items)
                  .leftJoin(designs, eq(items.designId, designs.id))
                  .where(inArray(items.id, uniqueNewTargetIds))

                for (const item of newItems) {
                  itemByMasterIdMap.set(item.masterId, {
                    ...item,
                    designCode: item.designCode ?? undefined,
                    designName: item.designName ?? undefined,
                  })
                  if (item.designCode || item.designName) {
                    externalDesignMap.set(item.id, {
                      code: item.designCode,
                      name: item.designName,
                    })
                  }
                }

                // Now add the deferred childrenMap entries
                for (const r of childRels) {
                  // Only process the ones we deferred (newTargetIds)
                  if (!newTargetIds.includes(r.rel.targetId)) continue

                  const targetId = r.rel.targetId
                  // Find masterId from newly fetched items
                  const fetched = newItems.find((i) => i.id === targetId)
                  if (!fetched) continue

                  if (!childrenMap.has(r.sourceMasterId)) {
                    childrenMap.set(r.sourceMasterId, [])
                  }
                  const existing = childrenMap.get(r.sourceMasterId)!
                  if (
                    !existing.some((c) => c.childMasterId === fetched.masterId)
                  ) {
                    existing.push({
                      childId: fetched.id,
                      childMasterId: fetched.masterId,
                      relationshipId: r.rel.id,
                      quantity: r.rel.quantity
                        ? Number(r.rel.quantity)
                        : undefined,
                      findNumber: r.rel.findNumber ?? undefined,
                    })
                    hasParent.add(fetched.masterId)
                  }
                }
              }

              // Continue expanding with newly discovered masterIds
              const nextMasterIds: Array<string> = []
              for (const r of childRels) {
                const targetId = r.rel.targetId
                const targetItem =
                  localItemById.get(targetId) ?? externalItemById.get(targetId)
                const masterId =
                  targetItem?.masterId ?? unknownTargetMasterIds.get(targetId)
                // Also check newly fetched items
                const fetchedMasterId = (() => {
                  for (const [mid, item] of itemByMasterIdMap) {
                    if (item.id === targetId) return mid
                  }
                  return undefined
                })()
                const resolvedMasterId = masterId ?? fetchedMasterId
                if (
                  resolvedMasterId &&
                  !allDiscoveredMasterIds.has(resolvedMasterId)
                ) {
                  allDiscoveredMasterIds.add(resolvedMasterId)
                  nextMasterIds.push(resolvedMasterId)
                }
              }
              currentMasterIds = nextMasterIds
            }
          }
        }

        // Find root items: Parts with inDesignStructure=true and no parent
        let roots: Array<BOMTreeNode> = []
        for (const item of allItems) {
          if (
            !hasParent.has(item.masterId) &&
            item.itemType === 'Part' &&
            item.inDesignStructure !== false
          ) {
            const node = buildNode(item.masterId, new Set())
            if (node) {
              roots.push(node)
            }
          }
        }

        // Add cross-design references as roots
        for (const masterId of crossRefMasterIds) {
          const node = buildNode(masterId, new Set())
          if (node) {
            roots.push(node)
          }
        }

        // Sort roots by item number
        roots.sort((a, b) => a.itemNumber.localeCompare(b.itemNumber))

        // For Library designs, filter roots to only those whose subtree contains an affected or branch-changed item
        if (design.designType === 'Library') {
          const hasAffectedDescendant = (node: BOMTreeNode): boolean => {
            if (node.isInEco) return true
            if (branchChangedMasterIds.has(node.masterId)) return true
            return node.children?.some(hasAffectedDescendant) ?? false
          }
          roots = roots.filter(hasAffectedDescendant)
        }

        // Find orphan items
        let orphans: Array<OrphanItem> = allItems
          .filter((item) => {
            if (item.itemType !== 'Part') return true
            if (item.inDesignStructure === false) return true
            return false
          })
          .map((item) => ({
            id: item.id,
            itemNumber: item.itemNumber,
            name: item.name,
            revision: item.revision,
            state: item.state,
            itemType: item.itemType,
            isInEco:
              affectedItemIds.has(item.id) ||
              affectedItemMasterIds.has(item.masterId),
            isBranchChanged: branchChangedMasterIds.has(item.masterId),
            changeAction:
              changeActionMap.get(item.id) ??
              changeActionByMasterIdMap.get(item.masterId) ??
              null,
          }))
          .sort((a, b) => a.itemNumber.localeCompare(b.itemNumber))

        // For Library designs, only show orphans that are in the ECO or changed on branch
        if (design.designType === 'Library') {
          orphans = orphans.filter(
            (item) => item.isInEco || item.isBranchChanged,
          )
        }

        return {
          roots,
          orphans,
          affectedItemIds: Array.from(affectedItemIds),
          ecoBranch,
          design: {
            id: design.id,
            name: design.name,
            description: design.description,
          },
          // Version context info for UI
          versionContext: {
            type: versionContext.type,
            isHistorical: versionContext.type === 'commit',
            mergedAt: ecoDesignAssoc?.mergedAt || null,
          },
        }
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
    apiHandler(
      { permission: ['change_orders', 'read'] },
      async ({ params }) => {
        const { id } = params as { id: string }

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
    apiHandler(
      { permission: ['change_orders', 'update'] },
      async ({ params, request }) => {
        const { id } = params as { id: string }
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
    apiHandler(
      { permission: ['change_orders', 'read'] },
      async ({ params, request }) => {
        const { id: changeOrderId, itemId } = params as {
          id: string
          itemId: string
        }

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

        // Find ancestors within the design
        const allAncestors = await ImpactAssessmentService.findAncestorChain(
          itemId,
          designId,
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
    apiHandler(
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
    apiHandler(
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

        return new Response(
          JSON.stringify({
            success: allSuccess,
            results,
          }),
          {
            status: allSuccess ? 200 : 207, // 207 Multi-Status if partial success
            headers: { 'Content-Type': 'application/json' },
          },
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
    apiHandler(
      { permission: ['change_orders', 'read'] },
      async ({ params }) => {
        const { id } = params as { id: string }

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
    apiHandler(
      { permission: ['change_orders', 'update'] },
      async ({ request, user }) => {
        const url = new URL(request.url)
        const riskId = url.searchParams.get('riskId')

        if (!riskId) {
          throw new ValidationError('Missing riskId parameter')
        }

        await ChangeOrderService.acknowledgeRisk(riskId, user.id)

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
    apiHandler(
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
    apiHandler(
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
    apiHandler(
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
    apiHandler(
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

// GET /api/change-orders/:id/workflow/transition
app.get(
  '/:id/workflow/transition',
  adapt(
    apiHandler(
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
    apiHandler(
      { permission: ['change_orders', 'update'] },
      async ({ params, request, user }) => {
        const data = await request.json()

        if (!data.toStateId) {
          throw new ValidationError('toStateId is required')
        }

        const instance = await WorkflowService.getInstanceByItemId(params.id)

        if (!instance) {
          throw new NotFoundError('Workflow', params.id, {
            detail: 'No workflow found for this change order',
          })
        }

        // Get effective structure (handles flexible workflows with instance-level states)
        const effectiveStructure = await WorkflowService.getEffectiveStructure(
          instance.id,
        )
        const targetState = effectiveStructure.states.find(
          (s) => s.id === data.toStateId,
        )

        // For transitions to a final state:
        // 1. First do the workflow transition (changes state to Approved)
        // 2. Then auto-trigger close() which merges branches and assigns revisions
        if (targetState?.isFinal === true) {
          // Execute the workflow transition first
          const transitionResult = await WorkflowService.transition(
            instance.id,
            data.toStateId,
            user.id,
            data.comments,
          )

          if (!transitionResult.success) {
            throw new ValidationError(
              transitionResult.error || 'Transition failed',
            )
          }

          // Determine if this is a cancellation or a release
          const stateName = (targetState.name || '').toLowerCase()
          const isCancellation =
            stateName.includes('cancel') || stateName.includes('reject')

          if (isCancellation) {
            // Cancel: cleanup branches without merging
            await ChangeOrderService.cancel(params.id, user.id)
            return {
              success: true,
              fromState: instance.currentState,
              toState: data.toStateId,
              cancelled: true,
            }
          }

          // Release: merge branches to main, assign revisions
          const mergeResult = await ChangeOrderService.close(params.id, user.id)

          return {
            success: true,
            fromState: instance.currentState,
            toState: data.toStateId,
            mergeResult,
          }
        }

        // For other transitions, use standard workflow transition
        const result = await WorkflowService.transition(
          instance.id,
          data.toStateId,
          user.id,
          data.comments,
        )

        if (!result.success) {
          throw new ValidationError(result.error || 'Transition failed')
        }

        return result
      },
    ),
  ),
)

// POST /api/change-orders/:id/workflow/validate-transition
app.post(
  '/:id/workflow/validate-transition',
  adapt(
    apiHandler(
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

        // Validate lifecycle effects if any (only present on definition-level transitions)
        const lifecycleEffects =
          'lifecycleEffects' in transition && transition.lifecycleEffects
            ? transition.lifecycleEffects
            : []
        let lifecycleEffectErrors: Array<string> = []

        if (lifecycleEffects.length > 0) {
          const lifecycleValidation =
            await WorkflowService.validateLifecycleEffectsGuards(
              transition,
              params.id,
              user.id,
            )
          lifecycleEffectErrors = lifecycleValidation.errors
        }

        // Build preview of affected items
        const affectedItems = await ChangeOrderService.getAffectedItems(
          params.id,
        )
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

            // Find applicable lifecycle effects for this item
            const applicableEffects = lifecycleEffects.filter(
              (e) => e.changeAction === affected.changeAction,
            )

            // Build predicted transition chain
            const predictedTransitions: Array<{
              fromState: string
              toState: string
              lifecycleName: string
            }> = []

            let currentState = item.state || ''
            for (const effect of applicableEffects) {
              if (effect.fromStateId === currentState) {
                const lifecycle = await WorkflowService.getById(
                  effect.lifecycleDefinitionId,
                )
                predictedTransitions.push({
                  fromState: effect.fromStateId,
                  toState: effect.toStateId,
                  lifecycleName: lifecycle?.name || 'Unknown',
                })
                currentState = effect.toStateId
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

        const valid = canTransitionResult.allowed

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
    apiHandler(
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
    apiHandler(
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
