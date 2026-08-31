// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Administrator availability — the lockout guards
 *
 * Security gate, and a one-way one: every path that can remove administrative
 * access is irreversible from inside the product. An instance whose last
 * Administrator has been deleted, deactivated, or stripped of the role has
 * nobody who can undo any of those, and the only repair is a hand-written
 * database statement.
 *
 * Three verbs reach that state — delete the account, deactivate it, reassign
 * its roles — and each is pinned here, along with the self-inflicted case
 * (an administrator removing their own access, which is the likeliest way to
 * arrive at it by accident).
 *
 * The invariants:
 *
 *  - an actor cannot delete or deactivate their own account
 *  - an actor cannot add or remove the Administrator role on themselves
 *  - the last Administrator account cannot be deleted
 *  - the last *active* Administrator cannot be deactivated
 *  - the last Administrator's role assignment cannot be dropped
 *  - none of the above blocks the same operation while a second active
 *    Administrator exists — the guard bounds the floor, it is not a freeze
 *
 * Run: npx vitest run packages/core/src/lib/auth/administrator-safety.test.ts
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import { and, eq } from 'drizzle-orm'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import {
  insertTestUser,
  insertTestUserWithRole,
} from '@/__tests__/fixtures/users'
import { UserService } from '@/lib/auth/UserService'
import { permissionService } from '@/lib/auth/permission-service'
import { ConflictError } from '@/lib/errors'
import { roles, userRoles, users } from '@/lib/db/schema/users'
import { takeFirst } from '@/lib/db/take-first'

describe('administrator availability guards', () => {
  const testDb = new TestDatabase()

  let admin: TestUser
  let administratorRoleId: string
  let userRoleId: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    permissionService.clearCache()

    admin = (await insertTestUserWithRole(testDb.db, 'Administrator')).user
    administratorRoleId = takeFirst(
      await testDb.db
        .select()
        .from(roles)
        .where(eq(roles.name, 'Administrator')),
    ).id
    userRoleId = takeFirst(
      await testDb.db.select().from(roles).where(eq(roles.name, 'User')),
    ).id
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  /** A second Administrator, so the floor is no longer one. */
  async function secondAdministrator(): Promise<TestUser> {
    return (await insertTestUserWithRole(testDb.db, 'Administrator')).user
  }

  async function isActive(userId: string): Promise<boolean> {
    return takeFirst(
      await testDb.db.select().from(users).where(eq(users.id, userId)),
    ).active
  }

  async function stillExists(userId: string): Promise<boolean> {
    const rows = await testDb.db
      .select()
      .from(users)
      .where(eq(users.id, userId))
    return rows.length > 0
  }

  async function holdsAdministrator(userId: string): Promise<boolean> {
    const rows = await testDb.db
      .select()
      .from(userRoles)
      .where(
        and(
          eq(userRoles.userId, userId),
          eq(userRoles.roleId, administratorRoleId),
        ),
      )
    return rows.length > 0
  }

  describe('acting on your own account', () => {
    it('refuses to delete it', async () => {
      await expect(UserService.deleteUser(admin.id, admin.id)).rejects.toThrow(
        ConflictError,
      )
      expect(await stillExists(admin.id)).toBe(true)
    })

    it('refuses to deactivate it', async () => {
      await expect(
        UserService.toggleActive(admin.id, false, admin.id),
      ).rejects.toThrow(ConflictError)
      expect(await isActive(admin.id)).toBe(true)
    })

    it('refuses to drop your own Administrator role', async () => {
      // A second administrator exists, so only the self-rule is under test.
      await secondAdministrator()

      await expect(
        UserService.assignRoles(admin.id, [userRoleId], admin.id),
      ).rejects.toThrow(ConflictError)
      expect(await holdsAdministrator(admin.id)).toBe(true)
    })

    it('refuses to grant yourself the Administrator role', async () => {
      const plain = await insertTestUser(testDb.db)

      await expect(
        UserService.assignRoles(
          plain.id,
          [administratorRoleId],
          // The actor is the target: a non-administrator promoting themselves.
          plain.id,
        ),
      ).rejects.toThrow(ConflictError)
      expect(await holdsAdministrator(plain.id)).toBe(false)
    })
  })

  describe('the last Administrator', () => {
    it('cannot be deleted', async () => {
      const actor = await insertTestUser(testDb.db)

      await expect(UserService.deleteUser(admin.id, actor.id)).rejects.toThrow(
        ConflictError,
      )
      expect(await stillExists(admin.id)).toBe(true)
    })

    it('cannot be deactivated', async () => {
      const actor = await insertTestUser(testDb.db)

      await expect(
        UserService.toggleActive(admin.id, false, actor.id),
      ).rejects.toThrow(ConflictError)
      expect(await isActive(admin.id)).toBe(true)
    })

    it('cannot have the Administrator role reassigned away', async () => {
      const actor = await insertTestUser(testDb.db)

      await expect(
        UserService.assignRoles(admin.id, [userRoleId], actor.id),
      ).rejects.toThrow(ConflictError)
      expect(await holdsAdministrator(admin.id)).toBe(true)
    })

    it('counts only *active* administrators as the floor', async () => {
      // A second administrator who cannot log in is not cover for removing
      // the one who can.
      const dormant = await secondAdministrator()
      const actor = await insertTestUser(testDb.db)
      await UserService.toggleActive(dormant.id, false, actor.id)

      await expect(
        UserService.toggleActive(admin.id, false, actor.id),
      ).rejects.toThrow(ConflictError)
      expect(await isActive(admin.id)).toBe(true)
    })
  })

  describe('with a second active Administrator', () => {
    it('allows deletion', async () => {
      const other = await secondAdministrator()

      await UserService.deleteUser(admin.id, other.id)

      expect(await stillExists(admin.id)).toBe(false)
    })

    it('allows deactivation', async () => {
      const other = await secondAdministrator()

      await UserService.toggleActive(admin.id, false, other.id)

      expect(await isActive(admin.id)).toBe(false)
    })

    it('allows the role to be reassigned away', async () => {
      const other = await secondAdministrator()

      await UserService.assignRoles(admin.id, [userRoleId], other.id)

      expect(await holdsAdministrator(admin.id)).toBe(false)
    })
  })
})
