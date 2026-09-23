// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { decodeIdToken, generateCodeVerifier, generateState } from 'arctic'
import { z } from 'zod'
import { SettingKeys } from '@cascadia/commons/lib/config/SettingKeys'
import { tagged } from '../adapter'
import { apiHandler } from '@/lib/api/handler'
import { AuthService } from '@/lib/auth/AuthService'
import { UserService } from '@/lib/auth/UserService'
import { hashSessionToken } from '@/lib/auth/password'
import { SessionManager } from '@/lib/auth/session'
import { AccessControlService } from '@/lib/auth/AccessControlService'
import { permissionService } from '@/lib/auth/permission-service'
import { buildClearSessionCookie, buildSessionCookie } from '@/lib/auth/cookie'
import { getSessionTokenFromRequest } from '@/lib/auth/server'
import {
  getAllowedGoogleDomains,
  getGitHubProvider,
  getGoogleProvider,
  isGitHubOAuthConfigured,
  isGoogleAccountPermitted,
  isGoogleOAuthConfigured,
} from '@/lib/auth/oauth'
import { SettingsService } from '@/lib/config/SettingsService'
import { ApiKeyService } from '@/lib/auth/ApiKeyService'
import { AuthenticationError } from '@/lib/errors'
import { db } from '@/lib/db'
import { authEvents } from '@/lib/db/schema/users'
import { resolveClientIp } from '@/lib/api/client-ip'

const adapt = tagged('Auth')

/**
 * Credential bodies.
 *
 * These are the API's login and password-change doors, so the schemas do the
 * least that is honest: require the fields, and cap their length so an
 * unbounded string never reaches the hasher or the user lookup. Minimum
 * password length stays with `UserService`, which is what stores it — a second
 * opinion here would be a second place to change.
 *
 * They deliberately do **not** narrow further. A login schema that rejected,
 * say, an over-long username with a distinct 400 would be a way to probe what
 * the server considers well-formed; every rejection here is the same shape.
 */
const MAX_CREDENTIAL = 512

const loginSchema = z.object({
  username: z.string().min(1).max(MAX_CREDENTIAL),
  password: z.string().min(1).max(MAX_CREDENTIAL),
})

const changePasswordSchema = z.object({
  password: z.string().min(1, 'Password is required').max(MAX_CREDENTIAL),
  currentPassword: z
    .string()
    .min(1, 'Current password is required')
    .max(MAX_CREDENTIAL),
})

/** A permission grant map: resource → actions. */
const permissionMapSchema = z.record(
  z.string().max(100),
  z.array(z.string().max(100)).max(100),
)

const createApiKeySchema = z.object({
  name: z.string().min(1).max(200),
  permissions: permissionMapSchema.nullish(),
  roles: z.array(z.string().uuid()).max(100).optional(),
  expiresAt: z.string().datetime().optional(),
})

const updateApiKeySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  permissions: permissionMapSchema.nullish(),
  roles: z.array(z.string().uuid()).max(100).nullish(),
})

const app = new Hono()

/** Parse a request's Cookie header into a plain object. */
function readCookies(request: Request): Record<string, string> {
  return Object.fromEntries(
    (request.headers.get('cookie') || '')
      .split('; ')
      .filter(Boolean)
      .map((c) => {
        const [key, ...v] = c.split('=')
        return [key, v.join('=')]
      }),
  )
}

/**
 * Redirect back to the login page with an error code.
 *
 * The codes are matched against OAUTH_ERROR_MESSAGES in
 * cascadia-web/src/routes/login.tsx, so a new code needs a message there or
 * the page shows a generic fallback.
 */
function loginRedirect(error: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: `/login?error=${error}` },
  })
}

/**
 * OAuth state and PKCE verifier cookies. Short-lived and single-purpose: they
 * exist only between the redirect out to the provider and the callback coming
 * back, and are cleared on the way through.
 */
function buildOAuthCookie(name: string, value: string, maxAge = 600): string {
  const parts = [
    `${name}=${value}`,
    'HttpOnly',
    'Path=/',
    `Max-Age=${maxAge}`,
    // Lax, not Strict: the callback arrives as a cross-site top-level
    // navigation from the provider, and Strict would withhold the cookie.
    'SameSite=Lax',
  ]
  if (process.env.NODE_ENV === 'production') parts.push('Secure')
  return parts.join('; ')
}

