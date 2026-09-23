// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Deleting an item while a reference to it is being created
 *
 * Data-integrity gate. `design_cross_references.referenced_item_id` has no
 * foreign key, so the database does not stop a hard delete from stranding a
 * reference; `ItemService.delete` does, by looking for references first. A
 * look is a check-then-write: a reference committed after the delete looked
 * and before it deleted would name nothing once both commit. That is the
 * stranding the look exists to prevent, on a path no single-connection test
 * can reach — the header of `CheckoutService.race.test.ts` says why.
 *
 * Two row locks close it. The delete takes FOR UPDATE on the item before it
 * looks again inside its transaction, and
 * `CrossDesignReferenceService.createReference` takes FOR KEY SHARE on the
 * item it validates. The test holds the reference's transaction open at the
 * worst moment — its row written and its lock taken, but not committed, so
 * invisible to every look — and requires the delete to wait for it and then
 * refuse.
 *
 * Remove either lock and this fails. Without the reference's, nothing makes
 * the delete wait: it looks past the uncommitted row and finishes first.
 * Without the delete's, it waits only at its DELETE, after its look, and then
 * deletes the item the reference has just committed against.
 *
 * Run: npx vitest run cascadia-api/src/items/services/ItemService.delete.race.test.ts
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import type { Part } from '@cascadia/commons/items/types/part'
import { ConcurrentTestDatabase } from '@/__tests__/helpers/concurrent-db'
import { ItemService } from '@/items/services/ItemService'
import { CrossDesignReferenceService } from '@/services/CrossDesignReferenceService'
import { DesignService } from '@/services/DesignService'
import { ValidationError } from '@/errors'
import { designCrossReferences } from '@/db/schema'

// Import to register item types
import '@/items/registerItemTypes.server'

describe('ItemService.delete — a reference created while the delete runs', () => {
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

  /** Resolves once some backend is waiting on a lock that `pid` holds. */
  async function somethingWaitsOn(pid: number): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt++) {
      const [row] = await concurrent.db.execute<{ waiting: number }>(
        sql`select count(*)::int as waiting from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))`,
      )
      if (row && row.waiting > 0) return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error(`Nothing waited on backend ${pid} within five seconds`)
  }

  it('waits for the reference to commit, then refuses and keeps both rows', async () => {
    const { user, programId, designId } =
      await concurrent.seedScope('xref-delete-race')
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    const referencing = await DesignService.create(
      {
        programId,
        name: 'Concurrent referencing design',
        code: `CRX-${unique}`,
        designType: 'Engineering',
      },
      user.id,
    )
    concurrent.trackDesign(referencing.id)

    const part = await ItemService.create<Part>(
      'Part',
      {
        itemType: 'Part',
        designId,
        revision: 'A',
        name: 'Referenced while deleted',
        partType: 'Manufacture',
      },
      user.id,
    )
    const partId = part.id!

    let release: () => void = () => {}
    const released = new Promise<void>((resolve) => {
      release = () => resolve()
    })
    let written: (pid: number) => void = () => {}
    const referenceWritten = new Promise<number>((resolve) => {
      written = resolve
    })

    // The reference's transaction, held at the worst moment: its row written
    // and its lock taken, nothing committed.
    const referencingTx = concurrent.db.transaction(async (tx) => {
      const [backend] = await tx.execute<{ pid: number }>(
        sql`select pg_backend_pid() as pid`,
      )
      if (!backend) throw new Error('pg_backend_pid() returned no row')
      await CrossDesignReferenceService.createReference(
        { referencingDesignId: referencing.id, referencedItemId: partId },
        user.id,
        tx,
      )
      written(backend.pid)
      await released
    })

    try {
      const holder = await Promise.race([
        referenceWritten,
        referencingTx.then(() => {
          throw new Error('The reference transaction ended before writing')
        }),
      ])

      const deleting = ItemService.delete(partId, user.id)
      const finished = Symbol('the delete finished')
      const first = await Promise.race([
        deleting.then(
          () => finished,
          () => finished,
        ),
        somethingWaitsOn(holder),
      ])
      // Finishing while the reference was still uncommitted means the delete
      // looked past it and went ahead.
      expect(first).not.toBe(finished)

      release()
      await referencingTx
      await expect(deleting).rejects.toThrow(ValidationError)
    } finally {
      release()
      await referencingTx.catch(() => {})
    }

    expect(await ItemService.findById(partId)).not.toBeNull()
    const rows = await concurrent.db
      .select()
      .from(designCrossReferences)
      .where(eq(designCrossReferences.referencedItemId, partId))
    expect(rows).toHaveLength(1)
  })
})
