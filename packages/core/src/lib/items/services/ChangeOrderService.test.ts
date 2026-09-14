// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * ChangeOrderService Tests
 *
 * Integration tests for the ChangeOrderService class.
 * Tests cover affected items, workflow transitions, validation, and ECO-as-branch functionality.
 *
 * Run: npm run test -- src/lib/items/services/ChangeOrderService.test.ts
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
  vi,
} from 'vitest'
import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import { ChangeOrderService } from './ChangeOrderService'
import { ItemService } from './ItemService'
import type { Part } from '@/lib/items/types/part'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { ChangeOrderReleasedPayload } from '@/lib/events'
import { RevisionService } from '@/lib/services/RevisionService'
import { CommitService } from '@/lib/services/CommitService'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import {
  branchItems as branchItemsTable,
  branches,
  changeOrderAffectedItems,
  changeOrderDesigns,
  changeOrderRisks,
  changeOrders,
  commits,
  designs,
  domainEvents,
  itemFieldChanges,
  itemRelationships,
  itemVersions,
  items as itemsTable,
  programs,
} from '@/lib/db/schema'
import {
  lifecycleDefinitions,
  lifecycleHistory,
  lifecycleInstances,
} from '@/lib/db/schema/lifecycles'
import { ConflictDetectionService } from '@/lib/services/ConflictDetectionService'
import { LifecycleService } from '@/lib/services/LifecycleService'
import { LIFECYCLE_IDS } from '@/lib/items/lifecycle-ids'
import { ItemTypeRegistry } from '@/lib/items/registry'
import {
  SYSTEM_USER_ID,
  overrideItemTypeConfig,
  seedStandardPartLifecycle,
} from '@/__tests__/fixtures/lifecycles'
import { NotFoundError, ValidationError } from '@/lib/errors'
import { takeFirst } from '@/lib/db/take-first'
import { LifecycleInstanceService } from '@/lib/lifecycles/LifecycleInstanceService'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

// Unique workflow definition ID for this test file's ECO workflow.
// Avoids races with other test files that also seed ECO workflows.
const TEST_WORKFLOW_ID = '00000000-0000-4000-8000-000000000112'

// Change Order Workflow definition for testing
// Simplified to allow direct transitions that match test expectations
const changeOrderWorkflowDefinition = {
  states: [
    {
      id: 'Draft',
      name: 'Draft',
      color: 'gray',
      description: 'ECO is being prepared',
      isInitial: true,
      isFinal: false,
    },
    {
      id: 'InReview',
      name: 'InReview',
      color: 'blue',
      description: 'ECO is under review',
      isInitial: false,
      isFinal: false,
    },
    {
      id: 'Approved',
      name: 'Approved',
      color: 'green',
      description: 'ECO has been approved',
      isInitial: false,
      isFinal: false,
    },
    {
      id: 'Implemented',
      name: 'Implemented',
      color: 'green',
      description: 'ECO changes have been implemented',
      isInitial: false,
      isFinal: false,
    },
    {
      id: 'Released',
      name: 'Released',
      color: 'green',
      description: 'ECO has been released',
      isInitial: false,
      isFinal: false,
    },
    {
      id: 'Closed',
      name: 'Closed',
      color: 'slate',
      description: 'ECO has been closed',
      isInitial: false,
      isFinal: true,
      finalKind: 'release',
    },
    {
      id: 'Rejected',
      name: 'Rejected',
      color: 'red',
      description: 'ECO was rejected',
      isInitial: false,
      isFinal: true,
      finalKind: 'cancel',
    },
    {
      id: 'Cancelled',
      name: 'Cancelled',
      color: 'gray',
      description: 'ECO was cancelled',
      isInitial: false,
      isFinal: true,
      finalKind: 'cancel',
    },
  ],
  transitions: [
    {
      id: 't1',
      name: 'Submit',
      fromStateId: 'Draft',
      toStateId: 'InReview',
      description: 'Submit ECO for review',
    },
    {
      id: 't2',
      name: 'Approve',
      fromStateId: 'InReview',
      toStateId: 'Approved',
      description: 'Approve the ECO',
    },
    {
      id: 't3',
      name: 'Reject',
      fromStateId: 'InReview',
      toStateId: 'Rejected',
      description: 'Reject the ECO',
    },
    {
      id: 't4',
      name: 'Return to Draft',
      fromStateId: 'InReview',
      toStateId: 'Draft',
      description: 'Return to submitter',
    },
    {
      id: 't5',
      name: 'Implement',
      fromStateId: 'Approved',
      toStateId: 'Implemented',
      description: 'Implement the changes',
    },
    {
      id: 't6',
      name: 'Close',
      fromStateId: 'Implemented',
      toStateId: 'Closed',
      description: 'Close the ECO',
    },
    {
      id: 't7',
      name: 'Cancel',
      fromStateId: 'Draft',
      toStateId: 'Cancelled',
      description: 'Cancel the ECO',
    },
    {
      id: 't8',
      name: 'Cancel',
      fromStateId: 'InReview',
      toStateId: 'Cancelled',
      description: 'Cancel the ECO',
    },
    {
      id: 't9',
      name: 'Release',
      fromStateId: 'Approved',
      toStateId: 'Released',
      description: 'Release the ECO (merge branches)',
    },
    {
      id: 't10',
      name: 'Close',
      fromStateId: 'Released',
      toStateId: 'Closed',
      description: 'Close the released ECO',
    },
  ],
  description: 'Simplified test workflow for Engineering Change Orders',
  applicableItemTypes: ['ChangeOrder'],
}

// A flexible Driving definition whose state ids share nothing with the strict
// one above. Claimed by this file like TEST_WORKFLOW_ID; not a real lifecycle.
const FLEXIBLE_WORKFLOW_ID = '00000000-0000-4000-8000-00000000c0f1'

const flexibleChangeOrderWorkflowDefinition = {
  states: [
    {
      id: 'start',
      name: 'Start',
      color: 'gray',
      isInitial: true,
      isFinal: false,
    },
    {
      id: 'complete',
      name: 'Complete',
      color: 'green',
      isInitial: false,
      isFinal: true,
      finalKind: 'release',
    },
  ],
  transitions: [
    {
      id: 'f1',
      name: 'Complete',
      fromStateId: 'start',
      toStateId: 'complete',
    },
  ],
  description: 'Flexible test workflow for XCO change orders',
  applicableItemTypes: ['ChangeOrder'],
}

