import { Hono } from 'hono'
import { and, eq, isNull } from 'drizzle-orm'
import { generateState } from 'arctic'
import { adapt } from '../adapter'
import { apiHandler, created } from '@/lib/api/handler'
import { AuthService } from '@/lib/auth/AuthService'
import { SessionManager } from '@/lib/auth/session'
import { permissionService } from '@/lib/auth/permission-service'
import { buildClearSessionCookie, buildSessionCookie } from '@/lib/auth/cookie'
import { getSessionTokenFromRequest } from '@/lib/auth/server'
import { getGitHubProvider } from '@/lib/auth/oauth'
import {
  generateApiKey,
  getKeyPrefix,
  hashApiKey,
} from '@/lib/auth/api-key-utils'
import { AuthenticationError, ValidationError } from '@/lib/errors'
import { db } from '@/lib/db'
import { apiKeys } from '@/lib/db/schema/api-keys'

const app = new Hono()

// POST /api/auth/login
app.post(
  '/login',
  adapt(
    apiHandler({ public: true, rateLimit: 'login' }, async ({ request }) => {
      const { username, password } = await request.json()

      const result = await AuthService.login({
        username,
        password,
        ipAddress: request.headers.get('x-forwarded-for') || 'unknown',
        userAgent: request.headers.get('user-agent') || 'unknown',
      })

      return new Response(
        JSON.stringify({
          data: { success: result.success, user: result.user },
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': buildSessionCookie(result.sessionToken),
          },
        },
      )
    }),
  ),
)

// POST /api/auth/logout
app.post(
  '/logout',
  adapt(
    apiHandler({ public: true }, async ({ request }) => {
      const cookieHeader = request.headers.get('cookie')
      const sessionToken = AuthService.parseSessionFromCookie(cookieHeader)

      if (!sessionToken) {
        throw new AuthenticationError('No session found')
      }

      await AuthService.logout({
        sessionToken,
        ipAddress: request.headers.get('x-forwarded-for') || 'unknown',
      })

      return new Response(JSON.stringify({ data: { success: true } }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': buildClearSessionCookie(),
        },
      })
    }),
  ),
)

// GET /api/auth/session
app.get(
  '/session',
  adapt(
    apiHandler({ public: true }, async ({ request }) => {
      try {
        const sessionToken = getSessionTokenFromRequest(request)
        if (!sessionToken) {
          return { authenticated: false }
        }

        const sessionData = await SessionManager.validateSession(sessionToken)
        if (!sessionData) {
          return { authenticated: false }
        }

        return {
          authenticated: true,
          user: {
            id: sessionData.user.id,
            email: sessionData.user.email,
            name: sessionData.user.name,
          },
        }
      } catch {
        return { authenticated: false }
      }
    }),
  ),
)

// GET /api/auth/permissions
app.get(
  '/permissions',
  adapt(
    apiHandler({}, async ({ user }) => {
      const [userRoles, userPermissions] = await Promise.all([
        permissionService.getUserRoles(user.id),
        permissionService.getUserPermissions(user.id),
      ])

      return {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
        },
        roles: userRoles,
        permissions: userPermissions,
      }
    }),
  ),
)

// GET /api/auth/github
app.get(
  '/github',
  adapt(
    // eslint-disable-next-line @typescript-eslint/require-await -- apiHandler signature requires async
    apiHandler({ public: true }, async () => {
      const github = getGitHubProvider()
      const state = generateState()
      const url = github.createAuthorizationURL(state, ['user:email'])

      return new Response(null, {
        status: 302,
        headers: {
          Location: url.toString(),
          'Set-Cookie': `github_oauth_state=${state}; HttpOnly; Path=/; Max-Age=600; SameSite=Lax`,
        },
      })
    }),
  ),
)

