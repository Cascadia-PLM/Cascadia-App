// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { tagged } from '../../adapter'
import { requirePermission } from '@/lib/auth/server'
import { NotFoundError, PermissionDeniedError } from '@/lib/errors'
import { ItemService } from '@/lib/items/services/ItemService'
import { getResourceType } from '@/lib/items/item-type-resources'
import { ItemRelationshipService } from '@/lib/items/services/ItemRelationshipService'
import { ImpactAssessmentService } from '@/lib/items/services/ImpactAssessmentService'
import { BranchService } from '@/lib/services/BranchService'
import { VersionResolver } from '@/lib/services/VersionResolver'
import { RequirementService } from '@/lib/services/RequirementService'
import {
  ImpactAnalysisService,
  impactAnalysisRequestSchema,
} from '@/lib/services/ImpactAnalysisService'
import { apiHandler, created } from '@/lib/api/handler'
import { requireItemAccess, requireItemsAccess } from '@/lib/auth/access'
import {
  calculateLockDuration,
  createLockedStatus,
  createUnlockedStatus,
} from '@/lib/api'
import { FileService } from '@/lib/vault/services/FileService'
import { db } from '@/lib/db'
import {
  changeOrders,
  documents,
  items,
  parts,
  requirements,
  tasks,
  users,
} from '@/lib/db/schema'

const adapt = tagged('Items')

const app = new Hono()

/**
 * Body of the lock/unlock routes. Optional — an absent body means the
 * default (non-force) behaviour, and only a literal `force: true` escalates.
 */
const lockBodySchema = z
  .object({
    force: z.boolean().optional(),
  })
  .optional()

/** Body of POST /items/:id/sync-properties. */
const syncPropertiesSchema = z.object({
  properties: z.record(z.string(), z.unknown()),
})