// POST /api/auth/login
app.post(
  '/login',
  adapt(
    apiHandler(
      { public: true, rateLimit: 'login', body: loginSchema },
      async ({ request, body: { username, password } }) => {
        const result = await AuthService.login({
          username,
          password,
          ipAddress: resolveClientIp(request),
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
      },
    ),
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
        ipAddress: resolveClientIp(request),
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
          isAdmin: boolean
        } = {
          completed: true,
          isAdmin: false,
        }
        try {
          const [completedRaw, isAdmin] = await Promise.all([
            SettingsService.getValue(SettingKeys.SETUP_COMPLETED),
            AccessControlService.hasCrossProgramAccess(sessionData.user.id),
          ])
          setupStatus = {
            completed: completedRaw === 'true',
            isAdmin,
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

// PUT /api/auth/password — change the signed-in user's local password
app.put(
  '/password',
  adapt(
    apiHandler(
      {
        // Deliberately session-only: an API key must not be able to replace
        // the interactive credentials of its owner. This was a hand-rolled
        // `authorization` header check, which the option now states.
        authMethod: 'session',
        rateLimit: 'login',
        body: changePasswordSchema,
      },
      async ({ request, body, user }) => {
        // Reached only with a session, so a token is present — but it is read
        // again here because the *current* session is the one kept alive when
        // the change revokes the others.
        const sessionToken = getSessionTokenFromRequest(request)
        if (!sessionToken) {
          throw new AuthenticationError('Session authentication required')
        }

        const { password, currentPassword } = body

        const currentSessionId = await hashSessionToken(sessionToken)
        await db.transaction(async (tx) => {
          await UserService.changePassword(
            user.id,
            password,
            currentPassword,
            currentSessionId,
            tx,
          )

          await tx.insert(authEvents).values({
            userId: user.id,
            eventType: 'password_changed',
            ipAddress: resolveClientIp(request),
            metadata: { method: 'self_service' },
          })
        })

        return { success: true }
      },
    ),
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

// GET /api/auth/providers — which OAuth buttons the login page should offer
app.get(
  '/providers',
  adapt(
    apiHandler(
      {
        public: true,
        openapi: {
          summary: 'Which OAuth providers are configured',
          description:
            'Drives which sign-in buttons the login page offers. Fixed at process start from the environment.',
          responses: {
            200: {
              schema: z.object({
                github: z.boolean(),
                google: z.boolean(),
              }),
            },
          },
        },
      },
      // eslint-disable-next-line @typescript-eslint/require-await -- apiHandler signature requires async
      async () => {
        return {
          github: isGitHubOAuthConfigured(),
          google: isGoogleOAuthConfigured(),
        }
      },
    ),
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
      const cookies = readCookies(request)

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
          ipAddress: resolveClientIp(request),
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

// GET /api/auth/google
app.get(
  '/google',
  adapt(
    // eslint-disable-next-line @typescript-eslint/require-await -- apiHandler signature requires async
    apiHandler({ public: true }, async () => {
      const google = getGoogleProvider()
      const state = generateState()
      const codeVerifier = generateCodeVerifier()

      // openid and email are what the id token claims below are read from;
      // profile supplies the display name.
      const url = google.createAuthorizationURL(state, codeVerifier, [
        'openid',
        'email',
        'profile',
      ])

      // A hint to Google's account chooser so people with several accounts
      // signed in land on the right one. Purely cosmetic — it is a request
      // parameter the user can edit, so the callback still verifies `hd`
      // itself and does not trust this having been honoured.
      const [onlyDomain, ...otherDomains] = getAllowedGoogleDomains()
      if (onlyDomain && otherDomains.length === 0) {
        url.searchParams.set('hd', onlyDomain)
      }

      const headers = new Headers({ Location: url.toString() })
      headers.append(
        'Set-Cookie',
        buildOAuthCookie('google_oauth_state', state),
      )
      headers.append(
        'Set-Cookie',
        buildOAuthCookie('google_oauth_verifier', codeVerifier),
      )

      return new Response(null, { status: 302, headers })
    }),
  ),
)

// GET /api/auth/callback/google
app.get(
  '/callback/google',
  adapt(
    apiHandler({ public: true }, async ({ request }) => {
      const url = new URL(request.url, 'http://localhost')
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')

      if (!code || !state) {
        return loginRedirect('missing_params')
      }

      const cookies = readCookies(request)
      const storedState = cookies['google_oauth_state']
      const codeVerifier = cookies['google_oauth_verifier']

      if (!storedState || storedState !== state || !codeVerifier) {
        return loginRedirect('invalid_state')
      }

      try {
        const google = getGoogleProvider()
        const tokens = await google.validateAuthorizationCode(
          code,
          codeVerifier,
        )

        // Decoded, not signature-verified — and that is correct here. This
        // token came straight back from Google's token endpoint over TLS in
        // the exchange above, rather than being presented by the browser, so
        // there is no untrusted party between Google and this line.
        const claims = decodeIdToken(tokens.idToken()) as {
          sub?: string
          email?: string
          email_verified?: boolean
          name?: string
          hd?: string
        }

        if (!claims.sub || !claims.email) {
          return loginRedirect('google_api_error')
        }

        if (claims.email_verified !== true) {
          return loginRedirect('email_unverified')
        }

        // The organisation restriction, when one is configured: the only thing
        // standing between a successful Google sign-in and an auto-provisioned
        // account. Checked before loginWithOAuth so a rejected account is
        // neither created nor linked. The refusal is still recorded, since an
        // operator wants to see who is knocking. See isGoogleAccountPermitted
        // for why `hd` and not the email's domain.
        if (!isGoogleAccountPermitted(claims.hd)) {
          await db.insert(authEvents).values({
            eventType: 'login_failed',
            ipAddress: resolveClientIp(request),
            metadata: {
              username: claims.email,
              provider: 'google',
              reason: 'domain_not_allowed',
              hd: claims.hd ?? null,
            },
          })
          return loginRedirect('wrong_domain')
        }

        const result = await AuthService.loginWithOAuth({
          provider: 'google',
          providerId: claims.sub,
          email: claims.email,
          name: claims.name || null,
          ipAddress: resolveClientIp(request),
          userAgent: request.headers.get('user-agent') || 'unknown',
        })

        const headers = new Headers({ Location: '/' })
        headers.append('Set-Cookie', buildSessionCookie(result.sessionToken))
        headers.append(
          'Set-Cookie',
          buildOAuthCookie('google_oauth_state', '', 0),
        )
        headers.append(
          'Set-Cookie',
          buildOAuthCookie('google_oauth_verifier', '', 0),
        )

        return new Response(null, { status: 302, headers })
      } catch (error) {
        // A deactivated account is a normal outcome worth naming, rather than
        // sending someone to the generic "try again" message forever.
        if (error instanceof AuthenticationError) {
          return loginRedirect('account_inactive')
        }
        console.error('Google OAuth error:', error)
        return loginRedirect('oauth_failed')
      }
    }),
  ),
)

// ============ API Keys ============
//
// Self-service is deliberately session-only: allowing an API key to create or
// re-scope another key would let a narrowed credential recover its owner's full
// permissions. Every handler is also scoped to `user.id`, so a caller can only
// ever see or change their own keys. The admin equivalents live under
// /api/v1/admin/api-keys and require a session too.

// GET /api/auth/api-keys — the caller's keys, plus what they may scope to
app.get(
  '/api-keys',
  adapt(
    apiHandler({ authMethod: 'session' }, async ({ user }) => {
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
    apiHandler(
      { authMethod: 'session', body: createApiKeySchema },
      async ({ body, user }) => {
        const { key, rawKey } = await ApiKeyService.create(user.id, body)

        // The raw key is returned ONCE — only its hash is stored.
        return new Response(JSON.stringify({ data: { ...key, key: rawKey } }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      },
    ),
  ),
)

// PATCH /api/auth/api-keys/:keyId — rename or re-scope
app.patch(
  '/api-keys/:keyId',
  adapt(
    apiHandler<{ keyId: string }, z.infer<typeof updateApiKeySchema>>(
      { authMethod: 'session', body: updateApiKeySchema },
      async ({ params, body, user }) => {
        const key = await ApiKeyService.update(params.keyId, user.id, body)
        return { apiKey: key }
      },
    ),
  ),
)

// POST /api/auth/api-keys/:keyId/rotate — new secret, same key
app.post(
  '/api-keys/:keyId/rotate',
  adapt(
    apiHandler<{ keyId: string }>(
      { authMethod: 'session' },
      async ({ params, user }) => {
        const { key, rawKey } = await ApiKeyService.rotate(
          params.keyId,
          user.id,
        )
        return { apiKey: key, key: rawKey }
      },
    ),
  ),
)

// POST /api/auth/api-keys/:keyId/disable — reversible pause
app.post(
  '/api-keys/:keyId/disable',
  adapt(
    apiHandler<{ keyId: string }>(
      { authMethod: 'session' },
      async ({ params, user }) => {
        const key = await ApiKeyService.setDisabled(params.keyId, user.id, true)
        return { apiKey: key }
      },
    ),
  ),
)

// POST /api/auth/api-keys/:keyId/enable — undo a disable
app.post(
  '/api-keys/:keyId/enable',
  adapt(
    apiHandler<{ keyId: string }>(
      { authMethod: 'session' },
      async ({ params, user }) => {
        const key = await ApiKeyService.setDisabled(
          params.keyId,
          user.id,
          false,
        )
        return { apiKey: key }
      },
    ),
  ),
)

// GET /api/auth/api-keys/:keyId/activity — recent authentication activity
app.get(
  '/api-keys/:keyId/activity',
  adapt(
    apiHandler<{ keyId: string }>(
      { authMethod: 'session' },
      async ({ params, user }) => {
        const events = await ApiKeyService.activity(params.keyId, user.id)
        return { events }
      },
    ),
  ),
)

// DELETE /api/auth/api-keys/:keyId — permanent revocation
app.delete(
  '/api-keys/:keyId',
  adapt(
    apiHandler<{ keyId: string }>(
      { authMethod: 'session' },
      async ({ params, user }) => {
        const key = await ApiKeyService.revoke(params.keyId, user.id)
        return { success: true, apiKey: key }
      },
    ),
  ),
)

export default app
