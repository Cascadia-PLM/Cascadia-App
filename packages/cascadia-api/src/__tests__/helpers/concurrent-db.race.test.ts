// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * ConcurrentTestDatabase — the harness proving itself
 *
 * The point of this harness is that two things happen at once on two real
 * connections. If that were ever untrue the race tests built on it would keep
 * passing while proving nothing, which is the failure mode it exists to end —
 * so it is asserted here rather than assumed.
 *
 * Three properties:
 *
 *  - two statements really do overlap (a serialized pool would take twice as
 *    long, and this is the difference between testing a race and testing a
 *    queue)
 *  - one connection's uncommitted write is invisible to another, which is
 *    what makes a check-then-write race reproducible at all
 *  - everything the harness creates, it removes — it commits for real against
 *    a database shared with every other suite
 *
 * Named `.race.test.ts` by the convention the harness header describes: these
 * files must not share a process with a gate-transaction suite.
 *
 * Run: npx vitest run packages/core/src/__tests__/helpers/concurrent-db.race.test.ts
 */

import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { ConcurrentTestDatabase } from './concurrent-db'
import type { Part } from '@/lib/items/types/part'
import { ItemService } from '@/lib/items/services/ItemService'
import { designs, items, programs, users } from '@/lib/db/schema'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

describe('ConcurrentTestDatabase', () => {
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

  it('runs two statements at the same time, not one after the other', async () => {
    const sleep = () => concurrent.db.execute(sql`SELECT pg_sleep(0.2)`)

    // Measured against itself rather than against a fixed number of
    // milliseconds. A wall-clock threshold is a promise about the machine:
    // this suite runs its files in parallel, so under load two 200ms sleeps
    // can overlap perfectly and still take longer than any constant you pick.
    // A serial baseline taken here inflates with the load the concurrent run
    // sees, so the ratio stays honest either way.
    const serialStart = Date.now()
    await sleep()
    await sleep()
    const serial = Date.now() - serialStart

    const parallelStart = Date.now()
    await Promise.all([sleep(), sleep()])
    const parallel = Date.now() - parallelStart

    // Perfectly overlapped is half. Two thirds leaves room for scheduling
    // without leaving room for "not overlapped at all".
    expect(parallel).toBeLessThan(serial * 0.75)
  })

  it('hides one connection uncommitted write from another', async () => {
    const { user, designId } = await concurrent.seedScope('visibility')

    // Hold a transaction open on one connection with an uncommitted insert,
    // and read from another while it is open. Under TestDatabase both of these
    // would be the same connection and the read would see the row.
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })

    let writtenId = ''
    const writer = concurrent.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(items)
        .values({
          // masterId is NOT NULL with no default — a lineage id is assigned by
          // ItemService.create, and this insert deliberately bypasses it.
          masterId: randomUUID(),
          itemNumber: `RACE-${Date.now()}`,
          revision: 'A',
          itemType: 'Part',
          name: 'Uncommitted',
          state: 'Draft',
          designId,
          createdBy: user.id,
          modifiedBy: user.id,
        })
        .returning()
      writtenId = row!.id
      await held
    })

    // Give the insert a moment to land inside the open transaction.
    await new Promise((resolve) => setTimeout(resolve, 100))

    const seenWhileOpen = await concurrent.db
      .select({ id: items.id })
      .from(items)
      .where(eq(items.name, 'Uncommitted'))

    release()
    await writer

    const seenAfterCommit = await concurrent.db
      .select({ id: items.id })
      .from(items)
      .where(eq(items.name, 'Uncommitted'))

    expect(seenWhileOpen).toEqual([])
    expect(seenAfterCommit.map((r) => r.id)).toEqual([writtenId])

    // Committed for real, so it is this suite's to remove.
    await concurrent.db.delete(items).where(eq(items.id, writtenId))
  })

  it('lets two services run against genuinely separate connections', async () => {
    const { user, designId } = await concurrent.seedScope('parallel-create')

    // Through the service layer rather than raw SQL: the harness is only
    // useful if `setTestDb` reaches the code under test, and item creation
    // also exercises `autonomousDb`'s number allocation, which needs a
    // connection of its own.
    const [first, second] = await Promise.all([
      ItemService.create<Part>(
        'Part',
        {
          itemType: 'Part',
          designId,
          revision: 'A',
          name: 'Parallel A',
          partType: 'Manufacture',
        },
        user.id,
      ),
      ItemService.create<Part>(
        'Part',
        {
          itemType: 'Part',
          designId,
          revision: 'A',
          name: 'Parallel B',
          partType: 'Manufacture',
        },
        user.id,
      ),
    ])

    // Distinct numbers: allocation is the thing most likely to collapse if the
    // two calls were secretly sharing one connection.
    expect(first.itemNumber).not.toBe(second.itemNumber)
  })

  it('removes everything it created', async () => {
    const { user, programId, designId } = await concurrent.seedScope('cleanup')
    await ItemService.create<Part>(
      'Part',
      {
        itemType: 'Part',
        designId,
        revision: 'A',
        name: 'Disposable',
        partType: 'Manufacture',
      },
      user.id,
    )

    await concurrent.cleanup()

    const [remainingItems] = await concurrent.db
      .select({ n: sql<number>`count(*)::int` })
      .from(items)
      .where(eq(items.designId, designId))
    const [remainingDesigns] = await concurrent.db
      .select({ n: sql<number>`count(*)::int` })
      .from(designs)
      .where(eq(designs.id, designId))
    const [remainingPrograms] = await concurrent.db
      .select({ n: sql<number>`count(*)::int` })
      .from(programs)
      .where(eq(programs.id, programId))
    const [remainingUsers] = await concurrent.db
      .select({ n: sql<number>`count(*)::int` })
      .from(users)
      .where(eq(users.id, user.id))

    expect({
      items: remainingItems?.n,
      designs: remainingDesigns?.n,
      programs: remainingPrograms?.n,
      users: remainingUsers?.n,
    }).toEqual({ items: 0, designs: 0, programs: 0, users: 0 })
  })
})
