// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { tagged } from '../adapter'
import { db } from '@/lib/db'
import { itemRelationships, items } from '@/lib/db/schema'
import { NotFoundError, ValidationError } from '@/lib/errors'
import { ItemService } from '@/lib/items/services/ItemService'
import { ItemRelationshipService } from '@/lib/items/services/ItemRelationshipService'
import { apiHandler, jsonResponse } from '@/lib/api/handler'
import {
  requireDesignAccess,
  requireItemIdsDesignAccess,
} from '@/lib/auth/access'
import { requirePermission } from '@/lib/auth/server'
import { getResourceType } from '@/lib/items/item-type-resources'
// Register item types (server-side version)
import '@/lib/items/registerItemTypes.server'

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
  metadata: z.record(z.string(), z.any()).optional(),
})

type RelationshipData = z.infer<typeof relationshipDataSchema>

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
    z.object({ relationship: relationshipDataSchema, error: z.string() }),
  ),
})

type BatchCreateResponse = z.infer<typeof batchCreateResponseSchema>

const app = new Hono()

async function requireRelationshipAccess(
  userId: string,
  relationshipId: string,
) {
  z.string().uuid().parse(relationshipId)
  const [relationship] = await db
    .select({
      id: itemRelationships.id,
      sourceId: itemRelationships.sourceId,
      targetId: itemRelationships.targetId,
    })
    .from(itemRelationships)
    .where(eq(itemRelationships.id, relationshipId))
    .limit(1)

  if (!relationship) {
    throw new NotFoundError('ItemRelationship', relationshipId)
  }

  const itemsById = await requireItemIdsDesignAccess(userId, [
    relationship.sourceId,
    relationship.targetId,
  ])
  return {
    relationship,
    source: itemsById.get(relationship.sourceId)!,
    target: itemsById.get(relationship.targetId)!,
  }
}

