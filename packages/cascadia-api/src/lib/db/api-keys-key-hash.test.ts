// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * api_keys.key_hash uniqueness — the authentication lookup key.
 *
 * Security-adjacent, and deliberately small: this is the cheap both-sided pin
 * the house pattern gives every new constraint, not a suite. `resolveApiKey`
 * identifies a presented secret by this hash and nothing else, and the column
 * carried neither a constraint nor an index — so nothing in the database
 * stopped two rows, with two different owners and two different scopes, from
 * claiming one credential, and which of them authenticated came down to row
 * order.
 *
 * Run: npx vitest run packages/core/src/lib/db/api-keys-key-hash.test.ts
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
import { eq } from 'drizzle-orm'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { apiKeys } from '@/lib/db/schema'
import { asPostgresError, constraintOf } from '@/lib/errors/pg'

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = '23505'

describe('api_keys.key_hash uniqueness', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let unique: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    user = await insertTestUser(testDb.db)
    unique = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  function keyRow(keyHash: string) {
    return {
      userId: user.id,
      name: `Key ${keyHash}`,
      keyHash,
      keyPrefix: 'csk_test',
    }
  }

  it('rejects a second key claiming the same hash', async () => {
    await testDb.db.insert(apiKeys).values(keyRow(`hash-${unique}`))

    let caught: unknown
    try {
      await testDb.db.insert(apiKeys).values(keyRow(`hash-${unique}`))
    } catch (error) {
      caught = error
    }

    const pgError = asPostgresError(caught)
    expect(pgError?.code).toBe(UNIQUE_VIOLATION)
    expect(constraintOf(pgError!)).toBe('uq_api_keys_key_hash')
  })

  it('admits distinct hashes for the same owner', async () => {
    await testDb.db
      .insert(apiKeys)
      .values([keyRow(`hash-a-${unique}`), keyRow(`hash-b-${unique}`)])

    const rows = await testDb.db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(eq(apiKeys.userId, user.id))
    expect(rows).toHaveLength(2)
  })
})
