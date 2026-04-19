import { eq } from 'drizzle-orm'
import { db } from '../db'
import { roles, userRoles } from '../db/schema/users'
import { hasPermission } from './permissions'
import type { PermissionAction, ResourceType } from './permissions'
import { authLogger } from '@/lib/logging/logger'

/**
 * Permission Service
 *
 * Handles permission checking for users based on their assigned roles.
 * Implements caching for performance.
 */
export class PermissionService {
  private cache = new Map<string, boolean>()
  private readonly CACHE_TTL = 2 * 60 * 1000 // 2 minutes
  private cacheTimestamps = new Map<string, number>()

  /**
   * Check if a user has permission to perform an action on a resource
   */
  async canUser(
    userId: string,
    action: PermissionAction,
    resource: ResourceType,
  ): Promise<boolean> {
    const cacheKey = `${userId}:${resource}:${action}`

    // Check cache
    if (this.cache.has(cacheKey)) {
      const timestamp = this.cacheTimestamps.get(cacheKey)
      if (timestamp && Date.now() - timestamp < this.CACHE_TTL) {
        return this.cache.get(cacheKey)!
      }
    }

    try {
      // Get user's roles and their permissions
      const userRoleRecords = await db
        .select({
          role: roles,
        })
        .from(userRoles)
        .innerJoin(roles, eq(userRoles.roleId, roles.id))
        .where(eq(userRoles.userId, userId))

      if (userRoleRecords.length === 0) {
        // No roles assigned - deny access
        this.setCache(cacheKey, false)
        return false
      }

      // Check if any of the user's roles grant the permission
      for (const record of userRoleRecords) {
        const rolePermissions = record.role.permissions

        if (
          rolePermissions &&
          hasPermission(rolePermissions, resource, action)
        ) {
          this.setCache(cacheKey, true)
          return true
        }
      }

      // No role grants the permission
      this.setCache(cacheKey, false)
      return false
    } catch (error) {
      authLogger.error(
        { err: error, userId, resource, action },
        'Error checking permissions',
      )
      return false
    }
  }

  /**
   * Check if a user has any of the specified permissions
   */
  async canUserAny(
    userId: string,
    checks: Array<{ action: PermissionAction; resource: ResourceType }>,
  ): Promise<boolean> {
    for (const check of checks) {
      if (await this.canUser(userId, check.action, check.resource)) {
        return true
      }
    }
    return false
  }

  /**
   * Check if a user has all of the specified permissions
   */
  async canUserAll(
    userId: string,
    checks: Array<{ action: PermissionAction; resource: ResourceType }>,
  ): Promise<boolean> {
    for (const check of checks) {
      if (!(await this.canUser(userId, check.action, check.resource))) {
        return false
      }
    }
    return true
  }

  /**
   * Get all permissions for a user (for displaying in UI)
   */
  async getUserPermissions(
    userId: string,
  ): Promise<Record<ResourceType, Array<PermissionAction>>> {
    const userRoleRecords = await db
      .select({
        role: roles,
      })
      .from(userRoles)
      .innerJoin(roles, eq(userRoles.roleId, roles.id))
      .where(eq(userRoles.userId, userId))

    const allPermissions: Record<string, Set<PermissionAction>> = {}

    // Aggregate permissions from all roles
    for (const record of userRoleRecords) {
      const rolePermissions = record.role.permissions

      if (rolePermissions) {
        for (const [resource, actions] of Object.entries(rolePermissions)) {
          if (!(resource in allPermissions)) {
            allPermissions[resource] = new Set()
          }

          for (const action of actions) {
            allPermissions[resource].add(action as PermissionAction)
          }
        }
      }
    }

    // Convert Sets to arrays
    const result: Record<string, Array<PermissionAction>> = {}
    for (const [resource, actionsSet] of Object.entries(allPermissions)) {
      result[resource] = Array.from(actionsSet)
    }

    return result as Record<ResourceType, Array<PermissionAction>>
  }

  /**
   * Get all roles for a user
   */
  async getUserRoles(userId: string): Promise<Array<string>> {
    const userRoleRecords = await db
      .select({
        role: roles,
      })
      .from(userRoles)
      .innerJoin(roles, eq(userRoles.roleId, roles.id))
      .where(eq(userRoles.userId, userId))

    return userRoleRecords.map((record) => record.role.name)
  }

  /**
   * Check if user has a specific role
   */
  async hasRole(userId: string, roleName: string): Promise<boolean> {
    const userRoleRecords = await db
      .select({
        role: roles,
      })
      .from(userRoles)
      .innerJoin(roles, eq(userRoles.roleId, roles.id))
      .where(eq(userRoles.userId, userId))

    return userRoleRecords.some((record) => record.role.name === roleName)
  }

  /**
   * Clear cache for a specific user
   */
  clearUserCache(userId: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${userId}:`)) {
        this.cache.delete(key)
        this.cacheTimestamps.delete(key)
      }
    }
  }

  /**
   * Clear entire cache
   */
  clearCache(): void {
    this.cache.clear()
    this.cacheTimestamps.clear()
  }

  private setCache(key: string, value: boolean): void {
    this.cache.set(key, value)
    this.cacheTimestamps.set(key, Date.now())
  }
}

// Export singleton instance
export const permissionService = new PermissionService()
