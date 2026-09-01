// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The request body of `POST /api/v1/items`, as a schema.
 *
 * Documentation only. The route still validates the way it always has: it
 * reads the envelope off the body and hands the remainder to
 * `ItemService.create`, which parses it against the registered schema for
 * that item type and raises a `ValidationError` carrying the type name. This
 * schema exists so the OpenAPI document can say what that body looks like
 * without an integrator having to read `lib/items/types/*.ts` to find out.
 *
 * Derived from `ITEM_TYPE_DEFINITIONS` rather than hand-written, so a new
 * item type is documented the moment it is registered. That is also why it
 * lives here, next to the definitions it is derived from, rather than in the
 * route file.
 */

import { z } from 'zod'
import { ITEM_TYPE_DEFINITIONS } from './item-type-definitions'

/**
 * The two keys the route consumes itself, before the item type's schema ever
 * sees the rest of the body. (`itemType` is read too, but it stays — it is
 * the discriminator.)
 */
const itemCreateEnvelope = {
  branchId: z
    .string()
    .uuid()
    .optional()
    .describe(
      'Create the item on this ECO branch instead of directly on main. ' +
        'Omitting it writes to main, which branch protection allows only ' +
        'before the design has released.',
    ),
  commitMessage: z
    .string()
    // Mirrors the cap the route's own envelope enforces on this field.
    // `documentsSupersetOfEnforced` promises every body this union describes
    // is one that envelope accepts, and nothing checks that promise: an
    // uncapped string here documented a 501-character message the route
    // answers 400 to.
    .max(500)
    .optional()
    .describe(
      'Message for the commit the branch write produces. Ignored without ' +
        '`branchId`. Defaults to "Created <itemType> <itemNumber>".',
    ),
}

/**
 * `ChangeOrder` is absent deliberately: the route rejects it and points at
 * `POST /api/v1/change-orders`, which takes the designs the ECO affects. An
 * ECO created here would be linked to nothing.
 */
const CREATABLE_TYPES = Object.entries(ITEM_TYPE_DEFINITIONS).filter(
  ([name]) => name !== 'ChangeOrder',
)

/**
 * Accepted by every item type's schema — they all extend `baseItemSchema` —
 * and then ignored: `ItemService.create` names the columns it inserts and
 * these are not among them, because the server assigns them. Documenting
 * them as writable would send an integrator looking for an effect that does
 * not exist — and, repeated across twelve union members, they were 32 KB of
 * the snapshot.
 */
const SERVER_ASSIGNED = new Set([
  'id',
  'masterId',
  'isCurrent',
  'createdAt',
  'createdBy',
  'modifiedAt',
  'modifiedBy',
  'lockedBy',
  'lockedAt',
])

const members: Array<z.ZodObject> = CREATABLE_TYPES.map(([, def]) => {
  // Every registered schema is a `z.object()` built on `baseItemSchema`, so
  // this holds; `SharedItemTypeDef.schema` is typed as the general `ZodType`
  // only because the registry stores them uniformly.
  const shape = (def.schema as z.ZodObject).shape
  // Rebuilt from the shape rather than `.omit()`ed: two of the thirteen
  // schemas carry object-level refinements, and Zod refuses to omit from
  // those. Dropping the refinement costs nothing here — nothing validates
  // against this schema, the route still validates against the registered
  // one.
  const writable = Object.fromEntries(
    Object.entries(shape).filter(([key]) => !SERVER_ASSIGNED.has(key)),
  )
  return z.object({ ...writable, ...itemCreateEnvelope })
})

// `z.discriminatedUnion` wants a non-empty tuple and `map` produces an array,
// so the first member is bound out to make one. The guard is unreachable —
// `ITEM_TYPE_DEFINITIONS` is a static module constant with thirteen entries —
// but binding beats asserting: a cast here would hide a genuinely empty
// registry behind a runtime error from inside Zod.
const [firstMember, ...restMembers] = members
if (!firstMember) {
  throw new Error('No creatable item types are registered')
}

export const itemCreateRequestSchema = z.discriminatedUnion('itemType', [
  firstMember,
  ...restMembers,
])
