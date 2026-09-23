// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * An archived branch accepts no writes.
 *
 * A branch is archived when its change order releases or is cancelled, when
 * the change order that owns it is deleted, when its workspace is deleted, or
 * by hand. From then on it is history — the record of what a release merged or
 * a cancellation abandoned — and nothing may land on it: no checkout, no
 * working copy, no edit, no commit.
 *
 * Every write path is driven against an archived branch in each shape
 * archiving leaves, and each asserts the same invariant: the write is refused
 * with a ValidationError, and the branch, its content and main read back
 * exactly as they did before the attempt. Releasing a lock is the one
 * deliberate exception, and is pinned here too.
 *
 * Run: npx vitest run cascadia-api/src/services/archived-branch-writes.test.ts
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
import { and, eq } from 'drizzle-orm'
import { ItemService } from '../items/services/ItemService'
import { ChangeOrderService } from '../items/services/ChangeOrderService'
import { BranchService } from './BranchService'
import { CheckoutService } from './CheckoutService'
import { CommitService } from './CommitService'
import { ConflictDetectionService } from './ConflictDetectionService'
import { CrossDesignReferenceService } from './CrossDesignReferenceService'
import { DesignService } from './DesignService'
import { UsageService } from './UsageService'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { BranchProtectionError, ValidationError } from '@/errors'
import {
  branchItems,
  branches,
  commits,
  designCrossReferences,
  itemRelationships,
  itemVersions,
  items,
  programMembers,
  programs,
} from '@/db/schema'
import { takeFirst } from '@/db/take-first'

// Import to register item types
import '@/items/registerItemTypes.server'

const SHAPES = [
  'change-order branch',
  'change-order branch whose change order was deleted',
  'workspace branch',
] as const
type Shape = (typeof SHAPES)[number]

type ItemRow = typeof items.$inferSelect

interface TrackedItem {
  part: ItemRow
  /** Its `branch_items` row on the branch */
  rowId: string
  workingCopyId: string
}

interface BranchWriteContext {
  branchId: string
  designId: string
  userId: string
  otherUserId: string
  uniquePrefix: string
  /** A released part the branch never touched */
  untracked: ItemRow
  /** A working copy on the branch, checked in */
  idle: TrackedItem
  /** A working copy on the branch whose checkout the archive left in place */
  held: TrackedItem
  /** A newer version of `idle` on main, to rebase or pull onto */
  newBase: ItemRow
  /** A part in another design, to pull in as a usage or a reference */
  source: ItemRow
  /** A cross-design reference on main, to remove on the branch */
  baselineReferenceId: string
}

type Write<TContext> = [label: string, write: (c: TContext) => Promise<unknown>]

