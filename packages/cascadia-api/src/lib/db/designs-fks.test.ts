// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Designs graph-pointer foreign keys (DBI-5) — data-integrity gate.
 *
 * The designs table carried six bare-uuid graph pointers (parent, clone
 * source, MBOM source design/tag/commit, default branch) that nothing
 * validated. The FKs close that, with deletion semantics chosen carefully:
 *
 *  - defaultBranchId is NO ACTION, not RESTRICT: deleting a design cascades
 *    its branches while defaultBranchId still points at one, and NO ACTION's
 *    end-of-statement check passes (the design row is gone by then) where
 *    RESTRICT would abort every design deletion. The delete test pins that.
 *  - the source pointers are SET NULL: provenance, not ownership, and a
 *    cross-design NO ACTION would have made any Engineering design with a
 *    derived MBOM undeletable.
 *
 * Run: npx vitest run packages/core/src/lib/db/designs-fks.test.ts
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
import { DesignService } from '@/lib/services/DesignService'
import { branches, commits, designs, programs } from '@/lib/db/schema'
import { asPostgresError } from '@/lib/errors/pg'
import { takeFirst } from '@/lib/db/take-first'

/** Postgres foreign_key_violation. */
const FK_VIOLATION = '23503'

describe('designs graph-pointer foreign keys (DBI-5)', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let unique: string
  let programId: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    user = await insertTestUser(testDb.db)
    unique = `${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    const program = takeFirst(
      await testDb.db
        .insert(programs)
        .values({ name: 'P', code: `PRG-${unique}`, createdBy: user.id })
        .returning(),
    )
    programId = program.id
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  it('deletes a design carrying branches, commits, and a defaultBranchId', async () => {
    // The real creation path: main branch, initial commit, defaultBranchId set.
    const design = await DesignService.create(
      {
        programId,
        name: 'Deletable',
        code: `DEL-${unique}`,
        designType: 'Engineering',
      },
      user.id,
    )
    const designId = design.id

    const row = takeFirst(
      await testDb.db.select().from(designs).where(eq(designs.id, designId)),
    )
    expect(row.defaultBranchId).not.toBeNull()

    // The moment RESTRICT would abort and NO ACTION must not: the cascade
    // removes the design's branches while defaultBranchId still names one.
    await testDb.db.delete(designs).where(eq(designs.id, designId))

    expect(
      await testDb.db.select().from(designs).where(eq(designs.id, designId)),
    ).toHaveLength(0)
    expect(
      await testDb.db
        .select()
        .from(branches)
        .where(eq(branches.designId, designId)),
    ).toHaveLength(0)
    expect(
      await testDb.db
        .select()
        .from(commits)
        .where(eq(commits.designId, designId)),
    ).toHaveLength(0)
  })

  it('rejects a design pointing at a commit that does not exist', async () => {
    let caught: unknown
    try {
      await testDb.db.insert(designs).values({
        programId,
        name: 'Bogus source',
        code: `BOG-${unique}`,
        createdBy: user.id,
        sourceCommitId: randomUUID(),
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeDefined()
    expect(asPostgresError(caught)?.code).toBe(FK_VIOLATION)
  })

  it('nulls the source pointers when the source design is deleted', async () => {
    const source = await DesignService.create(
      {
        programId,
        name: 'Source',
        code: `SRC-${unique}`,
        designType: 'Engineering',
      },
      user.id,
    )
    const derived = takeFirst(
      await testDb.db
        .insert(designs)
        .values({
          programId,
          name: 'Derived MBOM',
          code: `MBOM-${unique}`,
          designType: 'Manufacturing',
          createdBy: user.id,
          sourceDesignId: source.id,
        })
        .returning(),
    )

    // Deleting the source must not make the derived design undeletable —
    // the pointer clears instead (provenance, not ownership).
    await testDb.db.delete(designs).where(eq(designs.id, source.id))

    const after = takeFirst(
      await testDb.db.select().from(designs).where(eq(designs.id, derived.id)),
    )
    expect(after.sourceDesignId).toBeNull()
  })
})
