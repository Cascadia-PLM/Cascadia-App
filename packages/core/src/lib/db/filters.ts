// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import {
  and,
  eq,
  inArray,
  isNull,
  ne,
  not,
  notInArray,
  or,
  sql,
} from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import {
  changeOrderDesigns,
  issueDesigns,
  issues,
  items,
  physicalParts,
  workOrders,
} from './schema'
import type { SQL } from 'drizzle-orm'

/**
 * Reusable filter that excludes soft-deleted items.
 *
 * Treats NULL and false alike. `items.is_deleted` is nullable in the schema
 * but has carried `DEFAULT false` since the first commit, and no code path
 * writes NULL, so the NULL arm is defensive against a value the column
 * permits rather than against one any reachable database holds. It retires
 * the day a `SET NOT NULL` migration lands; until then this is the only
 * spelling of the predicate, so the two readings cannot drift apart.
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
 * The two axes a caller's reach is drawn on.
 *
 * Most item types hang off a design, so `designIds` bounds them. A work order
 * names a program directly and has no design at all, so it needs the other
 * axis — and that axis cannot be derived from the first: a program with no
 * designs would lose its work orders, and a program-less design (the Standard
 * Library) belongs to no program to derive.
 *
 * `null` in place of a scope object is cross-program authority, which sees
 * everything. An empty array on either axis is not `null`: it says the caller
 * reaches nothing on that axis, and must not fall through to "all".
 *
 * Resolve one with `AccessControlService.getAccessScope`.
 */
export interface AccessScope {
  /** Designs the caller may read. */
  designIds: Array<string>
  /** Programs the caller belongs to. */
  programIds: Array<string>
}

/**
 * Item types whose reach is decided by their own row rather than by
 * `items.designId`. Each gets an arm of its own below and is excluded from
 * both the design-id arm and the design-less arm, so exactly one rule applies.
 *
 * Task's absence is deliberate — the ruling recorded on `accessScopeCondition`
 * below, which is worth reading before adding `'Task'` here, because that one
 * edit silently reverses it. Note also that adding Task would remove it from
 * the design-id arm, taking branch-created tasks dark on top of the
 * program-less ones (`ItemVersioningFacade.createOnBranch` stamps the branch's
 * design onto every type it creates, with no type guard). Any future Task arm
 * therefore has to be disjunctive — design OR program — mirrored in
 * `requireItemAccess`, and present in the `designIds.length === 0` branch.
 */
const SELF_SCOPED_ITEM_TYPES = [
  'ChangeOrder',
  'WorkOrder',
  'PhysicalPart',
  'Issue',
]

// Aliased so the subqueries below never bind to an outer join of the same
// table: search and report execution both `leftJoin` the item-type table, and
// for itemType 'WorkOrder' / 'PhysicalPart' that table is this one. The ECO
// alias earns its keep the same way — the editable-ECO picker joins
// `change_order_designs` itself when it is filtering by design, and an
// unaliased subquery there reads as if it correlated with that join.
const scopedChangeOrderDesigns = alias(changeOrderDesigns, 'eco_design_scope')
const scopedWorkOrders = alias(workOrders, 'wo_scope')
const scopedPhysicalParts = alias(physicalParts, 'pp_scope')
const scopedPartLineage = alias(items, 'pp_lineage')
const scopedIssues = alias(issues, 'issue_scope')
const scopedIssueDesigns = alias(issueDesigns, 'issue_design_scope')

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
 *
 * Exported for the same reason `physicalPartAccessScopeCondition` is: the
 * editable-ECO picker (`ChangeOrderService.getEditableChangeOrders`) is a
 * second list over change orders, and it has to draw this boundary in this
 * expression rather than in a second copy of the rule that can drift from it.
 */
export function ecoAccessScopeCondition(
  accessDesignIds: Array<string>,
): SQL<unknown> {
  return sql`EXISTS (
    SELECT 1 FROM ${changeOrderDesigns} AS "eco_design_scope"
    WHERE ${eq(scopedChangeOrderDesigns.changeOrderId, items.id)}
      AND ${inArray(scopedChangeOrderDesigns.designId, accessDesignIds)}
  )`
}

/**
 * A work order names its program on its own row, so that is the axis.
 *
 * A program-less work order fails closed. It is a data gap, not a row sitting
 * outside every boundary — the ruling `requireWorkOrderAccess` and
 * `WorkOrderService.search` already implement. This is that same rule in the
 * shared item predicate, so the item list and the work-order list can no
 * longer answer one question two ways. Cross-program authority never reaches
 * here (a `null` scope returns before this is built), which is what keeps the
 * orphaned rows visible to the administrator who has to repair them.
 */
