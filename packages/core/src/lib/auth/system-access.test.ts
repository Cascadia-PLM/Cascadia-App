// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * System-section access — security-gate tests
 *
 * The `system` resource is what admits a user to Lifecycles, Users and
 * Administration. It used to be granted as `['read']` to every role, which
 * made it no gate at all; the sidebar offered those pages to a View Only
 * account and the pages 403'd on arrival.
 *
 * These pin the contract in both halves:
 *
 *  - which roles carry System access, straight off the code definitions
 *  - that the runtime path agrees — role definition → roles.permissions JSONB
 *    → PermissionService — so a drifted seed cannot quietly re-open it
 *
 * The runtime half deliberately inserts roles built from `ROLE_DEFINITIONS`
 * under scratch names rather than reusing the seeded rows: the seeded JSONB is
 * whatever `db:sync-roles` last wrote, and the invariant under test belongs to
 * the code.
 *
 * Run: npx vitest run packages/core/src/lib/auth/system-access.test.ts
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
import {
  ROLE_DEFINITIONS,
  canAccessSystem,
  canManageSystem,
  roleToDbFormat,
} from './permissions'
import { permissionService } from './permission-service'
import type { RoleName } from './permissions'
import { TestDatabase } from '@/__tests__/helpers/db'
import {
  assignRoleToUser,
  createCustomTestRole,
  insertTestRole,
  insertTestUser,
} from '@/__tests__/fixtures/users'

/** The only roles the System section is open to. */
const SYSTEM_ROLES: Array<RoleName> = ['Administrator', 'Power User']
/** The only role that may change instance configuration (everything under /admin). */
const ADMIN_ROLES: Array<RoleName> = ['Administrator']

const ALL_ROLES = Object.keys(ROLE_DEFINITIONS) as Array<RoleName>

describe('System-section access', () => {
  describe('role definitions', () => {
    it.each(ALL_ROLES)('%s: System access matches the contract', (roleName) => {
      const permissions = roleToDbFormat(ROLE_DEFINITIONS[roleName])

      expect(canAccessSystem(permissions)).toBe(SYSTEM_ROLES.includes(roleName))
      expect(canManageSystem(permissions)).toBe(ADMIN_ROLES.includes(roleName))
    })

    it('grants System access to no role below Power User', () => {
      const admitted = ALL_ROLES.filter((roleName) =>
        canAccessSystem(roleToDbFormat(ROLE_DEFINITIONS[roleName])),
      )

      expect(admitted).toEqual(SYSTEM_ROLES)
    })

    it('never lets manage outrun access', () => {
      // `hasPermission` treats `manage` as implying every other action, so a
      // role with system:manage and no system:read still reaches the section.
      // Asserted so the two predicates cannot drift into disagreeing.
      for (const roleName of ALL_ROLES) {
        const permissions = roleToDbFormat(ROLE_DEFINITIONS[roleName])
        if (canManageSystem(permissions)) {
          expect(canAccessSystem(permissions)).toBe(true)
        }
      }
    })
  })

  describe('runtime permission checks', () => {
    const testDb = new TestDatabase()

    beforeAll(() => {
      testDb.setup()
    })

    afterAll(async () => {
      await testDb.teardown()
    })

    beforeEach(async () => {
      await testDb.beginTransaction()
      // Users are new each test; the permission cache is process-global.
      permissionService.clearCache()
    })

    afterEach(async () => {
      await testDb.rollback()
    })

    /** A user holding one role, built from that role's code definition. */
    async function userWithRole(roleName: RoleName): Promise<string> {
      const user = await insertTestUser(testDb.db)
      const role = await insertTestRole(
        testDb.db,
        createCustomTestRole(
          `${roleName} (system-access test ${crypto.randomUUID()})`,
          roleToDbFormat(ROLE_DEFINITIONS[roleName]),
        ),
      )
      await assignRoleToUser(testDb.db, user.id, role.id)
      return user.id
    }

    it.each(ALL_ROLES)(
      '%s: PermissionService agrees with the definitions',
      async (roleName) => {
        const userId = await userWithRole(roleName)

        await expect(
          permissionService.canUser(userId, 'read', 'system'),
        ).resolves.toBe(SYSTEM_ROLES.includes(roleName))
        await expect(
          permissionService.canUser(userId, 'manage', 'system'),
        ).resolves.toBe(ADMIN_ROLES.includes(roleName))
      },
    )

    it('denies System access to a user with no roles at all', async () => {
      const user = await insertTestUser(testDb.db)

      await expect(
        permissionService.canUser(user.id, 'read', 'system'),
      ).resolves.toBe(false)
    })

    it('leaves the reads the rest of the app depends on alone', async () => {
      // The System pages were not gated by tightening users:read or
      // workflows:read — approver pickers, program team management and item
      // state resolution all read those, from every role. Tightening them
      // instead of `system` would have broken non-System pages.
      const userId = await userWithRole('User')

      await expect(
        permissionService.canUser(userId, 'read', 'users'),
      ).resolves.toBe(true)
      await expect(
        permissionService.canUser(userId, 'read', 'workflows'),
      ).resolves.toBe(true)
      await expect(
        permissionService.canUser(userId, 'read', 'roles'),
      ).resolves.toBe(true)
    })
  })
})