const BRANCH_WRITES: Array<Write<BranchWriteContext>> = [
  [
    'a checkout of an item it does not track',
    (c) =>
      CheckoutService.checkout(
        { itemMasterId: c.untracked.masterId, branchId: c.branchId },
        c.userId,
      ),
  ],
  [
    'a checkout of an item it already tracks',
    (c) =>
      CheckoutService.checkout(
        { itemMasterId: c.idle.part.masterId, branchId: c.branchId },
        c.userId,
      ),
  ],
  [
    'a revision working copy',
    (c) =>
      CheckoutService.ensureRevisionWorkingCopy(
        c.untracked,
        c.branchId,
        c.userId,
      ),
  ],
  [
    'a save by the holder of a checkout left on it',
    (c) =>
      CheckoutService.saveChanges(
        {
          branchId: c.branchId,
          itemId: c.held.workingCopyId,
          changes: { name: 'Saved after archiving' },
          commitMessage: 'Saved after archiving',
        },
        c.userId,
      ),
  ],
  [
    'a new item',
    (c) =>
      CheckoutService.createOnBranch(
        {
          designId: c.designId,
          itemNumber: `PN-${c.uniquePrefix}-LATE`,
          itemType: 'Part',
          name: 'Created after archiving',
        },
        c.branchId,
        'Created after archiving',
        c.userId,
      ),
  ],
  [
    'a delete of an item it tracks',
    (c) =>
      CheckoutService.deleteOnBranch(
        c.idle.part.masterId,
        c.branchId,
        'Deleted after archiving',
        c.userId,
      ),
  ],
  [
    // The branch answers before the lock does: not a ResourceLockedError
    'a delete of an item another user holds on it',
    (c) =>
      CheckoutService.deleteOnBranch(
        c.held.part.masterId,
        c.branchId,
        'Deleted after archiving',
        c.otherUserId,
      ),
  ],
  [
    'a delete of an item it does not track',
    (c) =>
      CheckoutService.deleteOnBranch(
        c.untracked.masterId,
        c.branchId,
        'Deleted after archiving',
        c.userId,
      ),
  ],
  [
    'a commit',
    (c) =>
      CommitService.create(
        {
          branchId: c.branchId,
          message: 'Committed after archiving',
          itemChanges: [],
        },
        c.userId,
      ),
  ],
  [
    'a rebase of a working copy onto main',
    (c) =>
      ConflictDetectionService.rebaseItem(
        c.idle.rowId,
        c.newBase.id,
        c.userId,
        {
          name: 'Rebased after archiving',
        },
      ),
  ],
  [
    'a pull from main into a working copy',
    (c) =>
      ConflictDetectionService.pullChangesFromMain(
        c.idle.rowId,
        c.newBase.id,
        c.userId,
      ),
  ],
  [
    'a usage subtree pulled in on it',
    (c) =>
      UsageService.createUsageSubtree(
        {
          rootItemId: c.source.id,
          targetDesignId: c.designId,
          branchId: c.branchId,
        },
        c.userId,
      ),
  ],
  [
    'a cross-design reference added on it',
    (c) =>
      CrossDesignReferenceService.createReference(
        {
          referencingDesignId: c.designId,
          referencedItemId: c.source.id,
          branchId: c.branchId,
        },
        c.userId,
      ),
  ],
  [
    'a cross-design reference removed on it',
    (c) =>
      CrossDesignReferenceService.removeReference(
        c.baselineReferenceId,
        c.branchId,
        c.userId,
      ),
  ],
]

const LOCK_RELEASES: Array<Write<BranchWriteContext>> = [
  [
    'cancelling the checkout',
    (c) =>
      CheckoutService.cancelCheckout(
        c.held.part.masterId,
        c.branchId,
        c.userId,
      ),
  ],
  [
    'checking it in',
    (c) => CheckoutService.checkin(c.held.part.masterId, c.branchId, c.userId),
  ],
]

interface DraftEditContext {
  branchId: string
  userId: string
  parentId: string
  childId: string
}

const DRAFT_EDITS: Array<Write<DraftEditContext>> = [
  [
    'a field edit',
    (c) =>
      ItemService.update(
        c.parentId,
        { name: 'Edited after archiving' },
        c.userId,
      ),
  ],
  [
    'a BOM line added under it',
    (c) =>
      ItemService.addRelationship(c.parentId, c.childId, 'BOM', c.userId, {
        quantity: '1',
      }),
  ],
  ['a hard delete', (c) => ItemService.delete(c.childId, c.userId)],
]

