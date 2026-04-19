/**
 * Auth Testing Utilities
 *
 * Provides utilities for mocking authentication in tests:
 * - Mock session creation
 * - Mock request creation with auth cookies
 * - Permission mocking
 *
 * @example
 * ```typescript
 * import { createMockRequest, createMockSession, mockAuth } from '@test/helpers/auth'
 *
 * // Create a mock authenticated request
 * const request = createMockRequest('/api/parts', {
 *   user: testUser,
 *   permissions: { parts: ['read', 'create'] }
 * })
 *
 * // Or use mockAuth for simple cases
 * const { request, session } = mockAuth(testUser)
 * ```
 */

import { vi } from 'vitest'
import type { TestUser } from '../fixtures/users'
import type {
  PermissionAction,
  ResourceType,
  RoleName,
} from '@/lib/auth/permissions'
import { ROLE_DEFINITIONS, roleToDbFormat } from '@/lib/auth/permissions'

/**
 * Session validation result type (matches SessionManager.validateSession return)
 */
export interface MockSessionValidationResult {
  user: {
    id: string
    email: string
    name: string | null
    active: boolean
  }
  session: {
    id: string
    expiresAt: Date
  }
}

/**
 * Options for creating mock requests
 */
export interface MockRequestOptions {
  method?: string
  body?: unknown
  headers?: Record<string, string>
  sessionToken?: string
}

/**
 * Options for creating mock auth context
 */
export interface MockAuthOptions {
  user: TestUser
  roles?: Array<RoleName>
  permissions?: Record<string, Array<string>>
  sessionId?: string
  sessionExpiresAt?: Date
}

/**
 * Create a mock session validation result
 */
