// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Archiving a branch on its own, as the branch update route does
 * (`BranchService.retireBranch`).
 *
 * Every other archive ends a branch by ending what owns it, and releases the
 * checkout locks on the branch in the same transaction. The route archived
 * and did nothing else. Two invariants pin down what it owes instead:
 *
 *  - A branch an open change order owns is never archived this way. The
 *    attempt is refused with a ValidationError, and the branch, its tracking
 *    rows with their locks, and the events recorded on it read back exactly
 *    as before, whatever state the open change order is in.
 *  - A branch it does archive holds no checkout lock afterwards. Each release
 *    is recorded as a cancellation by the lock's holder, and nothing else on
 *    the branch moves.
 *
 * Run: npx vitest run cascadia-api/src/services/BranchService.retire.test.ts
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
import { BranchService } from './BranchService'
import { DesignService } from './DesignService'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { seedStandardPartLifecycle } from '@/__tests__/fixtures/lifecycles'
import { ValidationError } from '@/errors'
import {
  branchItems,
  branches,
  domainEvents,
  lifecycleDefinitions,
  lifecycleInstances,
  programs,
} from '@/db/schema'
import { ItemTypeRegistry } from '@/items/registry'
import { takeFirst } from '@/db/take-first'

// Import to register item types
import '@/items/registerItemTypes.server'

// Unique to this file, so no other suite's workflow seed races it
const RETIRE_TEST_WORKFLOW_ID = '00000000-0000-4000-8000-000000000641'

type InstanceState = Partial<typeof lifecycleInstances.$inferInsert>
type BranchItemRow = typeof branchItems.$inferSelect

// A change order is open until its workflow completes, a release in progress
// included, and one with no workflow instance is open as well
const OPEN_CHANGE_ORDERS: Array<
  [label: string, instance: InstanceState | null]
> = [
  ['in its initial state', { currentState: 'Draft' }],
  [
    'in review, with its scope locked',
    { currentState: 'InReview', scopeLocked: true, scopeLockedAt: new Date() },
  ],
  [
    'partway through its release',
    { currentState: 'InReview', scopeLocked: true, releasingAt: new Date() },
  ],
  ['with no workflow instance', null],
]

