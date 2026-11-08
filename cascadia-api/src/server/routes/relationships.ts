// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import {
  makeCodeSchema,
  optionConditionSchema,
} from '@cascadia/commons/types/variants'
import { hasPermission } from '@cascadia/commons/auth/permissions'
import { relationshipMetadataSchema } from '@cascadia/commons/items/relationships/metadata'
import { tagged } from '../adapter'
import type { OptionCondition } from '@cascadia/commons/types/variants'
import { db } from '@/db'
import { itemRelationships, items } from '@/db/schema'
import { NotFoundError, PermissionDeniedError, ValidationError } from '@/errors'
import { requireDesignAccess, requireItemsAccess } from '@/auth/access'
import { intersectPermissions } from '@/auth/api-key-utils'
import { permissionService } from '@/auth/permission-service'
import { requireAuth, requirePermission } from '@/auth/server'
import { ItemService } from '@/items/services/ItemService'
import { ItemRelationshipService } from '@/items/services/ItemRelationshipService'
import { getResourceType } from '@/items/item-type-resources'
import { apiHandler, jsonResponse } from '@/api/handler'
// Register item types (server-side version)
import '@/items/registerItemTypes.server'

const adapt = tagged('Relationships')

/**
 * One line of a batch. Written as a schema rather than an interface so the
 * OpenAPI document can carry it; `RelationshipData` is inferred from it, so
 * the two cannot drift.
 *
 * Documentation only — the handler below still validates line by line and
 * collects the rejections into `errors[]`, which is the point of a batch
 * endpoint. Parsing the whole body against this would turn one malformed line
 * into a rejection of all 500.
 */
const relationshipDataSchema = z.object({
  sourceId: z.string().uuid(),
  targetId: z.string().uuid(),
  relationshipType: z
    .string()
    .describe('e.g. `BOM`, `Document`, `Satisfies`, `Consumes`'),
  /**
   * Stored as text, so a string arrives verbatim. BOM quantities are not all
   * integers — "2.5", or a unit-carrying "0.5 m" — and the column has always
   * held whatever was typed.
   */
  quantity: z.union([z.number(), z.string()]).optional(),
  referenceDesignator: z.string().optional(),
  findNumber: z.number().optional(),
  metadata: relationshipMetadataSchema.optional(),
  option: optionConditionSchema.nullish(),
  targetMakeCode: makeCodeSchema
    .nullish()
    .describe('Active execution of the target Part revision, e.g. `MK2`.'),
})

type RelationshipData = z.infer<typeof relationshipDataSchema>

/**
 * The envelope the handler enforces: at least one line, at most 500, and a
 * boolean flag. Each *line* stays loose here on purpose — see
 * `relationshipDataSchema` above; per-line rejection into `errors[]` is what a
 * batch endpoint is for.
 */
const batchCreateBodySchema = z.object({
  relationships: z.array(z.record(z.string(), z.unknown())).min(1).max(500),
  replaceExisting: z.boolean().optional(),
})

const batchCreateRequestSchema = z.object({
  relationships: z.array(relationshipDataSchema).min(1).max(500),
  replaceExisting: z
    .boolean()
    .optional()
    .describe(
      'Clear the existing edges of every source that has a line in this ' +
        'batch before inserting. Without it, an edge already stored is ' +
        'counted in `skipped` and left alone.',
    ),
})

const batchCreateResponseSchema = z.object({
  created: z.number().int(),
  skipped: z.number().int(),
  /**
   * Per-line rejections. Deliberately carries no `details`: the field existed
   * to pass the driver's exception text through, which meant a 400 body with
   * the full INSERT statement and its bound parameters in it.
   */
  errors: z.array(
    z.object({
      relationship: z.record(z.string(), z.unknown()),
      error: z.string(),
    }),
  ),
})

type BatchCreateResponse = z.infer<typeof batchCreateResponseSchema>

const app = new Hono()

/**
 * Both ends of one stored edge, by the edge's own id.
 *
 * An edge is addressed here by an id that names neither of the items it joins,
 * so the route has nothing to charge until it reads the row. Without this, the
 * blanket `parts` tuple was the whole gate: any caller holding it could edit or
 * delete any edge in the instance by id, across every program, and the service
 * layer checks existence rather than access. Both ends are charged, because an
 * edge is equally a fact about each.
 */