// GET /api/relationships
app.get(
  '/',
  adapt(
    apiHandler({}, async ({ request, user }) => {
      const url = new URL(request.url)
      const designId = url.searchParams.get('designId')
      const type = url.searchParams.get('type')

      if (!designId) {
        throw new ValidationError('designId is required')
      }
      z.string().uuid().parse(designId)
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

      const relationships = type
        ? await query.where(
            and(
              inArray(itemRelationships.sourceId, itemIds),
              eq(itemRelationships.relationshipType, type),
            ),
          )
        : await query.where(inArray(itemRelationships.sourceId, itemIds))

      const itemsById = await requireItemIdsDesignAccess(
        user.id,
        relationships.flatMap((relationship) => [
          relationship.sourceId,
          relationship.targetId,
        ]),
      )
      const requiredResources = new Set(
        [...itemsById.values()].map((item) => getResourceType(item.itemType)),
      )
      for (const resource of requiredResources) {
        await requirePermission(request, resource, 'read')
      }

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
        openapi: {
          summary: 'Create relationships in bulk',
          description:
            'Up to 500 edges in one request — this is how a BOM is loaded. ' +
            'A line naming the same `(sourceId, targetId, relationshipType)` ' +
            'twice rejects the whole request with 400: the caller has to ' +
            'merge those lines and sum their quantities. Otherwise nothing ' +
            'is written until the batch is known to be insertable, and the ' +
            'status reports the outcome: 201 when every line was created, ' +
            '207 when some lines were created and others rejected, 400 when ' +
            'none were.',
          request: { body: { schema: batchCreateRequestSchema } },
          responses: {
            201: { schema: batchCreateResponseSchema },
            207: {
              schema: batchCreateResponseSchema,
              description: 'Some lines created, others rejected',
            },
          },
        },
      },
      async ({ request, user }) => {
        const userId = user.id

        // Parse request body
        const body = (await request.json()) as {
          relationships: Array<RelationshipData>
          replaceExisting?: boolean
        }

        if (!Array.isArray(body.relationships)) {
          throw new ValidationError('Relationships array is required')
        }

        if (body.relationships.length === 0) {
          throw new ValidationError('Relationships array cannot be empty')
        }

        // Limit batch size
        if (body.relationships.length > 500) {
          throw new ValidationError('Batch size limited to 500 relationships')
        }

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

        body.relationships.forEach((relData, index) => {
          const { sourceId, targetId, relationshipType } = relData
          if (!sourceId || !targetId || !relationshipType) {
            errors.push({
              relationship: relData,
              error:
                'Missing required fields (sourceId, targetId, or relationshipType)',
            })
            return
          }
          if (
            !z.string().uuid().safeParse(sourceId).success ||
            !z.string().uuid().safeParse(targetId).success
          ) {
            errors.push({
              relationship: relData,
              error: 'sourceId and targetId must be valid UUIDs',
            })
            return
          }
          candidates.push({ index, relData })
        })

        // A BOM that lists the same child twice — "4 M4 screws here, 12 there"
        // — is two lines for one edge, and `unique(source_id, target_id,
        // relationship_type)` allows only one. Reject the whole request rather
        // than let the driver reject the second insert: the caller has to merge
        // those lines, and needs to be told which ones.
        const duplicates = ItemRelationshipService.findDuplicateEdges(
          candidates.map((c) => c.relData),
        )
        if (duplicates.length > 0) {
          throw new ValidationError(
            'A relationship may appear only once per (sourceId, targetId, ' +
              'relationshipType); combine the duplicate lines and sum their ' +
              'quantities',
            duplicates.map(({ index, firstIndex, edge }) => ({
              field: `relationships[${candidates[index]!.index}]`,
              message:
                `Duplicates relationships[${candidates[firstIndex]!.index}]: ` +
                `${edge.sourceId} → ${edge.targetId} (${edge.relationshipType})`,
              code: 'DUPLICATE_RELATIONSHIP',
            })),
          )
        }

        const itemsById = await requireItemIdsDesignAccess(
          user.id,
          candidates.flatMap(({ relData }) => [
            relData.sourceId,
            relData.targetId,
          ]),
        )
        const sourceResources = new Set(
          candidates.map(({ relData }) =>
            getResourceType(itemsById.get(relData.sourceId)!.itemType),
          ),
        )
        for (const resource of sourceResources) {
          await requirePermission(request, resource, 'update')
        }
        const targetResources = new Set(
          candidates.map(({ relData }) =>
            getResourceType(itemsById.get(relData.targetId)!.itemType),
          ),
        )
        for (const resource of targetResources) {
          await requirePermission(request, resource, 'read')
        }

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
          } = relData

          if (
            storedEdgeKeys.has(
              ItemRelationshipService.edgeKey({
                sourceId,
                targetId,
                relationshipType,
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
app.put(
  '/:relationshipId',
  adapt(
    apiHandler<{ relationshipId: string }>(
      {},
      async ({ params, request, user }) => {
        const { source, target } = await requireRelationshipAccess(
          user.id,
          params.relationshipId,
        )
        await requirePermission(
          request,
          getResourceType(source.itemType),
          'update',
        )
        await requirePermission(
          request,
          getResourceType(target.itemType),
          'read',
        )
        const data = await request.json()
        const updated = await ItemService.updateRelationship(
          params.relationshipId,
          user.id,
          {
            quantity: data.quantity,
            referenceDesignator: data.referenceDesignator,
            findNumber: data.findNumber,
          },
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
      {},
      async ({ params, request, user }) => {
        const { source, target } = await requireRelationshipAccess(
          user.id,
          params.relationshipId,
        )
        await requirePermission(
          request,
          getResourceType(source.itemType),
          'update',
        )
        await requirePermission(
          request,
          getResourceType(target.itemType),
          'read',
        )
        await ItemService.removeRelationship(params.relationshipId, user.id)
        return { success: true, message: 'Relationship deleted successfully' }
      },
    ),
  ),
)

export default app