// GET /api/items/:id/at-context
//
// This route, /:id/available-contexts and /:id/history hand-rolled
// `if (designId) await requireDesignAccess(...)` where every other by-id
// handler in this file calls `requireItemAccess`. Those are not the same
// check. `items.designId` is NULL on every ChangeOrder the application
// creates — an ECO's designs hang off `change_order_designs` — and on every
// Issue whose only axis is `issues.program_id` or `issue_designs`, so on
// those two types the branch never ran and authentication was the entire
// gate. This route ships the row merged with its type-specific table, so on
// an ECO that was a cross-program read of changeType, description,
// reasonForChange, impactDescription, riskLevel and the approval stamps for
// anyone holding the id.
//
// `requireItemAccess` dispatches ChangeOrder to `requireEcoAccess` and Issue
// to `requireIssueAccess`, and otherwise ends in the identical
// `requireDesignAccess` call — so the nine design-carrying types are
// unaffected. WorkOrder and PhysicalPart rows carry no designId either, and
// the dispatch they needed has since landed: they now answer
// `requireWorkOrderAccess` (the program the row names) and
// `requirePhysicalPartAccess` (the design of the part lineage the instance
// names), which is what the typed routers and the item list already applied
// to them.
//
// The gate runs BEFORE the existence lookup, matching the rest of the file.
// One consequence, for soft-deleted rows only: `requireItemAccess`
// deliberately does not filter them (its docblock says so — it answers
// authorization and leaves existence policy to its callers) while
// `ItemService.findById` does, so an unreachable soft-deleted id now answers
// 403 where it used to answer 404. A reachable one still answers 404.
//
// `findById` stays where it is. `requireItemAccess` returns only the bare
// `items` row, and these handlers ship it merged with its type-specific
// table; `PersistedItem` is not assignable to `typeof items.$inferSelect`, so
// the merged row cannot be handed back to the gate either.
//
// ---
//
// The RBAC tuple below — and on the seven other reads in this file, which
// point back at this note — cannot be declared statically in `apiHandler`
// options: /items/:id/* serves all 13 item types, so a fixed
// ['parts', 'read'] would charge the wrong resource for a Document and let a
// parts-only key read one. Dispatch on the row `requireItemAccess` already
// returned, the way GET /api/v1/items/:id and GET /:id/thumbnail do;
// `getResourceType` is fail-closed, so an unknown type charges parts rather
// than skipping the check.
//
// Declaring nothing here was not "no policy": `apiHandler` guards the whole
// RBAC block on `if (options.permission)`, so role permissions were never
// consulted and a scoped API key had nothing to intersect against. No seeded
// role moves — Administrator, Power User, Approver, User and View Only each
// hold `read` on all thirteen item resources — so what the tuple constrains
// is scoped API keys and customer-defined roles. On a WorkOrder or
// PhysicalPart id it is more than that: it is the only check these routes
// have, because `requireItemAccess` has no arm for either type.
app.get(
  '/:id/at-context',
  adapt(
    apiHandler<{ id: string }>({}, async ({ request, params, user }) => {
      const subject = await requireItemAccess(user.id, params.id)
      await requirePermission(
        request,
        getResourceType(subject.itemType),
        'read',
      )

      const url = new URL(request.url)
      const commitId = url.searchParams.get('commitId')
      const tagId = url.searchParams.get('tagId')
      const branchId = url.searchParams.get('branchId')

      // Get the base item to find masterId and designId
      const baseItem = await ItemService.findById(params.id)
      if (!baseItem) {
        throw new NotFoundError('Item', params.id)
      }

      const released = url.searchParams.get('released')

      // If no version context, return the base item
      // If released=true, resolve to the released/main version via VersionResolver
      let context:
        | { type: 'branch'; branchId: string }
        | { type: 'commit'; commitId: string }
        | { type: 'tag'; tagId: string }
        | { type: 'released'; designId: string }
        | undefined
      if (!commitId && !tagId && !branchId) {
        if (released === 'true' && baseItem.designId && baseItem.masterId) {
          context = { type: 'released', designId: baseItem.designId }
          // fall through to VersionResolver resolution below
        } else {
          return {
            item: baseItem,
            existsAtContext: true,
            resolvedItemId: baseItem.id,
          }
        }
      }

      // Need a design to resolve version context
      if (!baseItem.designId) {
        return {
          item: baseItem,
          existsAtContext: true,
          resolvedItemId: baseItem.id,
        }
      }

      // Build version context (if not already set by released=true above)
      if (!context) {
        if (commitId) {
          context = { type: 'commit', commitId }
        } else if (tagId) {
          context = { type: 'tag', tagId }
        } else if (branchId) {
          context = { type: 'branch', branchId }
        } else {
          context = { type: 'released', designId: baseItem.designId }
        }
      }

      // Get the item at the specified version context
      const itemAtContext = await VersionResolver.getItemAtContext(
        baseItem.masterId,
        baseItem.designId,
        context,
      )

      if (!itemAtContext) {
        // Not a 404: the item exists, it just has no version in this context.
        // That answer is data, and it used to ship as a 200 carrying a
        // top-level `error` beside `data` — a shape no client reads (apiFetch
        // only parses `error` on a non-ok status) and one the document does
        // not describe.
        return { item: null, existsAtContext: false }
      }

      // Enrich with type-specific data
      let enrichedItem = { ...itemAtContext }

      if (itemAtContext.itemType === 'Part') {
        const partResults = await db
          .select()
          .from(parts)
          .where(eq(parts.itemId, itemAtContext.id))
        if (partResults[0]) {
          enrichedItem = { ...enrichedItem, ...partResults[0] }
        }
      }
      if (itemAtContext.itemType === 'Document') {
        const docResults = await db
          .select()
          .from(documents)
          .where(eq(documents.itemId, itemAtContext.id))
        if (docResults[0]) {
          enrichedItem = { ...enrichedItem, ...docResults[0] }
        }
      }
      if (itemAtContext.itemType === 'ChangeOrder') {
        const coResults = await db
          .select()
          .from(changeOrders)
          .where(eq(changeOrders.itemId, itemAtContext.id))
        if (coResults[0]) {
          enrichedItem = { ...enrichedItem, ...coResults[0] }
        }
      }
      if (itemAtContext.itemType === 'Requirement') {
        const reqResults = await db
          .select()
          .from(requirements)
          .where(eq(requirements.itemId, itemAtContext.id))
        if (reqResults[0]) {
          enrichedItem = { ...enrichedItem, ...reqResults[0] }
        }
      }
      if (itemAtContext.itemType === 'Task') {
        const taskResults = await db
          .select()
          .from(tasks)
          .where(eq(tasks.itemId, itemAtContext.id))
        if (taskResults[0]) {
          enrichedItem = { ...enrichedItem, ...taskResults[0] }
        }
      }

      return {
        item: enrichedItem,
        existsAtContext: true,
        resolvedItemId: itemAtContext.id,
      }
    }),
  ),
)

