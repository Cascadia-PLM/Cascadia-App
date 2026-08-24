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
import { db, withTx } from '@/lib/db'
import type { TransactionClient } from '@/lib/db'
import { authEvents, roles, userRoles, users } from '@/lib/db/schema/users'
import { takeFirst } from '@/lib/db/take-first'
import {
  AlreadyExistsError,
  InvalidCredentialsError,
  NotFoundError,
  ValidationError,
} from '@/lib/errors'
type DatabaseUser = typeof users.$inferSelect

// The user shape that may leave the service/API boundary. Authentication
// secrets and lockout counters are deliberately impossible to return here.
export type User = Omit<DatabaseUser, 'passwordHash' | 'failedLoginAttempts'>
type SafeUserWithRoles = User & Pick<UserWithRoles, 'roles'>

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

    // Check if email already exists
    const existing = await db.query.users.findFirst({
      where: eq(users.email, validated.email),
    })

    if (existing) {
      throw new AlreadyExistsError('email', validated.email)
    }

    // Hash password
    const passwordHash = await hashPassword(validated.password)

    // Create user
    const user = takeFirst(
      await db
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

    // Assign default "User" role to new users
    const defaultRole = await db.query.roles.findFirst({
      where: eq(roles.name, 'User'),
    })

    if (defaultRole) {
      await db.insert(userRoles).values({
        userId: user.id,
        roleId: defaultRole.id,
      })
    }

    return toSafeUser(user)
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
  static async deleteUser(id: string): Promise<'deleted' | 'deactivated'> {
    try {
      await db.transaction(async (tx) => {
        // Lock the account so no new business reference can be attached between
        // checking its existence and deleting it.
        const [existing] = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, id))
          .limit(1)
          .for('update')

        if (!existing) {
          throw new NotFoundError('User', id)
        }

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
      await this.toggleActive(id, false)
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
      const term = `%${filters.search}%`
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
  ): Promise<void> {
    // Check if user exists
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    })

    if (!user) {
      throw new NotFoundError('User', userId)
    }

    // Verify all roles exist
    const existingRoles = await db.query.roles.findMany({
      where: inArray(roles.id, roleIds),
    })

    if (existingRoles.length !== roleIds.length) {
      throw new NotFoundError('Role', 'specified roles')
    }

    // Delete existing role assignments
    await db.delete(userRoles).where(eq(userRoles.userId, userId))

    // Insert new role assignments
    if (roleIds.length > 0) {
      await db.insert(userRoles).values(
        roleIds.map((roleId) => ({
          userId,
          roleId,
        })),
      )
    }

    // Clear permission cache for this user
    permissionService.clearUserCache(userId)
  }

  /**
   * Remove a specific role from a user
   */
  static async removeRole(userId: string, roleId: string): Promise<void> {
    await db
      .delete(userRoles)
      .where(and(eq(userRoles.userId, userId), eq(userRoles.roleId, roleId)))

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
  static async toggleActive(userId: string, active: boolean): Promise<User> {
    // Check if user exists
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    })

    if (!user) {
      throw new NotFoundError('User', userId)
    }

    return db.transaction(async (tx) => {
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
