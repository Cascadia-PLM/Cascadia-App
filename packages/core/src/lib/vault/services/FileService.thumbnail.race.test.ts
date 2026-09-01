// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Thumbnail designation under real concurrency
 *
 * `setItemThumbnail` cleared every existing designation on the item and then
 * set the new one, as two separate statements outside any transaction. Two
 * people pressing "use this image" at once therefore both cleared (finding
 * nothing) and both set, and the item ended up with two flagged files — a
 * state the reader does not model, so which picture the item showed came down
 * to row order. There was also a window, however brief, in which the item had
 * no thumbnail at all.
 *
 * The pair is now one transaction, `uq_vault_files_item_thumbnail` makes the
 * overlap impossible rather than merely unlikely, and the loser retries: it
 * re-reads, clears the winner's flag, and takes the designation. Last caller
 * in wins, which is what pressing the button means.
 *
 * None of that is observable under `TestDatabase`, where both calls queue on
 * one connection inside one transaction. This uses `ConcurrentTestDatabase`,
 * so the two designations really do interleave. No storage is touched:
 * designating a thumbnail is pure database work.
 *
 * Run: npx vitest run packages/core/src/lib/vault/services/FileService.thumbnail.race.test.ts
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { FileService } from './FileService'
import { ConcurrentTestDatabase } from '@/__tests__/helpers/concurrent-db'
import { insertTestDocument } from '@/__tests__/fixtures/items'
import { vaultFiles } from '@/lib/db/schema'
import { takeFirst } from '@/lib/db/take-first'
import { ConflictError } from '@/lib/errors'

describe('FileService.setItemThumbnail — concurrent designations', () => {
  const concurrent = new ConcurrentTestDatabase()

  beforeAll(() => {
    concurrent.setup()
  })

  afterAll(async () => {
    await concurrent.teardown()
  })

  afterEach(async () => {
    await concurrent.cleanup()
  })

  /** One item with two designatable images hanging off it. */
  async function contendedImages(label: string) {
    const { user, designId } = await concurrent.seedScope(label)
    const { item } = await insertTestDocument(concurrent.db, designId, user.id)

    const fileIds: Array<string> = []
    for (const name of ['front.png', 'back.png']) {
      const file = takeFirst(
        await concurrent.db
          .insert(vaultFiles)
          .values({
            itemId: item.id,
            fileName: name,
            originalFileName: name,
            fileSize: 512,
            mimeType: 'image/png',
            fileHash: `thumb-race-${item.id}-${name}`,
            storageType: 'local',
            storagePath: `thumb-race/${item.id}/${name}`,
            uploadedBy: user.id,
          })
          .returning(),
      )
      fileIds.push(file.id)
    }

    return { itemId: item.id, userId: user.id, fileIds }
  }

  async function flaggedFor(itemId: string) {
    return concurrent.db
      .select({ id: vaultFiles.id })
      .from(vaultFiles)
      .where(
        and(
          eq(vaultFiles.itemId, itemId),
          eq(vaultFiles.isItemThumbnail, true),
        ),
      )
  }

  it('leaves exactly one designation when two callers designate at once', async () => {
    const { itemId, userId, fileIds } = await contendedImages('thumbnail-race')

    const outcomes = await Promise.allSettled(
      fileIds.map((fileId) => FileService.setItemThumbnail(fileId, userId)),
    )

    // The invariant. Two flagged rows is the corruption; zero is the window
    // the non-transactional pair also left open.
    const flagged = await flaggedFor(itemId)
    expect(flagged).toHaveLength(1)
    expect(fileIds).toContain(flagged[0]!.id)

    // The retry is what the loser gets, not a 409: with one competing writer
    // the second attempt reads the winner's committed flag and clears it, so
    // both callers see their designation land.
    const rejected = outcomes.filter((o) => o.status === 'rejected')
    for (const loser of rejected) {
      // Should the retry bound ever be exhausted, the answer must still be the
      // class the API models — never a raw driver error.
      expect(loser.reason).toBeInstanceOf(ConflictError)
    }
    expect(rejected).toHaveLength(0)
  })

  it('replaces an existing designation rather than adding to it', async () => {
    const { itemId, userId, fileIds } = await contendedImages('thumbnail-swap')
    const [first, second] = fileIds

    await FileService.setItemThumbnail(first!, userId)
    await FileService.setItemThumbnail(second!, userId)

    const flagged = await flaggedFor(itemId)
    expect(flagged.map((row) => row.id)).toEqual([second])
  })
})
