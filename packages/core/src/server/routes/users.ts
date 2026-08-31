// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { z } from 'zod'
import { tagged } from '../adapter'
import { UserService } from '@/lib/auth/UserService'
import { NotFoundError } from '@/lib/errors'
import { hashSessionToken } from '@/lib/auth/password'
import { AuthService } from '@/lib/auth/AuthService'
import { apiHandler, created } from '@/lib/api/handler'
import { userCreateSchema, userUpdateSchema } from '@/lib/auth/types'
import { resolveClientIp } from '@/lib/api/client-ip'
import { db } from '@/lib/db'
import { authEvents } from '@/lib/db/schema/users'

/**
 * Password bodies.
 *
 * The minimum length is `UserService`'s to enforce — it hashes and stores the
 * value, and a second opinion here would be a second place to change. What
 * these schemas do is make "a password is required" a 400 that names the
 * field, and cap the length so an unbounded string never reaches the hasher.
 */
const MAX_PASSWORD = 512

const changePasswordSchema = z.object({
  password: z.string().min(1, 'Password is required').max(MAX_PASSWORD),
  currentPassword: z
    .string()
    .min(1, 'Current password is required')
    .max(MAX_PASSWORD),
})

const resetPasswordSchema = z.object({
  password: z.string().min(1, 'Password is required').max(MAX_PASSWORD),
})

const assignRolesSchema = z.object({
  roleIds: z.array(z.string().uuid()).max(100),
})

/**
 * Body of PUT /users/:id.
 *
 * Account status is deliberately not part of it. Deactivating has to revoke
 * the account's sessions and is gated on `users:manage`, which this route is
 * not — so it lives at `POST /users/:id/activate` and nowhere else. Naming
 * `active` here is refused rather than stripped, so a caller that tries is
 * told where the operation moved instead of receiving a 200 that did nothing.
 */
const userUpdateBodySchema = userUpdateSchema.extend({
  active: z
    .never({
      error: 'Use POST /users/:id/activate to change account status',
    })
    .optional()
    .describe(
      'Not accepted here. Account status is changed with ' +
        'POST /users/:id/activate, which revokes the sessions of an account ' +
        'it deactivates and is gated on users:manage.',
    ),
})

const adapt = tagged('Users')

const app = new Hono()

// GET /api/users
app.get(
  '/',
  adapt(
    apiHandler({ permission: ['users', 'read'] }, async ({ request }) => {
      const url = new URL(request.url)
      const search = url.searchParams.get('search') || undefined
      const activeParam = url.searchParams.get('active')
      const roleId = url.searchParams.get('roleId') || undefined

      const active =
        activeParam === 'true'
          ? true
          : activeParam === 'false'
            ? false
            : undefined

      const users = await UserService.listUsers({ search, active, roleId })
      const stats = await UserService.getStats()

      return { users, stats }
    }),
  ),
)

// POST /api/users
app.post(
  '/',
  adapt(
    apiHandler(
      { permission: ['users', 'create'], body: userCreateSchema },
      async ({ body, user }) => {
        const newUser = await UserService.createUser(body, user.id)

        return created({ user: newUser })
      },
    ),
  ),
)

// GET /api/users/:id
app.get(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['users', 'read'] },
      async ({ params }) => {
        const { id } = params
        const user = await UserService.getUserById(id)
        if (!user) throw new NotFoundError('User', id)
        return { user }
      },
    ),
  ),
)

// PUT /api/users/:id
app.put(
  '/:id',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof userUpdateBodySchema>>(
      { permission: ['users', 'update'], body: userUpdateBodySchema },
      async ({ params, body, user }) => {
        const updated = await UserService.updateUser(params.id, body, user.id)
        return { user: updated }
      },
    ),
  ),
)

// DELETE /api/users/:id
app.delete(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['users', 'delete'] },
      async ({ params, user }) => {
        const { id } = params
        const outcome = await UserService.deleteUser(id, user.id)
        return { success: true, outcome }
      },
    ),
  ),
)

// POST /api/users/:id/activate
app.post(
  '/:id/activate',
  adapt(
    apiHandler<{ id: string }, { active: boolean }>(
      {
        permission: ['users', 'manage'],
        body: z.object({ active: z.boolean() }),
      },
      async ({ params, body: { active }, user }) => {
        const updated = await UserService.toggleActive(
          params.id,
          active,
          user.id,
        )
        return { user: updated }
      },
    ),
  ),
)

// PUT /api/users/:id/password
app.put(
  '/:id/password',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof changePasswordSchema>>(
      {
        permission: ['users', 'manage'],
        rateLimit: 'login',
        body: changePasswordSchema,
      },
      async ({ params, request, body, user }) => {
        const { id } = params
        const { password, currentPassword } = body

        // Extract current session ID so it can be preserved
        const cookieHeader = request.headers.get('cookie')
        const sessionToken = AuthService.parseSessionFromCookie(cookieHeader)
        const currentSessionId = sessionToken
          ? await hashSessionToken(sessionToken)
          : undefined

        await db.transaction(async (tx) => {
          await UserService.changePassword(
            id,
            password,
            currentPassword,
            currentSessionId,
            tx,
          )

          await tx.insert(authEvents).values({
            userId: id,
            eventType: 'password_changed',
            ipAddress: resolveClientIp(request),
            metadata: {
              actorUserId: user.id,
              method: 'verified_admin_change',
            },
          })
        })

        return { success: true }
      },
    ),
  ),
)

// POST /api/users/:id/reset-password
app.post(
  '/:id/reset-password',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof resetPasswordSchema>>(
      {
        permission: ['users', 'manage'],
        rateLimit: 'login',
        body: resetPasswordSchema,
      },
      async ({ params, request, body: { password }, user }) => {
        const { id } = params

        await db.transaction(async (tx) => {
          await UserService.adminResetPassword(id, password, tx)

          await tx.insert(authEvents).values({
            userId: id,
            eventType: 'password_reset',
            ipAddress: resolveClientIp(request),
            metadata: { actorUserId: user.id },
          })
        })

        return { success: true }
      },
    ),
  ),
)

// GET /api/users/:id/roles
app.get(
  '/:id/roles',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['users', 'read'] },
      async ({ params }) => {
        const { id } = params
        const user = await UserService.getUserById(id)
        if (!user) throw new NotFoundError('User', id)
        return { roles: user.roles }
      },
    ),
  ),
)

// PUT /api/users/:id/roles
app.put(
  '/:id/roles',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof assignRolesSchema>>(
      { permission: ['users', 'manage'], body: assignRolesSchema },
      async ({ params, body: { roleIds }, user }) => {
        await UserService.assignRoles(params.id, roleIds, user.id)
        return { success: true }
      },
    ),
  ),
)

export default app