describe('archived branches accept no writes', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let otherUser: TestUser
  let uniquePrefix: string
  let designId: string
  let mainBranchId: string
  let initialCommitId: string
  let sourceDesignId: string
  let changeOrderId: string
  let changeOrderBranchId: string
  let workspaceBranchId: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()

    uniquePrefix = `T${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`

    user = await insertTestUser(testDb.db)
    otherUser = await insertTestUser(testDb.db)

    const program = takeFirst(
      await testDb.db
        .insert(programs)
        .values({
          name: 'Archive Program',
          code: `PROG-${uniquePrefix}`,
          createdBy: user.id,
        })
        .returning(),
    )
    // ItemService.update and delete refuse a design the caller cannot reach
    for (const member of [user, otherUser]) {
      await testDb.db.insert(programMembers).values({
        programId: program.id,
        userId: member.id,
        role: 'engineer',
        invitedBy: user.id,
      })
    }

    const design = await DesignService.create(
      {
        programId: program.id,
        name: 'Archive Design',
        code: `DES-${uniquePrefix}`,
        designType: 'Engineering',
      },
      user.id,
    )
    designId = design.id
    mainBranchId = design.mainBranch!.id
    initialCommitId = design.initialCommit!.id

    const sourceDesign = await DesignService.create(
      {
        programId: program.id,
        name: 'Source Design',
        code: `SRC-${uniquePrefix}`,
        designType: 'Engineering',
      },
      user.id,
    )
    sourceDesignId = sourceDesign.id

    const changeOrder = await ItemService.create(
      'ChangeOrder',
      {
        revision: 'A',
        name: 'Archive ECO',
        changeType: 'ECO',
        priority: 'medium',
        reasonForChange: 'Test',
        designId,
      } as any,
      user.id,
    )
    changeOrderId = changeOrder.id
    const { branch } = await BranchService.getOrCreateChangeOrderBranch(
      designId,
      changeOrder.id,
      user.id,
    )
    changeOrderBranchId = branch.id

    const workspace = await BranchService.createWorkspaceBranch(
      designId,
      user.id,
      `archive-${uniquePrefix}`,
    )
    workspaceBranchId = workspace.id
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  function branchOf(shape: Shape): string {
    return shape === 'workspace branch'
      ? workspaceBranchId
      : changeOrderBranchId
  }

  /**
   * Archive the shape's branch through `archiveBranch`, which every archiving
   * path ends in, and for the deleted-change-order shape delete the change
   * order afterwards. Nothing here releases locks, which is how a lock
   * outlives its branch: the branch update route archived without releasing
   * any until `retireBranch`.
   */
  async function archive(shape: Shape): Promise<string> {
    const branchId = branchOf(shape)
    await BranchService.archiveBranch(branchId, undefined, user.id)
    if (shape === 'change-order branch whose change order was deleted') {
      await ItemService.delete(changeOrderId, user.id)
    }

    const archived = await BranchService.getById(branchId)
    expect(archived?.isArchived).toBe(true)
    if (shape === 'change-order branch whose change order was deleted') {
      // ON DELETE SET NULL: the branch outlives its change order, with no
      // change order left to ask whether it still accepts new scope
      expect(archived?.changeOrderItemId).toBeNull()
    }
    return branchId
  }

  async function rowOf(id: string): Promise<ItemRow> {
    return takeFirst(
      await testDb.db.select().from(items).where(eq(items.id, id)),
    )
  }

  async function createReleasedPart(
    targetDesignId: string = designId,
  ): Promise<ItemRow> {
    const part = await ItemService.create(
      'Part',
      {
        itemNumber: `PN-${uniquePrefix}-${Math.random().toString(36).slice(2, 7)}`,
        revision: 'A',
        name: 'Released Part',
        state: 'Released',
        designId: targetDesignId,
      } as any,
      user.id,
      { bypassBranchProtection: true },
    )
    if (targetDesignId === designId) {
      // Linked to the initial commit so VersionResolver finds it on main
      await testDb.db.insert(itemVersions).values({
        commitId: initialCommitId,
        itemId: part.id,
        changeType: 'added',
      })
    }
    return rowOf(part.id)
  }

  /** A released part edited on the branch the way an engineer edits one. */
  async function trackOnBranch(
    branchId: string,
    { keepLock }: { keepLock: boolean },
  ): Promise<TrackedItem> {
    const part = await createReleasedPart()
    await CheckoutService.checkout(
      { itemMasterId: part.masterId, branchId },
      user.id,
    )
    const saved = await CheckoutService.saveChanges(
      {
        branchId,
        itemId: part.id,
        changes: { name: 'Edited on the branch' },
        commitMessage: 'Edited on the branch',
      },
      user.id,
    )
    if (!keepLock) {
      await CheckoutService.checkin(part.masterId, branchId, user.id)
    }
    const row = takeFirst(
      await testDb.db
        .select()
        .from(branchItems)
        .where(
          and(
            eq(branchItems.branchId, branchId),
            eq(branchItems.itemMasterId, part.masterId),
          ),
        ),
    )
    return { part, rowId: row.id, workingCopyId: saved.item.id }
  }

  /**
   * Everything a write to the branch could leave behind: the branch and its
   * head, its tracking rows and commits, every version row in the design, the
   * structure hanging off them, the design's cross-design references, and
   * main's head — an edit misread as main's own content commits there.
   */
  async function snapshot(branchId: string) {
    const branch = takeFirst(
      await testDb.db.select().from(branches).where(eq(branches.id, branchId)),
    )
    const main = takeFirst(
      await testDb.db
        .select()
        .from(branches)
        .where(eq(branches.id, mainBranchId)),
    )
    const tracking = await testDb.db
      .select()
      .from(branchItems)
      .where(eq(branchItems.branchId, branchId))
      .orderBy(branchItems.id)
    const history = await testDb.db
      .select()
      .from(commits)
      .where(eq(commits.branchId, branchId))
      .orderBy(commits.id)
    const versions = await testDb.db
      .select()
      .from(items)
      .where(eq(items.designId, designId))
      .orderBy(items.id)
    const structure = await testDb.db
      .select({ relationship: itemRelationships })
      .from(itemRelationships)
      .innerJoin(items, eq(itemRelationships.sourceId, items.id))
      .where(eq(items.designId, designId))
      .orderBy(itemRelationships.id)
    const references = await testDb.db
      .select()
      .from(designCrossReferences)
      .where(eq(designCrossReferences.referencingDesignId, designId))
      .orderBy(designCrossReferences.id)

    return {
      branch,
      mainHead: main.headCommitId,
      tracking,
      history,
      versions,
      structure,
      references,
    }
  }

  function withoutLocks(state: Awaited<ReturnType<typeof snapshot>>) {
    return {
      ...state,
      tracking: state.tracking.map(
        ({ checkedOutBy: _by, checkedOutAt: _at, ...row }) => row,
      ),
    }
  }

  describe.each([...SHAPES])('an archived %s', (shape) => {
    let c: BranchWriteContext

    // Content put on the branch while it was live, then the archive
    beforeEach(async () => {
      const branchId = branchOf(shape)

      const untracked = await createReleasedPart()
      const idle = await trackOnBranch(branchId, { keepLock: false })
      const held = await trackOnBranch(branchId, { keepLock: true })

      const newBase = takeFirst(
        await testDb.db
          .insert(items)
          .values({
            masterId: idle.part.masterId,
            designId,
            itemType: 'Part',
            itemNumber: idle.part.itemNumber,
            revision: 'B',
            name: 'Moved on main',
            state: idle.part.state,
            isCurrent: false,
            createdBy: user.id,
            modifiedBy: user.id,
          })
          .returning(),
      )

      const source = await createReleasedPart(sourceDesignId)
      const referenced = await createReleasedPart(sourceDesignId)
      const baselineReference =
        await CrossDesignReferenceService.createReference(
          { referencingDesignId: designId, referencedItemId: referenced.id },
          user.id,
        )

      c = {
        branchId: await archive(shape),
        designId,
        userId: user.id,
        otherUserId: otherUser.id,
        uniquePrefix,
        untracked,
        idle,
        held,
        newBase,
        source,
        baselineReferenceId: baselineReference.id,
      }
    })

    it.each(BRANCH_WRITES)(
      'refuses %s and is left as it was',
      async (_label, write) => {
        const before = await snapshot(c.branchId)

        await expect(write(c)).rejects.toThrow(ValidationError)

        expect(await snapshot(c.branchId)).toEqual(before)
      },
    )

    // Releasing a lock is the deliberate exception. It writes no content and
    // no commit, and a lock can outlive its branch — the branch update route
    // archived without releasing any until `retireBranch` — so refusing it
    // would leave the holder's lock on the item for good.
    it.each(LOCK_RELEASES)(
      'still lets the holder release a lock left on it by %s, and moves nothing else',
      async (_label, release) => {
        const before = await snapshot(c.branchId)

        await release(c)

        const after = await snapshot(c.branchId)
        const row = after.tracking.find((r) => r.id === c.held.rowId)
        expect(row?.checkedOutBy).toBeNull()
        expect(withoutLocks(after)).toEqual(withoutLocks(before))
      },
    )
  })

  // A row the archived branch made and never merged is not on main, so main's
  // rules were the wrong ones to judge it by. With no released item in the
  // design main is unprotected, and those rules let every one of these
  // through.
  describe.each([...SHAPES])('drafts an archived %s created', (shape) => {
    let c: DraftEditContext

    beforeEach(async () => {
      const liveBranchId = branchOf(shape)
      const draft = async (suffix: string) =>
        (
          await CheckoutService.createOnBranch(
            {
              designId,
              itemNumber: `PN-${uniquePrefix}-${suffix}`,
              itemType: 'Part',
              name: `Draft ${suffix}`,
            },
            liveBranchId,
            `Drafted ${suffix}`,
            user.id,
          )
        ).item
      const parent = await draft('PARENT')
      const child = await draft('CHILD')

      c = {
        branchId: await archive(shape),
        userId: user.id,
        parentId: parent.id,
        childId: child.id,
      }
      expect(await BranchService.isMainBranchProtected(designId)).toBe(false)
    })

    it.each(DRAFT_EDITS)(
      'refuses %s and is left as it was',
      async (_label, edit) => {
        const before = await snapshot(c.branchId)

        await expect(edit(c)).rejects.toThrow(ValidationError)

        expect(await snapshot(c.branchId)).toEqual(before)
      },
    )
  })

  describe.each([...SHAPES])(
    'revision working copies on an archived %s',
    (shape) => {
      let branchId: string
      let workInstructionCopy: ItemRow
      let partCopy: ItemRow

      beforeEach(async () => {
        const liveBranchId = branchOf(shape)
        const output = await createReleasedPart()
        const workInstruction = await ItemService.create(
          'WorkInstruction',
          {
            itemNumber: `WI-${uniquePrefix}`,
            revision: 'A',
            name: 'Released WI',
            state: 'Released',
            designId,
            outputPartId: output.id,
          } as any,
          user.id,
          { bypassBranchProtection: true },
        )
        const part = await createReleasedPart()

        workInstructionCopy = (
          await ChangeOrderService.createRevisionWorkingCopy(
            await rowOf(workInstruction.id),
            liveBranchId,
            user.id,
          )
        ).workingCopy
        partCopy = (
          await ChangeOrderService.createRevisionWorkingCopy(
            part,
            liveBranchId,
            user.id,
          )
        ).workingCopy

        branchId = await archive(shape)
        expect(await BranchService.isMainBranchProtected(designId)).toBe(true)
      })

      // Branch protection exempts a Free lifecycle, so main's rules let an
      // edit to this copy through even with main protected.
      it('refuses an edit to a work instruction copy and is left as it was', async () => {
        const before = await snapshot(branchId)

        await expect(
          ItemService.update(
            workInstructionCopy.id,
            { name: 'Edited after archiving' },
            user.id,
          ),
        ).rejects.toThrow(ValidationError)

        expect(await snapshot(branchId)).toEqual(before)
      })

      it('refuses an edit to a part copy and is left as it was', async () => {
        const before = await snapshot(branchId)

        await expect(
          ItemService.update(
            partCopy.id,
            { name: 'Edited after archiving' },
            user.id,
          ),
        ).rejects.toThrow(ValidationError)

        expect(await snapshot(branchId)).toEqual(before)
      })
    },
  )

  // The other side of the line: an archived branch's tracking row can point at
  // a row that is main's, and that row must stay governed by main.
  describe('rows an archived branch points at but did not make', () => {
    // A release promotes the working copy onto main in place. The archived
    // branch still tracks the row, but it is main's now, carrying the revision
    // the release assigned.
    it('leaves a copy a release promoted to main governed by main', async () => {
      const part = await createReleasedPart()
      const { workingCopy } =
        await ChangeOrderService.createRevisionWorkingCopy(
          part,
          changeOrderBranchId,
          user.id,
        )
      await testDb.db
        .update(items)
        .set({ isCurrent: false })
        .where(eq(items.id, part.id))
      await testDb.db
        .update(items)
        .set({ revision: 'B', state: 'Released', isCurrent: true })
        .where(eq(items.id, workingCopy.id))
      await archive('change-order branch')

      await expect(
        ItemService.update(workingCopy.id, { name: 'Edited on main' }, user.id),
      ).rejects.toThrow(BranchProtectionError)
    })

    // A plain checkout and a delete of an item the branch did not track both
    // leave a tracking row pointing at main's own row, and main's pre-release
    // drafts carry the unreleased marker a working copy does.
    it('leaves a main draft an archived branch checked out or deleted editable', async () => {
      const checkedOut = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-OUT`,
          name: 'Checked out',
          designId,
        } as any,
        user.id,
      )
      const deleted = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-DEL`,
          name: 'Deleted',
          designId,
        } as any,
        user.id,
      )
      await CheckoutService.checkout(
        { itemMasterId: checkedOut.masterId, branchId: workspaceBranchId },
        user.id,
      )
      await CheckoutService.deleteOnBranch(
        deleted.masterId,
        workspaceBranchId,
        'Deleted on the workspace',
        user.id,
      )
      await archive('workspace branch')
      expect(await BranchService.isMainBranchProtected(designId)).toBe(false)

      const edited = await ItemService.update(
        checkedOut.id,
        { name: 'Still editable' },
        user.id,
      )
      expect(edited.name).toBe('Still editable')

      const alsoEdited = await ItemService.update(
        deleted.id,
        { name: 'Also editable' },
        user.id,
      )
      expect(alsoEdited.name).toBe('Also editable')
    })
  })
})
