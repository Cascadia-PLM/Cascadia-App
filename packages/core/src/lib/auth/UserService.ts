// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import { hashPassword } from './password'
import {
  passwordChangeSchema,
  userCreateSchema,
  userUpdateSchema,
} from './types'
import { permissionService } from './permission-service'
import type { SQL } from 'drizzle-orm'
import type { UserWithRoles } from './types'
import type { z } from 'zod'
import type { TransactionClient } from '@/lib/db'
import { db, withTx } from '@/lib/db'
import { authEvents, roles, userRoles, users } from '@/lib/db/schema/users'
import { likeContains } from '@/lib/db/like-pattern'
import { takeFirst } from '@/lib/db/take-first'
import {
  AlreadyExistsError,
  ConflictError,
  InvalidCredentialsError,
  NotFoundError,
  ValidationError,
} from '@/lib/errors'

type DatabaseUser = typeof users.$inferSelect

// The user shape that may leave the service/API boundary. Authentication
// secrets and lockout counters are deliberately impossible to return here.
export type User = Omit<DatabaseUser, 'passwordHash' | 'failedLoginAttempts'>
type SafeUserWithRoles = User & Pick<UserWithRoles, 'roles'>

const ADMINISTRATOR_ROLE_NAME = 'Administrator'

interface LockedAdministrationState {
  target: { id: string; active: boolean }
  administratorRoleId: string | null
  targetIsAdministrator: boolean
  administratorCount: number
  activeAdministratorCount: number
}

/**
 * Serialize every operation that can change Administrator availability on the
 * shared Administrator role row. Without the common lock, two concurrent
 * requests could both observe two admins and remove one each.
 */
async function lockAdministrationState(
  tx: TransactionClient,
  targetUserId: string,
): Promise<LockedAdministrationState> {
  const [administratorRole] = await tx
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.name, ADMINISTRATOR_ROLE_NAME))
    .limit(1)
    .for('update')

  const [target] = await tx
    .select({ id: users.id, active: users.active })
    .from(users)
    .where(eq(users.id, targetUserId))
    .limit(1)
    .for('update')

  if (!target) throw new NotFoundError('User', targetUserId)
  if (!administratorRole) {
    return {
      target,
      administratorRoleId: null,
      targetIsAdministrator: false,
      administratorCount: 0,
      activeAdministratorCount: 0,
    }
  }

  const [targetMembership] = await tx
    .select({ userId: userRoles.userId })
    .from(userRoles)
    .where(
      and(
        eq(userRoles.userId, targetUserId),
        eq(userRoles.roleId, administratorRole.id),
      ),
    )
    .limit(1)

  const administrators = await tx
    .select({ id: users.id, active: users.active })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .where(eq(userRoles.roleId, administratorRole.id))

  return {
    target,
    administratorRoleId: administratorRole.id,
    targetIsAdministrator: Boolean(targetMembership),
    administratorCount: administrators.length,
    activeAdministratorCount: administrators.filter((user) => user.active)
      .length,
  }
}

function assertAccountAccessCanBeRemoved(
  actorUserId: string,
  state: LockedAdministrationState,
  action: 'delete' | 'deactivate',
): void {
  if (state.target.id === actorUserId) {
    throw new ConflictError(`You cannot ${action} your own account`)
  }
  if (
    action === 'delete' &&
    state.targetIsAdministrator &&
    state.administratorCount <= 1
  ) {
    throw new ConflictError('Cannot delete the last Administrator account')
  }
  if (
    state.target.active &&
    state.targetIsAdministrator &&
    state.activeAdministratorCount <= 1
  ) {
    throw new ConflictError(
      `Cannot ${action} the last active Administrator account`,
    )
  }
}

function toSafeUser(user: DatabaseUser): User {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    provider: user.provider,
    providerId: user.providerId,
    active: user.active,
    lockedUntil: user.lockedUntil,
    lastLogin: user.lastLogin,
    createdAt: user.createdAt,
  }
}

function hasPostgresErrorCode(error: unknown, code: string): boolean {
  const seen = new Set<unknown>()
  let current: unknown = error

  while (
    typeof current === 'object' &&
    current !== null &&
    !seen.has(current)
  ) {
    seen.add(current)
    if (
      'code' in current &&
      typeof current.code === 'string' &&
      current.code === code
    ) {
      return true
    }
    current = 'cause' in current ? current.cause : undefined
  }

  return false
}

// Re-export for backward compatibility
export { userCreateSchema, userUpdateSchema, passwordChangeSchema }
export type { UserWithRoles }

/**
 * Service class for managing users
 */