function workOrderAccessScopeCondition(
  accessProgramIds: Array<string>,
): SQL<unknown> {
  return sql`EXISTS (
    SELECT 1 FROM ${workOrders} AS "wo_scope"
    WHERE ${eq(scopedWorkOrders.itemId, items.id)}
      AND ${inArray(scopedWorkOrders.programId, accessProgramIds)}
  )`
}

/**
 * A physical part is an instance of a part, and it is authorized as that
 * part: whoever may reach the lineage may reach the units built from it. A
 * serial number is not a separate thing to authorize.
 *
 * `requirePhysicalPartAccess` draws exactly this boundary for one row —
 * `part_master_id` to `items.master_id` to that item's design — including its
 * exception: a lineage whose rows carry no design, or that has no rows left,
 * is ungated for the same reason a design-less item is.
 *
 * One deliberate divergence, which cannot bite: the by-id gate reads an
 * arbitrary lineage row (`findFirst`) while this admits on *any* reachable
 * row. They differ only for a lineage split across designs, which the
 * invariant that every version of a part shares its design forbids.
 *
 * Exported so a physical-part list scopes on this expression rather than on a
 * second copy of the rule.
 */
export function physicalPartAccessScopeCondition(
  accessDesignIds: Array<string>,
): SQL<unknown> {
  return sql`EXISTS (
    SELECT 1 FROM ${physicalParts} AS "pp_scope"
    WHERE ${eq(scopedPhysicalParts.itemId, items.id)}
      AND (
        EXISTS (
          SELECT 1 FROM ${items} AS "pp_lineage"
          WHERE ${eq(scopedPartLineage.masterId, scopedPhysicalParts.partMasterId)}
            AND ${inArray(scopedPartLineage.designId, accessDesignIds)}
        )
        OR NOT EXISTS (
          SELECT 1 FROM ${items} AS "pp_lineage"
          WHERE ${eq(scopedPartLineage.masterId, scopedPhysicalParts.partMasterId)}
            AND ${scopedPartLineage.designId} IS NOT NULL
        )
      )
  )`
}

/**
 * An issue is the one type that genuinely carries three axes, so its arm is a
 * disjunction rather than a copy of the work-order one.
 *
 *  - `items.design_id`, which an issue raised on an ECO or workspace branch
 *    always has: `ItemVersioningFacade.createOnBranch` stamps the branch's
 *    design onto every type it creates, not just the versioned ones.
 *  - `issues.program_id`, written by the CSV import wizard and, since the
 *    create-time derivation, by the type handler whenever the chosen designs
 *    resolve to exactly one program.
 *  - `issue_designs`, the designs the create form collects by hand — reachable
 *    if *any* of them is reachable, the rule `ecoAccessScopeCondition` applies
 *    to an ECO's links and for the same reason: the designs are equal, and
 *    business with one is business with the issue.
 *
 * Scoping on the program column alone — the shape a work order gets — would
 * have taken every branch-created and every design-linked issue dark on top of
 * the program-less ones, which is a strictly larger loss than the column being
 * NULL describes.
 *
 * An issue matching none of the three is reachable by cross-program authority
 * alone, exactly as a program-less work order is: no axis at all is a data gap
 * to be repaired, not a row sitting outside every boundary.
 * `requireIssueAccess` draws this same boundary for one row.
 */
function issueAccessScopeCondition(
  accessDesignIds: Array<string>,
  accessProgramIds: Array<string>,
): SQL<unknown> {
  return sql`(
    ${inArray(items.designId, accessDesignIds)}
    OR EXISTS (
      SELECT 1 FROM ${issues} AS "issue_scope"
      WHERE ${eq(scopedIssues.itemId, items.id)}
        AND ${inArray(scopedIssues.programId, accessProgramIds)}
    )
    OR EXISTS (
      SELECT 1 FROM ${issueDesigns} AS "issue_design_scope"
      WHERE ${eq(scopedIssueDesigns.issueItemId, items.id)}
        AND ${inArray(scopedIssueDesigns.designId, accessDesignIds)}
    )
  )`
}

