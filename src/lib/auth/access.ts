import { AccessControlService } from './AccessControlService'
import { BranchService } from '@/lib/services/BranchService'
import { NotFoundError, PermissionDeniedError } from '@/lib/errors'

/**
 * Verify user can access a design. Throws PermissionDeniedError if not.
 * Handles Global Admin bypass internally via AccessControlService.
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