describe('BranchService.retireBranch', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let holder: TestUser
  let designId: string
  let uniquePrefix: string

  beforeAll(async () => {
    await testDb.setup()
    await seedStandardPartLifecycle(testDb.db)

    await testDb.db
      .insert(lifecycleDefinitions)
      .values({
        id: RETIRE_TEST_WORKFLOW_ID,
        name: 'Test ECO Workflow - BranchRetirement',
        version: 1,
        workflowType: 'strict',
        definition: {
          states: [
            { id: 'Draft', name: 'Draft', isInitial: true, isFinal: false },
            {
              id: 'InReview',
              name: 'InReview',
              isInitial: false,
              isFinal: false,
            },
            {
              id: 'Released',
              name: 'Released',
              isInitial: false,
              isFinal: true,
              finalKind: 'release',
            },
          ],
          transitions: [
            {
              id: 't1',
              name: 'Submit',
              fromStateId: 'Draft',
              toStateId: 'InReview',
            },
            {
              id: 't2',
              name: 'Release',
              fromStateId: 'InReview',
              toStateId: 'Released',
            },
          ],
          applicableItemTypes: ['ChangeOrder'],
        },
        isActive: true,
        lifecycleType: 'Driving',
      })
      .onConflictDoNothing()

    await ItemTypeRegistry.reload()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    uniquePrefix = `BR${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    user = await insertTestUser(testDb.db)
    holder = await insertTestUser(testDb.db)

    const program = takeFirst(
      await testDb.db
        .insert(programs)
        .values({
          name: 'Retire Test Program',
          code: `PROG-${uniquePrefix}`,
          createdBy: user.id,
        })
        .returning(),
    )

    const design = await DesignService.create(
      {
        programId: program.id,
        name: 'Retire Test Design',
        code: `DESIGN-${uniquePrefix}`,
        designType: 'Engineering',
      },
      user.id,
    )
    designId = design.id
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  /**
   * A part drafted on the branch, its tracking row checked out by `holder`:
   * a lock someone still holds when the branch is archived.
   */
  async function holdLockOn(branchId: string): Promise<string> {
    const { item } = await ItemService.createOnBranch(
      'Part',
      {
        itemNumber: `PN-${uniquePrefix}-${Math.random().toString(36).slice(2, 7)}`,
        revision: 'A',
        name: 'Held Part',
        state: 'Draft',
        designId,
        partType: 'Manufacture',
      } as never,
      branchId,
      'Drafted on the branch',
      user.id,
    )
    const masterId = item.masterId!
    await testDb.db
      .update(branchItems)
      .set({ checkedOutBy: holder.id, checkedOutAt: new Date() })
      .where(
        and(
          eq(branchItems.branchId, branchId),
          eq(branchItems.itemMasterId, masterId),
        ),
      )
    return masterId
  }

  /**
   * A change order's branch carrying a held lock, with the change order's
   * workflow then put in the given state. The part is drafted before the
   * workflow exists, since a locked or completed scope takes no new items.
   */
  async function changeOrderBranch(instance: InstanceState | null) {
    const changeOrder = await ItemService.create(
      'ChangeOrder',
      {
        revision: '-',
        name: 'Retire Test ECO',
        changeType: 'ECO',
        reasonForChange: 'Test',
      } as any,
      user.id,
    )
    const { branch } = await BranchService.getOrCreateChangeOrderBranch(
      designId,
      changeOrder.id,
      user.id,
    )
    const heldMasterId = await holdLockOn(branch.id)

    if (instance) {
      await testDb.db.insert(lifecycleInstances).values({
        workflowDefinitionId: RETIRE_TEST_WORKFLOW_ID,
        itemId: changeOrder.id,
        ...instance,
      })
    }
    return { branchId: branch.id, heldMasterId }
  }

  /** The branch, its tracking rows with their locks, and its events. */
  async function snapshot(branchId: string) {
    return {
      branch: takeFirst(
        await testDb.db
          .select()
          .from(branches)
          .where(eq(branches.id, branchId)),
      ),
      tracking: await testDb.db
        .select()
        .from(branchItems)
        .where(eq(branchItems.branchId, branchId))
        .orderBy(branchItems.id),
      events: await testDb.db
        .select()
        .from(domainEvents)
        .where(eq(domainEvents.branchId, branchId))
        .orderBy(domainEvents.id),
    }
  }

  type Snapshot = Awaited<ReturnType<typeof snapshot>>

  function withoutLocks(rows: Array<BranchItemRow>) {
    return rows.map(({ checkedOutBy: _by, checkedOutAt: _at, ...row }) => row)
  }

  function recordedSince(before: Snapshot, after: Snapshot) {
    return after.events
      .filter((event) => !before.events.some((prior) => prior.id === event.id))
      .map((event) => ({
        type: event.type,
        masterId: event.subjectMasterId,
        actorId: event.actorId,
      }))
  }

  describe.each(OPEN_CHANGE_ORDERS)(
    'a branch whose change order is open %s',
    (_label, instance) => {
      it('is refused, and its rows, locks and events are left as they were', async () => {
        const { branchId } = await changeOrderBranch(instance)
        const before = await snapshot(branchId)

        await expect(
          BranchService.retireBranch(branchId, user.id),
        ).rejects.toThrow(ValidationError)

        expect(await snapshot(branchId)).toEqual(before)
      })
    },
  )

  const RETIRABLE: Array<
    [
      label: string,
      arrange: () => Promise<{ branchId: string; heldMasterId: string }>,
    ]
  > = [
    [
      'a workspace branch',
      async () => {
        const workspace = await BranchService.createWorkspaceBranch(
          designId,
          user.id,
          `retire-${uniquePrefix}`,
        )
        return {
          branchId: workspace.id,
          heldMasterId: await holdLockOn(workspace.id),
        }
      },
    ],
    [
      // A release that merges one design leaves another design's branch,
      // with nothing on it to merge, unarchived
      'a change-order branch whose change order has completed',
      () =>
        changeOrderBranch({
          currentState: 'Released',
          scopeLocked: true,
          completedAt: new Date(),
        }),
    ],
    [
      // What deleting a change order used to leave: a live branch, unowned
      'a change-order branch no change order owns any more',
      async () => {
        const arranged = await changeOrderBranch(null)
        await testDb.db
          .update(branches)
          .set({ changeOrderItemId: null })
          .where(eq(branches.id, arranged.branchId))
        return arranged
      },
    ],
  ]

  describe.each(RETIRABLE)('%s', (_label, arrange) => {
    it('is archived with no lock left on it, each release recorded as a cancellation by its holder', async () => {
      const { branchId, heldMasterId } = await arrange()
      const before = await snapshot(branchId)

      await BranchService.retireBranch(branchId, user.id)

      const after = await snapshot(branchId)
      expect(after.branch.isArchived).toBe(true)
      expect(after.tracking.filter((row) => row.checkedOutBy !== null)).toEqual(
        [],
      )
      expect(withoutLocks(after.tracking)).toEqual(
        withoutLocks(before.tracking),
      )
      expect(recordedSince(before, after)).toEqual(
        expect.arrayContaining([
          {
            type: 'item.checkout_cancelled',
            masterId: heldMasterId,
            actorId: holder.id,
          },
          { type: 'branch.archived', masterId: null, actorId: user.id },
        ]),
      )
      expect(recordedSince(before, after)).toHaveLength(2)
    })
  })

  // How the branch update route used to leave a branch: archived, with the
  // locks on it still held
  it('releases the locks an earlier archive left, and keeps the archive as it was', async () => {
    const workspace = await BranchService.createWorkspaceBranch(
      designId,
      user.id,
      `archived-${uniquePrefix}`,
    )
    const heldMasterId = await holdLockOn(workspace.id)
    await BranchService.archiveBranch(workspace.id, undefined, user.id)
    const before = await snapshot(workspace.id)

    await BranchService.retireBranch(workspace.id, user.id)

    const after = await snapshot(workspace.id)
    expect(after.branch).toEqual(before.branch)
    expect(after.tracking.filter((row) => row.checkedOutBy !== null)).toEqual(
      [],
    )
    expect(withoutLocks(after.tracking)).toEqual(withoutLocks(before.tracking))
    expect(recordedSince(before, after)).toEqual([
      {
        type: 'item.checkout_cancelled',
        masterId: heldMasterId,
        actorId: holder.id,
      },
    ])
  })
})
