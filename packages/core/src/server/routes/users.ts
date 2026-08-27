// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { z } from 'zod'
import { tagged } from '../adapter'
import { UserService } from '@/lib/auth/UserService'
import { NotFoundError, ValidationError } from '@/lib/errors'
import { hashSessionToken } from '@/lib/auth/password'
import { AuthService } from '@/lib/auth/AuthService'
import { apiHandler, created } from '@/lib/api/handler'
import { getClientIp } from '@/lib/api/rate-limit'
import { db } from '@/lib/db'
import { authEvents } from '@/lib/db/schema/users'

const adapt = tagged('Users')

const app = new Hono()
const roleAssignmentSchema = z.object({
  roleIds: z.array(z.string().uuid()),
})

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
      { permission: ['users', 'create'] },
      async ({ request, user }) => {
        const data = await request.json()
        const newUser = await UserService.createUser(data, user.id)

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
    apiHandler<{ id: string }>(
      { permission: ['users', 'update'] },
      async ({ params, request, user }) => {
        const { id } = params
        const data = await request.json()
        if (data && typeof data === 'object' && 'active' in data) {
          throw new ValidationError(
            'Use POST /users/:id/activate to change account status',
          )
        }
        const updated = await UserService.updateUser(id, data, user.id)
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
    apiHandler<{ id: string }>(
      { permission: ['users', 'manage'] },
      async ({ params, request, user }) => {
        const { id } = params
        const { active } = await request.json()
        if (typeof active !== 'boolean') {
          throw new ValidationError('active must be a boolean')
        }
        const updated = await UserService.toggleActive(id, active, user.id)
        return { user: updated }
      },
    ),
  ),
)

// PUT /api/users/:id/password
app.put(
  '/:id/password',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['users', 'manage'], rateLimit: 'login' },
      async ({ params, request, user }) => {
        const { id } = params
        const { password, currentPassword } = await request.json()
        if (!password || typeof password !== 'string') {
          throw new ValidationError('Password is required')
        }
        if (!currentPassword || typeof currentPassword !== 'string') {
          throw new ValidationError('Current password is required')
        }

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
            ipAddress: getClientIp(request),
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
    apiHandler<{ id: string }>(
      { permission: ['users', 'manage'], rateLimit: 'login' },
      async ({ params, request, user }) => {
        const { id } = params
        const { password } = await request.json()
        if (!password || typeof password !== 'string') {
          throw new ValidationError('Password is required')
        }

        await db.transaction(async (tx) => {
          await UserService.adminResetPassword(id, password, tx)

          await tx.insert(authEvents).values({
            userId: id,
            eventType: 'password_reset',
            ipAddress: getClientIp(request),
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
    apiHandler<{ id: string }>(
      { permission: ['users', 'manage'] },
      async ({ params, request, user }) => {
        const { id } = params
        const { roleIds } = roleAssignmentSchema.parse(await request.json())
        await UserService.assignRoles(id, roleIds, user.id)
        return { success: true }
      },
    ),
  ),
)

export default app