// GET /api/items/:id/available-contexts
//
// See the gate and tuple notes above GET /:id/at-context.
app.get(
  '/:id/available-contexts',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params, request, user }) => {
      const subject = await requireItemAccess(user.id, params.id)
      await requirePermission(
        request,
        getResourceType(subject.itemType),
        'read',
      )

      // Get the item to find masterId and designId
      const item = await ItemService.findById(params.id)
      if (!item) {
        throw new NotFoundError('Item', params.id)
      }

      // If no designId, return empty arrays - item is not versioned
      if (!item.designId) {
        return { branches: [], tags: [] }
      }

      // Get available contexts for the item
      const contexts = await VersionResolver.getAvailableContextsForItem(
        item.masterId,
        item.designId,
      )

      return contexts
    }),
  ),
)

// GET /api/items/:id/history
//
// See the gate and tuple notes above GET /:id/at-context. Gating here does
// not disturb the delete-inclusive lookup below: `requireItemAccess`
// deliberately does not filter soft-deleted rows either, so a soft-deleted row
// is still found, still gated on its own axes, and still served to a caller
// who may reach it.
app.get(
  '/:id/history',
  adapt(
    apiHandler<{ id: string }>({}, async ({ request, params, user }) => {
      const subject = await requireItemAccess(user.id, params.id)
      await requirePermission(
        request,
        getResourceType(subject.itemType),
        'read',
      )

      const url = new URL(request.url)
      const commitId = url.searchParams.get('commitId')
      const tagId = url.searchParams.get('tagId')
      const branchId = url.searchParams.get('branchId')

      // Get the item. History is an audit read, so it must answer for a
      // soft-deleted row's own id: once an ECO deletion is released, the id a
      // user has bookmarked (or follows from the ECO's affected-items list) is
      // exactly the row the merge soft-deleted, and 404-ing hides the deletion
      // event they came to read. ItemService.findById filters soft-deleted
      // rows, so fall back to a delete-inclusive lookup for the two fields this
      // handler needs. Scoped deliberately to this handler — every other
      // findById caller (search, lists, graph, edit paths) still wants deleted
      // rows gone, and access is still gated on the row's own design below.
      const item: { masterId: string; designId?: string | null } | undefined =
        (await ItemService.findById(params.id)) ??
        (
          await db
            .select({ masterId: items.masterId, designId: items.designId })
            .from(items)
            .where(eq(items.id, params.id))
            .limit(1)
        ).at(0)
      if (!item) {
        throw new NotFoundError('Item', params.id)
      }

      // Get history - need designId
      if (!item.designId) {
        // Item not in a design yet - return empty history
        return { history: [] }
      }

      // Resolve the version context to a commit ID
      let untilCommitId: string | undefined
      if (commitId) {
        untilCommitId = commitId
      } else if (tagId) {
        // Get the commit ID from the tag
        const { tags } = await import('@/lib/db/schema')
        const [tag] = await db
          .select({ commitId: tags.commitId })
          .from(tags)
          .where(eq(tags.id, tagId))
        if (!tag) throw new NotFoundError('Tag', tagId)
        untilCommitId = tag.commitId
      } else if (branchId) {
        // Get the head commit ID from the branch
        const branch = await BranchService.getById(branchId)
        if (branch?.headCommitId) {
          untilCommitId = branch.headCommitId
        }
      }

      // designId and masterId are guaranteed to be non-null at this point (checked above)
      const history = await ItemService.getHistory(
        item.masterId,
        item.designId,
        {
          untilCommitId,
          branchId: branchId || undefined,
        },
      )

      // Enrich with author information
      const authorIds = [...new Set(history.map((h) => h.commit.createdBy))]
      const authorsResult =
        authorIds.length > 0
          ? await db
              .select({ id: users.id, name: users.name })
              .from(users)
              .where(inArray(users.id, authorIds))
          : []
      const authorMap = new Map(authorsResult.map((a) => [a.id, a]))

      const enrichedHistory = history.map((entry) => ({
        ...entry,
        author: authorMap.get(entry.commit.createdBy) || null,
      }))

      return { history: enrichedHistory }
    }),
  ),
)

