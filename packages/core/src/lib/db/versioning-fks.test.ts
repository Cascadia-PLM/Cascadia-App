// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Versioning-graph foreign keys (DBI-6) — data-integrity gate.
 *
 * The versioning graph's pointers (commits⇄branches, branch_items→items,
 * item_versions→items, conflict_reviews→items) were bare uuids. These tests
 * pin the FK pass from both sides:
 *
 *  - deleteWorkspaceBranch leaves zero dangling branch_items rows — asked of
 *    the database, not the service, because the service used to delete the
 *    items and archive the branch with its tracking rows still pointing at
 *    them (the dangler class that motivated the FK)
 *  - a whole design deletes end-to-end with branches, commits, tags,
 *    branch_items, and item_versions in place (the cascades and NO ACTION
 *    end-of-statement checks compose)
 *  - history is protected: deleting a commit with children throws, and
 *    deleting an item a live branch still tracks throws
 *
 * DBI2-2 added the one edge that pass skipped — commits.change_order_item_id,
 * the merge provenance a release commit carries — and it is pinned here from
 * both sides too: a commit may not name an ECO that does not exist, and
 * deleting an ECO that a commit does name keeps the commit and nulls the
 * pointer, which is only correct if the graph readers tolerate the null.
 *
 * Run: npx vitest run packages/core/src/lib/db/versioning-fks.test.ts
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
import { and, eq, isNotNull, notInArray, sql } from 'drizzle-orm'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { ChangeOrder } from '@/lib/items/types/change-order'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { DesignService } from '@/lib/services/DesignService'
import { BranchService } from '@/lib/services/BranchService'
import { CommitGraphService } from '@/lib/services/CommitGraphService'
import { EcoBranchHistoryService } from '@/lib/services/EcoBranchHistoryService'
import { ItemService } from '@/lib/items/services/ItemService'
import {
  branchItems,
  branches,
  changeOrderDesigns,
  commits,
  designs,
  items,
  programs,
  tags,
} from '@/lib/db/schema'
import { asPostgresError } from '@/lib/errors/pg'
import { takeFirst } from '@/lib/db/take-first'
import '@/lib/items/registerItemTypes.server'

const FK_VIOLATION = '23503'

