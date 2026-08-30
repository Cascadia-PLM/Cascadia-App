// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * ThreadCacheService.getStats — freshness accounting.
 *
 * A monitoring read clears none of the three gates on its own, and this suite
 * would not exist for the counts alone. It exists because getStats() is also
 * the first step of the recurring maintenance.cache.cleanup job, and because
 * the way it broke is invisible to every other check we run: a JS Date
 * interpolated into a raw sql fragment becomes an untyped bind parameter that
 * postgres-js cannot serialize, so the query throws at the wire. It typechecks,
 * it lints, and it fails on every call — the endpoint 500s and the cache is
 * never swept. Executing the query against a real database is the only thing
 * that catches that shape.
 *
 * Assertions are deltas over a live table rather than absolute counts, so the
 * suite says what it means — this row is valid, that one is expired — without
 * depending on the table being empty when it starts.
 */

import { randomUUID } from 'node:crypto'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import { ThreadCacheService } from './ThreadCacheService'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { takeFirst } from '@/lib/db/take-first'
import { items, threadPathCache } from '@/lib/db/schema'

const HOUR_MS = 60 * 60 * 1000

describe('ThreadCacheService.getStats', () => {
  const testDb = new TestDatabase()
  let user: TestUser

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    user = await insertTestUser(testDb.db)
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  /** A bare item row — the only thing thread_path_cache needs a foreign key to. */
  async function insertItem(): Promise<string> {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    return takeFirst(
      await testDb.db
        .insert(items)
        .values({
          masterId: randomUUID(),
          itemNumber: `CACHE-${suffix}`,
          revision: 'A',
          itemType: 'Part',
          state: 'Draft',
          createdBy: user.id,
          modifiedBy: user.id,
        })
        .returning({ id: items.id }),
    ).id
  }

  async function insertCacheEntry(
    rootItemId: string,
    fields: { expiresAt?: Date | null; invalidatedAt?: Date | null },
  ): Promise<void> {
    await testDb.db.insert(threadPathCache).values({
      rootItemId,
      cacheConfigHash: `hash-${Math.random().toString(36).slice(2, 10)}`,
      threadData: {},
      expiresAt: fields.expiresAt ?? null,
      invalidatedAt: fields.invalidatedAt ?? null,
    })
  }

  it('answers instead of failing at the wire', async () => {
    const stats = await ThreadCacheService.getStats()

    expect(typeof stats.totalEntries).toBe('number')
    expect(typeof stats.validEntries).toBe('number')
    expect(typeof stats.expiredEntries).toBe('number')
    expect(typeof stats.invalidatedEntries).toBe('number')
  })

  it('counts an unexpired entry as valid and a lapsed one as expired', async () => {
    const before = await ThreadCacheService.getStats()
    const itemId = await insertItem()
    const now = Date.now()

    await insertCacheEntry(itemId, { expiresAt: new Date(now + HOUR_MS) })
    await insertCacheEntry(itemId, { expiresAt: null })
    await insertCacheEntry(itemId, { expiresAt: new Date(now - HOUR_MS) })
    await insertCacheEntry(itemId, { invalidatedAt: new Date(now) })

    const after = await ThreadCacheService.getStats()

    expect(after.totalEntries - before.totalEntries).toBe(4)
    // Unexpired and never-expiring both count; invalidated never does.
    expect(after.validEntries - before.validEntries).toBe(2)
    expect(after.expiredEntries - before.expiredEntries).toBe(1)
    expect(after.invalidatedEntries - before.invalidatedEntries).toBe(1)
  })
})
