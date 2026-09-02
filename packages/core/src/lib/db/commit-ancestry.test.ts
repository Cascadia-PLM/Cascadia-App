// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The ancestry walk enumerates commits, not paths.
 *
 * Complex-algorithm gate. This is the one property the rest of the versioning
 * suite structurally cannot see: `VersionResolver.test.ts` holds a 200-master
 * SQL-vs-in-memory equivalence oracle, and both of its arms share this walk, so
 * agreeing with each other says nothing about how many rows either produced.
 * Its fixture is also purely linear — no merge commits — which is exactly the
 * topology that hides the defect.
 *
 * ECO-as-Branch builds diamonds. A branch is cut at main's head, its commits
 * parent onto that chain, and `createMergeCommit` writes `parent_id` = main's
 * head together with `merge_parent_id` = the ECO's head. So every release
 * closes a diamond, and every diamond doubles the number of distinct
 * root-to-head paths while adding a constant number of commits.
 *
 * That divergence is the assertion. At 20 diamonds the graph holds 61 commits
 * and 2^20 = 1,048,576 paths. A walk that enumerates commits returns 61 rows
 * in milliseconds; the `UNION ALL` this replaced would return over a million
 * and take the test with it, which is why there is an explicit timeout rather
 * than a silent hang.
 *
 * Run: npx vitest run packages/core/src/lib/db/commit-ancestry.test.ts
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
import { sql } from 'drizzle-orm'
import { commitAncestorDepthCte, commitAncestorSetCte } from './commit-ancestry'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { DesignService } from '@/lib/services/DesignService'
import { programs } from '@/lib/db/schema'
import { commits } from '@/lib/db/schema/versioning'
import { takeFirst } from '@/lib/db/take-first'

/** Diamonds to stack. 20 → 61 commits, 1,048,576 distinct paths. */
const DIAMONDS = 20

describe('commit ancestry', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let programId: string
  let uniquePrefix: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    uniquePrefix = `CA${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    user = await insertTestUser(testDb.db)
    programId = takeFirst(
      await testDb.db
        .insert(programs)
        .values({
          name: 'Ancestry Program',
          code: `PROG-${uniquePrefix}`,
          createdBy: user.id,
        })
        .returning(),
    ).id
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  /**
   * Stack `count` diamonds onto a design's initial commit and return the final
   * head plus every commit id in the graph.
   *
   * One diamond is the shape a release leaves behind: two children of the
   * current head — main carrying on, and the ECO branch — rejoined by a merge
   * commit naming both.
   */
  async function stackDiamonds(count: number) {
    const design = await DesignService.create(
      {
        programId,
        name: 'Ancestry Design',
        code: `${uniquePrefix}-DES`,
        designType: 'Engineering',
      },
      user.id,
    )

    const root = design.initialCommit!.id
    const branchId = design.mainBranch!.id
    const all = [root]
    let head = root

    const insert = async (
      message: string,
      parentId: string,
      mergeParentId?: string,
    ) => {
      const row = takeFirst(
        await testDb.db
          .insert(commits)
          .values({
            designId: design.id,
            branchId,
            parentId,
            mergeParentId: mergeParentId ?? null,
            message,
            createdBy: user.id,
          })
          .returning(),
      )
      all.push(row.id)
      return row.id
    }

    for (let i = 0; i < count; i++) {
      const onMain = await insert(`main ${i}`, head)
      const onEco = await insert(`eco ${i}`, head)
      head = await insert(`merge ${i}`, onMain, onEco)
    }

    return { head, all }
  }

  it('returns one row per commit, not one per path', async () => {
    const { head, all } = await stackDiamonds(DIAMONDS)

    expect(all).toHaveLength(1 + 3 * DIAMONDS)

    const rows = (await testDb.db.execute(sql`
      WITH RECURSIVE ${commitAncestorDepthCte(head)}
      SELECT id, depth FROM commit_ancestors
    `)) as unknown as Array<{ id: string; depth: number }>

    // 2^20 paths reach the root. Anything near that many rows means the walk
    // went back to enumerating them.
    expect(rows).toHaveLength(all.length)
    expect(new Set(rows.map((r) => r.id)).size).toBe(all.length)
  }, 30_000)

  it('reaches every commit in the graph, so the bound is not hiding a short walk', async () => {
    const { head, all } = await stackDiamonds(DIAMONDS)

    const rows = (await testDb.db.execute(sql`
      WITH RECURSIVE ${commitAncestorSetCte(head)}
      SELECT id FROM commit_ancestors
    `)) as unknown as Array<{ id: string }>

    // The anti-vacancy leg: a walk that returned nothing would satisfy the
    // count bound above just as well as a correct one.
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set(all))
  }, 30_000)

  it('ranks each commit by its shortest distance from the head', async () => {
    const { head } = await stackDiamonds(3)

    const rows = (await testDb.db.execute(sql`
      WITH RECURSIVE ${commitAncestorDepthCte(head)}
      SELECT id, depth FROM commit_ancestors ORDER BY depth
    `)) as unknown as Array<{ id: string; depth: number }>

    // Position 0 is always the target commit itself, which is what every
    // consumer building a position map from this order depends on.
    expect(rows[0]!.id).toBe(head)
    expect(Number(rows[0]!.depth)).toBe(0)

    // Both arms of a diamond sit at the same depth, and the commit they
    // rejoin sits one deeper — reached twice, counted once.
    const byDepth = new Map<number, number>()
    for (const row of rows)
      byDepth.set(Number(row.depth), (byDepth.get(Number(row.depth)) ?? 0) + 1)
    expect(byDepth.get(1)).toBe(2)
  }, 30_000)
})