export class UserService {
  /**
   * Create a new user
   */
  static async createUser(
    data: z.infer<typeof userCreateSchema>,
    _createdBy: string,
  ): Promise<User> {
    // Validate input
    const validated = userCreateSchema.parse(data)

    // Hash password
    const passwordHash = await hashPassword(validated.password)

    return db.transaction(async (tx) => {
      const existing = await tx.query.users.findFirst({
        where: eq(users.email, validated.email),
      })
      if (existing) {
        throw new AlreadyExistsError('email', validated.email)
      }

      const [defaultRole] = await tx
        .select({ id: roles.id })
        .from(roles)
        .where(eq(roles.name, 'User'))
        .limit(1)
      if (!defaultRole) throw new NotFoundError('Role', 'User')

      const user = takeFirst(
        await tx
          .insert(users)
          .values({
            email: validated.email,
            name: validated.name,
            passwordHash,
            provider: validated.provider,
            providerId: validated.providerId,
            active: validated.active,
          })
          .returning(),
      )

      // Idempotent under the composite PK: a repeat assignment is a no-op,
      // never a 500.
      await tx
        .insert(userRoles)
        .values({
          userId: user.id,
          roleId: defaultRole.id,
        })
        .onConflictDoNothing()

      return toSafeUser(user)
    })
  }

  /**
   * Update an existing user
   */
  static async updateUser(
    id: string,
    data: z.infer<typeof userUpdateSchema>,
    _modifiedBy: string,
  ): Promise<User> {
    // Validate input
    const validated = userUpdateSchema.parse(data)

    // Check if user exists
    const existing = await db.query.users.findFirst({
      where: eq(users.id, id),
    })

    if (!existing) {
      throw new NotFoundError('User', id)
    }

    // If email is being changed, check for duplicates
    if (validated.email && validated.email !== existing.email) {
      const duplicate = await db.query.users.findFirst({
        where: eq(users.email, validated.email),
      })

      if (duplicate) {
        throw new AlreadyExistsError('email', validated.email)
      }
    }

    // Update user
    const [updated] = await db
      .update(users)
      .set(validated)
      .where(eq(users.id, id))
      .returning()

    if (!updated) {
      throw new NotFoundError('User', id)
    }

    return toSafeUser(updated)
  }

  /**
   * Delete a user
   */
  static async deleteUser(
    id: string,
    actorUserId: string,
  ): Promise<'deleted' | 'deactivated'> {
    try {
      await db.transaction(async (tx) => {
        const state = await lockAdministrationState(tx, id)
        assertAccountAccessCanBeRemoved(actorUserId, state, 'delete')

        // Authentication history alone must not make an otherwise unused
        // account permanent. Account-owned rows with ON DELETE CASCADE are
        // removed by PostgreSQL; protected business history intentionally is
        // not and will raise a foreign-key violation below.
        await tx.delete(authEvents).where(eq(authEvents.userId, id))
        await tx.delete(users).where(eq(users.id, id))
      })

      permissionService.clearUserCache(id)
      return 'deleted'
    } catch (error) {
      if (!hasPostgresErrorCode(error, '23503')) {
        throw error
      }

      // The failed transaction (including auth-event deletion) has rolled
      // back. Preserve the user referenced by business records, but revoke
      // access immediately.
      await this.toggleActive(id, false, actorUserId)
      permissionService.clearUserCache(id)
      return 'deactivated'
    }
  }

  /**
   * Get user by ID with roles
   */
  static async getUserById(id: string): Promise<SafeUserWithRoles | null> {
    const user = await db.query.users.findFirst({
      where: eq(users.id, id),
      with: {
        userRoles: {
          with: {
            role: true,
          },
        },
      },
    })

    if (!user) {
      return null
    }

    return {
      ...toSafeUser(user),
      roles: user.userRoles.map((ur) => ur.role),
    }
  }