describe('ChangeOrderService', () => {
  const testDb = new TestDatabase()
  let restoreItemTypeConfig: (() => Promise<void>) | undefined
  let user: TestUser
  let designId: string

  beforeAll(async () => {
    await testDb.setup()

    // System user + Part lifecycle + Part item-type link via shared fixture
    await seedStandardPartLifecycle(testDb.db)

    // ECO workflow is specific to this test file — uses a unique ID to avoid
    // races with other test files that seed their own ECO workflows.
    await testDb.db
      .insert(lifecycleDefinitions)
      .values({
        id: TEST_WORKFLOW_ID,
        name: 'ECO - CO Test Workflow',
        version: 1,
        workflowType: 'strict',
        definition: changeOrderWorkflowDefinition,
        isActive: true,
        lifecycleType: 'Driving',
      })
      .onConflictDoUpdate({
        target: lifecycleDefinitions.id,
        set: {
          definition: changeOrderWorkflowDefinition,
          workflowType: 'strict',
          lifecycleType: 'Driving',
        },
      })

    // A second Driving definition with state ids of its own, mapped to XCO:
    // the shape in which a change order was stamped from the type's
    // definition while its instance ran this one.
    await testDb.db
      .insert(lifecycleDefinitions)
      .values({
        id: FLEXIBLE_WORKFLOW_ID,
        name: 'XCO - CO Test Flexible Workflow',
        version: 1,
        workflowType: 'flexible',
        definition: flexibleChangeOrderWorkflowDefinition,
        isActive: true,
        lifecycleType: 'Driving',
      })
      .onConflictDoUpdate({
        target: lifecycleDefinitions.id,
        set: {
          definition: flexibleChangeOrderWorkflowDefinition,
          workflowType: 'flexible',
          lifecycleType: 'Driving',
        },
      })

    // Link ChangeOrder item type to the ECO workflow
    restoreItemTypeConfig = await overrideItemTypeConfig(
      testDb.db,
      'ChangeOrder',
      {
        lifecycleDefinitionId: TEST_WORKFLOW_ID,
        lifecyclesByChangeType: {
          ECO: TEST_WORKFLOW_ID,
          ECN: TEST_WORKFLOW_ID,
          Deviation: TEST_WORKFLOW_ID,
          MCO: TEST_WORKFLOW_ID,
          XCO: FLEXIBLE_WORKFLOW_ID,
        },
      },
      SYSTEM_USER_ID,
    )
  })

  afterAll(async () => {
    // Shared row: put back what this suite found before it wrote.
    await restoreItemTypeConfig?.()
    await testDb.teardown()
  })

  // Generate unique prefix for test isolation
  let uniquePrefix: string

  /**
   * Drive a change order through its workflow the way the product does.
   * The old `submit()`/`approve()` convenience wrappers are gone — they were an
   * alternative entry point that skipped `executeWorkflowTransition`'s release
   * claim, which is the interlock that keeps a failed merge retryable.
   */
  async function transitionTo(changeOrderId: string, toStateId: string) {
    const { result } = await ChangeOrderService.executeWorkflowTransition(
      changeOrderId,
      toStateId,
      user.id,
    )
    if (!result.success) {
      throw new Error(`transitionTo(${toStateId}) failed: ${result.error}`)
    }
  }

  beforeEach(async () => {
    await testDb.beginTransaction()

    // Generate unique prefix for this test run
    uniquePrefix = `T${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`

    // Create test user (let fixture generate unique email)
    user = await insertTestUser(testDb.db)

    // Create test design with branch structure
    const createdDesign = takeFirst(
      await testDb.db
        .insert(designs)
        .values({
          name: 'Test Design',
          code: `PROD-${uniquePrefix}`,
          designType: 'Engineering',
          createdBy: user.id,
        })
        .returning(),
    )

    // Branch first, then the commit on it — commits.branch_id is a real FK
    // now, so the old placeholder-then-fixup order cannot insert.
    const mainBranch = takeFirst(
      await testDb.db
        .insert(branches)
        .values({
          designId: createdDesign.id,
          name: 'main',
          branchType: 'main',
          createdBy: user.id,
        })
        .returning(),
    )

    const initialCommit = takeFirst(
      await testDb.db
        .insert(commits)
        .values({
          designId: createdDesign.id,
          branchId: mainBranch.id,
          message: 'Initial commit',
          createdBy: user.id,
        })
        .returning(),
    )

    await testDb.db
      .update(branches)
      .set({ headCommitId: initialCommit.id, baseCommitId: initialCommit.id })
      .where(eq(branches.id, mainBranch.id))

    const [updated] = await testDb.db
      .update(designs)
      .set({ defaultBranchId: mainBranch.id })
      .where(eq(designs.id, createdDesign.id))
      .returning()

    expect(updated).toBeDefined()
    designId = updated!.id
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  // Helper to create a change order with workflow instance
  // ChangeOrders are exempt from branch protection (workflow control objects)
  // Note: ChangeOrders use auto-generated item numbers, so itemNumber is not passed
  async function createChangeOrder(overrides: Record<string, any> = {}) {
    const changeOrder = await ItemService.create(
      'ChangeOrder',
      {
        // itemNumber is auto-generated for ChangeOrders
        revision: 'A',
        name: 'Test Change Order',
        changeType: 'ECO',
        priority: 'medium',
        reasonForChange: 'Test reason',
        designId,
        ...overrides,
      } as any,
      user.id,
    )

    // Start workflow instance for the change order
    await testDb.db.insert(lifecycleInstances).values({
      workflowDefinitionId: TEST_WORKFLOW_ID,
      itemId: changeOrder.id,
      currentState: 'Draft',
      context: { actorId: user.id },
    })

    return changeOrder
  }

  // Helper to create a part
  // Bypasses branch protection since these tests focus on ChangeOrderService logic, not branch protection
  async function createPart(overrides: Record<string, any> = {}) {
    return ItemService.create(
      'Part',
      {
        itemNumber: `PN-${uniquePrefix}-${Math.random().toString(36).slice(2, 7)}`,
        revision: 'A',
        name: 'Test Part',
        designId,
        ...overrides,
      } as any,
      user.id,
      { bypassBranchProtection: true },
    )
  }

  // Helper: create a second design with a main branch (mirrors beforeEach).
  async function createDesign(codeSuffix: string): Promise<string> {
    const d = takeFirst(
      await testDb.db
        .insert(designs)
        .values({
          name: `Test Design ${codeSuffix}`,
          code: `PROD-${uniquePrefix}-${codeSuffix}`,
          designType: 'Engineering',
          createdBy: user.id,
        })
        .returning(),
    )
    const b = takeFirst(
      await testDb.db
        .insert(branches)
        .values({
          designId: d.id,
          name: 'main',
          branchType: 'main',
          createdBy: user.id,
        })
        .returning(),
    )
    const c = takeFirst(
      await testDb.db
        .insert(commits)
        .values({
          designId: d.id,
          branchId: b.id,
          message: 'Initial commit',
          createdBy: user.id,
        })
        .returning(),
    )
    await testDb.db
      .update(branches)
      .set({ headCommitId: c.id, baseCommitId: c.id })
      .where(eq(branches.id, b.id))
    await testDb.db
      .update(designs)
      .set({ defaultBranchId: b.id })
      .where(eq(designs.id, d.id))
    return d.id
  }

  describe('create', () => {
    const input = (changeType: string, name: string) => ({
      revision: 'A',
      name,
      changeType,
      priority: 'medium',
      reasonForChange: 'Test',
    })

    it('creates the change order with its workflow running and its state stamped from it', async () => {
      const changeOrder = await ChangeOrderService.create(
        input('ECO', 'Created ECO'),
        [designId],
        user.id,
      )
      const changeOrderInstance = await ChangeOrderService.getWorkflowInstance(
        changeOrder.id!,
      )
      expect(changeOrderInstance?.workflowDefinitionId).toBe(TEST_WORKFLOW_ID)
      expect(changeOrderInstance?.currentState).toBe('Draft')
      expect(changeOrder.state).toBe('Draft')

      // A change type mapped to another definition starts that one, and the
      // state follows it rather than the type's definition
      const xco = await ChangeOrderService.create(
        input('XCO', 'Created XCO'),
        [designId],
        user.id,
      )
      const xcoInstance = await ChangeOrderService.getWorkflowInstance(xco.id!)
      expect(xcoInstance?.workflowDefinitionId).toBe(FLEXIBLE_WORKFLOW_ID)
      expect(xcoInstance?.currentState).toBe('start')
      expect(xco.state).toBe('start')
      expect((await ItemService.findById(xco.id!))?.state).toBe('start')
    })

    it('creates nothing when the change type has no workflow configured', async () => {
      const original = ItemTypeRegistry.getRuntimeConfig.bind(ItemTypeRegistry)
      const config = vi
        .spyOn(ItemTypeRegistry, 'getRuntimeConfig')
        .mockImplementation((name) =>
          name === 'ChangeOrder'
            ? {
                ...original(name),
                lifecyclesByChangeType: { ECO: TEST_WORKFLOW_ID },
              }
            : original(name),
        )
      const liveBranches = () =>
        testDb.db
          .select({ id: branches.id })
          .from(branches)
          .where(
            and(
              eq(branches.designId, designId),
              eq(branches.isArchived, false),
            ),
          )
      const liveBefore = await liveBranches()

      try {
        await expect(
          ChangeOrderService.create(
            input('MCO', 'Unconfigured MCO'),
            [designId],
            user.id,
          ),
        ).rejects.toThrow(ValidationError)
      } finally {
        config.mockRestore()
      }

      // Rolled back whole: no change order, and the branch its design link
      // made is not left open on the design
      const rows = await testDb.db
        .select({ id: itemsTable.id })
        .from(itemsTable)
        .where(eq(itemsTable.name, 'Unconfigured MCO'))
      expect(rows).toHaveLength(0)
      expect(await liveBranches()).toHaveLength(liveBefore.length)
    })

    it('refuses an unknown change type before creating anything', async () => {
      await expect(
        ChangeOrderService.create(
          input('Bogus', 'Bogus change type'),
          [designId],
          user.id,
        ),
      ).rejects.toThrow(ValidationError)

      const rows = await testDb.db
        .select({ id: itemsTable.id })
        .from(itemsTable)
        .where(eq(itemsTable.name, 'Bogus change type'))
      expect(rows).toHaveLength(0)
    })
  })

  describe('addAffectedItem', () => {
    it('adds an affected item with release action', async () => {
      const changeOrder = await createChangeOrder()
      const part = await createPart()

      const affected = await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        {
          affectedItemId: part.id,
          changeAction: 'release',
        },
        user.id,
      )

      expect(affected).toBeDefined()
      expect(affected.id).toBeDefined()
      expect(affected.changeOrderId).toBe(changeOrder.id)
      expect(affected.affectedItemId).toBe(part.id)
      expect(affected.changeAction).toBe('release')
      // Target resolved from the lifecycle, not supplied by the caller
      expect(affected.targetState).toBe('Released')
    })

    it('adds an affected item with revise action', async () => {
      const changeOrder = await createChangeOrder()
      const part = await createPart({ state: 'Released' })

      const affected = await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        {
          affectedItemId: part.id,
          changeAction: 'revise',
        },
        user.id,
      )

      expect(affected.changeAction).toBe('revise')
      // Snapshot and prediction both come from the item and its lifecycle
      expect(affected.currentRevision).toBe('A')
      expect(affected.targetRevision).toBe('B')
    })

    it('adds an affected item with obsolete action', async () => {
      const changeOrder = await createChangeOrder()
      const part = await createPart({ state: 'Released' })
      const replacement = await createPart({ name: 'Replacement Part' })

      const affected = await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        {
          affectedItemId: part.id,
          changeAction: 'obsolete',
          replacementItemId: replacement.id,
        },
        user.id,
      )

      expect(affected.changeAction).toBe('obsolete')
      expect(affected.replacementItemId).toBe(replacement.id)
    })

    it('adds an affected item with add action for new items', async () => {
      const changeOrder = await createChangeOrder()
      const newItemNumber = `PN-${uniquePrefix}-NEW-001`

      const affected = await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        {
          changeAction: 'release',
          newItemType: 'Part',
          newItemData: { name: 'New Part', itemNumber: newItemNumber },
        },
        user.id,
      )

      expect(affected.changeAction).toBe('release')
      expect(affected.newItemType).toBe('Part')
      expect(affected.newItemData).toEqual({
        name: 'New Part',
        itemNumber: newItemNumber,
      })
    })

    it('records change description', async () => {
      const changeOrder = await createChangeOrder()
      // 'revise' action requires the item to be in 'Released' state
      const part = await createPart({ state: 'Released' })

      const affected = await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        {
          affectedItemId: part.id,
          changeAction: 'revise',
          changeDescription: 'Updating material specification',
        },
        user.id,
      )

      expect(affected.changeDescription).toBe('Updating material specification')
    })

    it('creates a ChangeOrder created commit when design association is first made', async () => {
      const changeOrder = await createChangeOrder()
      const part = await createPart()

      // Adding affected item should create the design association and commit
      await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        { affectedItemId: part.id, changeAction: 'release' },
        user.id,
      )

      // Get the ECO designs for this change order
      const ecoDesigns = await ChangeOrderService.getChangeOrderDesigns(
        changeOrder.id,
      )
      expect(ecoDesigns.length).toBe(1)

      // Find commits on the ECO branch
      const branchCommits = await testDb.db
        .select()
        .from(commits)
        .where(eq(commits.branchId, ecoDesigns[0]!.branchId!))

      // Should have a commit with "ChangeOrder xxx created" message
      const creationCommit = branchCommits.find(
        (c) =>
          c.message.includes('ChangeOrder') && c.message.includes('created'),
      )
      expect(creationCommit).toBeDefined()
      expect(creationCommit!.message).toBe(
        `ChangeOrder ${changeOrder.itemNumber} created`,
      )
    })

    it('release does NOT associate other designs that merely hold usage copies', async () => {
      const changeOrder = await createChangeOrder()
      const definition = await createPart()

      // A second design holds a usage copy of the definition.
      const otherDesignId = await createDesign('B')
      const usage = await createPart({
        designId: otherDesignId,
        name: 'Usage copy',
      })
      await testDb.db
        .update(itemsTable)
        .set({ usageOf: definition.id })
        .where(eq(itemsTable.id, usage.id))

      await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        { affectedItemId: definition.id, changeAction: 'release' },
        user.id,
      )

      // Only the definition's OWN design is associated with the release ECO —
      // the usage-copy design must NOT be pulled in (it has no affected items,
      // and associating it would leak the ECO's baseline onto it).
      const ecoDesigns = await ChangeOrderService.getChangeOrderDesigns(
        changeOrder.id,
      )
      expect(ecoDesigns.map((d) => d.designId)).toEqual([designId])
    })
  })

  describe('duplicate affected items', () => {
    it('refuses to add the same item to a change order twice', async () => {
      const changeOrder = await createChangeOrder()
      const part = await createPart({ state: 'Released' })

      await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        { affectedItemId: part.id, changeAction: 'revise' },
        user.id,
      )

      // 'revise' and 'obsolete' are each individually valid from Released, so
      // both rows would be accepted and the merge would process them in
      // whatever order the table returned - leaving the released state up to
      // row ordering.
      await expect(
        ChangeOrderService.addAffectedItem(
          changeOrder.id,
          { affectedItemId: part.id, changeAction: 'obsolete' },
          user.id,
        ),
      ).rejects.toThrow(ValidationError)

      expect(
        await ChangeOrderService.getAffectedItems(changeOrder.id),
      ).toHaveLength(1)
    })
  })

  describe('removeAffectedItem', () => {
    it('removes an existing affected item', async () => {
      const changeOrder = await createChangeOrder()
      const part = await createPart()

      const affected = await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        { affectedItemId: part.id, changeAction: 'release' },
        user.id,
      )

      await ChangeOrderService.removeAffectedItem(changeOrder.id, affected.id!)

      const items = await ChangeOrderService.getAffectedItems(changeOrder.id)
      expect(items).toHaveLength(0)
    })

    it('rejects an unknown affected item', async () => {
      const changeOrder = await createChangeOrder()

      await expect(
        ChangeOrderService.removeAffectedItem(
          changeOrder.id,
          '00000000-0000-0000-0000-000000000000',
        ),
      ).rejects.toThrow(NotFoundError)
    })

    it('refuses to remove an affected item belonging to another change order', async () => {
      const ownerChangeOrder = await createChangeOrder()
      const otherChangeOrder = await createChangeOrder()
      const part = await createPart()

      const affected = await ChangeOrderService.addAffectedItem(
        ownerChangeOrder.id,
        { affectedItemId: part.id, changeAction: 'release' },
        user.id,
      )

      // An affected-item row id is not authority to delete it: the ECO that
      // owns the row is what scopes the delete.
      await expect(
        ChangeOrderService.removeAffectedItem(
          otherChangeOrder.id,
          affected.id!,
        ),
      ).rejects.toThrow(NotFoundError)

      const stillThere = await ChangeOrderService.getAffectedItems(
        ownerChangeOrder.id,
      )
      expect(stillThere).toHaveLength(1)
    })

    it('refuses removal while the item still carries branch changes', async () => {
      const changeOrder = await createChangeOrder()
      const part = await createPart({ state: 'Released' })

      // 'revise' on a Released item creates a working copy + branch change
      const affected = await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        { affectedItemId: part.id, changeAction: 'revise' },
        user.id,
      )
      expect(affected.workingCopyId).toBeTruthy()

      // Removing only the paperwork would leave the branch change to release
      // anyway - the reviewed scope and the released result must not diverge.
      await expect(
        ChangeOrderService.removeAffectedItem(changeOrder.id, affected.id!),
      ).rejects.toThrow(ValidationError)

      expect(
        await ChangeOrderService.getAffectedItems(changeOrder.id),
      ).toHaveLength(1)
    })

    it('removes the branch change too when discarding is explicit', async () => {
      const changeOrder = await createChangeOrder()
      const part = await createPart({ state: 'Released' })

      const affected = await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        { affectedItemId: part.id, changeAction: 'revise' },
        user.id,
      )
      // An engineer holds the working copy's lock when the change is dropped.
      await testDb.db
        .update(branchItemsTable)
        .set({ checkedOutBy: user.id, checkedOutAt: new Date() })
        .where(
          and(
            eq(branchItemsTable.itemMasterId, part.masterId),
            isNotNull(branchItemsTable.changeType),
          ),
        )

      await ChangeOrderService.removeAffectedItem(
        changeOrder.id,
        affected.id!,
        {
          discardBranchChanges: true,
        },
      )

      // The lock went with the change, and the log says so: a projection of
      // who holds what would otherwise keep it for good.
      const cancelled = await testDb.db
        .select()
        .from(domainEvents)
        .where(
          and(
            eq(domainEvents.type, 'item.checkout_cancelled'),
            eq(domainEvents.subjectMasterId, part.masterId),
          ),
        )
      expect(cancelled).toHaveLength(1)
      expect(cancelled[0]!.actorId).toBe(user.id)

      expect(
        await ChangeOrderService.getAffectedItems(changeOrder.id),
      ).toHaveLength(0)

      // The branch no longer reports a change for this master, so the merge
      // has nothing to release for it.
      const ecoDesigns = await ChangeOrderService.getChangeOrderDesigns(
        changeOrder.id,
      )
      const branchIds = ecoDesigns
        .map((d) => d.branchId)
        .filter((id): id is string => id !== null)
      const remaining = branchIds.length
        ? await testDb.db
            .select()
            .from(branchItemsTable)
            .where(eq(branchItemsTable.itemMasterId, part.masterId))
        : []
      expect(remaining.filter((r) => r.changeType !== null)).toHaveLength(0)
    })

    it('refuses removal once ECO scope is locked', async () => {
      const changeOrder = await createChangeOrder()
      const part = await createPart()

      const affected = await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        { affectedItemId: part.id, changeAction: 'release' },
        user.id,
      )

      await testDb.db
        .update(lifecycleInstances)
        .set({ scopeLocked: true, scopeLockedAt: new Date() })
        .where(eq(lifecycleInstances.itemId, changeOrder.id))

      await expect(
        ChangeOrderService.removeAffectedItem(changeOrder.id, affected.id!),
      ).rejects.toThrow(ValidationError)
    })
  })

  describe('getAffectedItems', () => {
    it('returns affected items with item details', async () => {
      const changeOrder = await createChangeOrder()
      // part1 uses 'release' action which is valid for Draft state
      const part1 = await createPart({ name: 'Part One' })
      // part2 uses 'revise' action which requires 'Released' state
      const part2 = await createPart({ name: 'Part Two', state: 'Released' })

      await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        { affectedItemId: part1.id, changeAction: 'release' },
        user.id,
      )
      await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        { affectedItemId: part2.id, changeAction: 'revise' },
        user.id,
      )

      const items = await ChangeOrderService.getAffectedItems(changeOrder.id)

      expect(items).toHaveLength(2)
      expect(items[0]?.affectedItemDetails).toBeDefined()
      expect(
        items.some((i) => i.affectedItemDetails?.name === 'Part One'),
      ).toBe(true)
      expect(
        items.some((i) => i.affectedItemDetails?.name === 'Part Two'),
      ).toBe(true)
    })

    it('returns empty array for change order with no affected items', async () => {
      const changeOrder = await createChangeOrder()

      const items = await ChangeOrderService.getAffectedItems(changeOrder.id)

      expect(items).toEqual([])
    })
  })

  describe('getRisks', () => {
    it('returns risks for a change order', async () => {
      const changeOrder = await createChangeOrder()

      // Manually insert a risk
      await testDb.db.insert(changeOrderRisks).values({
        changeOrderId: changeOrder.id,
        category: 'production',
        severity: 'high',
        description: 'Test risk',
        requiresAcknowledgement: true,
      })

      const risks = await ChangeOrderService.getRisks(changeOrder.id)

      expect(risks).toHaveLength(1)
      expect(risks[0]).toMatchObject({
        category: 'production',
        severity: 'high',
      })
    })

    it('returns empty array when no risks', async () => {
      const changeOrder = await createChangeOrder()

      const risks = await ChangeOrderService.getRisks(changeOrder.id)

      expect(risks).toEqual([])
    })
  })

  describe('acknowledgeRisk', () => {
    it('records acknowledgement with user and timestamp', async () => {
      const changeOrder = await createChangeOrder()

      const risk = takeFirst(
        await testDb.db
          .insert(changeOrderRisks)
          .values({
            changeOrderId: changeOrder.id,
            category: 'production',
            severity: 'critical',
            description: 'Critical risk requiring acknowledgement',
            requiresAcknowledgement: true,
          })
          .returning(),
      )

      await ChangeOrderService.acknowledgeRiskForChangeOrder(
        changeOrder.id,
        risk.id,
        user.id,
      )

      const risks = await ChangeOrderService.getRisks(changeOrder.id)

      expect(risks[0]).toMatchObject({ acknowledgedBy: user.id })
      expect(risks[0]?.acknowledgedAt).toBeDefined()
    })
  })

  describe('release gates', () => {
    it('refuses to release with an unacknowledged critical risk', async () => {
      const changeOrder = await createChangeOrder()
      const part = await createPart()

      await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        { affectedItemId: part.id, changeAction: 'release' },
        user.id,
      )

      await testDb.db.insert(changeOrderRisks).values({
        changeOrderId: changeOrder.id,
        category: 'production',
        severity: 'critical',
        description: 'Critical risk',
        requiresAcknowledgement: true,
      })

      // The gate runs before the release claim is taken, so a refusal leaves
      // nothing to clean up. (This invariant used to be reachable only through
      // the `approve()` wrapper, which nothing in production called.)
      await expect(
        ChangeOrderService.assertReleaseGates(changeOrder.id),
      ).rejects.toThrow(ValidationError)
    })

    it('allows release once the critical risk is acknowledged', async () => {
      const changeOrder = await createChangeOrder()
      const part = await createPart()

      await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        { affectedItemId: part.id, changeAction: 'release' },
        user.id,
      )

      const risk = takeFirst(
        await testDb.db
          .insert(changeOrderRisks)
          .values({
            changeOrderId: changeOrder.id,
            category: 'production',
            severity: 'critical',
            description: 'Critical risk',
            requiresAcknowledgement: true,
          })
          .returning(),
      )

      await ChangeOrderService.acknowledgeRiskForChangeOrder(
        changeOrder.id,
        risk.id,
        user.id,
      )

      await expect(
        ChangeOrderService.assertReleaseGates(changeOrder.id),
      ).resolves.toBeUndefined()
    })
  })

  describe('workflow milestones', () => {
    it('stamps submittedAt when the change order leaves its initial state', async () => {
      const changeOrder = await createChangeOrder()
      const part = await createPart()

      await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        { affectedItemId: part.id, changeAction: 'release' },
        user.id,
      )

      const before = takeFirst(
        await testDb.db
          .select()
          .from(changeOrders)
          .where(eq(changeOrders.itemId, changeOrder.id)),
      )
      expect(before.submittedAt).toBeNull()

      await transitionTo(changeOrder.id, 'InReview')

      // Shown on the detail page and the design's ECO list. It was previously
      // written only by the dead `submit()` wrapper, so in the shipped product
      // it was always blank.
      const after = takeFirst(
        await testDb.db
          .select()
          .from(changeOrders)
          .where(eq(changeOrders.itemId, changeOrder.id)),
      )
      expect(after.submittedAt).toBeInstanceOf(Date)
    })

    it('keeps the original submittedAt across a rework round trip', async () => {
      const changeOrder = await createChangeOrder()
      const part = await createPart()

      await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        { affectedItemId: part.id, changeAction: 'release' },
        user.id,
      )

      await transitionTo(changeOrder.id, 'InReview')
      const first = takeFirst(
        await testDb.db
          .select()
          .from(changeOrders)
          .where(eq(changeOrders.itemId, changeOrder.id)),
      ).submittedAt

      await transitionTo(changeOrder.id, 'Draft')
      await transitionTo(changeOrder.id, 'InReview')

      const second = takeFirst(
        await testDb.db
          .select()
          .from(changeOrders)
          .where(eq(changeOrders.itemId, changeOrder.id)),
      ).submittedAt

      expect(second).toEqual(first)
    })
  })

  describe('release summary', () => {
    it('reports what a release without a branch released, read from its commits', async () => {
      const changeOrder = await createChangeOrder()
      const part = await createPart()
      await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        { affectedItemId: part.id, changeAction: 'release' },
        user.id,
      )

      await transitionTo(changeOrder.id, 'InReview')
      await transitionTo(changeOrder.id, 'Approved')
      await transitionTo(changeOrder.id, 'Implemented')
      await transitionTo(changeOrder.id, 'Closed')

      const [released] = await testDb.db
        .select()
        .from(domainEvents)
        .where(
          and(
            eq(domainEvents.type, 'change_order.released'),
            eq(domainEvents.subjectId, changeOrder.id),
          ),
        )
      const payload = released?.payload as ChangeOrderReleasedPayload
      // No branch merged, and the list used to be built from branch merges
      // alone, so a release like this one reported nothing released.
      const [releaseCommit] = await testDb.db
        .select()
        .from(commits)
        .where(
          and(
            eq(commits.changeOrderItemId, changeOrder.id),
            isNotNull(commits.revisionsAssigned),
          ),
        )
      expect(payload.releases).toHaveLength(1)
      expect(payload.releases[0]).toMatchObject({
        designId,
        mergeCommitId: releaseCommit?.id,
      })
      expect(payload.totalRevisionsAssigned).toBe(
        Object.keys(payload.releases[0]!.revisionsAssigned).length,
      )
    })
  })

  describe('close', () => {
    // Note: close() calls releaseChangeOrder() which requires 'Approved' state
    // In simplified workflow, close() from Approved state stays in Approved (no transition)
    // The ECO-as-branch workflow just processes affected items and sets closedAt
    it('processes release and stays in Approved state for simplified workflow', async () => {
      const changeOrder = await createChangeOrder()
      const part = await createPart()

      // Add affected item (required for submit)
      await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        { affectedItemId: part.id, changeAction: 'release' },
        user.id,
      )

      // close() uses releaseChangeOrder() which handles branch merging
      // It requires 'Approved' state, not 'Implemented'
      await transitionTo(changeOrder.id, 'InReview')
      await transitionTo(changeOrder.id, 'Approved')
      await ChangeOrderService.close(changeOrder.id, user.id)

      const updated = await ItemService.findById(changeOrder.id)
      // In simplified workflow, close() from Approved doesn't transition state
      expect(updated?.state).toBe('Approved')
    })

    it('updates closedAt timestamp', async () => {
      const changeOrder = await createChangeOrder()
      const part = await createPart()

      // Add affected item (required for submit)
      await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        { affectedItemId: part.id, changeAction: 'release' },
        user.id,
      )

      await transitionTo(changeOrder.id, 'InReview')
      await transitionTo(changeOrder.id, 'Approved')
      await ChangeOrderService.close(changeOrder.id, user.id)

      const coRecord = await testDb.db
        .select()
        .from(changeOrders)
        .where(eq(changeOrders.itemId, changeOrder.id))
        .limit(1)

      expect(coRecord[0]?.closedAt).toBeDefined()
    })
  })

  describe('getChangeOrderDesigns', () => {
    it('returns empty array when no designs associated', async () => {
      const changeOrder = await createChangeOrder()

      const ecoDesigns = await ChangeOrderService.getChangeOrderDesigns(
        changeOrder.id,
      )

      expect(ecoDesigns).toEqual([])
    })
  })

  describe('getImpactReport', () => {
    it('returns null when no impact report exists', async () => {
      const changeOrder = await createChangeOrder()

      const report = await ChangeOrderService.getImpactReport(changeOrder.id)

      expect(report).toBeNull()
    })
  })

  describe('autoStartWorkflow', () => {
    it('starts workflow for configured changeType', async () => {
      // Create change order WITHOUT workflow instance (to test autoStart)
      // Note: ChangeOrders use auto-generated item numbers
      const changeOrder = await ItemService.create(
        'ChangeOrder',
        {
          // itemNumber is auto-generated for ChangeOrders
          revision: 'A',
          name: 'AutoStart Test ECO',
          changeType: 'ECO',
          priority: 'medium',
          reasonForChange: 'Test autostart',
          designId,
        } as any,
        user.id,
      )

      // autoStartWorkflow should create a workflow instance
      const instance = await ChangeOrderService.autoStartWorkflow(
        changeOrder.id,
        'ECO',
        user.id,
      )

      expect(instance).toBeDefined()
      expect(instance.itemId).toBe(changeOrder.id)
      expect(instance.currentState).toBe('Draft')
      expect(instance.workflowDefinitionId).toBe(TEST_WORKFLOW_ID)
    })

    it('starts workflow for MCO changeType', async () => {
      // Create change order WITHOUT workflow instance
      // Note: ChangeOrders use auto-generated item numbers (ECO prefix regardless of changeType)
      const changeOrder = await ItemService.create(
        'ChangeOrder',
        {
          // itemNumber is auto-generated for ChangeOrders
          revision: 'A',
          name: 'AutoStart Test MCO',
          changeType: 'MCO',
          priority: 'medium',
          reasonForChange: 'Test MCO autostart',
          designId,
        } as any,
        user.id,
      )

      // MCO is mapped to the same workflow
      const instance = await ChangeOrderService.autoStartWorkflow(
        changeOrder.id,
        'MCO',
        user.id,
      )

      expect(instance).toBeDefined()
      expect(instance.currentState).toBe('Draft')
    })

    it('records the state it restamps when the workflow starts somewhere else', async () => {
      const definitionId = '00000000-0000-4000-8000-000000000232'
      await testDb.db
        .insert(lifecycleDefinitions)
        .values({
          id: definitionId,
          name: 'Test ECO Workflow - Proposed start',
          version: 1,
          workflowType: 'strict',
          definition: {
            states: [
              {
                id: 'Proposed',
                name: 'Proposed',
                isInitial: true,
                isFinal: false,
              },
              {
                id: 'Done',
                name: 'Done',
                isInitial: false,
                isFinal: true,
                finalKind: 'release',
              },
            ],
            transitions: [
              {
                id: 't1',
                name: 'Finish',
                fromStateId: 'Proposed',
                toStateId: 'Done',
              },
            ],
            applicableItemTypes: ['ChangeOrder'],
          },
          isActive: true,
          lifecycleType: 'Driving',
        })
        .onConflictDoNothing()
      const changeOrder = await ItemService.create(
        'ChangeOrder',
        {
          revision: 'A',
          name: 'Restamped ECO',
          changeType: 'ECO',
          priority: 'medium',
          reasonForChange: 'Restamp',
          designId,
        } as any,
        user.id,
      )

      await ChangeOrderService.startWorkflow(
        changeOrder.id,
        definitionId,
        user.id,
      )

      // `item.created` said the change order was in the type's initial state;
      // the workflow started it in its own, and the log has to say so.
      const updates = await testDb.db
        .select()
        .from(domainEvents)
        .where(
          and(
            eq(domainEvents.type, 'item.updated'),
            eq(domainEvents.subjectId, changeOrder.id),
          ),
        )
      expect(updates).toHaveLength(1)
      expect(updates[0]!.payload).toMatchObject({
        state: 'Proposed',
        changedFields: ['state'],
      })
    })
  })

  describe('addAffectedItemsBatch', () => {
    it('adds multiple affected items in batch', async () => {
      const changeOrder = await createChangeOrder()
      const part1 = await createPart({ name: 'Batch Part 1' })
      const part2 = await createPart({ name: 'Batch Part 2' })

      const results = await ChangeOrderService.addAffectedItemsBatch(
        changeOrder.id,
        [
          { affectedItemId: part1.id, changeAction: 'release' },
          { affectedItemId: part2.id, changeAction: 'release' },
        ],
        user.id,
      )

      expect(results).toHaveLength(2)
      const items = await ChangeOrderService.getAffectedItems(changeOrder.id)
      expect(items).toHaveLength(2)
    })

    it('skips an item already present under a different version id', async () => {
      const changeOrder = await createChangeOrder()
      const part = await createPart()

      await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        { affectedItemId: part.id, changeAction: 'release' },
        user.id,
      )

      // A second version of the same logical item: same masterId, different
      // items.id — what a branch working copy or a later revision looks like.
      const laterVersion = takeFirst(
        await testDb.db
          .insert(itemsTable)
          .values({
            masterId: part.masterId,
            itemNumber: part.itemNumber,
            revision: '-abc12345',
            itemType: 'Part',
            name: part.name,
            state: 'Draft',
            designId,
            isCurrent: false,
            createdBy: user.id,
            modifiedBy: user.id,
          })
          .returning(),
      )

      // Keyed on the item's id this looks absent; keyed on masterId it is
      // present. The batch must agree with addAffectedItem, which rejects the
      // masterId duplicate — otherwise the whole batch throws instead of
      // skipping the one item it already had.
      const results = await ChangeOrderService.addAffectedItemsBatch(
        changeOrder.id,
        [{ affectedItemId: laterVersion.id, changeAction: 'release' }],
        user.id,
      )

      expect(results).toHaveLength(1)
      const stored = await ChangeOrderService.getAffectedItems(changeOrder.id)
      expect(stored).toHaveLength(1)
      expect(stored[0]?.affectedItemId).toBe(part.id)
    })

    it('skips items already in the ECO', async () => {
      const changeOrder = await createChangeOrder()
      const part = await createPart()

      // Add first
      await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        { affectedItemId: part.id, changeAction: 'release' },
        user.id,
      )

      // Try to add again via batch - should skip
      const results = await ChangeOrderService.addAffectedItemsBatch(
        changeOrder.id,
        [{ affectedItemId: part.id, changeAction: 'release' }],
        user.id,
      )

      expect(results).toHaveLength(1) // Returns the existing one
      const items = await ChangeOrderService.getAffectedItems(changeOrder.id)
      expect(items).toHaveLength(1) // Still only one
    })

    // Invariant: the batch is all-or-nothing. A failure part-way must not
    // leave earlier items added, nor the design association and ECO branch
    // their processing created.
    //
    // Honest limit: under TestDatabase everything runs on one connection, so
    // a service that ignored the threaded transaction would still roll back
    // here — this test pins error propagation and the rollback shape, but
    // cannot distinguish a threaded transaction from an unthreaded one. That
    // guarantee is reviewed by reading the call chain (see `withTx`).
    it('rolls the whole batch back when a later item fails', async () => {
      const changeOrder = await createChangeOrder()
      const good = await createPart({ name: 'Batch Atomic Good' })
      // Draft part: 'revise' requires the lifecycle's Released state, so this
      // fails validation deterministically — after `good` has been processed.
      const bad = await createPart({ name: 'Batch Atomic Bad' })

      await expect(
        ChangeOrderService.addAffectedItemsBatch(
          changeOrder.id,
          [
            { affectedItemId: good.id, changeAction: 'release' },
            { affectedItemId: bad.id, changeAction: 'revise' },
          ],
          user.id,
        ),
      ).rejects.toThrow(ValidationError)

      // The valid first item did not survive its sibling's failure
      const stored = await ChangeOrderService.getAffectedItems(changeOrder.id)
      expect(stored).toHaveLength(0)

      // Neither did the side effects of processing it: no design association,
      // no ECO branch
      const associations = await testDb.db
        .select()
        .from(changeOrderDesigns)
        .where(eq(changeOrderDesigns.changeOrderId, changeOrder.id))
      expect(associations).toHaveLength(0)

      const changeOrderBranches = await testDb.db
        .select()
        .from(branches)
        .where(eq(branches.changeOrderItemId, changeOrder.id))
      expect(changeOrderBranches).toHaveLength(0)

      // And the change order is still usable: the same valid item adds cleanly
      const retry = await ChangeOrderService.addAffectedItemsBatch(
        changeOrder.id,
        [{ affectedItemId: good.id, changeAction: 'release' }],
        user.id,
      )
      expect(retry).toHaveLength(1)
    })
  })

  describe('submit', () => {
    it('transitions change order from Draft to InReview', async () => {
      const changeOrder = await createChangeOrder()
      const part = await createPart()

      await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        { affectedItemId: part.id, changeAction: 'release' },
        user.id,
      )

      // In the simplified workflow, submit() goes directly to InReview
      await transitionTo(changeOrder.id, 'InReview')

      const updated = await ItemService.findById(changeOrder.id)
      expect(updated?.state).toBe('InReview')
    })
  })

  describe('getImpactedItems', () => {
    it('returns empty array when no impacted items', async () => {
      const changeOrder = await createChangeOrder()

      const impacted = await ChangeOrderService.getImpactedItems(changeOrder.id)

      expect(impacted).toEqual([])
    })
  })

  describe('addDesign', () => {
    it('adds a design to an ECO and creates branch', async () => {
      const changeOrder = await createChangeOrder()

      const changeOrderDesign = await ChangeOrderService.addDesign(
        changeOrder.id,
        designId,
        user.id,
      )

      expect(changeOrderDesign).toBeDefined()
      expect(changeOrderDesign.designId).toBe(designId)
      expect(changeOrderDesign.branchId).toBeDefined()
      expect(changeOrderDesign.mergeStatus).toBe('pending')
    })

    it('returns existing record if already added', async () => {
      const changeOrder = await createChangeOrder()

      const first = await ChangeOrderService.addDesign(
        changeOrder.id,
        designId,
        user.id,
      )

      const second = await ChangeOrderService.addDesign(
        changeOrder.id,
        designId,
        user.id,
      )

      expect(second.id).toBe(first.id)
    })

    it('throws error when change order not found', async () => {
      await expect(
        ChangeOrderService.addDesign(
          '00000000-0000-0000-0000-000000000000',
          designId,
          user.id,
        ),
      ).rejects.toThrow(NotFoundError)
    })

    it('throws error when change order not in Draft or InReview state', async () => {
      const changeOrder = await createChangeOrder()
      const part = await createPart()

      await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        { affectedItemId: part.id, changeAction: 'release' },
        user.id,
      )

      await transitionTo(changeOrder.id, 'InReview')
      await transitionTo(changeOrder.id, 'Approved')

      await expect(
        ChangeOrderService.addDesign(changeOrder.id, designId, user.id),
      ).rejects.toThrow(ValidationError)
    })

    it('creates a ChangeOrder created commit when design is first linked', async () => {
      const changeOrder = await createChangeOrder()

      const changeOrderDesign = await ChangeOrderService.addDesign(
        changeOrder.id,
        designId,
        user.id,
      )

      // Get the branch and check for commits
      const changeOrderBranch = await testDb.db
        .select()
        .from(branches)
        .where(eq(branches.id, changeOrderDesign.branchId!))
        .limit(1)

      expect(changeOrderBranch[0]).toBeDefined()

      // Find commits on this branch
      const branchCommits = await testDb.db
        .select()
        .from(commits)
        .where(eq(commits.branchId, changeOrderDesign.branchId!))

      // Should have at least one commit with "ChangeOrder xxx created" message
      const creationCommit = branchCommits.find(
        (c) =>
          c.message.includes('ChangeOrder') && c.message.includes('created'),
      )
      expect(creationCommit).toBeDefined()
      expect(creationCommit!.message).toBe(
        `ChangeOrder ${changeOrder.itemNumber} created`,
      )
    })

    it('does not create duplicate commit when design already linked', async () => {
      const changeOrder = await createChangeOrder()

      // First call - should create commit
      const first = await ChangeOrderService.addDesign(
        changeOrder.id,
        designId,
        user.id,
      )

      // Get initial commit count
      const initialCommits = await testDb.db
        .select()
        .from(commits)
        .where(eq(commits.branchId, first.branchId!))

      // Second call - should NOT create another commit
      await ChangeOrderService.addDesign(changeOrder.id, designId, user.id)

      // Get final commit count
      const finalCommits = await testDb.db
        .select()
        .from(commits)
        .where(eq(commits.branchId, first.branchId!))

      // Should have same number of commits (no duplicate created)
      expect(finalCommits.length).toBe(initialCommits.length)
    })
  })

  // `null` as the access scope is cross-program authority — these cover the
  // summary's own arithmetic, not the redaction that scope drives. The
  // scoped behaviour is pinned in program-isolation.permissions.test.ts.
  describe('getSummary', () => {
    it('returns summary for ECO with no designs', async () => {
      const changeOrder = await createChangeOrder()

      const summary = await ChangeOrderService.getSummary(changeOrder.id, null)

      expect(summary.changeOrder).toBeDefined()
      expect(summary.designs).toEqual([])
      expect(summary.totalItemsAffected).toBe(0)
      expect(summary.canSubmit).toBe(true) // No checked out items
    })

    it('throws error for non-existent change order', async () => {
      await expect(
        ChangeOrderService.getSummary(
          '00000000-0000-0000-0000-000000000000',
          null,
        ),
      ).rejects.toThrow(NotFoundError)
    })

    it('tallies branch changes by type and counts affected items per design', async () => {
      const changeOrder = await createChangeOrder()
      const part = await createPart()

      // Adding an affected item associates the design and creates its branch
      await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        { affectedItemId: part.id, changeAction: 'release' },
        user.id,
      )

      const [changeOrderDesign] =
        await ChangeOrderService.getChangeOrderDesigns(changeOrder.id)
      const branchId = changeOrderDesign!.branchId!

      // Three more branch rows, one of each change type
      for (const [i, changeType] of (
        ['modified', 'added', 'deleted'] as const
      ).entries()) {
        const other = await createPart({ name: `Tally Part ${i}` })
        await testDb.db
          .insert(branchItemsTable)
          .values({
            branchId,
            itemMasterId: other.masterId,
            currentItemId: other.id,
            baseItemId: other.id,
            changeType,
          })
          .onConflictDoNothing()
      }

      const summary = await ChangeOrderService.getSummary(changeOrder.id, null)

      expect(summary.designs).toHaveLength(1)
      const [designSummary] = summary.designs
      expect(designSummary?.itemsModified).toBe(1)
      expect(designSummary?.itemsAdded).toBe(1)
      expect(designSummary?.itemsDeleted).toBe(1)
      // Derived from the affected-items rows, not a stored counter
      expect(designSummary?.itemsAffected).toBe(1)
      expect(summary.totalItemsAffected).toBe(1)
      expect(designSummary?.branch?.id).toBe(branchId)
    })

    it('reports a held checkout without refusing to submit', async () => {
      const changeOrder = await createChangeOrder()
      const part = await createPart()

      await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        { affectedItemId: part.id, changeAction: 'release' },
        user.id,
      )

      const [changeOrderDesign] =
        await ChangeOrderService.getChangeOrderDesigns(changeOrder.id)
      const branchId = changeOrderDesign!.branchId!

      const before = await ChangeOrderService.getSummary(changeOrder.id, null)
      expect(before.canSubmit).toBe(true)
      expect(before.designs[0]?.hasCheckedOutItems).toBe(false)

      // A branch row held by someone — what a checkout leaves behind
      const heldPart = await createPart({ name: 'Held Part' })
      await testDb.db.insert(branchItemsTable).values({
        branchId,
        itemMasterId: heldPart.masterId,
        currentItemId: heldPart.id,
        baseItemId: heldPart.id,
        changeType: 'modified',
        checkedOutBy: user.id,
      })

      // Reported, not blocking: the submit transition never checked for a
      // held checkout, so a summary that refused here disagreed with the
      // server that accepted the submit
      const after = await ChangeOrderService.getSummary(changeOrder.id, null)
      expect(after.canSubmit).toBe(true)
      expect(after.designs[0]?.hasCheckedOutItems).toBe(true)
    })
  })

  describe('getWorkflowInstance', () => {
    it('returns workflow instance for change order', async () => {
      const changeOrder = await createChangeOrder()

      const instance = await ChangeOrderService.getWorkflowInstance(
        changeOrder.id,
      )

      expect(instance).toBeDefined()
      expect(instance?.itemId).toBe(changeOrder.id)
      expect(instance?.currentState).toBe('Draft')
    })

    it('returns undefined for change order without workflow', async () => {
      // Create without workflow instance
      const changeOrder = await ItemService.create(
        'ChangeOrder',
        {
          revision: 'A',
          name: 'No Workflow ECO',
          changeType: 'ECO',
          priority: 'medium',
          reasonForChange: 'Test',
          designId,
        } as any,
        user.id,
      )

      const instance = await ChangeOrderService.getWorkflowInstance(
        changeOrder.id,
      )

      expect(instance).toBeNull()
    })
  })

  describe('getWorkflowHistory', () => {
    it('returns empty array for change order without workflow', async () => {
      const changeOrder = await ItemService.create(
        'ChangeOrder',
        {
          revision: 'A',
          name: 'No Workflow ECO',
          changeType: 'ECO',
          priority: 'medium',
          reasonForChange: 'Test',
          designId,
        } as any,
        user.id,
      )

      const history = await ChangeOrderService.getWorkflowHistory(
        changeOrder.id,
      )

      expect(history).toEqual([])
    })
  })

  describe('checkoutItem', () => {
    it('checkouts a Draft item to ECO branch', async () => {
      const changeOrder = await createChangeOrder()
      const part = await createPart({ state: 'Draft' })

      const result = await ChangeOrderService.checkoutItem(
        changeOrder.id,
        part.id,
        user.id,
      )

      expect(result.branchItem).toBeDefined()
      expect(result.branch).toBeDefined()
      expect(result.branch.branchType).toBe('eco')
    })

    it('creates working copy for Released item', async () => {
      const changeOrder = await createChangeOrder()
      const part = await createPart({ state: 'Released' })

      const result = await ChangeOrderService.checkoutItem(
        changeOrder.id,
        part.id,
        user.id,
      )

      expect(result.branchItem).toBeDefined()
      expect(result.branchItem.changeType).toBe('modified')
    })

    it('throws error for non-existent change order', async () => {
      const part = await createPart()

      await expect(
        ChangeOrderService.checkoutItem(
          '00000000-0000-0000-0000-000000000000',
          part.id,
          user.id,
        ),
      ).rejects.toThrow(NotFoundError)
    })

    it('throws error when item is not a change order', async () => {
      const part1 = await createPart()
      const part2 = await createPart()

      // Try to use a Part as change order
      await expect(
        ChangeOrderService.checkoutItem(part1.id, part2.id, user.id),
      ).rejects.toThrow(ValidationError)
    })

    it('throws error when ECO not in editable state', async () => {
      const changeOrder = await createChangeOrder()
      const part = await createPart()

      // Add affected item to allow submission
      await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        { affectedItemId: part.id, changeAction: 'release' },
        user.id,
      )

      // Progress ECO to Approved state
      await transitionTo(changeOrder.id, 'InReview')
      await transitionTo(changeOrder.id, 'Approved')

      // Create another part to try checkout
      const anotherPart = await createPart({ name: 'Another Part' })

      await expect(
        ChangeOrderService.checkoutItem(
          changeOrder.id,
          anotherPart.id,
          user.id,
        ),
      ).rejects.toThrow(ValidationError)
    })

    it('throws error for non-existent item', async () => {
      const changeOrder = await createChangeOrder()

      await expect(
        ChangeOrderService.checkoutItem(
          changeOrder.id,
          '00000000-0000-0000-0000-000000000000',
          user.id,
        ),
      ).rejects.toThrow(NotFoundError)
    })
  })

  describe('states a change order can hold', () => {
    it('come from every workflow a change type runs, never from a list in code', async () => {
      const ids = (
        await LifecycleService.getRenderableStates('ChangeOrder')
      ).map((s) => s.id)

      // Both mapped definitions, in one list
      expect(ids).toEqual(
        expect.arrayContaining([
          'Draft',
          'InReview',
          'Approved',
          'start',
          'complete',
        ]),
      )
      // The nine-state flow the code used to declare, and fed to the AI
      // assistant and the global state filter as fact
      for (const fictional of [
        'Submitted',
        'ImpactAssessment',
        'Review',
        'Implementation',
      ]) {
        expect(ids).not.toContain(fictional)
      }
    })
  })

  describe('resolveConflicts', () => {
    async function releaseChangeOrder(changeOrderId: string) {
      for (const state of ['InReview', 'Approved', 'Implemented', 'Closed']) {
        await transitionTo(changeOrderId, state)
      }
    }

    /**
     * One released part, two change orders. Ours checks it out first; theirs
     * checks it out, edits it and releases, so main has moved under our
     * branch; then ours makes its own edits. Theirs releases before ours
     * edits so the cross-change-order check does not block it.
     */
    async function branchBehindMain(edits: {
      ours: Record<string, unknown>
      theirs: Record<string, unknown>
    }) {
      const part = await createPart({
        state: 'Released',
        name: 'Base name',
        description: 'Base description',
      })
      const ours = await createChangeOrder()
      const { branchItem } = await ChangeOrderService.checkoutItem(
        ours.id,
        part.id,
        user.id,
      )

      const theirs = await createChangeOrder()
      const theirCheckout = await ChangeOrderService.checkoutItem(
        theirs.id,
        part.id,
        user.id,
      )
      await ItemService.update(
        theirCheckout.branchItem.currentItemId!,
        edits.theirs,
        user.id,
      )
      await releaseChangeOrder(theirs.id)

      await ItemService.update(branchItem.currentItemId!, edits.ours, user.id)

      return { part, ours, workingCopyId: branchItem.currentItemId! }
    }

    async function currentVersionOf(masterId: string): Promise<Part> {
      const row = takeFirst(
        await testDb.db
          .select({ id: itemsTable.id })
          .from(itemsTable)
          .where(
            and(
              eq(itemsTable.masterId, masterId),
              eq(itemsTable.isCurrent, true),
            ),
          ),
      )
      return (await ItemService.findById(row.id)) as unknown as Part
    }

    it('keep_ours merges main under our changes instead of overwriting it at release', async () => {
      const { part, ours, workingCopyId } = await branchBehindMain({
        ours: { description: 'Ours description' },
        theirs: { name: 'Their name' },
      })

      const outcomes = await ChangeOrderService.resolveConflicts(
        ours.id,
        [{ itemId: part.masterId, resolution: 'keep_ours' }],
        user.id,
      )
      expect(outcomes).toEqual([
        { itemId: part.masterId, resolution: 'keep_ours', success: true },
      ])

      // The working copy now carries both sides...
      const workingCopy = (await ItemService.findById(
        workingCopyId,
      )) as unknown as Part
      expect(workingCopy.name).toBe('Their name')
      expect(workingCopy.description).toBe('Ours description')

      // ...and so does what the release puts on main. Before, keep_ours
      // only repointed the branch's base, and the release then reverted
      // the other change order's edit.
      await releaseChangeOrder(ours.id)
      const released = await currentVersionOf(part.masterId)
      expect(released.revision).toBe('C')
      expect(released.name).toBe('Their name')
      expect(released.description).toBe('Ours description')
    })

    it('keep_theirs takes main where both sides changed a field and keeps ours elsewhere', async () => {
      const { part, ours } = await branchBehindMain({
        ours: { name: 'Our name', description: 'Ours description' },
        theirs: { name: 'Their name' },
      })

      const [outcome] = await ChangeOrderService.resolveConflicts(
        ours.id,
        [{ itemId: part.masterId, resolution: 'keep_theirs' }],
        user.id,
      )
      expect(outcome?.success).toBe(true)

      // Before, keep_theirs dropped the branch's change entirely, and the
      // release minted a revision with none of our edits in it.
      await releaseChangeOrder(ours.id)
      const released = await currentVersionOf(part.masterId)
      expect(released.name).toBe('Their name')
      expect(released.description).toBe('Ours description')
    })

    it('honours a per-field choice over the item-level one', async () => {
      const { part, ours } = await branchBehindMain({
        ours: { name: 'Our name', description: 'Our description' },
        theirs: { name: 'Their name', description: 'Their description' },
      })

      const [outcome] = await ChangeOrderService.resolveConflicts(
        ours.id,
        [
          {
            itemId: part.masterId,
            resolution: 'keep_ours',
            fieldResolutions: { description: 'theirs' },
          },
        ],
        user.id,
      )
      expect(outcome?.success).toBe(true)

      await releaseChangeOrder(ours.id)
      const released = await currentVersionOf(part.masterId)
      expect(released.name).toBe('Our name')
      expect(released.description).toBe('Their description')
    })

    it('skip removes the item from the change order, so the release mints it no revision', async () => {
      const changeOrder = await createChangeOrder()
      const skipped = await createPart({ state: 'Released', name: 'Skipped' })
      const { branchItem } = await ChangeOrderService.checkoutItem(
        changeOrder.id,
        skipped.id,
        user.id,
      )
      await ItemService.update(
        branchItem.currentItemId!,
        { name: 'Edited, then skipped' },
        user.id,
      )
      // Something else for the change order to release
      const kept = await createPart()
      await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        { affectedItemId: kept.id, changeAction: 'release' },
        user.id,
      )

      const [outcome] = await ChangeOrderService.resolveConflicts(
        changeOrder.id,
        [{ itemId: skipped.masterId, resolution: 'skip' }],
        user.id,
      )
      expect(outcome?.success).toBe(true)

      // Out of scope, and no longer a change on the branch
      const scope = await ChangeOrderService.getAffectedItems(changeOrder.id)
      expect(scope.map((a) => a.affectedItemMasterId)).toEqual([kept.masterId])
      const branchRow = await testDb.db
        .select()
        .from(branchItemsTable)
        .where(eq(branchItemsTable.id, branchItem.id))
        .then((rows) => rows.at(0))
      expect(branchRow?.changeType ?? null).toBeNull()

      // Before, skip deleted the branch row and left the scope row, and the
      // release read "revise, no content" as a revision to mint.
      await releaseChangeOrder(changeOrder.id)
      const versions = await testDb.db
        .select({ revision: itemsTable.revision })
        .from(itemsTable)
        .where(eq(itemsTable.masterId, skipped.masterId))
      // The working copy the checkout minted stays behind as an orphaned
      // row under its branch-scoped working revision, as it always has after
      // removeAffectedItem; it is not a released version.
      const releasedVersions = versions.filter(
        (v) => !RevisionService.isWorkingRevision(v.revision),
      )
      expect(releasedVersions.map((v) => v.revision)).toEqual(['A'])
      expect((await currentVersionOf(skipped.masterId)).revision).toBe('A')
      expect((await ItemService.findById(kept.id))?.state).toBe('Released')
    })

    it('refuses skip once the scope is locked, and changes nothing', async () => {
      const changeOrder = await createChangeOrder()
      const part = await createPart({ state: 'Released' })
      const { branchItem } = await ChangeOrderService.checkoutItem(
        changeOrder.id,
        part.id,
        user.id,
      )
      await transitionTo(changeOrder.id, 'InReview')

      const [outcome] = await ChangeOrderService.resolveConflicts(
        changeOrder.id,
        [{ itemId: part.masterId, resolution: 'skip' }],
        user.id,
      )
      expect(outcome?.success).toBe(false)

      const scope = await ChangeOrderService.getAffectedItems(changeOrder.id)
      expect(scope.map((a) => a.affectedItemMasterId)).toEqual([part.masterId])
      const branchRow = takeFirst(
        await testDb.db
          .select()
          .from(branchItemsTable)
          .where(eq(branchItemsTable.id, branchItem.id)),
      )
      expect(branchRow.changeType).toBe('modified')
    })

    it('reports an item the change order does not change as a failed resolution', async () => {
      const changeOrder = await createChangeOrder()
      const part = await createPart()

      const [outcome] = await ChangeOrderService.resolveConflicts(
        changeOrder.id,
        [{ itemId: part.masterId, resolution: 'keep_ours' }],
        user.id,
      )
      expect(outcome?.success).toBe(false)
    })
  })

  describe('startWorkflow', () => {
    it('starts workflow with given definition', async () => {
      // Create change order without auto-started workflow
      const changeOrder = await ItemService.create(
        'ChangeOrder',
        {
          revision: 'A',
          name: 'Manual Workflow ECO',
          changeType: 'ECO',
          priority: 'medium',
          reasonForChange: 'Test manual start',
          designId,
        } as any,
        user.id,
      )

      const instance = await ChangeOrderService.startWorkflow(
        changeOrder.id,
        TEST_WORKFLOW_ID,
        user.id,
      )

      expect(instance).toBeDefined()
      expect(instance.itemId).toBe(changeOrder.id)
      expect(instance.workflowDefinitionId).toBe(TEST_WORKFLOW_ID)
    })

    /** A change order with no instance yet, the way `ItemService.create` leaves it. */
    async function createBareChangeOrder(changeType = 'XCO') {
      return ItemService.create(
        'ChangeOrder',
        {
          revision: 'A',
          name: `Bare ${changeType}`,
          changeType,
          priority: 'medium',
          reasonForChange: 'Test',
          designId,
        } as any,
        user.id,
      )
    }

    it("stamps the change order's state from the instance it starts, not from the type's definition", async () => {
      const changeOrder = await createBareChangeOrder()
      // Created at the initial state of the type's own definition
      expect((await ItemService.findById(changeOrder.id))?.state).toBe('Draft')

      const instance = await ChangeOrderService.startWorkflow(
        changeOrder.id,
        FLEXIBLE_WORKFLOW_ID,
        user.id,
      )
      expect(instance.currentState).toBe('start')
      expect((await ItemService.findById(changeOrder.id))?.state).toBe('start')

      // What governs the change order is the definition it runs...
      const governing = await LifecycleService.getGoverningDefinitionForItem({
        id: changeOrder.id,
        itemType: 'ChangeOrder',
      })
      expect(governing?.id).toBe(FLEXIBLE_WORKFLOW_ID)
      expect(governing?.states.map((s) => s.id)).toEqual(['start', 'complete'])

      // ...while the type's renderable states span every mapped definition,
      // so a list mixing change types can name any of them
      const renderable = (
        await LifecycleService.getRenderableStates('ChangeOrder')
      ).map((s) => s.id)
      expect(renderable).toEqual(
        expect.arrayContaining(['Draft', 'InReview', 'start', 'complete']),
      )
      await expect(
        LifecycleService.validateStateForType('ChangeOrder', 'complete'),
      ).resolves.toBeUndefined()
    })

    it('autoStartWorkflow runs the mapped definition and stamps its state', async () => {
      const changeOrder = await createBareChangeOrder('XCO')

      const instance = await ChangeOrderService.autoStartWorkflow(
        changeOrder.id,
        'XCO',
        user.id,
      )

      expect(instance.workflowDefinitionId).toBe(FLEXIBLE_WORKFLOW_ID)
      expect((await ItemService.findById(changeOrder.id))?.state).toBe('start')
    })

    it('refuses a definition that is not a change-order workflow', async () => {
      const changeOrder = await createBareChangeOrder()

      await expect(
        ChangeOrderService.startWorkflow(
          changeOrder.id,
          LIFECYCLE_IDS.part,
          user.id,
        ),
      ).rejects.toThrow(ValidationError)

      expect(
        await ChangeOrderService.getWorkflowInstance(changeOrder.id),
      ).toBeNull()
      expect((await ItemService.findById(changeOrder.id))?.state).toBe('Draft')
    })

    it('starts nothing when the history row cannot be written', async () => {
      const changeOrder = await createBareChangeOrder()

      const historyWrite = vi
        .spyOn(LifecycleInstanceService, 'recordHistory')
        .mockRejectedValueOnce(new Error('connection reset'))
      await expect(
        ChangeOrderService.startWorkflow(
          changeOrder.id,
          FLEXIBLE_WORKFLOW_ID,
          user.id,
        ),
      ).rejects.toThrow('connection reset')
      historyWrite.mockRestore()

      // No instance, and the state the instance would have stamped is absent
      expect(
        await ChangeOrderService.getWorkflowInstance(changeOrder.id),
      ).toBeNull()
      expect((await ItemService.findById(changeOrder.id))?.state).toBe('Draft')
    })
  })

  describe('applyBomChange', () => {
    it('records a quantity change in the branch history, as add and remove are', async () => {
      const parent = await createPart({ state: 'Released' })
      const child = await createPart({ state: 'Released' })
      const changeOrder = await createChangeOrder()
      const { workingCopyId } = await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        { affectedItemId: parent.id, changeAction: 'revise' },
        user.id,
      )
      expect(workingCopyId).toBeTruthy()

      await ChangeOrderService.applyBomChange(
        changeOrder.id,
        {
          parentItemId: parent.id,
          childItemId: child.id,
          quantity: 1,
          action: 'add',
        },
        user.id,
      )
      await ChangeOrderService.applyBomChange(
        changeOrder.id,
        {
          parentItemId: parent.id,
          childItemId: child.id,
          quantity: 3,
          action: 'modify',
        },
        user.id,
      )

      // Written to the working copy on the branch, never to the row on main
      const onMain = await testDb.db
        .select()
        .from(itemRelationships)
        .where(eq(itemRelationships.sourceId, parent.id))
      expect(onMain).toHaveLength(0)
      const onBranch = await testDb.db
        .select()
        .from(itemRelationships)
        .where(
          and(
            eq(itemRelationships.sourceId, workingCopyId!),
            eq(itemRelationships.targetId, child.id),
          ),
        )
      expect(onBranch.map((r) => Number(r.quantity))).toEqual([3])

      // The branch history carries the change. `modify` was a raw update of
      // the row, so a reviewer saw the child added at 1 and nothing after.
      const branchId = (
        await ChangeOrderService.getChangeOrderDesigns(changeOrder.id)
      ).find((d) => d.branchId)?.branchId
      const quantityChanges = await testDb.db
        .select({
          oldValue: itemFieldChanges.oldValue,
          newValue: itemFieldChanges.newValue,
        })
        .from(itemFieldChanges)
        .innerJoin(
          itemVersions,
          eq(itemFieldChanges.itemVersionId, itemVersions.id),
        )
        .innerJoin(commits, eq(itemVersions.commitId, commits.id))
        .where(
          and(
            eq(commits.branchId, branchId!),
            eq(itemFieldChanges.fieldName, 'bom_quantity_changed'),
          ),
        )
      expect(quantityChanges).toHaveLength(1)
      // Numeric column: the stored quantity reads back with its scale
      expect(quantityChanges[0]).toMatchObject({
        oldValue: { quantity: expect.stringMatching(/^1(.0+)?$/) },
        newValue: { quantity: expect.stringMatching(/^3(.0+)?$/) },
      })
    })
  })

  describe('listByScope', () => {
    it('pages newest first, with a total that counts each change order once', async () => {
      const program = takeFirst(
        await testDb.db
          .insert(programs)
          .values({
            name: 'List Program',
            code: `LP-${uniquePrefix}`,
            createdBy: user.id,
          })
          .returning(),
      )
      const otherDesignId = await createDesign('list-other')
      await testDb.db
        .update(designs)
        .set({ programId: program.id })
        .where(inArray(designs.id, [designId, otherDesignId]))

      const first = await createChangeOrder({ name: 'First' })
      const second = await createChangeOrder({ name: 'Second' })
      const third = await createChangeOrder({ name: 'Third' })
      await testDb.db.insert(changeOrderDesigns).values([
        { changeOrderId: first.id, designId, mergeStatus: 'pending' },
        { changeOrderId: second.id, designId, mergeStatus: 'pending' },
        { changeOrderId: third.id, designId, mergeStatus: 'pending' },
        // On two of the program's designs: listed once, counted once
        {
          changeOrderId: third.id,
          designId: otherDesignId,
          mergeStatus: 'pending',
        },
      ])
      // Distinct timestamps, so the order under test is unambiguous
      for (const [i, co] of [first, second, third].entries()) {
        await testDb.db
          .update(itemsTable)
          .set({ createdAt: new Date(Date.UTC(2026, 0, 1 + i)) })
          .where(eq(itemsTable.id, co.id))
      }

      // The ids used to be collected unordered and sliced in memory, so the
      // same offset could answer with different rows from one call to the next
      const page1 = await ChangeOrderService.listByScope(
        { designId },
        { limit: 2, offset: 0 },
      )
      expect(page1.total).toBe(3)
      expect(page1.changeOrders.map((c) => c.id)).toEqual([third.id, second.id])
      const page2 = await ChangeOrderService.listByScope(
        { designId },
        { limit: 2, offset: 2 },
      )
      expect(page2.total).toBe(3)
      expect(page2.changeOrders.map((c) => c.id)).toEqual([first.id])

      const byProgram = await ChangeOrderService.listByScope(
        { programId: program.id },
        { limit: 10, offset: 0 },
      )
      expect(byProgram.total).toBe(3)
      expect(byProgram.changeOrders.map((c) => c.id)).toEqual([
        third.id,
        second.id,
        first.id,
      ])
    })
  })

  describe('design association is one transaction', () => {
    // Linking a design means the association row, the ECO branch and the
    // registration commit. Three of the four paths that did this ran them as
    // separate statements on the pool, so a failure part-way left a branch
    // with no association, or an association naming a branch whose
    // registration never landed. Every path now goes through
    // `ensureDesignAssociation` on a transaction.

    it('addDesign leaves nothing behind when the registration fails', async () => {
      const changeOrder = await createChangeOrder()

      const commitWrite = vi
        .spyOn(CommitService, 'create')
        .mockRejectedValueOnce(new Error('connection reset'))
      await expect(
        ChangeOrderService.addDesign(changeOrder.id, designId, user.id),
      ).rejects.toThrow('connection reset')
      commitWrite.mockRestore()

      expect(
        await ChangeOrderService.getChangeOrderDesigns(changeOrder.id),
      ).toEqual([])
      const changeOrderBranches = await testDb.db
        .select()
        .from(branches)
        .where(
          and(eq(branches.designId, designId), eq(branches.branchType, 'eco')),
        )
      expect(changeOrderBranches).toEqual([])

      // Nothing is stuck: the same call succeeds next time
      const linked = await ChangeOrderService.addDesign(
        changeOrder.id,
        designId,
        user.id,
      )
      expect(linked.branchId).toBeTruthy()
    })

    it('checkoutItem leaves nothing behind when the intake fails', async () => {
      const changeOrder = await createChangeOrder()
      const part = await createPart({ state: 'Released' })

      const commitWrite = vi
        .spyOn(CommitService, 'create')
        .mockRejectedValueOnce(new Error('connection reset'))
      await expect(
        ChangeOrderService.checkoutItem(changeOrder.id, part.id, user.id),
      ).rejects.toThrow('connection reset')
      commitWrite.mockRestore()

      // No scope row, no association, no branch, no working copy
      expect(await ChangeOrderService.getAffectedItems(changeOrder.id)).toEqual(
        [],
      )
      expect(
        await ChangeOrderService.getChangeOrderDesigns(changeOrder.id),
      ).toEqual([])
      const versions = await testDb.db
        .select({ id: itemsTable.id })
        .from(itemsTable)
        .where(eq(itemsTable.masterId, part.masterId))
      expect(versions).toHaveLength(1)

      // ...and the retry is a normal checkout: the working copy, locked
      const result = await ChangeOrderService.checkoutItem(
        changeOrder.id,
        part.id,
        user.id,
      )
      expect(result.branchItem.changeType).toBe('modified')
      expect(result.branchItem.checkedOutBy).toBe(user.id)
      const [scoped] = await ChangeOrderService.getAffectedItems(changeOrder.id)
      expect(scoped?.changeAction).toBe('revise')
      expect(scoped?.workingCopyId).toBe(result.branchItem.currentItemId)
    })

    it('checkoutItem treats an item already in scope as already scoped', async () => {
      const changeOrder = await createChangeOrder()
      const part = await createPart({ state: 'Released' })
      const added = await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        { affectedItemId: part.id, changeAction: 'revise' },
        user.id,
      )

      // Scope management created the working copy unlocked; the checkout
      // is the edit intent that locks it, and adds no second scope row
      const result = await ChangeOrderService.checkoutItem(
        changeOrder.id,
        part.id,
        user.id,
      )
      expect(result.branchItem.currentItemId).toBe(added.workingCopyId)
      expect(result.branchItem.checkedOutBy).toBe(user.id)
      expect(
        await ChangeOrderService.getAffectedItems(changeOrder.id),
      ).toHaveLength(1)
    })
  })

  describe('transitionWorkflow', () => {
    it('throws error when no workflow found', async () => {
      const changeOrder = await ItemService.create(
        'ChangeOrder',
        {
          revision: 'A',
          name: 'No Workflow ECO',
          changeType: 'ECO',
          priority: 'medium',
          reasonForChange: 'Test',
          designId,
        } as any,
        user.id,
      )
      // Reaching a change order means reaching one of its designs, and the
      // relation that decides that is change_order_designs — `items.designId`,
      // which createChangeOrder sets, is NULL on every ECO the application
      // builds. Linked directly rather than through addDesign so the
      // fixture does not also create a branch and a commit. The design carries
      // no programId, so membership is not what is under test here.
      await testDb.db.insert(changeOrderDesigns).values({
        changeOrderId: changeOrder.id,
        designId,
        mergeStatus: 'pending',
      })

      await expect(
        ChangeOrderService.transitionWorkflow(
          changeOrder.id,
          'Submitted',
          user.id,
        ),
      ).rejects.toThrow(NotFoundError)
    })
  })

  describe('addAffectedItem edge cases', () => {
    it('throws validation error for invalid action on state', async () => {
      const changeOrder = await createChangeOrder()
      // Create a Draft part - cannot apply 'revise' action
      const part = await createPart({ state: 'Draft' })

      await expect(
        ChangeOrderService.addAffectedItem(
          changeOrder.id,
          {
            affectedItemId: part.id,
            changeAction: 'revise', // Invalid for Draft state
          },
          user.id,
        ),
      ).rejects.toThrow()
    })

    it('handles add action with no existing item', async () => {
      const changeOrder = await createChangeOrder()
      const newItemNumber = `PN-${uniquePrefix}-ADD-001`

      const affected = await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        {
          changeAction: 'release',
          newItemType: 'Part',
          newItemData: { itemNumber: newItemNumber, name: 'New Part' },
        },
        user.id,
      )

      expect(affected.changeAction).toBe('release')
      expect(affected.newItemType).toBe('Part')
      expect(affected.affectedItemId).toBeNull()
    })

    it('creates working copy for revise action on released item with design', async () => {
      const changeOrder = await createChangeOrder()
      const part = await createPart({ state: 'Released' })

      const affected = await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        {
          affectedItemId: part.id,
          changeAction: 'revise',
          currentRevision: 'A',
        },
        user.id,
      )

      // Should have working copy
      expect(affected.workingCopyId).toBeDefined()
      expect(affected.changeAction).toBe('revise')
    })
  })

  describe('executeWorkflowTransition (release orchestration)', () => {
    // Raw-inserts a Driving workflow whose single transition goes straight to
    // the given final state, then repoints the CO's instance at it. Raw
    // insert is deliberate: some tests need definitions that create()-time
    // validation would reject, to prove the runtime fails closed.
    async function setupCoWithFinalState(
      finalState: Record<string, unknown>,
      guards: Array<Record<string, unknown>> = [],
    ) {
      const defId = randomUUID()
      await testDb.db.insert(lifecycleDefinitions).values({
        id: defId,
        name: `CO Orchestration ${uniquePrefix}-${Math.random().toString(36).slice(2, 6)}`,
        version: 1,
        workflowType: 'strict',
        definition: {
          states: [
            { id: 'Draft', name: 'Draft', isInitial: true, isFinal: false },
            finalState,
          ],
          transitions: [
            {
              id: 't1',
              name: 'Complete',
              fromStateId: 'Draft',
              toStateId: finalState.id,
              guards,
            },
          ],
          applicableItemTypes: ['ChangeOrder'],
        },
        isActive: true,
        lifecycleType: 'Driving',
      })

      const changeOrder = await createChangeOrder()
      // Reaching a change order means reaching one of its designs, and the
      // relation that decides that is change_order_designs — `items.designId`,
      // which createChangeOrder sets, is NULL on every ECO the application
      // builds. Linked directly rather than through addDesign so the
      // fixture does not also create a branch and a commit. The design carries
      // no programId, so membership is not what is under test here.
      await testDb.db.insert(changeOrderDesigns).values({
        changeOrderId: changeOrder.id,
        designId,
        mergeStatus: 'pending',
      })
      await testDb.db
        .update(lifecycleInstances)
        .set({ workflowDefinitionId: defId })
        .where(eq(lifecycleInstances.itemId, changeOrder.id))

      return { changeOrder }
    }

    it('releases when finalKind says release, even if the name suggests cancellation', async () => {
      const { changeOrder } = await setupCoWithFinalState({
        id: 'DoneRejected',
        name: 'Done, rejected items removed',
        isFinal: true,
        finalKind: 'release',
      })
      const part = await createPart()
      await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        { affectedItemId: part.id, changeAction: 'release' },
        user.id,
      )

      const outcome = await ChangeOrderService.executeWorkflowTransition(
        changeOrder.id,
        'DoneRejected',
        user.id,
      )

      expect(outcome.result.success).toBe(true)
      expect(outcome.cancelled).toBe(false)
      expect(outcome.mergeResult).toBeDefined()

      const releasedPart = await ItemService.findById(part.id)
      expect(releasedPart?.state).toBe('Released')

      const instance = await ChangeOrderService.getWorkflowInstance(
        changeOrder.id,
      )
      expect(instance?.currentState).toBe('DoneRejected')
      expect(instance?.completedAt).toBeDefined()
    })

    it('previews the transition against the change order itself, doing nothing', async () => {
      const { changeOrder } = await setupCoWithFinalState(
        {
          id: 'Approved',
          name: 'Approved',
          isFinal: true,
          finalKind: 'release',
        },
        [
          {
            id: 'g1',
            name: 'Description Required',
            type: 'field_value',
            config: { fieldName: 'description', operator: 'is_not_empty' },
            errorMessage: 'Description is required',
          },
        ],
      )
      const part = await createPart()
      await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        { affectedItemId: part.id, changeAction: 'release' },
        user.id,
      )

      // No description yet, so the guard refuses. The preview used to
      // evaluate guards against an empty item — refusing regardless of the
      // change order — while execution read the row.
      const refused = await ChangeOrderService.validateTransition(
        changeOrder.id,
        'Approved',
        user.id,
      )
      expect(refused).toMatchObject({
        valid: false,
        workflowGuardErrors: [expect.any(String)],
      })

      await testDb.db
        .update(changeOrders)
        .set({ description: 'Bracket rework' })
        .where(eq(changeOrders.itemId, changeOrder.id))

      const before = await ItemService.findById(part.id)
      const previewed = await ChangeOrderService.validateTransition(
        changeOrder.id,
        'Approved',
        user.id,
      )
      expect(previewed).toMatchObject({
        valid: true,
        workflowGuardErrors: [],
        affectedItemErrors: [],
        affectedItemsPreview: [
          {
            itemId: part.id,
            changeAction: 'release',
            predictedTransitions: [
              { fromState: before?.state, toState: 'Released' },
            ],
          },
        ],
        transitionName: 'Complete',
        fromState: 'Draft',
        toState: 'Approved',
      })

      // A preview: the change order has not moved and the part is untouched
      const instance = await ChangeOrderService.getWorkflowInstance(
        changeOrder.id,
      )
      expect(instance?.currentState).toBe('Draft')
      expect((await ItemService.findById(part.id))?.state).toBe(before?.state)
    })

    it('reports a release the change-action mappings would refuse', async () => {
      const { changeOrder } = await setupCoWithFinalState({
        id: 'Approved',
        name: 'Approved',
        isFinal: true,
        finalKind: 'release',
      })
      const part = await createPart()
      await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        { affectedItemId: part.id, changeAction: 'release' },
        user.id,
      )
      // Released since it was added: `release` maps from the initial state,
      // so the merge would refuse it — and the preview says so first
      await testDb.db
        .update(itemsTable)
        .set({ state: 'Released' })
        .where(eq(itemsTable.id, part.id))

      const result = await ChangeOrderService.validateTransition(
        changeOrder.id,
        'Approved',
        user.id,
      )
      expect(result).toMatchObject({
        valid: false,
        workflowGuardErrors: [],
        affectedItemErrors: [expect.stringContaining(part.itemNumber)],
        affectedItemsPreview: [],
      })
    })

    it('blocks a release while a critical risk is unacknowledged', async () => {
      const { changeOrder } = await setupCoWithFinalState({
        id: 'Approved',
        name: 'Approved',
        isFinal: true,
        finalKind: 'release',
      })
      const part = await createPart()
      await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        { affectedItemId: part.id, changeAction: 'release' },
        user.id,
      )

      await testDb.db.insert(changeOrderRisks).values({
        changeOrderId: changeOrder.id,
        category: 'production',
        severity: 'critical',
        description: 'Obsoleting a part still used in released assemblies',
        requiresAcknowledgement: true,
      })

      // This gate lived only in approve(), which nothing in production calls,
      // so acknowledgement was decorative: the transition endpoint released
      // regardless.
      await expect(
        ChangeOrderService.executeWorkflowTransition(
          changeOrder.id,
          'Approved',
          user.id,
        ),
      ).rejects.toThrow(ValidationError)

      // Nothing released, and no claim left behind
      const untouched = await ItemService.findById(part.id)
      expect(untouched?.state).toBe('Draft')
      const instance = await ChangeOrderService.getWorkflowInstance(
        changeOrder.id,
      )
      expect(instance?.currentState).toBe('Draft')
      expect(instance?.releasingAt ?? null).toBeNull()
    })

    it('releases once the critical risk is acknowledged', async () => {
      const { changeOrder } = await setupCoWithFinalState({
        id: 'Approved',
        name: 'Approved',
        isFinal: true,
        finalKind: 'release',
      })
      const part = await createPart()
      await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        { affectedItemId: part.id, changeAction: 'release' },
        user.id,
      )

      const risk = takeFirst(
        await testDb.db
          .insert(changeOrderRisks)
          .values({
            changeOrderId: changeOrder.id,
            category: 'production',
            severity: 'critical',
            description: 'Needs sign-off',
            requiresAcknowledgement: true,
          })
          .returning(),
      )
      await ChangeOrderService.acknowledgeRiskForChangeOrder(
        changeOrder.id,
        risk.id,
        user.id,
      )

      const outcome = await ChangeOrderService.executeWorkflowTransition(
        changeOrder.id,
        'Approved',
        user.id,
      )
      expect(outcome.result.success).toBe(true)
      expect((await ItemService.findById(part.id))?.state).toBe('Released')
    })

    it('cancels when finalKind says cancel, even if the name suggests completion', async () => {
      const { changeOrder } = await setupCoWithFinalState({
        id: 'Complete',
        name: 'Complete',
        isFinal: true,
        finalKind: 'cancel',
      })
      const part = await createPart()
      await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        { affectedItemId: part.id, changeAction: 'release' },
        user.id,
      )

      const outcome = await ChangeOrderService.executeWorkflowTransition(
        changeOrder.id,
        'Complete',
        user.id,
      )

      expect(outcome.result.success).toBe(true)
      expect(outcome.cancelled).toBe(true)
      expect(outcome.mergeResult).toBeUndefined()

      // Nothing merged: the affected part is untouched
      const untouched = await ItemService.findById(part.id)
      expect(untouched?.state).toBe('Draft')

      const coRecord = takeFirst(
        await testDb.db
          .select()
          .from(changeOrders)
          .where(eq(changeOrders.itemId, changeOrder.id)),
      )
      expect(coRecord.closedAt).not.toBeNull()
    })

    it('leaves a failed release in its pre-final state, fully retryable', async () => {
      const { changeOrder } = await setupCoWithFinalState({
        id: 'Closed',
        name: 'Closed',
        isFinal: true,
        finalKind: 'release',
      })
      // No affected items: close() throws inside the release interlock

      await expect(
        ChangeOrderService.executeWorkflowTransition(
          changeOrder.id,
          'Closed',
          user.id,
        ),
      ).rejects.toThrow(ValidationError)

      // The workflow never reached the final state and holds no stale claim
      const instance = await ChangeOrderService.getWorkflowInstance(
        changeOrder.id,
      )
      expect(instance?.currentState).toBe('Draft')
      expect(instance?.completedAt).toBeUndefined()
      expect(instance?.releasingAt).toBeUndefined()

      // Fix the problem and retry the exact same transition
      const part = await createPart()
      await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        { affectedItemId: part.id, changeAction: 'release' },
        user.id,
      )

      const retry = await ChangeOrderService.executeWorkflowTransition(
        changeOrder.id,
        'Closed',
        user.id,
      )
      expect(retry.result.success).toBe(true)
      expect(retry.mergeResult).toBeDefined()
    })

    it('passes the release gates again after releasing branch content', async () => {
      const changeOrder = await createChangeOrder()
      const part = await createPart({ state: 'Released' })
      // Real branch content: a working copy with an edit of its own, which the
      // release promotes onto main as the next revision
      const { branchItem } = await ChangeOrderService.checkoutItem(
        changeOrder.id,
        part.id,
        user.id,
      )
      await ItemService.update(
        branchItem.currentItemId!,
        { name: 'Edited on the branch' },
        user.id,
      )
      await transitionTo(changeOrder.id, 'InReview')
      await transitionTo(changeOrder.id, 'Approved')
      await transitionTo(changeOrder.id, 'Implemented')
      await transitionTo(changeOrder.id, 'Closed')

      // The archived branch's base is the row the release replaced and main
      // now carries the row it promoted, so walking the branch reported the
      // release as a blocking concurrent modification of itself — which
      // wedged the retry of a release whose state write had failed after the
      // merge. A finished branch is not a conflict.
      const conflicts =
        await ConflictDetectionService.detectConflictsForChangeOrder(
          changeOrder.id,
        )
      expect(
        conflicts.conflicts.filter((c) => c.itemMasterId === part.masterId),
      ).toEqual([])
      expect(conflicts.hasBlockingConflicts).toBe(false)
      await expect(
        ChangeOrderService.assertReleaseGates(changeOrder.id),
      ).resolves.toBeUndefined()
    })

    it('retries a release whose state write failed, without releasing anything twice', async () => {
      const { changeOrder } = await setupCoWithFinalState({
        id: 'Closed',
        name: 'Closed',
        isFinal: true,
        finalKind: 'release',
      })
      // A revision with no branch content: the one arm of the release that is
      // not idempotent by inspection, because a second pass would base its
      // letter on the version the first pass created. Raw insert on purpose —
      // intake creates a working copy for `revise` whenever a branch exists,
      // and this fixture's design has none, which is the shape under test.
      const part = await createPart({ state: 'Released' })
      await testDb.db.insert(changeOrderAffectedItems).values({
        changeOrderId: changeOrder.id,
        affectedItemId: part.id,
        affectedItemMasterId: part.masterId,
        changeAction: 'revise',
        createdBy: user.id,
      })
      const revisionsOf = async () =>
        (
          await testDb.db
            .select({
              revision: itemsTable.revision,
              isCurrent: itemsTable.isCurrent,
            })
            .from(itemsTable)
            .where(eq(itemsTable.masterId, part.masterId))
        ).sort((a, b) => a.revision.localeCompare(b.revision))
      const changeOrderRow = async () =>
        takeFirst(
          await testDb.db
            .select()
            .from(changeOrders)
            .where(eq(changeOrders.itemId, changeOrder.id)),
        )

      // The merge commits first, by design; the state write after it fails
      const historyWrite = vi
        .spyOn(LifecycleInstanceService, 'recordHistory')
        .mockRejectedValueOnce(new Error('connection reset'))
      await expect(
        ChangeOrderService.executeWorkflowTransition(
          changeOrder.id,
          'Closed',
          user.id,
        ),
      ).rejects.toThrow('connection reset')
      historyWrite.mockRestore()

      // The release itself happened and is recorded as done...
      expect((await revisionsOf()).map((v) => v.revision)).toEqual(['A', 'B'])
      const afterFailure = await changeOrderRow()
      expect(afterFailure.implementedAt).not.toBeNull()
      expect(afterFailure.closedAt).not.toBeNull()
      // ...while the workflow, the change order's own state, its milestones
      // and its history all still say the transition never happened
      expect(afterFailure.approvedAt).toBeNull()
      const instance = await ChangeOrderService.getWorkflowInstance(
        changeOrder.id,
      )
      expect(instance?.currentState).toBe('Draft')
      expect(instance?.completedAt).toBeUndefined()
      expect(instance?.releasingAt).toBeUndefined()
      expect((await ItemService.findById(changeOrder.id))?.state).toBe('Draft')
      const historyAfterFailure = await testDb.db
        .select()
        .from(lifecycleHistory)
        .where(eq(lifecycleHistory.instanceId, instance!.id))
      expect(historyAfterFailure.some((h) => h.toState === 'Closed')).toBe(
        false,
      )

      // The same transition completes on retry: the gates pass, nothing is
      // released a second time, and the workflow ends with its record intact
      const retry = await ChangeOrderService.executeWorkflowTransition(
        changeOrder.id,
        'Closed',
        user.id,
      )
      expect(retry.result.success).toBe(true)

      const versions = await revisionsOf()
      expect(versions.map((v) => v.revision)).toEqual(['A', 'B'])
      expect(versions.find((v) => v.revision === 'B')?.isCurrent).toBe(true)
      const completed = await ChangeOrderService.getWorkflowInstance(
        changeOrder.id,
      )
      expect(completed?.currentState).toBe('Closed')
      expect(completed?.completedAt).toBeDefined()
      expect((await ItemService.findById(changeOrder.id))?.state).toBe('Closed')
      const afterRetry = await changeOrderRow()
      expect(afterRetry.approvedAt).not.toBeNull()
      expect(afterRetry.approvedBy).toBe(user.id)
      expect(afterRetry.closedAt).toEqual(afterFailure.closedAt)
      const historyAfterRetry = await testDb.db
        .select()
        .from(lifecycleHistory)
        .where(eq(lifecycleHistory.instanceId, instance!.id))
      expect(historyAfterRetry.some((h) => h.toState === 'Closed')).toBe(true)
    })

    it('leaves affected item states untouched on non-final transitions (single-mechanism invariant)', async () => {
      // With transition_driven_item and lifecycleEffects deleted, the merge
      // at release is the only writer of driven item state — mid-flight
      // workflow movement must not touch affected items.
      const changeOrder = await createChangeOrder()
      const part = await createPart()
      await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        { affectedItemId: part.id, changeAction: 'release' },
        user.id,
      )

      const outcome = await ChangeOrderService.executeWorkflowTransition(
        changeOrder.id,
        'InReview',
        user.id,
      )
      expect(outcome.result.success).toBe(true)

      const untouched = await ItemService.findById(part.id)
      expect(untouched?.state).toBe('Draft')
    })

    it('fails closed when a final state lacks finalKind', async () => {
      const { changeOrder } = await setupCoWithFinalState({
        id: 'Done',
        name: 'Done',
        isFinal: true,
        // finalKind deliberately missing — raw insert bypassed validation
      })

      await expect(
        ChangeOrderService.executeWorkflowTransition(
          changeOrder.id,
          'Done',
          user.id,
        ),
      ).rejects.toThrow(ValidationError)

      const instance = await ChangeOrderService.getWorkflowInstance(
        changeOrder.id,
      )
      expect(instance?.currentState).toBe('Draft')
      expect(instance?.completedAt).toBeUndefined()
    })
  })
})
