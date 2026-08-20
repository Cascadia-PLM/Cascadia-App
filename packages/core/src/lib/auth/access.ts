// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { eq } from 'drizzle-orm'
import { AccessControlService } from './AccessControlService'
import { BranchService } from '@/lib/services/BranchService'
import { FileService } from '@/lib/vault/services/FileService'
import { db } from '@/lib/db'
import { changeOrderDesigns, items } from '@/lib/db/schema/items'
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
