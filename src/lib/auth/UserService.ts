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
import { db } from '@/lib/db'
import { roles, userRoles, users } from '@/lib/db/schema/users'
import {
  AlreadyExistsError,
  InvalidCredentialsError,
  NotFoundError,
  ValidationError,
} from '@/lib/errors'
// User type inferred from the users table schema
export type User = typeof users.$inferSelect

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
    const [user] = await db
      .insert(users)
      .values({
        email: validated.email,
        name: validated.name,
        passwordHash,
        provider: validated.provider,
        providerId: validated.providerId,
        active: validated.active,
      })
      .returning()

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

    return user
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

    return updated
  }

  /**
   * Delete a user
   */
  static async deleteUser(id: string): Promise<void> {
    // Check if user exists
    const existing = await db.query.users.findFirst({
      where: eq(users.id, id),
    })

    if (!existing) {
      throw new NotFoundError('User', id)
    }

    // Delete user roles first (foreign key constraint)
    await db.delete(userRoles).where(eq(userRoles.userId, id))

    // Delete user
    await db.delete(users).where(eq(users.id, id))
  }

  /**
   * Get user by ID with roles
   */
  static async getUserById(id: string): Promise<UserWithRoles | null> {
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
      ...user,
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
  }): Promise<Array<UserWithRoles>> {
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
      ...user,
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
  ): Promise<void> {
    // Validate new password
    const validated = passwordChangeSchema.parse({ password: newPassword })

    // Check if user exists
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    })

    if (!user) {
      throw new NotFoundError('User', userId)
    }

    // Verify current password
    if (!user.passwordHash) {
      throw new ValidationError('User has no password set')
    }
    const { verifyPassword } = await import('./password')
    const isValid = await verifyPassword(user.passwordHash, currentPassword)
    if (!isValid) {
      throw new InvalidCredentialsError()
    }

    // Hash new password
    const passwordHash = await hashPassword(validated.password)

    // Update password and reset lockout state
    await db
      .update(users)
      .set({ passwordHash, failedLoginAttempts: 0, lockedUntil: null })
      .where(eq(users.id, userId))

    // Invalidate all other sessions
    const { SessionManager } = await import('./session')
    if (currentSessionId) {
      await SessionManager.deleteOtherSessions(userId, currentSessionId)
    } else {
      await SessionManager.deleteUserSessions(userId)
    }
  }

  /**
   * Admin-initiated password reset.
   * Skips current password verification. Invalidates ALL user sessions.
   */
  static async adminResetPassword(
    userId: string,
    newPassword: string,
  ): Promise<void> {
    const validated = passwordChangeSchema.parse({ password: newPassword })

    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    })

    if (!user) {
      throw new NotFoundError('User', userId)
    }

    const passwordHash = await hashPassword(validated.password)

    await db
      .update(users)
      .set({ passwordHash, failedLoginAttempts: 0, lockedUntil: null })
      .where(eq(users.id, userId))

    const { SessionManager } = await import('./session')
    await SessionManager.deleteUserSessions(userId)
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

    // Update active status
    const [updated] = await db
      .update(users)
      .set({ active })
      .where(eq(users.id, userId))
      .returning()

    // Immediately revoke all sessions when deactivating
    if (!active) {
      const { SessionManager } = await import('./session')
      await SessionManager.deleteUserSessions(userId)
    }

    return updated
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