async function requireEdgeAccess(
  userId: string,
  relationshipId: string,
): Promise<{ sourceId: string; targetId: string }> {
  const [edge] = await db
    .select({
      sourceId: itemRelationships.sourceId,
      targetId: itemRelationships.targetId,
    })
    .from(itemRelationships)
    .where(eq(itemRelationships.id, relationshipId))
    .limit(1)

  if (!edge) throw new NotFoundError('ItemRelationship', relationshipId)

  await requireItemsAccess(userId, [edge.sourceId, edge.targetId])
  return edge
}

// GET /api/relationships
app.get(
  '/',
  adapt(
    apiHandler({ permission: ['parts', 'read'] }, async ({ request, user }) => {
      const url = new URL(request.url)
      const designId = url.searchParams.get('designId')
      const type = url.searchParams.get('type')

      if (!designId) {
        throw new ValidationError('designId is required')
      }

      // `parts:read` says the caller may read parts; the design in the query
      // string says whose. Every by-id item read checks this; a BOM edge names
      // two items, so listing a design's edges discloses its structure just as
      // plainly. Handles the cross-program-authority bypass internally.
      await requireDesignAccess(user.id, designId)

      // Get all items in the design
      const designItems = await db
        .select({ id: items.id })
        .from(items)
        .where(eq(items.designId, designId))

      const itemIds = designItems.map((i) => i.id)

      if (itemIds.length === 0) {
        return { relationships: [] }
      }

      // Get relationships where source or target is in the design
      const query = db
        .select({
          id: itemRelationships.id,
          sourceId: itemRelationships.sourceId,
          targetId: itemRelationships.targetId,
          relationshipType: itemRelationships.relationshipType,
        })
        .from(itemRelationships)

      if (type) {
        const relationships = await query.where(
          and(
            inArray(itemRelationships.sourceId, itemIds),
            eq(itemRelationships.relationshipType, type),
          ),
        )
        return { relationships }
      }

      const relationships = await query.where(
        inArray(itemRelationships.sourceId, itemIds),
      )

      return { relationships }
    }),
  ),
)