// POST /api/items/:id/impact-analysis
//
// See the tuple note above GET /:id/at-context. This one takes the READ tuple
// despite the verb: it is a POST only because it carries a body, and
// `ImpactAnalysisService.analyze` traverses relationships and writes nothing.
app.post(
  '/:id/impact-analysis',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof impactAnalysisRequestSchema>>(
      { body: impactAnalysisRequestSchema },
      async ({ params, request, user, body }) => {
        const subject = await requireItemAccess(user.id, params.id)
        await requirePermission(
          request,
          getResourceType(subject.itemType),
          'read',
        )

        // Run impact analysis
        const result = await ImpactAnalysisService.analyze({
          itemId: params.id,
          ...body,
        })

        return result
      },
    ),
  ),
)

// GET /api/items/:id/lock-status
//
// See the tuple note above GET /:id/at-context.
app.get(
  '/:id/lock-status',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params, request, user }) => {
      const subject = await requireItemAccess(user.id, params.id)
      await requirePermission(
        request,
        getResourceType(subject.itemType),
        'read',
      )
      const { id } = params

      // Get item with lock info
      const result = await db
        .select()
        .from(items)
        .where(eq(items.id, id))
        .limit(1)
      const item = result.at(0)

      if (!item) {
        throw new NotFoundError('Item', id)
      }

      // If not locked, return simple status
      if (!item.lockedBy) {
        const status = createUnlockedStatus('lock')
        return { lockStatus: status }
      }

      // Get user info for locked by user. Named for its role rather than
      // `user`, which is now the caller.
      const userResult = await db
        .select()
        .from(users)
        .where(eq(users.id, item.lockedBy))
        .limit(1)
      const lockOwner = userResult.at(0)

      // Create locked status with unified schema
      const status = createLockedStatus({
        lockedBy: {
          id: item.lockedBy,
          name: lockOwner?.name ?? 'Unknown User',
          email: lockOwner?.email ?? 'unknown',
        },
        lockedAt: item.lockedAt ?? new Date(),
        lockType: 'lock',
        lockedFor: item.lockedAt
          ? calculateLockDuration(item.lockedAt)
          : undefined,
        scope: 'item',
      })

      return { lockStatus: status }
    }),
  ),
)

// POST /api/items/:id/lock
app.post(
  '/:id/lock',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof lockBodySchema>>(
      // The tuple for this route — and for the three writes below it,
      // /:id/relationships, /:id/sync-properties and /:id/unlock — cannot be
      // declared statically: /items/:id/* serves all 13 item types, so a
      // fixed ['parts','update'] would charge the wrong resource for a
      // Document and let a parts-only key rewrite one. Dispatch on the row
      // `requireItemAccess` already returns, the way GET /api/v1/items/:id
      // and the thumbnail route do; `getResourceType` is fail-closed, so an
      // unknown type charges parts rather than skipping the check.
      //
      // Declaring nothing here was not "no policy": `apiHandler` guards the
      // whole RBAC block on `if (options.permission)`, so role permissions
      // were never consulted and a scoped API key had nothing to intersect
      // against. Membership was the only gate — and on a WorkOrder or a
      // PhysicalPart it was not even that, because `requireItemAccess` then
      // gated on `items.designId`, which neither type carries, leaving
      // sync-properties on one of those gated by authentication alone. The
      // tuple is now a second gate on those two types rather than the only
      // one: `requireItemAccess` dispatches both to their own program
      // derivation.
      //
      // Consequence, matching the two routes named above: the check sits
      // behind the existence lookup, so a nonexistent id answers 404 before
      // 403. That leak is bounded by the membership gate applied first.
      { body: lockBodySchema },
      async ({ request, params, user, body }) => {
        const subject = await requireItemAccess(user.id, params.id)
        await requirePermission(
          request,
          getResourceType(subject.itemType),
          'update',
        )
        const { id } = params
        const userId = user.id

        const force = body?.force === true

        // Get current item
        const result = await db
          .select()
          .from(items)
          .where(eq(items.id, id))
          .limit(1)
        const item = result.at(0)

        if (!item) {
          throw new NotFoundError('Item', id)
        }

        // Check if already locked
        if (item.lockedBy) {
          // If locked by same user, return success
          if (item.lockedBy === userId) {
            return {
              success: true,
              message: 'Item already locked by you',
              lockedBy: userId,
              lockedAt: item.lockedAt,
            }
          }

          // If locked by another user and not forcing, return conflict
          if (!force) {
            const { ConflictError } = await import('@/lib/errors')
            throw new ConflictError('Item is already locked by another user')
          }

          // Stealing another user's lock is an admin override
          await requirePermission(request, 'system', 'manage')
        }

        // Lock the item
        const updateResult = await db
          .update(items)
          .set({
            lockedBy: userId,
            lockedAt: new Date(),
            modifiedBy: userId,
            modifiedAt: new Date(),
          })
          .where(eq(items.id, id))
          .returning()
        const updated = updateResult.at(0)

        return {
          success: true,
          message: 'Item locked successfully',
          lockedBy: updated?.lockedBy,
          lockedAt: updated?.lockedAt,
        }
      },
    ),
  ),
)

