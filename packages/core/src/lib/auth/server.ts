// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { db } from '../db'
import { resolveClientIp } from '../api/client-ip'
import { authEvents } from '../db/schema/users'
import { ErrorCode } from '../errors/codes'
import { SessionManager } from './session'
import { permissionService } from './permission-service'
import { resolveCredentials } from './credentials'
import { intersectPermissions, intersectRoles } from './api-key-utils'
import { hasPermission } from './permissions'
import type { Session, SessionUser, SessionValidationResult } from './session'
import type { PermissionAction, ResourceType } from './permissions'

/**
 * Result of unified request authentication. For API-key requests there is no
 * session — `session` is null and the two scope fields carry the key's
 * optional narrowing (null on either = inherit the owner's full set).
 *
 * `scope` and `roleScope` are independent axes: permission checks consult the
 * first, `requireRole` the second. Neither can widen what the owner already
 * has.
 */
export interface AuthValidationResult {
  session: Session | null
  user: SessionUser
  authMethod: 'session' | 'api_key'
  scope: Record<string, Array<string>> | null
  roleScope: Array<string> | null
  keyId?: string
}

/**
 * Server-side authentication utilities
 */

/**
 * Create an error response in the standard format.
 */
function createAuthErrorResponse(
  code: ErrorCode,
  message: string,
  status: number,
): Response {
  return new Response(
    JSON.stringify({
      error: {
        code,
        message,
        timestamp: new Date().toISOString(),
      },
    }),
    {
      status,
      headers: {
        'Content-Type': 'application/json',
      },
    },
  )
}

/**
 * Get session from request cookies
 */
export function getSessionTokenFromRequest(request: Request): string | null {
  const cookieHeader = request.headers.get('cookie')
  if (!cookieHeader) {
    return null
  }

  // Parse session token from cookie
  const cookies = Object.fromEntries(
    cookieHeader.split('; ').map((c) => {
      const [key, ...v] = c.split('=')
      return [key, v.join('=')]
    }),
  )

  return cookies['session'] || null
}

/**
 * Validate session from request and return user data
 */
export async function validateRequestSession(
  request: Request,
): Promise<SessionValidationResult | null> {
  const sessionToken = getSessionTokenFromRequest(request)

  if (!sessionToken) {
    return null
  }

  return await SessionManager.validateSession(sessionToken)
}

/**
 * Require authentication for a request.
 *
 * Unified: accepts a session cookie OR a Bearer API key, via the same
 * resolveCredentials() that apiHandler uses. Historically this helper
 * validated only the session cookie, which made every route that gates
 * through requirePermission/requireRole reject valid API-key callers with
 * 401 AUTH_REQUIRED — breaking headless clients (CAD connectors, scripts)
 * on the items/designs/programs routes while the rest of /api/v1 accepted
 * the same key.
 *
 * For session auth the full session record is preserved; API-key auth has
 * no session (session: null) and carries the key's optional scope.
 */
export async function requireAuth(
  request: Request,
): Promise<AuthValidationResult> {
  // Authorization-header requests are token auth only — mirroring
  // resolveCredentials' rule of never falling back to cookies when a
  // (possibly invalid) header is present.
  const authHeader = request.headers.get('authorization')
  if (!authHeader) {
    const sessionData = await validateRequestSession(request)
    if (sessionData) {
      return {
        session: sessionData.session,
        user: sessionData.user,
        authMethod: 'session',
        scope: null,
        roleScope: null,
      }
    }
    throw createAuthErrorResponse(
      ErrorCode.AUTH_REQUIRED,
      'Authentication required',
      401,
    )
  }

  const credentials = await resolveCredentials(request)
  if (!credentials) {
    throw createAuthErrorResponse(
      ErrorCode.AUTH_REQUIRED,
      'Authentication required',
      401,
    )
  }
  return {
    session: null,
    user: credentials.user,
    authMethod: credentials.authMethod,
    scope: credentials.scope,
    roleScope: credentials.roleScope,
    keyId: credentials.keyId,
  }
}

/**
 * Require authentication and specific permission for a request
 * Returns auth data or throws an error response
 */
export async function requirePermission(
  request: Request,
  resource: ResourceType,
  action: PermissionAction,
): Promise<AuthValidationResult> {
  const auth = await requireAuth(request)

  // Scoped API keys narrow the user's role permissions (same semantics as
  // apiHandler's declared-permission path).
  let allowed: boolean
  if (auth.scope) {
    const userPermissions = await permissionService.getUserPermissions(
      auth.user.id,
    )
    allowed = hasPermission(
      intersectPermissions(userPermissions, auth.scope),
      resource,
      action,
    )
  } else {
    allowed = await permissionService.canUser(auth.user.id, action, resource)
  }

  if (!allowed) {
    // Log permission denial
    await db.insert(authEvents).values({
      userId: auth.user.id,
      eventType: 'permission_denied',
      ipAddress: resolveClientIp(request),
      metadata: {
        resource,
        action,
        authMethod: auth.authMethod,
        ...(auth.keyId ? { keyId: auth.keyId } : {}),
      },
    })

    throw createAuthErrorResponse(
      ErrorCode.PERMISSION_DENIED,
      `You do not have permission to ${action} ${resource}`,
      403,
    )
  }

  return auth
}

/**
 * Check if the authenticated caller may exercise a specific role.
 *
 * Two conditions, both required:
 *   1. The *user* holds the role (unchanged, longstanding behaviour).
 *   2. For API-key auth, the *key* was scoped to include the role.
 *
 * (2) is what keeps role-gated actions — e.g. `bypassBranchProtection` on the
 * import routes — from riding along on a narrowly-scoped key. A key carries
 * its owner's identity, so without an explicit role scope every key an admin
 * minted would clear every role gate regardless of how tightly its permission
 * scope was drawn. A null roleScope preserves the old inherit-everything
 * behaviour for keys created before this existed.
 */
export async function requireRole(
  request: Request,
  roleName: string,
): Promise<AuthValidationResult> {
  const auth = await requireAuth(request)

  const userRoles = await permissionService.getUserRoles(auth.user.id)
  const effectiveRoles = intersectRoles(userRoles, auth.roleScope)
  const hasRole = effectiveRoles.includes(roleName)

  if (!hasRole) {
    // Distinguish "your user lacks the role" from "your key wasn't scoped for
    // it" — same 403 to the caller, but the audit trail needs to tell them
    // apart when someone is debugging a headless client.
    const deniedByKeyScope = userRoles.includes(roleName)

    await db.insert(authEvents).values({
      userId: auth.user.id,
      eventType: 'permission_denied',
      ipAddress: resolveClientIp(request),
      metadata: {
        requiredRole: roleName,
        authMethod: auth.authMethod,
        ...(auth.keyId ? { keyId: auth.keyId } : {}),
        ...(deniedByKeyScope ? { deniedBy: 'key_role_scope' } : {}),
      },
    })

    throw createAuthErrorResponse(
      ErrorCode.ROLE_REQUIRED,
      deniedByKeyScope
        ? `This API key is not scoped for the ${roleName} role`
        : `This action requires the ${roleName} role`,
      403,
    )
  }

  return auth
}