// POST /api/relationships/batch-create
app.post(
  '/batch-create',
  adapt(
    apiHandler(
      {
        permission: ['parts', 'update'],
        body: batchCreateBodySchema,
        openapi: {
          summary: 'Create relationships in bulk',
          description:
            'Up to 500 edges in one request — this is how a BOM is loaded. ' +
            'A line naming the same source, target, relationship type, option ' +
            'condition and target execution twice rejects the whole request ' +
            'with 400: the caller has to merge those lines and sum their ' +
            'quantities. Otherwise nothing is written until the batch is ' +
            'known to be insertable, and the status reports the outcome: 201 ' +
            'when every line was created, 207 when some lines were created ' +
            'and others rejected, 400 when none were.',
          // documented-not-enforced: per-line rejection is this endpoint's
          // contract. Parsing the whole body against the schema would turn
          // one malformed line into a rejection of all 500, which is what
          // `errors[]` exists to avoid. `documentsSupersetOfEnforced` is what
          // keeps the per-line shape in the document: `batchCreateBodySchema`
          // above is the deliberately looser envelope this route enforces, and
          // every body this schema describes passes it, so the document is the
          // stricter of the two.
          request: {
            body: {
              schema: batchCreateRequestSchema,
              documentsSupersetOfEnforced: true,
            },
          },
          responses: {
            201: { schema: batchCreateResponseSchema },
            207: {
              schema: batchCreateResponseSchema,
              description: 'Some lines created, others rejected',
            },
          },
        },
      },
      async ({ body, user }) => {
        const userId = user.id
        // The three shape checks that used to live here — array, non-empty,
        // at most 500 — are the envelope schema now. Lines stay untyped
        // until the per-line pass below rejects them individually.

        // Everything below is validation of the request as given — no write
        // happens until the batch is known to be insertable. The route used to
        // delete the parents' existing edges first and discover the problem
        // during the insert, which left a rejected batch with its BOM deleted
        // and nothing to put back.
        const errors: BatchCreateResponse['errors'] = []
        // Kept alongside each candidate so a message can name the line the
        // caller sent, not the position that survived filtering.
        const candidates: Array<{ index: number; relData: RelationshipData }> =
          []

        body.relationships.forEach((rawRelationship, index) => {
          const parsed = relationshipDataSchema.safeParse(rawRelationship)
          if (!parsed.success) {
            errors.push({
              relationship: rawRelationship,
              error: parsed.error.issues
                .map((issue) => issue.message)
                .join('; '),
            })
            return
          }
          const relData = parsed.data
          candidates.push({ index, relData })
        })

        // A BOM that repeats the same complete edge identity is one line twice.
        // Conditions and target executions are part of that identity, so the
        // same child may still appear in several valid configurations.
        const duplicates = ItemRelationshipService.findDuplicateEdges(
          candidates.map((c) => c.relData),
        )
        if (duplicates.length > 0) {
          throw new ValidationError(
            'A relationship may appear only once per source, target, type, ' +
              'option condition and target execution; combine the duplicate ' +
              'lines and sum their quantities',
            duplicates.map(({ index, firstIndex, edge }) => ({
              field: `relationships[${candidates[index]!.index}]`,
              message:
                `Duplicates relationships[${candidates[firstIndex]!.index}]: ` +
                `${edge.sourceId} → ${edge.targetId} (${edge.relationshipType})`,
              code: 'DUPLICATE_RELATIONSHIP',
            })),
          )
        }

        // Every item the batch names, both ends of every line. Charged before
        // anything is written and after the duplicate check, so a batch that
        // reaches outside the caller's programs is refused whole rather than
        // part-applied. The ids come from the body, so `access:` cannot cover
        // them.
        await requireItemsAccess(
          userId,
          candidates.flatMap(({ relData }) => [
            relData.sourceId,
            relData.targetId,
          ]),
        )

        // Edges already stored are skipped rather than replaced. One query for
        // the whole batch — this was a SELECT per line, 500 round trips for a
        // 500-line BOM.
        let storedEdgeKeys = new Set<string>()
        if (!body.replaceExisting && candidates.length > 0) {
          const sourceIds = [
            ...new Set(candidates.map((c) => c.relData.sourceId)),
          ]
          const stored = await db
            .select({
              sourceId: itemRelationships.sourceId,
              targetId: itemRelationships.targetId,
              relationshipType: itemRelationships.relationshipType,
              option: itemRelationships.option,
              targetMakeCode: itemRelationships.targetMakeCode,
            })
            .from(itemRelationships)
            .where(inArray(itemRelationships.sourceId, sourceIds))

          storedEdgeKeys = new Set(
            stored.map((edge) => ItemRelationshipService.edgeKey(edge)),
          )
        }

        let skipped = 0
        const validRelationships: Array<{
          sourceId: string
          targetId: string
          relationshipType: string
          userId: string
          data?: {
            quantity?: string
            referenceDesignator?: string
            findNumber?: number
            metadata?: Record<string, unknown>
            option?: OptionCondition | null
            targetMakeCode?: string | null
          }
        }> = []

        for (const { relData } of candidates) {
          const {
            sourceId,
            targetId,
            relationshipType,
            quantity,
            referenceDesignator,
            findNumber,
            metadata,
            option,
            targetMakeCode,
          } = relData

          if (
            storedEdgeKeys.has(
              ItemRelationshipService.edgeKey({
                sourceId,
                targetId,
                relationshipType,
                option,
                targetMakeCode,
              }),
            )
          ) {
            skipped++
            continue
          }

          validRelationships.push({
            sourceId,
            targetId,
            relationshipType,
            userId,
            data: {
              quantity: quantity ? quantity.toString() : undefined,
              referenceDesignator: referenceDesignator || undefined,
              findNumber: findNumber || undefined,
              metadata: metadata || undefined,
              option: option ?? null,
              targetMakeCode: targetMakeCode ?? null,
            },
          })
        }

        // Replacement runs inside the service's transaction with the insert.
        // Only the sources that actually have lines to write get cleared, so a
        // request whose every line for one parent was malformed no longer wipes
        // that parent's structure as a side effect.
        const inserted =
          validRelationships.length > 0
            ? await ItemRelationshipService.addRelationshipBatch(
                validRelationships,
                { replaceExisting: body.replaceExisting },
              )
            : []
        const created = inserted.length

        const response: BatchCreateResponse = {
          created,
          skipped,
          errors,
        }

        // Return appropriate status code
        let status = 201
        if (errors.length > 0 && created > 0) {
          status = 207 // Multi-Status
        } else if (errors.length > 0 && created === 0) {
          status = 400
        }

        return jsonResponse(response, status)
      },
    ),
  ),
)

// PUT /api/relationships/:relationshipId
/**
 * The fields an edge's own row carries. All optional — an absent key leaves
 * the column alone, `null` clears it.
 *
 * `quantity` is stored as text and a number is accepted for it (a client
 * sending `2` rather than `"2"` has always worked), so it is coerced here
 * rather than at the driver.
 *
 * `metadata` is replaced whole, not merged key by key: send the full set the
 * edge should carry. The server's own keys are outside it either way.
 */
