// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Driver error inspection — pinned against a real violation
 *
 * `isUniqueViolation` is a claim about someone else's object shape, and
 * getting it wrong fails open: every accessor returns undefined, the
 * narrowing silently answers "not a unique violation", and the caller falls
 * through to whatever it does with an unrecognised error. That is exactly what
 * happened — the fields were read as `table`/`constraint`, which node-postgres
 * sets and postgres.js (this codebase's driver) does not.
 *
 * So this test forces a real 23505 through the real driver rather than
 * asserting against a literal, which would only re-state the assumption.
 *
 * Run: npx vitest run src/lib/errors/pg.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  asPostgresError,
  constraintOf,
  isDatabaseError,
  isUniqueViolation,
  safeErrorMessage,
  tableOf,
} from './pg'
import { NotFoundError } from './index'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { users } from '@/lib/db/schema'

describe('postgres driver error inspection', () => {
  const testDb = new TestDatabase()
  let uniqueViolation: unknown

  beforeAll(async () => {
    await testDb.setup()
    // Everything here happens inside one transaction that is rolled back.
    await testDb.beginTransaction()

    // users.email is unique; inserting the same address twice raises 23505.
    const existing = await insertTestUser(testDb.db)
    try {
      await testDb.db.insert(users).values({
        email: existing.email,
        name: 'Duplicate',
        active: true,
      })
    } catch (error) {
      uniqueViolation = error
    }
  })

  afterAll(async () => {
    await testDb.rollback()
    await testDb.teardown()
  })

  it('finds the driver error behind drizzle wrapper', () => {
    // The wrapper itself carries no code — only the query text and params.
    expect((uniqueViolation as { code?: string }).code).toBeUndefined()

    const pgError = asPostgresError(uniqueViolation)
    expect(pgError?.code).toBe('23505')
  })

  it('reads the table and constraint the driver actually reports', () => {
    const pgError = asPostgresError(uniqueViolation)!
    expect(tableOf(pgError)).toBe('users')
    expect(constraintOf(pgError)).toContain('users')
  })

  it('narrows a unique violation to its table', () => {
    expect(isUniqueViolation(uniqueViolation)).toBe(true)
    expect(isUniqueViolation(uniqueViolation, { table: 'users' })).toBe(true)
    expect(
      isUniqueViolation(uniqueViolation, { table: 'item_relationships' }),
    ).toBe(false)
  })

  it('answers no for anything that is not a driver error', () => {
    expect(isUniqueViolation(new Error('nope'))).toBe(false)
    expect(isUniqueViolation(null)).toBe(false)
    expect(asPostgresError({ cause: { cause: {} } })).toBeNull()
  })

  it('keeps the failed statement out of the message it hands on', () => {
    // What the wrapper actually says, so the redaction has something to hide.
    expect((uniqueViolation as Error).message).toContain('insert into')

    expect(isDatabaseError(uniqueViolation)).toBe(true)
    const message = safeErrorMessage(uniqueViolation, 'Tool execution failed')
    expect(message).toBe('Tool execution failed')
    expect(message).not.toContain('insert into')
  })

  it('leaves an error written to be read alone', () => {
    // Every AppError carries a string `code` of its own, which is exactly what
    // asPostgresError looks for — so the one message a caller can act on is
    // the one most at risk of being mistaken for a driver error and redacted.
    const notFound = new NotFoundError('Part', 'PN-1')
    expect(isDatabaseError(notFound)).toBe(false)
    expect(safeErrorMessage(notFound, 'fallback')).toBe(notFound.message)

    expect(isDatabaseError(new Error('Item not found'))).toBe(false)
    expect(safeErrorMessage(new Error('Item not found'), 'fallback')).toBe(
      'Item not found',
    )
    expect(safeErrorMessage('a thrown string', 'fallback')).toBe('fallback')
  })
})
