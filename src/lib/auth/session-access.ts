import { AccessControlService } from './AccessControlService'
import type { DesignSession } from '@/lib/design-engine/session-service'
import { PermissionDeniedError } from '@/lib/errors'

/**
 * Verify user can access a design engine session.
 *
 * - Read access: Global Admin or any member of the session's program
 * - Write access: Global Admin or the session owner only
 *
 * Throws PermissionDeniedError if access is denied.
 */
export async function requireSessionAccess(
  userId: string,
  session: DesignSession,
  mode: 'read' | 'write',
): Promise<void> {
  // Global Admin bypasses all checks
  if (await AccessControlService.isGlobalAdmin(userId)) {
    return
  }

  // Must be a member of the session's program
  const canAccessProgram = await AccessControlService.canAccessProgram(
    userId,
    session.programId,
  )
  if (!canAccessProgram) {
    throw new PermissionDeniedError('design_session', mode)
  }

  // Write access requires ownership
  if (mode === 'write' && session.userId !== userId) {
    throw new PermissionDeniedError('design_session', mode)
  }
}