const relationshipEditSchema = z.object({
  quantity: z
    .union([z.number(), z.string().max(100)])
    .transform((v) => String(v))
    .nullish(),
  referenceDesignator: z.string().max(200).nullish(),
  findNumber: z.number().int().min(0).max(1_000_000).nullish(),
  metadata: relationshipMetadataSchema
    .nullish()
    .describe(
      "Replaces the edge's caller-owned metadata keys as a whole; null " +
        'clears them. Server-maintained keys (`affirmed`) are kept either way.',
    ),
  option: optionConditionSchema
    .nullish()
    .describe('Product variants: null makes the line fixed again.'),
  targetMakeCode: makeCodeSchema
    .nullish()
    .describe('Active execution of the target Part revision; null clears it.'),
})

app.put(
  '/:relationshipId',
  adapt(
    apiHandler<
      { relationshipId: string },
      z.infer<typeof relationshipEditSchema>
    >(
      { permission: ['parts', 'update'], body: relationshipEditSchema },
      async ({ params, body, user }) => {
        await requireEdgeAccess(user.id, params.relationshipId)

        const updated = await ItemService.updateRelationship(
          params.relationshipId,
          user.id,
          body,
        )
        return { relationship: updated }
      },
    ),
  ),
)

// DELETE /api/relationships/:relationshipId
app.delete(
  '/:relationshipId',
  adapt(
    apiHandler<{ relationshipId: string }>(
      { permission: ['parts', 'delete'] },
      async ({ params, user }) => {
        await requireEdgeAccess(user.id, params.relationshipId)

        await ItemService.removeRelationship(params.relationshipId, user.id)
        return { success: true, message: 'Relationship deleted successfully' }
      },
    ),
  ),
)

const suspectReasonSchema = z.enum(['source_revised', 'target_revised'])

const bulkAffirmBodySchema = z.object({
  relationshipIds: z.array(z.string().uuid()).min(1).max(500),
})

/**
 * What became of one id in a bulk affirm. Per row rather than all-or-nothing:
 * an "affirm all suspect" over a panel's links must not be refused outright
 * because one of them is in a program the caller cannot reach, and a
 * reviewer wants to know which ones were.
 */
const affirmOutcomeSchema = z.enum([
  'affirmed',
  'not_found',
  'forbidden',
  'not_suspectable',
])

const bulkAffirmResponseSchema = z.object({
  affirmed: z.number().int(),
  results: z.array(
    z.object({
      relationshipId: z.string().uuid(),
      outcome: affirmOutcomeSchema,
      /** Present when `outcome` is `affirmed`. */
      suspect: z.boolean().optional(),
      reasons: z.array(suspectReasonSchema).optional(),
    }),
  ),
})

type BulkAffirmResponse = z.infer<typeof bulkAffirmResponseSchema>

