import { db } from '../db'
import { authEvents } from '../db/schema/users'
import { ErrorCode } from '../errors/codes'
import { SessionManager } from './session'
import { permissionService } from './permission-service'
import type { SessionValidationResult } from './session'
import type { PermissionAction, ResourceType } from './permissions'

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
 * Require authentication for a request
 * Returns session data or throws an error response
 */
export async function requireAuth(
  request: Request,
): Promise<SessionValidationResult> {
  const sessionData = await validateRequestSession(request)

  if (!sessionData) {
    throw createAuthErrorResponse(
      ErrorCode.AUTH_REQUIRED,
      'Authentication required',
      401,
    )
  }

  return sessionData
}

/**
 * Require authentication and specific permission for a request
 * Returns session data or throws an error response
 */
export async function requirePermission(
  request: Request,
  resource: ResourceType,
  action: PermissionAction,
): Promise<SessionValidationResult> {
  const sessionData = await requireAuth(request)

  const hasPermission = await permissionService.canUser(
    sessionData.user.id,
    action,
    resource,
  )

  if (!hasPermission) {
    // Log permission denial
    await db.insert(authEvents).values({
      userId: sessionData.user.id,
      eventType: 'permission_denied',
      ipAddress: request.headers.get('x-forwarded-for') || 'unknown',
      metadata: { resource, action },
    })

    throw createAuthErrorResponse(
      ErrorCode.PERMISSION_DENIED,
      `You do not have permission to ${action} ${resource}`,
      403,
    )
  }

  return sessionData
}

/**
 * Check if the authenticated user has a specific role
 */
export async function requireRole(
  request: Request,
  roleName: string,
): Promise<SessionValidationResult> {
  const sessionData = await requireAuth(request)

  const hasRole = await permissionService.hasRole(sessionData.user.id, roleName)

  if (!hasRole) {
    // Log permission denial
    await db.insert(authEvents).values({
      userId: sessionData.user.id,
      eventType: 'permission_denied',
      ipAddress: request.headers.get('x-forwarded-for') || 'unknown',
      metadata: { requiredRole: roleName },
    })

    throw createAuthErrorResponse(
      ErrorCode.ROLE_REQUIRED,
      `This action requires the ${roleName} role`,
      403,
    )
  }

  return sessionData
}
