// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, eq, inArray, isNull, ne, not, or, sql } from 'drizzle-orm'
import { changeOrderDesigns, items } from './schema'
import type { SQL } from 'drizzle-orm'

/**
 * Reusable filter that excludes soft-deleted items.
 * Uses the defensive pattern: treats NULL and false as "not deleted"
 * for backward compatibility with rows inserted before the column existed.
 */
export function notDeleted() {
  return or(isNull(items.isDeleted), eq(items.isDeleted, false))!
}

/**
 * Excludes unreleased working copies: versions carrying a branch working
 * revision (`-{branchId8}`, or the historical `DRAFT` / `-` markers) rather
 * than a revision the merge assigned.
 *
 * The SQL counterpart of `RevisionService.isWorkingRevision`, for queries
 * that answer "what is released" without going through the commit graph.
 */
export function notWorkingRevision() {
  return and(
    not(sql`${items.revision} LIKE '-%'`),
    ne(items.revision, 'DRAFT'),
    ne(items.revision, ''),
  )!
}

/**
 * A change order's designs live in `change_order_designs`, not in
 * `items.designId` — an ECO spans designs, and none of them is primary.
 *
 * So a ChangeOrder row cannot be scoped the way every other item type is.
 * `items.designId` is left NULL on every ECO the application creates, which
 * put all of them in the design-less bucket below and handed every ECO in the
 * instance to every caller. The boundary has to be drawn over the link table
 * instead: reachable if *any* linked design is reachable, because the designs
 * are equal and membership in one is enough to have business with the ECO.
 *
 * An ECO with no links at all is reachable by nobody but cross-program
 * authority. That is only safe because creation now requires at least one
 * design (`ChangeOrderService.create`); rows predating that invariant are
 * invisible until an administrator links a design to them.
 */
function ecoAccessScopeCondition(accessDesignIds: Array<string>): SQL<unknown> {
  return sql`EXISTS (
    SELECT 1 FROM ${changeOrderDesigns}
    WHERE ${eq(changeOrderDesigns.changeOrderId, items.id)}
      AND ${inArray(changeOrderDesigns.designId, accessDesignIds)}
  )`
}

/**
 * Restrict a query on `items` to the designs the caller may read.
 *
 * Returns `null` when there is nothing to restrict — `undefined`/`null` scope
 * is cross-program authority, which sees everything. Callers push a non-null
 * result onto their condition list and otherwise leave the query untouched.
 *
 * `[]` is not `null`: it means the caller reaches no *program* design at all,
 * and must not fall through to "everything".
 *
 * Design-less items (`items.designId IS NULL`) are always admitted. They sit
 * outside every program, so there is no boundary to isolate them across, and
 * `AccessControlService.canAccessDesign` treats a design with no program the
 * same permissive way. Change orders are the one type this rule does *not*
 * cover — see `ecoAccessScopeCondition` — because their design link is a
 * many-to-many elsewhere and a NULL `designId` means "not recorded here",
 * not "outside every program".
 *
 * Lives here rather than beside any one caller because item lists, search,
 * dashboard counts and report execution all have to draw the boundary in the
 * same place. Three hand-rolled copies of the `[]`-vs-`null` rule is three
 * chances to get it wrong.
 */
export function accessScopeCondition(
  accessDesignIds: Array<string> | null | undefined,
): SQL<unknown> | null {
  if (!accessDesignIds) return null

  const designLess = and(
    ne(items.itemType, 'ChangeOrder'),
    isNull(items.designId),
  )!

  if (accessDesignIds.length === 0) return designLess

  return or(
    and(
      ne(items.itemType, 'ChangeOrder'),
      inArray(items.designId, accessDesignIds),
    ),
    designLess,
    and(
      eq(items.itemType, 'ChangeOrder'),
      ecoAccessScopeCondition(accessDesignIds),
    ),
  ) as SQL<unknown>
}