describe('versioning-graph foreign keys (DBI-6)', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let unique: string
  let programId: string
  let designId: string
  let mainBranchId: string

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
    const design = await DesignService.create(
      {
        programId,
        name: 'FK Design',
        code: `FKD-${unique}`,
        designType: 'Engineering',
      },
      user.id,
    )
    designId = design.id
    mainBranchId = design.mainBranch!.id
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  /**
   * An ECO's item id, built the way the application builds one: no design of
   * its own (an ECO is design-agnostic at creation) and an auto-assigned
   * number.
   */
  async function createChangeOrder(): Promise<string> {
    const eco = await ItemService.create<ChangeOrder>(
      'ChangeOrder',
      {
        itemType: 'ChangeOrder',
        revision: 'A',
        name: 'FK ECO',
        changeType: 'ECO',
        priority: 'medium',
        reasonForChange: 'Pin the commit provenance edge',
      },
      user.id,
    )
    return eco.id!
  }

  it('deleteWorkspaceBranch leaves zero branch_items rows pointing at nonexistent items', async () => {
    const workspace = await BranchService.createWorkspaceBranch(
      designId,
      user.id,
      `scratch-${unique}`,
    )

    // An item created on the workspace only (changeType 'added').
    const result = await ItemService.createOnBranch(
      'Part',
      {
        itemNumber: `WS-${unique}`,
        name: 'Workspace-only part',
        designId,
        partType: 'Manufacture',
      } as never,
      workspace.id,
      'Created on workspace',
      user.id,
    )
    expect(result.item.id).toBeDefined()

    await BranchService.deleteWorkspaceBranch(workspace.id, user.id)

    // Asked of the database: every branch_items.current_item_id that remains
    // (branch-wide, archived included) resolves to a live items row.
    const danglers = await testDb.db
      .select({ id: branchItems.id })
      .from(branchItems)
      .where(
        and(
          eq(branchItems.branchId, workspace.id),
          isNotNull(branchItems.currentItemId),
          notInArray(
            branchItems.currentItemId,
            testDb.db.select({ id: items.id }).from(items),
          ),
        ),
      )
    expect(danglers).toHaveLength(0)

    // And the workspace-only item is actually gone (the delete still works).
    expect(await ItemService.findById(result.item.id!)).toBeNull()
  })

  it('deletes a design end-to-end with branches, commits, tags, branch_items, and item_versions', async () => {
    // Content on main: an item with a commit + itemVersion via the real path.
    const created = await ItemService.createOnBranch(
      'Part',
      {
        itemNumber: `DEL-${unique}`,
        name: 'To be cascaded',
        designId,
        partType: 'Manufacture',
      } as never,
      mainBranchId,
      'Add part',
      user.id,
    )
    await DesignService.createTag(
      designId,
      { name: `v-${unique}`, tagType: 'baseline' },
      user.id,
    )

    // The item rows block design deletion via items.design_id (NO ACTION) —
    // remove them first the way a real purge would, then the graph cascades.
    await testDb.db
      .delete(branchItems)
      .where(
        eq(
          branchItems.itemMasterId,
          takeFirst(
            await testDb.db
              .select({ masterId: items.masterId })
              .from(items)
              .where(eq(items.id, created.item.id!)),
          ).masterId,
        ),
      )
    await testDb.db.delete(items).where(eq(items.designId, designId))

    await testDb.db.delete(designs).where(eq(designs.id, designId))

    for (const [table, label] of [
      [branches, 'branches'],
      [commits, 'commits'],
      [tags, 'tags'],
    ] as const) {
      const rows = await testDb.db
        .select({ n: sql<number>`count(*)` })
        .from(table)
        .where(eq(table.designId, designId))
      expect(Number(rows[0]!.n), label).toBe(0)
    }
  })

  it('refuses to delete a commit out from under its children', async () => {
    const head = takeFirst(
      await testDb.db
        .select()
        .from(branches)
        .where(eq(branches.id, mainBranchId)),
    )
    const child = takeFirst(
      await testDb.db
        .insert(commits)
        .values({
          designId,
          branchId: mainBranchId,
          parentId: head.headCommitId!,
          message: 'Child commit',
          createdBy: user.id,
        })
        .returning(),
    )
    expect(child.parentId).toBe(head.headCommitId)

    let caught: unknown
    try {
      await testDb.db.delete(commits).where(eq(commits.id, head.headCommitId!))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeDefined()
    expect(asPostgresError(caught)?.code).toBe(FK_VIOLATION)
  })

  it("nulls a commit's ECO pointer when the ECO is deleted, and the graph readers still render it", async () => {
    // Two change orders on one design: the first is released and then deleted,
    // the second is what the ECO-history read is asked for afterwards.
    const releasedEcoId = await createChangeOrder()
    const openEcoId = await createChangeOrder()

    const { branch: openBranch } = await BranchService.getOrCreateEcoBranch(
      designId,
      openEcoId,
      user.id,
    )
    // EcoBranchHistoryService finds a change order's designs through this
    // relation; linked directly so the fixture stays a fixture.
    await testDb.db.insert(changeOrderDesigns).values({
      changeOrderId: openEcoId,
      designId,
      branchId: openBranch.id,
      mergeStatus: 'pending',
    })

    // The release commit on main, carrying the ECO linkage the merge writes.
    const releaseCommit = takeFirst(
      await testDb.db
        .insert(commits)
        .values({
          designId,
          branchId: mainBranchId,
          message: 'Released via ECO',
          changeOrderItemId: releasedEcoId,
          createdBy: user.id,
        })
        .returning(),
    )
    expect(releaseCommit.changeOrderItemId).toBe(releasedEcoId)

    await testDb.db.delete(items).where(eq(items.id, releasedEcoId))

    // The commit is history: it survives its ECO, with the pointer nulled.
    const kept = takeFirst(
      await testDb.db
        .select()
        .from(commits)
        .where(eq(commits.id, releaseCommit.id)),
    )
    expect(kept.changeOrderItemId).toBeNull()

    // Both graph readers still render that commit, without an ECO number.
    const designGraph = await CommitGraphService.buildCommitGraph(
      designId,
      null,
      50,
    )
    const designNode = designGraph.nodes.find(
      (node) => node.data.commitId === releaseCommit.id,
    )
    expect(designNode).toBeDefined()
    expect(designNode!.data.changeOrderItemId).toBeUndefined()
    expect(designNode!.data.ecoNumber).toBeUndefined()

    const ecoGraph = await EcoBranchHistoryService.getGraph(openEcoId, {
      designId,
    })
    const ecoNode = ecoGraph.nodes.find(
      (node) => node.data.commitId === releaseCommit.id,
    )
    expect(ecoNode).toBeDefined()
    expect(ecoNode!.data.ecoNumber).toBeUndefined()
  })

  it('refuses a commit whose ECO pointer names no item', async () => {
    let caught: unknown
    try {
      await testDb.db.insert(commits).values({
        designId,
        branchId: mainBranchId,
        message: 'Released via ECO: gone',
        // A well-formed uuid that names nothing — the shape a bare column let
        // through for the whole life of the schema.
        changeOrderItemId: '00000000-0000-4000-8000-0000000000ff',
        createdBy: user.id,
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeDefined()
    expect(asPostgresError(caught)?.code).toBe(FK_VIOLATION)
  })

  it('refuses to delete an item a live branch still tracks', async () => {
    const created = await ItemService.createOnBranch(
      'Part',
      {
        itemNumber: `TRK-${unique}`,
        name: 'Tracked part',
        designId,
        partType: 'Manufacture',
      } as never,
      mainBranchId,
      'Add tracked part',
      user.id,
    )

    let caught: unknown
    try {
      await testDb.db.delete(items).where(eq(items.id, created.item.id!))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeDefined()
    expect(asPostgresError(caught)?.code).toBe(FK_VIOLATION)
  })
})
