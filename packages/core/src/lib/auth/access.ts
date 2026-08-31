// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { eq, inArray } from 'drizzle-orm'
import { AccessControlService } from './AccessControlService'
import { BranchService } from '@/lib/services/BranchService'
import { FileService } from '@/lib/vault/services/FileService'
import { db } from '@/lib/db'
import {
  changeOrderDesigns,
  issueDesigns,
  issues,
  items,
  physicalParts,
} from '@/lib/db/schema/items'
import { workOrders } from '@/lib/db/schema/work-orders'
import {
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from '@/lib/errors'

/**
 * Verify user can access a design. Throws PermissionDeniedError if not.
 * Handles the cross-program-authority bypass internally via AccessControlService.
 */
export async function requireDesignAccess(
  userId: string,
  designId: string,
): Promise<void> {
  const canAccess = await AccessControlService.canAccessDesign(userId, designId)
  if (!canAccess) {
    throw new PermissionDeniedError('design', 'read')
  }
}

/**
 * The designs a change order touches, split by whether this caller reaches them.
 *
 * A change order spans designs and none of them is primary, so "may this user
 * see this ECO" is not a single yes/no over one design — it is an intersection.
 * Reaching *any* linked design is enough to have business with the ECO; the
 * designs the caller does not reach are what the detail views redact.
 *
 * `restrictedCount` is deliberately not returned. Callers get a boolean,
 * because how many items or designs sit behind the boundary is itself a
 * disclosure — it sizes a program the caller cannot open.
 */
export async function resolveEcoDesignScope(
  userId: string,
  changeOrderId: string,
): Promise<{
  /** Every design linked to the ECO. */
  linked: Array<string>
  /** The subset this caller may read. */
  reachable: Array<string>
  /** Whether anything was withheld — never how much. */
  hasRestricted: boolean
  /** Cross-program authority: bounded by nothing, including "no links at all". */
  unrestricted: boolean
}> {
  const rows = await db
    .select({ designId: changeOrderDesigns.designId })
    .from(changeOrderDesigns)
    .where(eq(changeOrderDesigns.changeOrderId, changeOrderId))

  const linked = [...new Set(rows.map((r) => r.designId))]

  const scope = await AccessControlService.getAccessibleDesignIds(userId)
  if (scope === null) {
    return {
      linked,
      reachable: linked,
      hasRestricted: false,
      unrestricted: true,
    }
  }

  const allowed = new Set(scope)
  const reachable = linked.filter((id) => allowed.has(id))
  return {
    linked,
    reachable,
    hasRestricted: reachable.length < linked.length,
    unrestricted: false,
  }
}

/**
 * Assert the caller may open this change order at all, and return its scope.
 *
 * Reaching none of its designs means the ECO is not theirs to see. An ECO with
 * no design links at all is that case for everyone *except* cross-program
 * authority — which is the point: creation requires a design, so a link-less
 * row predates the invariant and someone has to be able to open it and repair
 * it. Testing `reachable` alone would have locked administrators out of
 * exactly the rows only they can fix.
 */
export async function requireEcoAccess(userId: string, changeOrderId: string) {
  const scope = await resolveEcoDesignScope(userId, changeOrderId)
  if (!scope.unrestricted && scope.reachable.length === 0) {
    throw new PermissionDeniedError('change order', 'read')
  }
  return scope
}

/**
 * Verify user can access the design that a branch belongs to.
 * Throws NotFoundError if branch doesn't exist, PermissionDeniedError if no access.
 * Returns the branch for convenience.
 */
export async function requireBranchAccess(
  userId: string,
  branchId: string,
): Promise<{
  branch: NonNullable<Awaited<ReturnType<typeof BranchService.getById>>>
  designId: string
}> {
  const branch = await BranchService.getById(branchId)
  if (!branch) throw new NotFoundError('Branch', branchId)

  await requireDesignAccess(userId, branch.designId)
  return { branch, designId: branch.designId }
}

/**
 * Resolve an item and assert the caller may reach it.
 *
 * RBAC answers "may this user read parts"; this answers "may they read *this*
 * part". Type permission is instance-blind, so without this a viewer in one
 * program could read, and in several places write, every item in every other
 * program by knowing an id.
 *
 * Four types are delegated rather than checked here, all for one reason: their
 * `items.designId` is NULL, so the `item.designId` arm below passes vacuously
 * and gates nothing at all.
 *
 *  - ChangeOrder → `requireEcoAccess`. An ECO's designs hang off
 *    `change_order_designs`.
 *  - Issue → `requireIssueAccess`, for that reason and one more: an issue may
 *    carry a design, a program, a set of design links, or none of them, and
 *    the arm below sees only the first.
 *  - WorkOrder → `requireWorkOrderAccess`. A work order is not versioned and
 *    belongs to no design; it names `work_orders.program_id` directly.
 *  - PhysicalPart → `requirePhysicalPartAccess`. An instance is authorized as
 *    the part it is an instance of, through `physical_parts.part_master_id`.
 *
 * These are the same four types `SELF_SCOPED_ITEM_TYPES` names in
 * `@/lib/db/filters`, and each arm here is the one-row twin of that type's arm
 * in `accessScopeCondition`. Both surfaces have to draw the boundary in the
 * same place: one admitting what the other refuses is the failure these arms
 * exist to fix. The last two arms landed after the first two, and until they
 * did, a work order or a physical instance was gated by authentication alone
 * on 31 generic-router surfaces plus the AI/MCP tool handlers, while the item
 * list and both typed routers refused the very same rows.
 *
 * Dispatching here rather than only from `routes/issues.ts`, `work-orders.ts`
 * and `physical-parts.ts` is what covers the generic `/items/:id` sub-routes —
 * transition, lock, relationships, files, checkout — and the AI tool handlers,
 * which all reach those types through this one function and no other.
 *
 * Two consequences of the last two arms, both intended. A work order whose
 * `program_id` is NULL fails closed to everyone without `programs:manage` here
 * as it already does on the typed routes and in every list — administrators
 * keep reach precisely so they can repair the row. And both helpers throw
 * `NotFoundError` when the child row is missing, so an `items` row of either
 * type with no `work_orders` / `physical_parts` row answers 404 rather than
 * passing; the two-table pattern makes that unreachable, but it is a status
 * change, not only a 403 change.
 *
 * A Task is deliberately *not* dispatched, and that silence is a ruling rather
 * than the oversight it resembles. A task carries no design of its own, so it
 * falls through to the `item.designId` arm below — which for a design-less row
 * passes vacuously — and stays reachable by any authenticated caller holding
 * `tasks:read`. `tasks.program_id` exists but nothing supplies it, and the
 * chain a reader reaches for, `assignee` → `program_members`, is a circle
 * rather than a derivation: it takes the boundary from the very membership
 * table the boundary is checked against, and resolves "exactly one" only on a
 * single-program install, where it looks right while being wrong by
 * construction. The full reasoning — including why requiring a program is a
 * two-part product change rather than a predicate flip — is recorded on
 * `accessScopeCondition` in `@/lib/db/filters`, and it is recorded in both
 * places on purpose: this gate and that predicate must not drift, because one
 * surface admitting what the other refuses is the failure the ChangeOrder and
 * Issue arms exist to fix.
 *
 * Takes an id or a row already in hand, and returns the row, so a handler that
 * needs the item does not read it twice. Soft-deleted items are deliberately
 * not filtered out here. `items.isDeleted` is the authoritative marker the rest
 * of the system keys on — always through `notDeleted()` in `@/lib/db/filters`,
 * which is now its only spelling — and `deletedAt`/`deletedBy` are the audit
 * stamp the ECO merge writes alongside it (`ChangeOrderMergeService`,
 * the `changeType === 'deleted'` arm), never on their own and never read back.
 * This helper answers authorization only: a soft-deleted row keeps its
 * `designId`, so the boundary drawn here is still the right one, and existence
 * policy stays with the readers that already elide or 404 such rows.
 *
 * Lives beside `requireFileAccess` for the same reason it does: a module
 * contributing an item action can reuse it without importing a route module.
 */
export async function requireItemAccess(
  userId: string,
  itemOrId: string | typeof items.$inferSelect,
): Promise<typeof items.$inferSelect> {
  const item =
    typeof itemOrId === 'string'
      ? await db.query.items.findFirst({ where: eq(items.id, itemOrId) })
      : itemOrId

  if (!item) {
    throw new NotFoundError(
      'Item',
      typeof itemOrId === 'string' ? itemOrId : '',
    )
  }

  if (item.itemType === 'ChangeOrder') {
    await requireEcoAccess(userId, item.id)
    return item
  }

  if (item.itemType === 'Issue') {
    await requireIssueAccess(userId, item)
    return item
  }

  if (item.itemType === 'WorkOrder') {
    await requireWorkOrderAccess(userId, item.id)
    return item
  }

  if (item.itemType === 'PhysicalPart') {
    await requirePhysicalPartAccess(userId, item.id)
    return item
  }

  if (item.designId) await requireDesignAccess(userId, item.designId)
  return item
}

/**
 * `requireItemAccess` for a list of ids, returning the rows by id.
 *
 * This is the gate for items a request names in its **body** rather than its
 * path. The `access:` handler option cannot cover those — it runs before the
 * body is read — so a route that links, allocates or relates one item to
 * another has to charge the far end itself, and every such route was charging
 * only the near one. Knowing a UUID was then enough to write an edge across a
 * program boundary, and to learn from the response that the item exists.
 *
 * Each id goes through `requireItemAccess` rather than a `designId` comparison,
 * so the item types whose reach is not their design — ChangeOrder, Issue,
 * WorkOrder, PhysicalPart — keep the rules those arms encode. A `designId`-only
 * check would silently pass every ECO, whose `designId` is always null.
 *
 * Ids are de-duplicated and read in one query; the per-item checks then run on
 * rows already in hand. An unknown id is a `NotFoundError` naming it, matching
 * what the by-id routes answer for the same id.
 */
export async function requireItemsAccess(
  userId: string,
  itemIds: Array<string>,
): Promise<Map<string, typeof items.$inferSelect>> {
  const uniqueIds = [...new Set(itemIds)]
  if (uniqueIds.length === 0) return new Map()

  const rows = await db.query.items.findMany({
    where: inArray(items.id, uniqueIds),
  })
  const byId = new Map(rows.map((row) => [row.id, row]))

  const missing = uniqueIds.find((id) => !byId.has(id))
  if (missing) throw new NotFoundError('Item', missing)

  for (const id of uniqueIds) {
    await requireItemAccess(userId, byId.get(id)!)
  }

  return byId
}

/**
 * Assert the caller may reach an issue.
 *
 * The mirror of the `Issue` arm in `accessScopeCondition`, for one row. An
 * issue is reachable when *any* of its three axes is:
 *
 *  - `items.design_id`, which every issue raised on an ECO or workspace branch
 *    carries (`ItemVersioningFacade.createOnBranch` stamps the branch's design
 *    onto whatever type it creates)
 *  - `issues.program_id`, from the CSV import wizard or the create-time
 *    derivation over the chosen designs
 *  - any `issue_designs` link, the designs the create form collects — one
 *    reachable link is enough, the rule `requireEcoAccess` applies to an ECO
 *
 * An issue carrying none of them is reachable by cross-program authority
 * alone, the rule `requireWorkOrderAccess` applies to a program-less order: a
 * row with no axis is a data gap someone has to open and repair, not a row
 * that sits outside every boundary. `programId` on `issueUpdateSchema` is what
 * makes that repair possible; without it this would strand the row forever.
 *
 * Takes the already-resolved `items` row so the caller does not read it twice.
 */
export async function requireIssueAccess(
  userId: string,
  item: typeof items.$inferSelect,
): Promise<void> {
  if (
    item.designId &&
    (await AccessControlService.canAccessDesign(userId, item.designId))
  ) {
    return
  }

  const issue = await db.query.issues.findFirst({
    where: eq(issues.itemId, item.id),
  })
  if (
    issue?.programId &&
    (await AccessControlService.canAccessProgram(userId, issue.programId))
  ) {
    return
  }

  const links = await db
    .select({ designId: issueDesigns.designId })
    .from(issueDesigns)
    .where(eq(issueDesigns.issueItemId, item.id))
  for (const link of links) {
    if (await AccessControlService.canAccessDesign(userId, link.designId)) {
      return
    }
  }

  if (await AccessControlService.hasCrossProgramAccess(userId)) return

  throw new PermissionDeniedError('issue', 'read')
}

/**
 * Assert the caller may reach a work order.
 *
 * A work order carries no `designId` — it is not versioned and belongs to no
 * design — so `requireItemAccess` would pass it vacuously. It names its
 * program directly instead, which is the axis the work-order list already
 * scopes on, so this is that same rule for one row.
 *
 * A program-less work order is reachable by cross-program authority alone —
 * the rule `requireEcoAccess` applies to a link-less ECO, for the same reason.
 * A row with no program is a data gap, not a row that sits outside every
 * boundary: this is the only instance-level gate the work-order routes have,
 * and it covers the traveler, sign-off, material consumption and production,
 * so "no program" must not mean "everyone may write it". Creation now derives
 * the program from the part being built (`WorkOrderService.create`), and
 * administrators keep reach precisely so they can open and repair the rows
 * that predate that.
 */
export async function requireWorkOrderAccess(
  userId: string,
  workOrderItemId: string,
): Promise<typeof workOrders.$inferSelect> {
  const workOrder = await db.query.workOrders.findFirst({
    where: eq(workOrders.itemId, workOrderItemId),
  })
  if (!workOrder) throw new NotFoundError('Work order', workOrderItemId)

  const allowed = workOrder.programId
    ? await AccessControlService.canAccessProgram(userId, workOrder.programId)
    : await AccessControlService.hasCrossProgramAccess(userId)
  if (!allowed) throw new PermissionDeniedError('work order', 'read')

  return workOrder
}

/**
 * Assert the caller may reach a physical instance.
 *
 * Like a work order, a physical part carries no `designId` of its own. What it
 * does carry is `partMasterId`: the lineage of the part it is an instance of.
 * That part is in a design, and whoever may reach the part may reach its
 * units — the serial number is not a separate thing to be authorized, it is
 * this part, built.
 *
 * Any row of the lineage answers the question: every version of a part shares
 * its design. An instance whose part has no design, or whose lineage has no
 * rows left, is ungated for the same reason a design-less item is.
 */
export async function requirePhysicalPartAccess(
  userId: string,
  physicalPartItemId: string,
): Promise<typeof physicalParts.$inferSelect> {
  const physicalPart = await db.query.physicalParts.findFirst({
    where: eq(physicalParts.itemId, physicalPartItemId),
  })
  if (!physicalPart) {
    throw new NotFoundError('Physical part', physicalPartItemId)
  }

  const partVersion = await db.query.items.findFirst({
    where: eq(items.masterId, physicalPart.partMasterId),
  })
  if (partVersion?.designId) {
    await requireDesignAccess(userId, partVersion.designId)
  }

  return physicalPart
}

/**
 * Assert the caller may reach the part lineage a masterId names.
 *
 * The AML is master-level data: an approved-manufacturer row is bound to a
 * part's `masterId` so it survives revisions, and therefore carries no
 * `designId` of its own. The part does, and whoever may reach the part may
 * reach its sourcing — which manufacturers a design has qualified is the
 * design's own commercial information.
 *
 * Any row of the lineage answers the question: every version of a part shares
 * its design. A master with no rows left, or whose part has no design, is
 * ungated for the same reason a design-less item is — the same rule
 * `requirePhysicalPartAccess` applies to the other master-keyed surface.
 */
export async function requirePartMasterAccess(
  userId: string,
  partMasterId: string,
): Promise<void> {
  const partVersion = await db.query.items.findFirst({
    where: eq(items.masterId, partMasterId),
  })
  if (partVersion?.designId) {
    await requireDesignAccess(userId, partVersion.designId)
  }
}

/**
 * Resolve a file and assert the caller may see it.
 *
 * The design-level check is the one that matters: `documents:read` says the
 * user may read documents in general, while design membership says they may
 * read *this* one.
 *
 * Lives here rather than in `src/server/routes/files.ts` so a module
 * contributing a file action can reuse it without importing a route module —
 * which would drag that router's own `mountRoutes` call into the composition
 * root's load, before registration had finished.
 */
export async function requireFileAccess(fileId: string, userId: string) {
  const file = await FileService.getFileMetadata(fileId)
  if (!file) throw new NotFoundError('File', fileId)
  if (file.deletedAt) throw new ValidationError('File has been deleted')

  if (file.itemId) {
    const item = await db.query.items.findFirst({
      where: eq(items.id, file.itemId),
    })
    if (item?.designId) {
      await requireDesignAccess(userId, item.designId)
    }
  }

  return file
}