// GET /api/auth/callback/github
app.get(
  '/callback/github',
  adapt(
    apiHandler({ public: true }, async ({ request }) => {
      const url = new URL(request.url, 'http://localhost')
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')

      if (!code || !state) {
        return new Response(null, {
          status: 302,
          headers: { Location: '/login?error=missing_params' },
        })
      }

      // Validate state against cookie
      const cookies = Object.fromEntries(
        (request.headers.get('cookie') || '')
          .split('; ')
          .filter(Boolean)
          .map((c) => {
            const [key, ...v] = c.split('=')
            return [key, v.join('=')]
          }),
      )

      const storedState = cookies['github_oauth_state']
      if (!storedState || storedState !== state) {
        return new Response(null, {
          status: 302,
          headers: { Location: '/login?error=invalid_state' },
        })
      }

      try {
        const github = getGitHubProvider()
        const tokens = await github.validateAuthorizationCode(code)
        const accessToken = tokens.accessToken()

        const [userResponse, emailsResponse] = await Promise.all([
          fetch('https://api.github.com/user', {
            headers: { Authorization: `Bearer ${accessToken}` },
          }),
          fetch('https://api.github.com/user/emails', {
            headers: { Authorization: `Bearer ${accessToken}` },
          }),
        ])

        if (!userResponse.ok) {
          return new Response(null, {
            status: 302,
            headers: { Location: '/login?error=github_api_error' },
          })
        }

        const githubUser = (await userResponse.json()) as {
          id: number
          login: string
          name: string | null
          email: string | null
        }

        let email = githubUser.email
        if (!email && emailsResponse.ok) {
          const emails = (await emailsResponse.json()) as Array<{
            email: string
            primary: boolean
            verified: boolean
          }>
          const primary = emails.find((e) => e.primary && e.verified)
          email =
            primary?.email || emails.find((e) => e.verified)?.email || null
        }

        if (!email) {
          return new Response(null, {
            status: 302,
            headers: {
              Location:
                '/login?error=no_email&message=Your GitHub account must have a verified email address.',
            },
          })
        }

        const result = await AuthService.loginWithOAuth({
          provider: 'github',
          providerId: String(githubUser.id),
          email,
          name: githubUser.name || githubUser.login,
          ipAddress: request.headers.get('x-forwarded-for') || 'unknown',
          userAgent: request.headers.get('user-agent') || 'unknown',
        })

        return new Response(null, {
          status: 302,
          headers: {
            Location: '/',
            'Set-Cookie': [
              buildSessionCookie(result.sessionToken),
              'github_oauth_state=; HttpOnly; Path=/; Max-Age=0',
            ].join(', '),
          },
        })
      } catch (error) {
        console.error('GitHub OAuth error:', error)
        return new Response(null, {
          status: 302,
          headers: { Location: '/login?error=oauth_failed' },
        })
      }
    }),
  ),
)

// ============ API Keys ============

// GET /api/auth/api-keys — List the current user's API keys (masked)
app.get(
  '/api-keys',
  adapt(
    apiHandler({}, async ({ user }) => {
      const keys = await db
        .select({
          id: apiKeys.id,
          name: apiKeys.name,
          keyPrefix: apiKeys.keyPrefix,
          permissions: apiKeys.permissions,
          expiresAt: apiKeys.expiresAt,
          lastUsedAt: apiKeys.lastUsedAt,
          createdAt: apiKeys.createdAt,
        })
        .from(apiKeys)
        .where(and(eq(apiKeys.userId, user.id), isNull(apiKeys.revokedAt)))

      return { apiKeys: keys }
    }),
  ),
)

// POST /api/auth/api-keys — Create a new API key
app.post(
  '/api-keys',
  adapt(
    apiHandler({}, async ({ request, user }) => {
      const body = await request.json()
      const {
        name,
        permissions: scope,
        expiresAt,
      } = body as {
        name?: string
        permissions?: Record<string, Array<string>>
        expiresAt?: string
      }

      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        throw new ValidationError('API key name is required')
      }

      if (name.length > 255) {
        throw new ValidationError(
          'API key name must be 255 characters or fewer',
        )
      }

      // Generate the key
      const rawKey = generateApiKey()
      const keyHash = hashApiKey(rawKey)
      const keyPrefix = getKeyPrefix(rawKey)

      const [createdKey] = await db
        .insert(apiKeys)
        .values({
          userId: user.id,
          name: name.trim(),
          keyHash,
          keyPrefix,
          permissions: scope ?? null,
          expiresAt: expiresAt ? new Date(expiresAt) : null,
        })
        .returning({
          id: apiKeys.id,
          name: apiKeys.name,
          keyPrefix: apiKeys.keyPrefix,
          permissions: apiKeys.permissions,
          expiresAt: apiKeys.expiresAt,
          createdAt: apiKeys.createdAt,
        })

      // Return the raw key ONCE — it cannot be retrieved again
      return new Response(
        JSON.stringify({
          data: {
            ...createdKey,
            key: rawKey,
          },
        }),
        {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    }),
  ),
)

// DELETE /api/auth/api-keys/:keyId — Revoke an API key
app.delete(
  '/api-keys/:keyId',
  adapt(
    apiHandler({}, async ({ params, user }) => {
      const { keyId } = params

      // Only allow revoking own keys
      const [key] = await db
        .select({ id: apiKeys.id, userId: apiKeys.userId })
        .from(apiKeys)
        .where(
          and(
            eq(apiKeys.id, keyId),
            eq(apiKeys.userId, user.id),
            isNull(apiKeys.revokedAt),
          ),
        )
        .limit(1)

      if (!key) {
        throw new ValidationError('API key not found or already revoked')
      }

      await db
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(eq(apiKeys.id, keyId))

      return { success: true, revokedKeyId: keyId }
    }),
  ),
)

export default app