// GET /api/items/:id/relationships
//
// See the tuple note above GET /:id/at-context. The tuple charges the PATH
// item's resource; the neighbours this returns are not gated individually,
// which is a separate and still-open question.
app.get(
  '/:id/relationships',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params, request, user }) => {
      const subject = await requireItemAccess(user.id, params.id)
      await requirePermission(
        request,
        getResourceType(subject.itemType),
        'read',
      )
      const url = new URL(request.url)
      const relationshipType = url.searchParams.get('type') || undefined
      const branchId = url.searchParams.get('branch') || undefined

      const relationships = branchId
        ? await ItemRelationshipService.getRelationshipsWithDetailsForBranch(
            params.id,
            branchId,
            relationshipType,
          )
        : await ItemService.getRelationshipsWithDetails(
            params.id,
            relationshipType,
          )

      return { relationships }
    }),
  ),
)

/**
 * One edge, added to the item named in the path. The batch equivalent is
 * `POST /api/v1/relationships/batch-create`.
 */
const addRelationshipSchema = z.object({
  targetId: z.string().uuid(),
  relationshipType: z
    .string()
    .describe('e.g. `BOM`, `Document`, `Satisfies`, `Consumes`'),
  quantity: z
    .union([z.number(), z.string()])
    .optional()
    .describe(
      'Stored as text, so a string arrives verbatim — BOM quantities are ' +
        'not all integers.',
    ),
  referenceDesignator: z.string().optional(),
  findNumber: z.number().optional(),
})

// POST /api/items/:id/relationships
app.post(
  '/:id/relationships',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof addRelationshipSchema>>(
      {
        body: addRelationshipSchema,
        openapi: {
          summary: 'Add a relationship from this item',
          description:
            'The path item is the edge source. `(sourceId, targetId, ' +
            'relationshipType)` is unique, so re-adding an existing edge ' +
            'fails rather than duplicating it.',
          request: { params: z.object({ id: z.string().uuid() }) },
          responses: {
            201: { schema: z.object({ success: z.boolean() }) },
          },
        },
      },
      async ({ body: data, params, request, user }) => {
        // Charged on the SOURCE only — an edge is the source item's own
        // structure (ItemRelationshipService.addRelationship says so, and
        // POST /api/v1/relationships/batch-create charges the same way).
        // See the tuple note above POST /:id/lock.
        const item = await requireItemAccess(user.id, params.id)
        await requirePermission(
          request,
          getResourceType(item.itemType),
          'update',
        )

        // The target is named in the body, so the `access:` gate cannot reach
        // it and the source check above says nothing about it. Charged for
        // reach only: the edge remains the source item's own structure, so the
        // permission tuple stays the source's, per the note above.
        await requireItemsAccess(user.id, [data.targetId])

        await ItemService.addRelationship(
          params.id,
          data.targetId,
          data.relationshipType,
          user.id,
          {
            // The schema accepts a number or a string, on purpose — BOM
            // quantities are not all integers and the column is text. The
            // service takes text, so the number case is stringified here
            // rather than reaching the insert as a number. Previously the
            // body was `any`, so nothing said the two disagreed.
            quantity:
              data.quantity === undefined ? undefined : String(data.quantity),
            referenceDesignator: data.referenceDesignator,
            findNumber: data.findNumber,
          },
        )

        return created({ success: true })
      },
    ),
  ),
)