  /**
   * List all users with optional filtering (database-level)
   */
  static async listUsers(filters?: {
    search?: string
    active?: boolean
    roleId?: string
  }): Promise<Array<SafeUserWithRoles>> {
    const conditions: Array<SQL<unknown>> = []

    if (filters?.search) {
      const term = likeContains(filters.search)
      conditions.push(
        or(ilike(users.email, term), ilike(users.name, term)) as SQL<unknown>,
      )
    }

    if (filters?.active !== undefined) {
      conditions.push(eq(users.active, filters.active))
    }

    if (filters?.roleId) {
      conditions.push(
        sql`${users.id} IN (SELECT user_id FROM user_roles WHERE role_id = ${filters.roleId})`,
      )
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined

    const result = await db.query.users.findMany({
      where: whereClause,
      with: {
        userRoles: {
          with: {
            role: true,
          },
        },
      },
      orderBy: (usersTable, { asc }) => [asc(usersTable.name)],
    })

    return result.map((user) => ({
      ...toSafeUser(user),
      roles: user.userRoles.map((ur) => ur.role),
    }))
  }

  /**
   * Assign roles to a user (replaces existing roles)
   */
  static async assignRoles(
    userId: string,
    roleIds: Array<string>,
    actorUserId: string,
  ): Promise<void> {
    const uniqueRoleIds = [...new Set(roleIds)]

    await db.transaction(async (tx) => {
      const state = await lockAdministrationState(tx, userId)
      const existingRoles =
        uniqueRoleIds.length > 0
          ? await tx.query.roles.findMany({
              where: inArray(roles.id, uniqueRoleIds),
            })
          : []

      if (existingRoles.length !== uniqueRoleIds.length) {
        throw new NotFoundError('Role', 'specified roles')
      }

      const keepsAdministrator = state.administratorRoleId
        ? uniqueRoleIds.includes(state.administratorRoleId)
        : false
      if (
        state.target.id === actorUserId &&
        state.targetIsAdministrator !== keepsAdministrator
      ) {
        throw new ConflictError(
          'You cannot change your own Administrator role assignment',
        )
      }
      if (
        state.targetIsAdministrator &&
        !keepsAdministrator &&
        (state.administratorCount <= 1 ||
          (state.target.active && state.activeAdministratorCount <= 1))
      ) {
        throw new ConflictError(
          'Cannot remove the last Administrator role assignment or leave no active Administrator',
        )
      }

      await tx.delete(userRoles).where(eq(userRoles.userId, userId))
      if (uniqueRoleIds.length > 0) {
        // onConflictDoNothing: under the composite PK a concurrent assignment
        // of the same pair is a no-op, never a 500.
        await tx
          .insert(userRoles)
          .values(uniqueRoleIds.map((roleId) => ({ userId, roleId })))
          .onConflictDoNothing()
      }
    })

    // Clear permission cache for this user
    permissionService.clearUserCache(userId)
  }

  /**
   * Change user password.
   * Requires current password verification and invalidates all other sessions.
   */
  static async changePassword(
    userId: string,
    newPassword: string,
    currentPassword: string,
    currentSessionId?: string,
    tx?: TransactionClient,
  ): Promise<void> {
    // Validate new password
    const validated = passwordChangeSchema.parse({ password: newPassword })

    await withTx(tx, async (run) => {
      const user = await run.query.users.findFirst({
        where: eq(users.id, userId),
      })

      if (!user) {
        throw new NotFoundError('User', userId)
      }

      if (!user.passwordHash) {
        throw new ValidationError('User has no password set')
      }
      const { verifyPassword } = await import('./password')
      const isValid = await verifyPassword(user.passwordHash, currentPassword)
      if (!isValid) {
        throw new InvalidCredentialsError()
      }

      const passwordHash = await hashPassword(validated.password)

      await run
        .update(users)
        .set({ passwordHash, failedLoginAttempts: 0, lockedUntil: null })
        .where(eq(users.id, userId))

      const { SessionManager } = await import('./session')
      if (currentSessionId) {
        await SessionManager.deleteOtherSessions(userId, currentSessionId, run)
      } else {
        await SessionManager.deleteUserSessions(userId, run)
      }
    })
  }

  /**
   * Admin-initiated password reset.
   * Skips current password verification. Invalidates ALL user sessions.
   */
  static async adminResetPassword(
    userId: string,
    newPassword: string,
    tx?: TransactionClient,
  ): Promise<void> {
    const validated = passwordChangeSchema.parse({ password: newPassword })

    await withTx(tx, async (run) => {
      const user = await run.query.users.findFirst({
        where: eq(users.id, userId),
      })

      if (!user) {
        throw new NotFoundError('User', userId)
      }

      const passwordHash = await hashPassword(validated.password)

      await run
        .update(users)
        .set({ passwordHash, failedLoginAttempts: 0, lockedUntil: null })
        .where(eq(users.id, userId))

      const { SessionManager } = await import('./session')
      await SessionManager.deleteUserSessions(userId, run)
    })
  }

  /**
   * Toggle user active status.
   * When deactivating, immediately revokes all sessions for the user.
   */
  static async toggleActive(
    userId: string,
    active: boolean,
    actorUserId: string,
  ): Promise<User> {
    return db.transaction(async (tx) => {
      const state = await lockAdministrationState(tx, userId)
      if (!active && state.target.active) {
        assertAccountAccessCanBeRemoved(actorUserId, state, 'deactivate')
      }

      const [updated] = await tx
        .update(users)
        .set({ active })
        .where(eq(users.id, userId))
        .returning()

      if (!updated) {
        throw new NotFoundError('User', userId)
      }

      if (!active) {
        const { SessionManager } = await import('./session')
        await SessionManager.deleteUserSessions(userId, tx)
      }

      return toSafeUser(updated)
    })
  }

  /**
   * Get user statistics
   */
  static async getStats(): Promise<{
    total: number
    active: number
    inactive: number
    byProvider: Record<string, number>
  }> {
    const allUsers = await db.query.users.findMany()

    const stats = {
      total: allUsers.length,
      active: allUsers.filter((u) => u.active).length,
      inactive: allUsers.filter((u) => !u.active).length,
      byProvider: {} as Record<string, number>,
    }

    // Count by provider
    for (const user of allUsers) {
      const provider = user.provider || 'local'
      stats.byProvider[provider] = (stats.byProvider[provider] || 0) + 1
    }

    return stats
  }
}
