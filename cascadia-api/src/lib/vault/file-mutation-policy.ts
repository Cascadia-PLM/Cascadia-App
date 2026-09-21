// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import type { PermissionAction } from '@cascadia/commons/lib/auth/permissions'
import { requireFileAccess, requireItemAccess } from '@/lib/auth/access'
import { requirePermission } from '@/lib/auth/server'
import { ValidationError } from '@/lib/errors'
import { getResourceType } from '@/lib/items/item-type-resources'
import { ItemService } from '@/lib/items/services/ItemService'
import { BranchService } from '@/lib/services/BranchService'

type EditableItem = Awaited<ReturnType<typeof requireItemAccess>>
type EditableBranch = Awaited<
  ReturnType<typeof ItemService.requireContentEditable>
>

/**
 * Authorize a user-facing mutation of an item's vault attachments.
 *
 * Files inherit both RBAC and versioning policy from their owning item. A file
 * on a Part is therefore a `parts:update`, not a `documents:update`, and a
 * released revision is no more editable through the vault routes than through
 * the ordinary item update route.
 */
export async function requireItemFileMutation(
  request: Request,
  itemId: string,
  userId: string,
  options: {
    action?: PermissionAction
    requireEditable?: boolean
  } = {},
): Promise<{ item: EditableItem; branch: EditableBranch }> {
  const item = await requireItemAccess(userId, itemId)
  await requirePermission(
    request,
    getResourceType(item.itemType),
    options.action ?? 'update',
  )

  const branch =
    options.requireEditable === false
      ? null
      : await ItemService.requireContentEditable(item, userId)

  return { item, branch }
}

/** Apply the owning item's mutation policy to a file addressed by id. */
export async function requireFileMutation(
  request: Request,
  fileId: string,
  userId: string,
  options: {
    action?: PermissionAction
    requireEditable?: boolean
  } = {},
) {
  const file = await requireFileAccess(fileId, userId)
  const { item, branch } = await requireItemFileMutation(
    request,
    file.itemId,
    userId,
    options,
  )

  if (options.requireEditable !== false) {
    await requireExistingFileBranchContext(item, branch, file.branchId)
  }

  return { file, item, branch }
}

/**
 * Refuse a file row from a different version context than the editable item.
 * Item identity alone is insufficient because legacy/main and branch files
 * may be visible together in a working-copy listing.
 */
async function requireExistingFileBranchContext(
  item: EditableItem,
  editableBranch: EditableBranch,
  fileBranchId: string | null,
): Promise<void> {
  if (editableBranch) {
    if (fileBranchId !== editableBranch.branchId) {
      throw branchValidationError(
        'File does not belong to the item working-copy branch',
        'Must identify the item working-copy branch',
      )
    }
    return
  }

  if (!item.designId || fileBranchId === null) return

  const mainBranch = await BranchService.getMainBranch(item.designId)
  if (fileBranchId !== mainBranch?.id) {
    throw branchValidationError(
      'File does not belong to the item main branch',
      'Must identify the item main branch',
    )
  }
}

function branchValidationError(message: string, fieldMessage: string) {
  return new ValidationError(message, [
    { field: 'branchId', message: fieldMessage },
  ])
}

/**
 * Ensure an upload is attached to the same version context that was authorized.
 *
 * A working copy must name its ECO/workspace branch. A directly editable main
 * item may omit the branch (legacy/global attachment) or name that design's
 * main branch, as the current Part and Document clients do.
 */
export async function requireUploadBranchContext(
  item: EditableItem,
  editableBranch: EditableBranch,
  branchId: string | undefined,
): Promise<void> {
  if (editableBranch) {
    if (branchId !== editableBranch.branchId) {
      throw branchValidationError(
        'Upload branch does not match the item working copy',
        'Must identify the item working-copy branch',
      )
    }
    return
  }

  if (!branchId) return

  // Self-scoped/design-less items (notably ChangeOrder and PhysicalPart) do
  // not participate in ItemEditPolicy's design-branch model. Preserve their
  // existing attachment context: there is no authoritative design branch to
  // compare it with here. Versioned Part/Document working copies take the
  // strict arm above, which is the integrity boundary this validation adds.
  if (!item.designId) return

  const mainBranch = await BranchService.getMainBranch(item.designId)
  if (branchId !== mainBranch?.id) {
    throw branchValidationError(
      'Upload branch does not match the item main branch',
      'Must identify the item main branch',
    )
  }
}