export function createMockSession(
  options: MockAuthOptions,
): MockSessionValidationResult {
  return {
    user: {
      id: options.user.id,
      email: options.user.email,
      name: options.user.name,
      active: options.user.active,
    },
    session: {
      id: options.sessionId ?? crypto.randomUUID().replace(/-/g, ''),
      expiresAt:
        options.sessionExpiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  }
}

/**
 * Create a mock Request object with optional auth
 */
export function createMockRequest(
  url: string,
  options: MockRequestOptions = {},
): Request {
  const { method = 'GET', body, headers = {}, sessionToken } = options

  const requestHeaders = new Headers(headers)

  // Add session cookie if provided
  if (sessionToken) {
    requestHeaders.set('cookie', `session=${sessionToken}`)
  }

  // Add content-type for JSON bodies
  if (body && !requestHeaders.has('content-type')) {
    requestHeaders.set('content-type', 'application/json')
  }

  const requestInit: RequestInit = {
    method,
    headers: requestHeaders,
  }

  if (body && method !== 'GET' && method !== 'HEAD') {
    requestInit.body = JSON.stringify(body)
  }

  // Ensure URL is absolute
  const absoluteUrl = url.startsWith('http')
    ? url
    : `http://localhost:3000${url.startsWith('/') ? url : `/${url}`}`

  return new Request(absoluteUrl, requestInit)
}

/**
 * Create a mock authenticated request
 */
export function createAuthenticatedRequest(
  url: string,
  options: MockRequestOptions & { sessionToken: string },
): Request {
  return createMockRequest(url, options)
}

/**
 * Get permissions for a role
 */
export function getPermissionsForRole(
  roleName: RoleName,
): Record<string, Array<string>> {
  const definition = ROLE_DEFINITIONS[roleName]
  return roleToDbFormat(definition)
}

/**
 * Get combined permissions for multiple roles
 */
export function getPermissionsForRoles(
  roleNames: Array<RoleName>,
): Record<string, Array<string>> {
  const combined: Record<string, Set<string>> = {}

  for (const roleName of roleNames) {
    const rolePerms = getPermissionsForRole(roleName)
    for (const [resource, actions] of Object.entries(rolePerms)) {
      combined[resource] ??= new Set()
      for (const action of actions) {
        combined[resource].add(action)
      }
    }
  }

  const result: Record<string, Array<string>> = {}
  for (const [resource, actions] of Object.entries(combined)) {
    result[resource] = Array.from(actions)
  }

  return result
}

/**
 * Check if permissions include a specific action on a resource
 */
export function hasPermission(
  permissions: Partial<Record<string, Array<string>>>,
  resource: ResourceType,
  action: PermissionAction,
): boolean {
  const resourcePerms = permissions[resource]
  return (
    resourcePerms?.includes(action) ||
    resourcePerms?.includes('manage') ||
    false
  )
}

/**
 * Mock auth module for tests
 *
 * Returns mock functions that can be configured for different test scenarios.
 *
 * @example
 * ```typescript
 * const { mockValidateSession, mockRequireAuth, restore } = setupAuthMocks()
 *
 * mockValidateSession.mockResolvedValue(createMockSession({ user: testUser }))
 *
 * // Run your test...
 *
 * restore() // Clean up
 * ```
 */
export function setupAuthMocks() {
  const mockValidateSession = vi.fn()
  const mockRequireAuth = vi.fn()
  const mockRequirePermission = vi.fn()
  const mockRequireRole = vi.fn()

  // Store original modules for restoration
  const originalMocks: Array<() => void> = []

  return {
    mockValidateSession,
    mockRequireAuth,
    mockRequirePermission,
    mockRequireRole,

    /**
     * Configure mocks for a successful auth scenario
     */
    configureSuccess(options: MockAuthOptions) {
      const session = createMockSession(options)
      mockValidateSession.mockResolvedValue(session)
      mockRequireAuth.mockResolvedValue(session)
      mockRequirePermission.mockResolvedValue(session)
      mockRequireRole.mockResolvedValue(session)
    },

    /**
     * Configure mocks for an unauthenticated scenario
     */
    configureUnauthenticated() {
      const errorResponse = new Response(
        JSON.stringify({
          error: {
            code: 'AUTH_REQUIRED',
            message: 'Authentication required',
          },
        }),
        { status: 401 },
      )

      mockValidateSession.mockResolvedValue(null)
      mockRequireAuth.mockRejectedValue(errorResponse)
      mockRequirePermission.mockRejectedValue(errorResponse)
      mockRequireRole.mockRejectedValue(errorResponse)
    },

    /**
     * Configure mocks for a permission denied scenario
     */
    configurePermissionDenied(options: MockAuthOptions) {
      const session = createMockSession(options)
      const errorResponse = new Response(
        JSON.stringify({
          error: {
            code: 'PERMISSION_DENIED',
            message: 'Permission denied',
          },
        }),
        { status: 403 },
      )

      mockValidateSession.mockResolvedValue(session)
      mockRequireAuth.mockResolvedValue(session)
      mockRequirePermission.mockRejectedValue(errorResponse)
    },

    /**
     * Restore original modules
     */
    restore() {
      for (const restoreFn of originalMocks) {
        restoreFn()
      }
      vi.restoreAllMocks()
    },
  }
}

/**
 * Quick helper to create auth context for a test user
 *
 * @example
 * ```typescript
 * const auth = mockAuth(testUser, ['Administrator'])
 * // auth.session - the mock session
 * // auth.permissions - the user's permissions
 * // auth.hasPermission('parts', 'create') - check permissions
 * ```
 */
export function mockAuth(user: TestUser, roles: Array<RoleName> = ['User']) {
  const permissions = getPermissionsForRoles(roles)
  const session = createMockSession({
    user,
    roles,
    permissions,
  })

  return {
    session,
    permissions,
    roles,
    user,

    /**
     * Check if this mock auth has a specific permission
     */
    hasPermission(resource: ResourceType, action: PermissionAction): boolean {
      return hasPermission(permissions, resource, action)
    },

    /**
     * Create an authenticated request with this user's session
     */
    createRequest(
      url: string,
      options: Omit<MockRequestOptions, 'sessionToken'> = {},
    ): Request {
      return createMockRequest(url, {
        ...options,
        sessionToken: session.session.id,
      })
    },
  }
}

/**
 * Type guard to check if a response is an auth error
 */
export function isAuthError(response: Response): boolean {
  return response.status === 401 || response.status === 403
}

/**
 * Parse auth error from response
 */
export async function parseAuthError(response: Response): Promise<{
  code: string
  message: string
} | null> {
  if (!isAuthError(response)) return null

  try {
    const body = await response.json()
    return body.error ?? null
  } catch {
    return null
  }
}

/**
 * Auth test assertions
 */
export const authAssertions = {
  /**
   * Assert that a response requires authentication
   */
  async requiresAuth(response: Response): Promise<void> {
    if (response.status !== 401) {
      throw new Error(`Expected 401 Unauthorized, got ${response.status}`)
    }
    const error = await parseAuthError(response)
    if (!error || error.code !== 'AUTH_REQUIRED') {
      throw new Error(`Expected AUTH_REQUIRED error, got ${error?.code}`)
    }
  },

  /**
   * Assert that a response was denied due to permissions
   */
  async requiresPermission(response: Response): Promise<void> {
    if (response.status !== 403) {
      throw new Error(`Expected 403 Forbidden, got ${response.status}`)
    }
    const error = await parseAuthError(response)
    if (!error || error.code !== 'PERMISSION_DENIED') {
      throw new Error(`Expected PERMISSION_DENIED error, got ${error?.code}`)
    }
  },

  /**
   * Assert that a response was denied due to missing role
   */
  async requiresRole(response: Response): Promise<void> {
    if (response.status !== 403) {
      throw new Error(`Expected 403 Forbidden, got ${response.status}`)
    }
    const error = await parseAuthError(response)
    if (!error || error.code !== 'ROLE_REQUIRED') {
      throw new Error(`Expected ROLE_REQUIRED error, got ${error?.code}`)
    }
  },
}
