// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import type { DesignSession } from '@/design-engine/session-service'
import { AccessControlService } from '@/auth/AccessControlService'
import { PermissionDeniedError } from '@/errors'

/**
 * Verify user can access a design engine session.
 *
 * - Read access: cross-program authority or any member of the session's program
 * - Write access: cross-program authority or the session owner only
 *
 * Throws PermissionDeniedError if access is denied.
 */
export async function requireSessionAccess(
  userId: string,
  session: DesignSession,
  mode: 'read' | 'write',
): Promise<void> {
  // Cross-program authority bypasses all checks
  if (await AccessControlService.hasCrossProgramAccess(userId)) {
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
