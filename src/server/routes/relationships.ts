import { Hono } from 'hono'
import { and, eq, inArray } from 'drizzle-orm'
import { adapt } from '../adapter'
import { db } from '@/lib/db'
import { itemRelationships, items } from '@/lib/db/schema'
import { ValidationError } from '@/lib/errors'
import { ItemService } from '@/lib/items/services/ItemService'
import { ItemRelationshipService } from '@/lib/items/services/ItemRelationshipService'
import { apiHandler, jsonResponse } from '@/lib/api/handler'
// Register item types (server-side version)
import '@/lib/items/registerItemTypes.server'

interface RelationshipData {
  sourceId: string
  targetId: string
  relationshipType: string
  quantity?: number
  referenceDesignator?: string
  findNumber?: number
  metadata?: Record<string, any>
}

interface BatchCreateResponse {
  created: number
  skipped: number
  errors: Array<{
    relationship: RelationshipData
    error: string
    details?: string
  }>
}

const app = new Hono()

// GET /api/relationships
app.get(
  '/',
  adapt(
    apiHandler({ permission: ['parts', 'read'] }, async ({ request }) => {
      const url = new URL(request.url)
      const designId = url.searchParams.get('designId')
      const type = url.searchParams.get('type')

      if (!designId) {
        throw new ValidationError('designId is required')
      }

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
      { permission: ['parts', 'update'] },
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

        // If replaceExisting, delete old relationships for the source items
        if (body.replaceExisting) {
          // Get unique source IDs
          const sourceIds = [
            ...new Set(body.relationships.map((r) => r.sourceId)),
          ]

          for (const sourceId of sourceIds) {
            // Delete existing relationships of the same type
            const relationshipTypes = [
              ...new Set(
                body.relationships
                  .filter((r) => r.sourceId === sourceId)
                  .map((r) => r.relationshipType),
              ),
            ]

            for (const relType of relationshipTypes) {
              await db
                .delete(itemRelationships)
                .where(
                  and(
                    eq(itemRelationships.sourceId, sourceId),
                    eq(itemRelationships.relationshipType, relType),
                  ),
                )
            }
          }
        }

        let created = 0
        let skipped = 0
        const errors: Array<{
          relationship: RelationshipData
          error: string
          details?: string
        }> = []
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

        // Validate each relationship
        for (const relData of body.relationships) {
          try {
            const {
              sourceId,
              targetId,
              relationshipType,
              quantity,
              referenceDesignator,
              findNumber,
              metadata,
            } = relData

            // Validate required fields
            if (!sourceId || !targetId || !relationshipType) {
              errors.push({
                relationship: relData,
                error:
                  'Missing required fields (sourceId, targetId, or relationshipType)',
              })
              continue
            }

            // Check if relationship already exists (if not replacing)
            if (!body.replaceExisting) {
              const existing = await db
                .select()
                .from(itemRelationships)
                .where(
                  and(
                    eq(itemRelationships.sourceId, sourceId),
                    eq(itemRelationships.targetId, targetId),
                    eq(itemRelationships.relationshipType, relationshipType),
                  ),
                )
                .limit(1)

              if (existing.length > 0) {
                skipped++
                continue
              }
            }

            // Collect valid relationships for batch insert
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

            created++
          } catch (error) {
            errors.push({
              relationship: relData,
              error: 'Failed to validate relationship',
              details: (error as Error).message,
            })
          }
        }

        // Batch insert with history tracking
        if (validRelationships.length > 0) {
          try {
            await ItemRelationshipService.addRelationshipBatch(
              validRelationships,
            )
          } catch (error) {
            // If batch insert fails, report all as errors
            created = 0
            for (const rel of validRelationships) {
              errors.push({
                relationship: {
                  sourceId: rel.sourceId,
                  targetId: rel.targetId,
                  relationshipType: rel.relationshipType,
                },
                error: 'Batch insert failed',
                details: (error as Error).message,
              })
            }
          }
        }

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
    apiHandler(
      { permission: ['parts', 'update'] },
      async ({ params, request, user }) => {
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
    apiHandler(
      { permission: ['parts', 'delete'] },
      async ({ params, user }) => {
        await ItemService.removeRelationship(params.relationshipId, user.id)
        return { success: true, message: 'Relationship deleted successfully' }
      },
    ),
  ),
)

export default app