// GET /api/items/:id/satisfied-requirements
//
// See the tuple note above GET /:id/at-context.
app.get(
  '/:id/satisfied-requirements',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params, request, user }) => {
      const subject = await requireItemAccess(user.id, params.id)
      await requirePermission(
        request,
        getResourceType(subject.itemType),
        'read',
      )
      const { id } = params
      const satisfiedRequirements =
        await RequirementService.getRequirementsSatisfiedBy(id)

      return { requirements: satisfiedRequirements }
    }),
  ),
)

// POST /api/items/:id/sync-properties
app.post(
  '/:id/sync-properties',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof syncPropertiesSchema>>(
      // See the tuple note above POST /:id/lock.
      { body: syncPropertiesSchema },
      async ({ params, request, user, body }) => {
        // requireItemAccess returns the row and throws the identical
        // NotFoundError('Item', id), so the re-select this used to do below
        // was one query answering a question already answered.
        const item = await requireItemAccess(user.id, params.id)
        await requirePermission(
          request,
          getResourceType(item.itemType),
          'update',
        )
        const { id } = params
        const userId = user.id

        const { properties } = body

        const updatedFields: Array<string> = []

        // Update base item properties
        const baseUpdates: any = {
          modifiedBy: userId,
          modifiedAt: new Date(),
        }

        if (properties.name !== undefined) {
          baseUpdates.name = properties.name
          updatedFields.push('name')
        }

        if (properties.state !== undefined) {
          baseUpdates.state = properties.state
          updatedFields.push('state')
        }

        // Update base item if there are changes
        if (Object.keys(baseUpdates).length > 2) {
          // More than just modifiedBy/modifiedAt
          await db.update(items).set(baseUpdates).where(eq(items.id, id))
        }

        // Update type-specific properties based on item type
        if (item.itemType === 'Part') {
          const partUpdates: any = {}

          if (properties.material !== undefined) {
            partUpdates.material = properties.material
            updatedFields.push('material')
          }

          if (properties.weight !== undefined && properties.weight !== null) {
            partUpdates.weight = properties.weight.toString()
            updatedFields.push('weight')
          }

          if (properties.weightUnit !== undefined) {
            partUpdates.weightUnit = properties.weightUnit
            updatedFields.push('weightUnit')
          }

          if (properties.description !== undefined) {
            partUpdates.description = properties.description
            updatedFields.push('description')
          }

          if (properties.partType !== undefined) {
            partUpdates.partType = properties.partType
            updatedFields.push('partType')
          }

          if (properties.cost !== undefined && properties.cost !== null) {
            partUpdates.cost = properties.cost.toString()
            updatedFields.push('cost')
          }

          if (properties.costCurrency !== undefined) {
            partUpdates.costCurrency = properties.costCurrency
            updatedFields.push('costCurrency')
          }

          if (properties.leadTimeDays !== undefined) {
            partUpdates.leadTimeDays = properties.leadTimeDays
            updatedFields.push('leadTimeDays')
          }

          // Update parts table if there are changes
          if (Object.keys(partUpdates).length > 0) {
            await db.update(parts).set(partUpdates).where(eq(parts.itemId, id))
          }
        }

        // TODO: Handle other item types (Documents, etc.)

        return {
          success: true,
          message: 'Properties synced successfully',
          updatedFields,
        }
      },
    ),
  ),
)