// POST /api/relationships/affirm
app.post(
  '/affirm',
  adapt(
    apiHandler<Record<string, never>, z.infer<typeof bulkAffirmBodySchema>>(
      {
        body: bulkAffirmBodySchema,
        openapi: {
          summary: 'Affirm several trace links',
          description:
            'The bulk form of `POST /relationships/{relationshipId}/affirm`: ' +
            'records that each named claim still holds for the versions its ' +
            'ends currently name. Each id is charged on its own — `update` on ' +
            'the source item’s type, plus access to both ends — and reported ' +
            'on its own, so one link the caller may not affirm does not refuse ' +
            'the rest. At most 500 ids per call.',
          request: { body: { schema: bulkAffirmBodySchema } },
          responses: { 200: { schema: bulkAffirmResponseSchema } },
        },
      },
      async ({ body, request, user }) => {
        const ids = [...new Set(body.relationshipIds)]
        const edges = await db
          .select({
            id: itemRelationships.id,
            sourceId: itemRelationships.sourceId,
            targetId: itemRelationships.targetId,
          })
          .from(itemRelationships)
          .where(inArray(itemRelationships.id, ids))
        const edgeById = new Map(edges.map((edge) => [edge.id, edge]))

        // One type-level check per source type present: the tuple the
        // single-link route charges, asked rather than required, since a
        // refusal here is a row's outcome and not the request's. The same
        // arithmetic as `requirePermission` — a scoped API key narrows the
        // role's grants and never widens them.
        const sourceTypes = new Map(
          (
            await db
              .select({ id: items.id, itemType: items.itemType })
              .from(items)
              .where(
                inArray(items.id, [
                  ...new Set(edges.map((edge) => edge.sourceId)),
                ]),
              )
          ).map((row) => [row.id, row.itemType]),
        )
        const auth = await requireAuth(request)
        const effectivePermissions = auth.scope
          ? intersectPermissions(
              await permissionService.getUserPermissions(user.id),
              auth.scope,
            )
          : null
        const permittedType = new Map<string, boolean>()
        for (const itemType of new Set(sourceTypes.values())) {
          const resource = getResourceType(itemType)
          permittedType.set(
            itemType,
            effectivePermissions
              ? hasPermission(effectivePermissions, resource, 'update')
              : await permissionService.canUser(user.id, 'update', resource),
          )
        }

        // Instance-level access to both ends. One read covers the common
        // case; only when it refuses does each edge get asked on its own.
        const ends = [
          ...new Set(edges.flatMap((edge) => [edge.sourceId, edge.targetId])),
        ]
        let reachable: (edge: { sourceId: string; targetId: string }) => boolean
        try {
          await requireItemsAccess(user.id, ends)
          reachable = () => true
        } catch (error) {
          if (
            !(error instanceof PermissionDeniedError) &&
            !(error instanceof NotFoundError)
          ) {
            throw error
          }
          const refused = new Set<string>()
          for (const id of ends) {
            try {
              await requireItemsAccess(user.id, [id])
            } catch (perItem) {
              if (
                !(perItem instanceof PermissionDeniedError) &&
                !(perItem instanceof NotFoundError)
              ) {
                throw perItem
              }
              refused.add(id)
            }
          }
          reachable = (edge) =>
            !refused.has(edge.sourceId) && !refused.has(edge.targetId)
        }

        const results: BulkAffirmResponse['results'] = []
        for (const relationshipId of ids) {
          const edge = edgeById.get(relationshipId)
          if (!edge) {
            results.push({ relationshipId, outcome: 'not_found' })
            continue
          }
          const sourceType = sourceTypes.get(edge.sourceId)
          if (
            !sourceType ||
            !permittedType.get(sourceType) ||
            !reachable(edge)
          ) {
            results.push({ relationshipId, outcome: 'forbidden' })
            continue
          }
          try {
            const { state } = await ItemRelationshipService.affirmRelationship(
              relationshipId,
              user.id,
            )
            results.push({
              relationshipId,
              outcome: 'affirmed',
              suspect: state.suspect,
              reasons: state.reasons,
            })
          } catch (error) {
            if (error instanceof ValidationError) {
              results.push({ relationshipId, outcome: 'not_suspectable' })
            } else if (error instanceof NotFoundError) {
              results.push({ relationshipId, outcome: 'not_found' })
            } else {
              throw error
            }
          }
        }

        return {
          affirmed: results.filter((r) => r.outcome === 'affirmed').length,
          results,
        }
      },
    ),
  ),
)

// POST /api/relationships/:relationshipId/affirm
app.post(
  '/:relationshipId/affirm',
  adapt(
    apiHandler<{ relationshipId: string }>(
      {
        openapi: {
          summary: 'Affirm a trace link',
          description:
            'Records that a traceability claim (`SATISFIES`, `ALLOCATED_TO`, ' +
            '`VERIFIED_BY`, `VALIDATES`) still holds for the versions its ends ' +
            'currently name, which clears its suspect flag. Affirming is a ' +
            'review record, not an edit of the link, so it needs no checkout; ' +
            'it charges `update` on the source item’s own type.',
          request: {
            params: z.object({ relationshipId: z.string().uuid() }),
          },
          responses: {
            200: {
              schema: z.object({
                relationshipId: z.string().uuid(),
                suspect: z.boolean(),
                reasons: z.array(suspectReasonSchema),
              }),
            },
          },
        },
      },
      async ({ params, request, user }) => {
        const edge = await requireEdgeAccess(user.id, params.relationshipId)
        // Charged on the source's own type, like every other write to an
        // item's structure (see POST /items/:id/relationships).
        const source = await ItemService.findById(edge.sourceId)
        if (!source) {
          throw new NotFoundError('Item', edge.sourceId)
        }
        await requirePermission(
          request,
          getResourceType(source.itemType),
          'update',
        )

        const { relationship, state } =
          await ItemRelationshipService.affirmRelationship(
            params.relationshipId,
            user.id,
          )
        return {
          relationshipId: relationship.id,
          suspect: state.suspect,
          reasons: state.reasons,
        }
      },
    ),
  ),
)

export default app
