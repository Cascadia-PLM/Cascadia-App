// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { eq } from 'drizzle-orm'
import { AccessControlService } from './AccessControlService'
import { BranchService } from '@/lib/services/BranchService'
import { FileService } from '@/lib/vault/services/FileService'
import { db } from '@/lib/db'
import { items } from '@/lib/db/schema/items'
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