/**
 * Restrict a query on `items` to what the caller may read.
 *
 * Returns `null` when there is nothing to restrict — `undefined`/`null` scope
 * is cross-program authority, which sees everything. Callers push a non-null
 * result onto their condition list and otherwise leave the query untouched.
 *
 * An empty axis is not `null`: `designIds: []` means the caller reaches no
 * program design at all, and must not fall through to "everything".
 *
 * **Design-less admission is a per-type rule, not a blanket one.** An item
 * with `items.designId IS NULL` is admitted to everyone only when its type has
 * no other axis to be scoped on — a Tool sits outside every program, so there
 * is no boundary to isolate it across, which is the same thing
 * `AccessControlService.canAccessDesign` decides about a program-less design.
 * Four types do carry an axis of their own and are scoped on it instead:
 *
 *  - ChangeOrder, through `change_order_designs` (`ecoAccessScopeCondition`)
 *  - WorkOrder, through `work_orders.program_id`
 *  - PhysicalPart, through its part's lineage
 *  - Issue, through whichever of its three axes it carries
 *
 * Each arm reproduces that type's own by-id gate in `@/lib/auth/access`, so a
 * row can never be listed by one surface and refused by the other. Blanket
 * design-less admission is what let a work order the by-id gate refuses still
 * appear in the item list.
 *
 * That correspondence is now true of all four arms rather than aspirational
 * for two: `requireItemAccess` dispatches WorkOrder and PhysicalPart as well
 * as ChangeOrder and Issue, so the generic `/items/:id/*` router no longer
 * answers a third way from either this predicate or the typed routers. The
 * one divergence that remains is the pre-existing and deliberate one recorded
 * on `physicalPartAccessScopeCondition` above — the by-id gate reads an
 * arbitrary lineage row while this admits on any reachable one — which is
 * inherited by the dispatch unchanged, and which the invariant that every
 * version of a part shares its design keeps from biting.
 *
 * Task stays admitted, and that is a ruling rather than an oversight.
 * `tasks.program_id` exists and the type handler writes it, but nothing in the
 * application ever supplies one and nothing can derive one: the only
 * structurally single-valued chain (`parent_task_id` → `items` → `designs`) is
 * written by no form and terminates in NULL anyway, because a task's parent is
 * another task and tasks carry no design; and `assignee` → `program_members`
 * is not a derivation at all but a circle, taking the authorization boundary
 * from the very membership table the boundary is checked against.
 *
 * That circle is the trap, and it is the thing the next reader will reach for,
 * because it resolves "exactly one" on a single-program install: it looks
 * right while being wrong by construction, and it is wrong precisely when a
 * second program exists — the only situation this predicate exists for.
 *
 * Scoping Task is therefore a decision to *require* a program at creation,
 * which takes every task already in an install dark with none of them
 * rescuable: `taskUpdateSchema` carries no `programId`, so a row scoped in
 * error has no repair path at all. Requiring a program is a two-part product
 * change — the create *and* update schemas, plus a membership-gated picker in
 * the form — not a predicate flip here.
 *
 * The ruling, made rather than deferred: a program is deliberately not
 * required at task creation, and Task is deliberately not scoped. It is a
 * scoped ruling, not an eternal one — it is right for an install where tasks
 * are instance-wide chores, and revisiting it is a product decision about
 * whether tasks are program-private data, not a bug fix. A test pins the
 * admission on both the list and the by-id surface so it cannot change by
 * accident.
 *
 * Lives here rather than beside any one caller because item lists, search,
 * dashboard counts and report execution all have to draw the boundary in the
 * same place. Three hand-rolled copies of the rule is three chances to get it
 * wrong.
 */
export function accessScopeCondition(
  scope: AccessScope | null | undefined,
): SQL<unknown> | null {
  if (!scope) return null

  const { designIds, programIds } = scope

  const designLess = and(
    notInArray(items.itemType, SELF_SCOPED_ITEM_TYPES),
    isNull(items.designId),
  )!

  // Both arms go false on an empty axis — `inArray(col, [])` compiles to
  // `false` — but they still belong in the empty-scope branch below: the
  // physical-part arm also admits a lineage carrying no design at all, which
  // is the ungated case the by-id gate names. Leaving them out of that branch
  // would restore blanket design-less admission for exactly the caller this
  // predicate exists to bound.
  const workOrderScoped = and(
    eq(items.itemType, 'WorkOrder'),
    workOrderAccessScopeCondition(programIds),
  )!
  const physicalPartScoped = and(
    eq(items.itemType, 'PhysicalPart'),
    physicalPartAccessScopeCondition(designIds),
  )!
  // The issue arm belongs in the empty-scope branch for a reason the other two
  // only share by accident: its program disjunct is drawn on `programIds`, and
  // a caller can reach a program that has no designs yet. Leaving it out would
  // hide that program's own issues from its own members — which is the whole
  // of the bug this arm exists to fix, reproduced for exactly the caller it
  // was written for.
  const issueScoped = and(
    eq(items.itemType, 'Issue'),
    issueAccessScopeCondition(designIds, programIds),
  )!

  if (designIds.length === 0) {
    return or(designLess, workOrderScoped, physicalPartScoped, issueScoped)!
  }

  return or(
    and(
      notInArray(items.itemType, SELF_SCOPED_ITEM_TYPES),
      inArray(items.designId, designIds),
    ),
    designLess,
    and(eq(items.itemType, 'ChangeOrder'), ecoAccessScopeCondition(designIds)),
    workOrderScoped,
    physicalPartScoped,
    issueScoped,
  )!
}
