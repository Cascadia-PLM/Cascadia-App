import { and, eq, gt, isNull } from 'drizzle-orm'
import { db } from '../db'
import { apiKeys } from '../db/schema/api-keys'
import { users } from '../db/schema/users'
import { SessionManager } from './session'
import { getSessionTokenFromRequest } from './server'
import { hashApiKey } from './api-key-utils'
import type { SessionUser } from './session'
import { authLogger } from '@/lib/logging/logger'

export type AuthMethod = 'session' | 'api_key'

export interface ResolvedCredentials {
  user: SessionUser
  authMethod: AuthMethod
  /** API key scope — null means full user permissions */
  scope: Record<string, Array<string>> | null
  /** API key ID for audit logging */
  keyId?: string
}

/**
 * Unified credential resolver.
 *
 * Extracts credentials from a request by checking (in order):
 * 1. Authorization header (Bearer csc_... for API keys)
 * 2. Session cookie
 *
 * Returns null if no valid credentials found.
 */
export async function resolveCredentials(
  request: Request,
): Promise<ResolvedCredentials | null> {
  // 1. Check Authorization header
  const authHeader = request.headers.get('authorization')
  if (authHeader) {
    const resolved = await resolveFromAuthHeader(authHeader)
    if (resolved) return resolved
    // Invalid auth header — don't fall through to cookies.
    // If someone sends an Authorization header, they intend token auth.
    return null
  }

  // 2. Check session cookie
  return resolveFromSession(request)
}

/**
 * Resolve credentials from an Authorization header.
 */
async function resolveFromAuthHeader(
  authHeader: string,
): Promise<ResolvedCredentials | null> {
  if (!authHeader.startsWith('Bearer ')) return null

  const token = authHeader.slice(7)

  // API key path: csc_ prefix
  if (token.startsWith('csc_')) {
    return resolveApiKey(token)
  }

  // Future: other bearer token types (access tokens, etc.)
  return null
}

/**
 * Resolve credentials from an API key.
 */
async function resolveApiKey(
  rawKey: string,
): Promise<ResolvedCredentials | null> {
  try {
    const keyHash = hashApiKey(rawKey)

    const result = await db
      .select({
        key: apiKeys,
        user: {
          id: users.id,
          email: users.email,
          name: users.name,
          active: users.active,
        },
      })
      .from(apiKeys)
      .innerJoin(users, eq(apiKeys.userId, users.id))
      .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)))
      .limit(1)

    if (result.length === 0) return null

    const { key, user } = result[0]

    // Check expiration
    if (key.expiresAt && key.expiresAt < new Date()) return null

    // Check user is active
    if (!user.active) return null

    // Update lastUsedAt (fire-and-forget, don't block the request)
    db.update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, key.id))
      .catch((err) =>
        authLogger.error({ err }, 'Failed to update API key lastUsedAt'),
      )

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        active: user.active,
      },
      authMethod: 'api_key',
      scope: key.permissions,
      keyId: key.id,
    }
  } catch (error) {
    authLogger.error({ err: error }, 'API key resolution error')
    return null
  }
}

/**
 * Resolve credentials from session cookie.
 */
async function resolveFromSession(
  request: Request,
): Promise<ResolvedCredentials | null> {
  const sessionToken = getSessionTokenFromRequest(request)
  if (!sessionToken) return null

  const sessionData = await SessionManager.validateSession(sessionToken)
  if (!sessionData) return null

  return {
    user: sessionData.user,
    authMethod: 'session',
    scope: null,
  }
}