// GET /api/items/:id/thumbnail
app.get(
  '/:id/thumbnail',
  adapt(
    apiHandler<{ id: string }>(
      // The tuple cannot be declared statically: this route serves the
      // thumbnail of *any* item, and FileService is item-type agnostic, so a
      // fixed ['parts','read'] both charged the wrong resource for a Document
      // and let a parts-only key read one. Dispatch on the row instead, the
      // way GET /api/v1/items/:id does. Consequence, matching that route: a
      // nonexistent id now answers 404 before 403, bounded by the
      // program-membership gate requireItemAccess applies first.
      {},
      async ({ request, params, user }) => {
        const item = await requireItemAccess(user.id, params.id)
        await requirePermission(request, getResourceType(item.itemType), 'read')
        const { id } = params

        // Resolve the thumbnail: user-designated image first, then generated
        const thumbnailFileId = await FileService.getItemThumbnailFileId(id)
        if (!thumbnailFileId) {
          return new Response(null, { status: 404 })
        }

        const thumbnailFile = await FileService.getFileMetadata(thumbnailFileId)
        if (!thumbnailFile) {
          return new Response(null, { status: 404 })
        }

        // Content-addressed validator: changing the designated image changes the
        // hash, so clients pick up a new thumbnail on their next revalidation.
        const etag = `"${thumbnailFile.fileHash}"`

        // Never echo back an arbitrary stored MIME type - thumbnails render
        // inline, so restrict to raster image types
        const mimeType =
          thumbnailFile.mimeType.startsWith('image/') &&
          !thumbnailFile.mimeType.includes('svg')
            ? thumbnailFile.mimeType
            : 'image/png'

        const headers = {
          'Content-Type': mimeType,
          ETag: etag,
          // Authenticated content: never store in a shared cache, and always
          // revalidate so a newly set thumbnail is not served stale
          'Cache-Control': 'private, no-cache',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; sandbox",
        }

        if (request.headers.get('if-none-match') === etag) {
          return new Response(null, { status: 304, headers })
        }

        const data = await FileService.downloadFile(thumbnailFileId, user.id)

        return new Response(new Uint8Array(data), {
          headers: {
            ...headers,
            'Content-Length': data.length.toString(),
          },
        })
      },
    ),
  ),
)

// POST /api/items/:id/unlock
app.post(
  '/:id/unlock',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof lockBodySchema>>(
      // See the tuple note above POST /:id/lock.
      { body: lockBodySchema },
      async ({ params, request, user, body }) => {
        const subject = await requireItemAccess(user.id, params.id)
        await requirePermission(
          request,
          getResourceType(subject.itemType),
          'update',
        )
        const { id } = params
        const userId = user.id

        const force = body?.force === true

        // Get current item
        const result = await db
          .select()
          .from(items)
          .where(eq(items.id, id))
          .limit(1)
        const item = result.at(0)

        if (!item) {
          throw new NotFoundError('Item', id)
        }

        // Check if item is locked
        if (!item.lockedBy) {
          return {
            success: true,
            message: 'Item is not locked',
          }
        }

        // Check if locked by current user or force unlock
        if (item.lockedBy !== userId) {
          if (!force) {
            throw new PermissionDeniedError('item', 'unlock')
          }

          // Breaking another user's lock is the same admin override that
          // stealing one requires on POST /:id/lock. Charging nothing here
          // left that gate decorative: a forced unlock followed by a plain,
          // unforced lock reaches the lock route's admin-only end state —
          // previous holder evicted, item held by the caller — for any role
          // holding the type's `update`.
          //
          // Deliberately below the "not locked" early return above, so a
          // caller that merely loses a race to another unlock keeps its 200
          // instead of being turned into a 403.
          await requirePermission(request, 'system', 'manage')
        }

        // Unlock the item
        await db
          .update(items)
          .set({
            lockedBy: null,
            lockedAt: null,
            modifiedBy: userId,
            modifiedAt: new Date(),
          })
          .where(eq(items.id, id))

        return {
          success: true,
          message: 'Item unlocked successfully',
        }
      },
    ),
  ),
)

// GET /api/items/:id/where-used
//
// See the tuple note above GET /:id/at-context. As with /:id/relationships,
// the tuple charges the path item's resource and says nothing about the
// parents the traversal returns.
app.get(
  '/:id/where-used',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params, request, user }) => {
      const subject = await requireItemAccess(user.id, params.id)
      await requirePermission(
        request,
        getResourceType(subject.itemType),
        'read',
      )
      const url = new URL(request.url, 'http://localhost')
      const maxDepthParam = url.searchParams.get('maxDepth')
      const maxDepth = maxDepthParam
        ? Math.min(Math.max(parseInt(maxDepthParam, 10) || 10, 1), 50)
        : 10

      const whereUsed = await ImpactAssessmentService.findWhereUsed(params.id, {
        maxDepth,
      })

      return {
        itemId: params.id,
        whereUsed,
        totalUsages: whereUsed.length,
      }
    }),
  ),
)

export default app
