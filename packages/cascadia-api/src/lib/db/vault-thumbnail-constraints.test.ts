// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * vault_files thumbnail integrity — one designation per item, and a real
 * pointer to the generated thumbnail.
 *
 * Both constraints are new, so both get the cheap both-sided pin the house
 * pattern gives a new constraint; the data-integrity gate is marginal on its
 * own (the worst outcome was a wrong picture) and the race the uniqueness
 * closes is pinned separately in `FileService.thumbnail.race.test.ts`.
 *
 *  - `uq_vault_files_item_thumbnail` makes "at most one per item" — until now
 *    a comment on the column and nothing else — true of the table.
 *  - `thumbnail_file_id` was a bare uuid carrying a comment claiming a raw-SQL
 *    migration had made it a foreign key. No migration in either edition ever
 *    did, and a hard-deleted vault_files row would have left an item
 *    advertising a thumbnail id that resolves to nothing.
 *
 * Run: npx vitest run packages/core/src/lib/db/vault-thumbnail-constraints.test.ts
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
import { eq } from 'drizzle-orm'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { insertTestDocument } from '@/__tests__/fixtures/items'
import { vaultFiles } from '@/lib/db/schema'
import { asPostgresError, constraintOf } from '@/lib/errors/pg'
import { takeFirst } from '@/lib/db/take-first'

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = '23505'
/** Postgres foreign_key_violation. */
const FK_VIOLATION = '23503'

describe('vault_files thumbnail constraints', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let itemId: string
  let otherItemId: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    user = await insertTestUser(testDb.db)
    const { item } = await insertTestDocument(testDb.db, null, user.id)
    itemId = item.id
    const { item: other } = await insertTestDocument(testDb.db, null, user.id)
    otherItemId = other.id
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  function fileRow(overrides: Record<string, unknown> = {}) {
    const hash = randomUUID()
    return {
      itemId,
      fileName: `${hash}.png`,
      originalFileName: 'photo.png',
      fileSize: 1024,
      mimeType: 'image/png',
      fileHash: hash,
      storageType: 'local',
      storagePath: `thumb-pin/${hash}.png`,
      uploadedBy: user.id,
      ...overrides,
    }
  }

  async function insertExpecting(code: string, run: () => Promise<unknown>) {
    let caught: unknown
    try {
      await run()
    } catch (error) {
      caught = error
    }
    expect(caught).toBeDefined()
    const pgError = asPostgresError(caught)
    expect(pgError?.code).toBe(code)
    return pgError!
  }

  it('rejects a second thumbnail designation on one item', async () => {
    await testDb.db
      .insert(vaultFiles)
      .values(fileRow({ isItemThumbnail: true }))

    const pgError = await insertExpecting(UNIQUE_VIOLATION, () =>
      testDb.db.insert(vaultFiles).values(fileRow({ isItemThumbnail: true })),
    )
    expect(constraintOf(pgError)).toBe('uq_vault_files_item_thumbnail')
  })

  it('admits one designation per item, and any number of undesignated files', async () => {
    // The index is partial on purpose: only the flagged rows are constrained,
    // so an item's other files are unaffected by it.
    await testDb.db
      .insert(vaultFiles)
      .values([
        fileRow({ isItemThumbnail: true }),
        fileRow(),
        fileRow(),
        fileRow({ itemId: otherItemId, isItemThumbnail: true }),
      ])

    const rows = await testDb.db
      .select({ id: vaultFiles.id })
      .from(vaultFiles)
      .where(eq(vaultFiles.uploadedBy, user.id))
    expect(rows).toHaveLength(4)
  })

  it('rejects a thumbnail pointer at a file that does not exist', async () => {
    await insertExpecting(FK_VIOLATION, () =>
      testDb.db
        .insert(vaultFiles)
        .values(fileRow({ thumbnailFileId: randomUUID() })),
    )
  })

  it('nulls the pointer when the thumbnail file is hard-deleted', async () => {
    // SET NULL, not RESTRICT: a hard delete of a generated thumbnail must
    // stay possible, and the model it was generated from survives with no
    // thumbnail rather than becoming undeletable.
    const thumbnail = takeFirst(
      await testDb.db.insert(vaultFiles).values(fileRow()).returning(),
    )
    const model = takeFirst(
      await testDb.db
        .insert(vaultFiles)
        .values(fileRow({ thumbnailFileId: thumbnail.id }))
        .returning(),
    )

    await testDb.db.delete(vaultFiles).where(eq(vaultFiles.id, thumbnail.id))

    const after = takeFirst(
      await testDb.db
        .select()
        .from(vaultFiles)
        .where(eq(vaultFiles.id, model.id)),
    )
    expect(after.thumbnailFileId).toBeNull()
  })
})
