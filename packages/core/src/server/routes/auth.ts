// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { generateState } from 'arctic'
import { tagged } from '../adapter'
import type {
  CreateApiKeyInput,
  UpdateApiKeyInput,
} from '@/lib/auth/ApiKeyService'
import { apiHandler } from '@/lib/api/handler'
import { AuthService } from '@/lib/auth/AuthService'
import { SessionManager } from '@/lib/auth/session'
import { AccessControlService } from '@/lib/auth/AccessControlService'
import { permissionService } from '@/lib/auth/permission-service'
import { buildClearSessionCookie, buildSessionCookie } from '@/lib/auth/cookie'
import { getSessionTokenFromRequest } from '@/lib/auth/server'
import { getGitHubProvider } from '@/lib/auth/oauth'
import { SettingKeys } from '@/lib/config/SettingKeys'
import { SettingsService } from '@/lib/config/SettingsService'
import { ApiKeyService } from '@/lib/auth/ApiKeyService'
import { AuthenticationError } from '@/lib/errors'

const adapt = tagged('Auth')

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

        // Surface first-time-setup state alongside the session so the
        // root route can decide whether to redirect to /setup without a
        // second per-navigation fetch. Wrapped so a settings/role-check
        // failure can't break login.
        let setupStatus: {
          completed: boolean
          isGlobalAdmin: boolean
        } = {
          completed: true,
          isGlobalAdmin: false,
        }
        try {
          const [completedRaw, isGlobalAdmin] = await Promise.all([
            SettingsService.getValue(SettingKeys.SETUP_COMPLETED),
            AccessControlService.isGlobalAdmin(sessionData.user.id),
          ])
          setupStatus = {
            completed: completedRaw === 'true',
            isGlobalAdmin,
          }
        } catch {
          // Default to "completed" so a transient failure doesn't lock
          // an admin out into the wizard. The wizard is also reachable
          // manually from the admin index.
        }

        return {
          authenticated: true,
          user: {
            id: sessionData.user.id,
            email: sessionData.user.email,
            name: sessionData.user.name,
          },
          setupStatus,
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
//
// Self-service: every handler is scoped to `user.id`, so a caller can only
// ever see or change their own keys. The admin equivalents live under
// /api/v1/admin/api-keys and differ only in passing a null owner.

// GET /api/auth/api-keys — the caller's keys, plus what they may scope to
app.get(
  '/api-keys',
  adapt(
    apiHandler({}, async ({ user }) => {
      const [keys, scopableRoles] = await Promise.all([
        ApiKeyService.listForUser(user.id),
        // A key can only ever narrow, so the roles a caller may scope to are
        // exactly the roles they hold.
        permissionService.getUserRoles(user.id),
      ])

      return { apiKeys: keys, scopableRoles }
    }),
  ),
)

// POST /api/auth/api-keys — create a key
app.post(
  '/api-keys',
  adapt(
    apiHandler({}, async ({ request, user }) => {
      const body = (await request.json()) as CreateApiKeyInput

      const { key, rawKey } = await ApiKeyService.create(user.id, body)

      // The raw key is returned ONCE — only its hash is stored.
      return new Response(JSON.stringify({ data: { ...key, key: rawKey } }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })
    }),
  ),
)

// PATCH /api/auth/api-keys/:keyId — rename or re-scope
app.patch(
  '/api-keys/:keyId',
  adapt(
    apiHandler<{ keyId: string }>({}, async ({ params, request, user }) => {
      const body = (await request.json()) as UpdateApiKeyInput
      const key = await ApiKeyService.update(params.keyId, user.id, body)
      return { apiKey: key }
    }),
  ),
)

// POST /api/auth/api-keys/:keyId/rotate — new secret, same key
app.post(
  '/api-keys/:keyId/rotate',
  adapt(
    apiHandler<{ keyId: string }>({}, async ({ params, user }) => {
      const { key, rawKey } = await ApiKeyService.rotate(params.keyId, user.id)
      return { apiKey: key, key: rawKey }
    }),
  ),
)

// POST /api/auth/api-keys/:keyId/disable — reversible pause
app.post(
  '/api-keys/:keyId/disable',
  adapt(
    apiHandler<{ keyId: string }>({}, async ({ params, user }) => {
      const key = await ApiKeyService.setDisabled(params.keyId, user.id, true)
      return { apiKey: key }
    }),
  ),
)

// POST /api/auth/api-keys/:keyId/enable — undo a disable
app.post(
  '/api-keys/:keyId/enable',
  adapt(
    apiHandler<{ keyId: string }>({}, async ({ params, user }) => {
      const key = await ApiKeyService.setDisabled(params.keyId, user.id, false)
      return { apiKey: key }
    }),
  ),
)

// GET /api/auth/api-keys/:keyId/activity — recent authentication activity
app.get(
  '/api-keys/:keyId/activity',
  adapt(
    apiHandler<{ keyId: string }>({}, async ({ params, user }) => {
      const events = await ApiKeyService.activity(params.keyId, user.id)
      return { events }
    }),
  ),
)

// DELETE /api/auth/api-keys/:keyId — permanent revocation
app.delete(
  '/api-keys/:keyId',
  adapt(
    apiHandler<{ keyId: string }>({}, async ({ params, user }) => {
      const key = await ApiKeyService.revoke(params.keyId, user.id)
      return { success: true, apiKey: key }
    }),
  ),
)

export default app
