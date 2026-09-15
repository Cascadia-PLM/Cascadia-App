// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * user_roles membership invariants
 *
 * Security gate. Role membership is access-control data, and the table had
 * no key at all: nothing stopped the same (user, role) pair landing twice.
 * The composite primary key makes membership a set; these tests pin that a
 * repeat assignment stays a quiet no-op (the write paths carry
 * onConflictDoNothing) while an unguarded duplicate insert is now a real
 * violation rather than a silent twin row.
 *
 * Run: npx vitest run packages/core/src/lib/auth/user-roles.test.ts
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
import { insertTestUser } from '@/__tests__/fixtures/users'
import { UserService } from '@/lib/auth/UserService'
import { roles, userRoles } from '@/lib/db/schema/users'
import { UNIQUE_VIOLATION, asPostgresError } from '@/lib/errors/pg'
import { takeFirst } from '@/lib/db/take-first'

describe('user_roles composite primary key', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  /** Role writes name the administrator making them, for the self- and
   *  last-Administrator guards. Membership is what is under test here, so
   *  this is simply somebody other than the subject. */
  let actor: TestUser
  let roleId: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    user = await insertTestUser(testDb.db)
    actor = await insertTestUser(testDb.db)
    // The built-in roles are committed once by global setup.
    roleId = takeFirst(
      await testDb.db.select().from(roles).where(eq(roles.name, 'User')),
    ).id
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  async function membershipRows() {
    return testDb.db
      .select()
      .from(userRoles)
      .where(and(eq(userRoles.userId, user.id), eq(userRoles.roleId, roleId)))
  }

  it('collapses a duplicated role id in one assignment to one row', async () => {
    await UserService.assignRoles(user.id, [roleId, roleId], actor.id)

    expect(await membershipRows()).toHaveLength(1)
  })

  it('leaves exactly one row when the same role is assigned twice', async () => {
    await UserService.assignRoles(user.id, [roleId], actor.id)
    await UserService.assignRoles(user.id, [roleId], actor.id)

    expect(await membershipRows()).toHaveLength(1)
  })

  it('rejects an unguarded duplicate insert at the key', async () => {
    await testDb.db.insert(userRoles).values({ userId: user.id, roleId })

    let caught: unknown
    try {
      // Nested transaction = savepoint, so the violation rolls back to it
      // and the suite's gate transaction survives to assert the row count.
      await testDb.db.transaction(async (tx) => {
        await tx.insert(userRoles).values({ userId: user.id, roleId })
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeDefined()
    expect(asPostgresError(caught)?.code).toBe(UNIQUE_VIOLATION)
    expect(await membershipRows()).toHaveLength(1)
  })
})
