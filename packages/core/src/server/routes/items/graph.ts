// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { z } from 'zod'
import { tagged } from '../../adapter'
import { requirePermission } from '@/lib/auth/server'
import { NotFoundError } from '@/lib/errors'
import { getResourceType } from '@/lib/items/item-type-resources'
import { ItemService } from '@/lib/items/services/ItemService'
import { GraphService } from '@/lib/services/GraphService'
import { apiHandler, parseQuery } from '@/lib/api/handler'
import { requireItemAccess } from '@/lib/auth/access'
import { AccessControlService } from '@/lib/auth/AccessControlService'

const adapt = tagged('Items')

const app = new Hono()

/**
 * Query params for the item graph walk.
 *
 * `depth` was `parseInt(searchParams.get('depth') || '2', 10)`, so `?depth=abc`
 * produced NaN — and the walk's cutoff, `level > depth`, is always false
 * against NaN. One malformed character turned a bounded neighbourhood query
 * into a traversal of the entire connected component. `?depth=999` asked for
 * the same thing politely and was also accepted. Bounds are enforced here
 * instead, and out-of-range values are rejected rather than silently clamped
 * so a consumer asking for more than the cap finds out. Every depth selector
 * in the UI stops at 5; 10 is headroom.
 *
 * Non-strict, like itemSearchQuerySchema: unknown params are ignored rather
 * than rejected, because this is the frozen v1 contract.
 */
const itemGraphQuerySchema = z.object({
  depth: z.coerce.number().int().min(0).max(10).default(2),
  direction: z.enum(['all', 'outgoing', 'incoming']).default('all'),
  types: z
    .string()
    .optional()
    .transform((value) => value?.split(',').filter(Boolean) ?? []),
  // Default true — only the literal 'false' turns usage edges off.
  includeUsages: z
    .string()
    .optional()
    .transform((value) => value !== 'false'),
  // Attached vault files are opt-in so existing graph consumers keep
  // their item-only shape.
  includeFiles: z
    .string()
    .optional()
    .transform((value) => value === 'true'),
  // Branch context for file visibility only (mirrors the Files tab:
  // branch-agnostic files plus files uploaded on the viewed branch).
  branch: z.string().uuid().optional(),
})

// GET /api/items/:id/graph
app.get(
  '/:id/graph',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params, request, user }) => {
      const {
        depth,
        direction,
        types: relationshipTypes,
        includeUsages,
        includeFiles,
        branch: fileBranchId,
      } = parseQuery(request, itemGraphQuerySchema)

      // The same gate GET /:id applies, verbatim. This route had none at all,
      // which made it the widest read in the API: one id and a depth returned
      // the item, its BOM, its where-used and its files, unbounded.
      //
      // It then hand-rolled `if (designId) requireDesignAccess(...)`, which is
      // vacuous on the four types whose `items.design_id` is NULL — ChangeOrder,
      // Issue, WorkOrder, PhysicalPart. `requireItemAccess` dispatches all four
      // and ends in the identical design check for the rest, and
      // `getResourceType` is fail-closed where `itemTypeToResource` skipped the
      // tuple entirely on a type it did not know.
      const subject = await requireItemAccess(user.id, params.id)
      await requirePermission(
        request,
        getResourceType(subject.itemType),
        'read',
      )

      // Get the center item
      const centerItem = await ItemService.findById(params.id)
      if (!centerItem) {
        throw new NotFoundError('Item', params.id)
      }

      // Reaching the center does not mean reaching its neighbours: a BOM line
      // can point into another program's design. Resolve the caller's scope
      // once and let the walk prune with it. null is unrestricted; [] reaches
      // no design at all, and conflating the two would invert the whole check.
      const accessibleDesignIds =
        await AccessControlService.getAccessibleDesignIds(user.id)
      const designScope =
        accessibleDesignIds === null ? null : new Set(accessibleDesignIds)

      const graphData = await GraphService.buildItemGraph(params.id, {
        depth,
        direction,
        relationshipTypes,
        includeUsages,
        includeFiles,
        fileBranchId,
        designScope,
        centerDesignId: centerItem.designId ?? null,
      })

      // Return graphData directly as Response to preserve existing shape
      // (existing clients expect { nodes, edges } at the top level, not
      // { data: { nodes, edges } })
      return new Response(JSON.stringify(graphData), {
        headers: { 'Content-Type': 'application/json' },
      })
    }),
  ),
)

export default app
