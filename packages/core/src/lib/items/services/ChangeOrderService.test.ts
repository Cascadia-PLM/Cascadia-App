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
} from 'vitest'
import { eq } from 'drizzle-orm'
import { ChangeOrderService } from './ChangeOrderService'
import { ItemService } from './ItemService'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import {
  branchItems as branchItemsTable,
  branches,
  changeOrderDesigns,
  changeOrderRisks,
  changeOrders,
  commits,
  designs,
  items as itemsTable,
} from '@/lib/db/schema'
import {
  workflowDefinitions,
  workflowInstances,
} from '@/lib/db/schema/workflows'
import {
  SYSTEM_USER_ID,
  overrideItemTypeConfig,
  seedStandardPartLifecycle,
} from '@/__tests__/fixtures/lifecycles'
import { NotFoundError, ValidationError } from '@/lib/errors'
import { takeFirst } from '@/lib/db/take-first'

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
  definitionType: 'workflow',
  description: 'Simplified test workflow for Engineering Change Orders',
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
      .insert(workflowDefinitions)
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
        target: workflowDefinitions.id,
        set: {
          definition: changeOrderWorkflowDefinition,
          workflowType: 'strict',
          lifecycleType: 'Driving',
        },
      })

    // Link ChangeOrder item type to the ECO workflow
    restoreItemTypeConfig = await overrideItemTypeConfig(
      testDb.db,
      'ChangeOrder',
      {
        lifecycleDefinitionId: TEST_WORKFLOW_ID,
        workflowsByChangeType: {
          ECO: TEST_WORKFLOW_ID,
          ECN: TEST_WORKFLOW_ID,
          Deviation: TEST_WORKFLOW_ID,
          MCO: TEST_WORKFLOW_ID,
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
    await testDb.db.insert(workflowInstances).values({
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
      const ecoDesigns = await ChangeOrderService.getEcoDesigns(changeOrder.id)
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
      const ecoDesigns = await ChangeOrderService.getEcoDesigns(changeOrder.id)
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
      const ownerEco = await createChangeOrder()
      const otherEco = await createChangeOrder()
      const part = await createPart()

      const affected = await ChangeOrderService.addAffectedItem(
        ownerEco.id,
        { affectedItemId: part.id, changeAction: 'release' },
        user.id,
      )

      // An affected-item row id is not authority to delete it: the ECO that
      // owns the row is what scopes the delete.
      await expect(
        ChangeOrderService.removeAffectedItem(otherEco.id, affected.id!),
      ).rejects.toThrow(NotFoundError)

      const stillThere = await ChangeOrderService.getAffectedItems(ownerEco.id)
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

      await ChangeOrderService.removeAffectedItem(
        changeOrder.id,
        affected.id!,
        {
          discardBranchChanges: true,
        },
      )

      expect(
        await ChangeOrderService.getAffectedItems(changeOrder.id),
      ).toHaveLength(0)

      // The branch no longer reports a change for this master, so the merge
      // has nothing to release for it.
      const ecoDesigns = await ChangeOrderService.getEcoDesigns(changeOrder.id)
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
        .update(workflowInstances)
        .set({ scopeLocked: true, scopeLockedAt: new Date() })
        .where(eq(workflowInstances.itemId, changeOrder.id))

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

  describe('close', () => {
    // Note: close() calls releaseEco() which requires 'Approved' state
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

      // close() uses releaseEco() which handles branch merging
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

  describe('getEcoDesigns', () => {
    it('returns empty array when no designs associated', async () => {
      const changeOrder = await createChangeOrder()

      const ecoDesigns = await ChangeOrderService.getEcoDesigns(changeOrder.id)

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

      const ecoBranches = await testDb.db
        .select()
        .from(branches)
        .where(eq(branches.changeOrderItemId, changeOrder.id))
      expect(ecoBranches).toHaveLength(0)

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

  describe('addDesignToEco', () => {
    it('adds a design to an ECO and creates branch', async () => {
      const changeOrder = await createChangeOrder()

      const ecoDesign = await ChangeOrderService.addDesignToEco(
        changeOrder.id,
        designId,
        user.id,
      )

      expect(ecoDesign).toBeDefined()
      expect(ecoDesign.designId).toBe(designId)
      expect(ecoDesign.branchId).toBeDefined()
      expect(ecoDesign.mergeStatus).toBe('pending')
    })

    it('returns existing record if already added', async () => {
      const changeOrder = await createChangeOrder()

      const first = await ChangeOrderService.addDesignToEco(
        changeOrder.id,
        designId,
        user.id,
      )

      const second = await ChangeOrderService.addDesignToEco(
        changeOrder.id,
        designId,
        user.id,
      )

      expect(second.id).toBe(first.id)
    })

    it('throws error when change order not found', async () => {
      await expect(
        ChangeOrderService.addDesignToEco(
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
        ChangeOrderService.addDesignToEco(changeOrder.id, designId, user.id),
      ).rejects.toThrow(ValidationError)
    })

    it('creates a ChangeOrder created commit when design is first linked', async () => {
      const changeOrder = await createChangeOrder()

      const ecoDesign = await ChangeOrderService.addDesignToEco(
        changeOrder.id,
        designId,
        user.id,
      )

      // Get the branch and check for commits
      const ecoBranch = await testDb.db
        .select()
        .from(branches)
        .where(eq(branches.id, ecoDesign.branchId!))
        .limit(1)

      expect(ecoBranch[0]).toBeDefined()

      // Find commits on this branch
      const branchCommits = await testDb.db
        .select()
        .from(commits)
        .where(eq(commits.branchId, ecoDesign.branchId!))

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
      const first = await ChangeOrderService.addDesignToEco(
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
      await ChangeOrderService.addDesignToEco(changeOrder.id, designId, user.id)

      // Get final commit count
      const finalCommits = await testDb.db
        .select()
        .from(commits)
        .where(eq(commits.branchId, first.branchId!))

      // Should have same number of commits (no duplicate created)
      expect(finalCommits.length).toBe(initialCommits.length)
    })
  })

  describe('getValidActionsForItem', () => {
    it('returns valid actions for Draft item', async () => {
      const part = await createPart({ state: 'Draft' })

      const actions = await ChangeOrderService.getValidActionsForItem(part.id)

      expect(actions).toContain('release')
    })

    it('returns valid actions for Released item', async () => {
      const part = await createPart({ state: 'Released' })

      const actions = await ChangeOrderService.getValidActionsForItem(part.id)

      expect(actions).toContain('revise')
      expect(actions).toContain('obsolete')
    })

    it('returns empty array for non-existent item', async () => {
      const actions = await ChangeOrderService.getValidActionsForItem(
        '00000000-0000-0000-0000-000000000000',
      )

      expect(actions).toEqual([])
    })
  })

  // `null` as the access scope is cross-program authority — these cover the
  // summary's own arithmetic, not the redaction that scope drives. The
  // scoped behaviour is pinned in program-isolation.permissions.test.ts.
  describe('getEcoSummary', () => {
    it('returns summary for ECO with no designs', async () => {
      const changeOrder = await createChangeOrder()

      const summary = await ChangeOrderService.getEcoSummary(
        changeOrder.id,
        null,
      )

      expect(summary.changeOrder).toBeDefined()
      expect(summary.designs).toEqual([])
      expect(summary.totalItemsAffected).toBe(0)
      expect(summary.canSubmit).toBe(true) // No checked out items
    })

    it('throws error for non-existent change order', async () => {
      await expect(
        ChangeOrderService.getEcoSummary(
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

      const [ecoDesign] = await ChangeOrderService.getEcoDesigns(changeOrder.id)
      const branchId = ecoDesign!.branchId!

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

      const summary = await ChangeOrderService.getEcoSummary(
        changeOrder.id,
        null,
      )

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

    it('reports a held checkout and refuses to submit while one is open', async () => {
      const changeOrder = await createChangeOrder()
      const part = await createPart()

      await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        { affectedItemId: part.id, changeAction: 'release' },
        user.id,
      )

      const [ecoDesign] = await ChangeOrderService.getEcoDesigns(changeOrder.id)
      const branchId = ecoDesign!.branchId!

      const before = await ChangeOrderService.getEcoSummary(
        changeOrder.id,
        null,
      )
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

      const after = await ChangeOrderService.getEcoSummary(changeOrder.id, null)
      expect(after.canSubmit).toBe(false)
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

  describe('checkoutItemToEco', () => {
    it('checkouts a Draft item to ECO branch', async () => {
      const changeOrder = await createChangeOrder()
      const part = await createPart({ state: 'Draft' })

      const result = await ChangeOrderService.checkoutItemToEco(
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

      const result = await ChangeOrderService.checkoutItemToEco(
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
        ChangeOrderService.checkoutItemToEco(
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
        ChangeOrderService.checkoutItemToEco(part1.id, part2.id, user.id),
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
        ChangeOrderService.checkoutItemToEco(
          changeOrder.id,
          anotherPart.id,
          user.id,
        ),
      ).rejects.toThrow(ValidationError)
    })

    it('throws error for non-existent item', async () => {
      const changeOrder = await createChangeOrder()

      await expect(
        ChangeOrderService.checkoutItemToEco(
          changeOrder.id,
          '00000000-0000-0000-0000-000000000000',
          user.id,
        ),
      ).rejects.toThrow(NotFoundError)
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
      // builds. Linked directly rather than through addDesignToEco so the
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
    async function setupCoWithFinalState(finalState: Record<string, unknown>) {
      const defId = randomUUID()
      await testDb.db.insert(workflowDefinitions).values({
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
            },
          ],
          definitionType: 'workflow',
          applicableItemTypes: ['ChangeOrder'],
        },
        isActive: true,
        lifecycleType: 'Driving',
      })

      const changeOrder = await createChangeOrder()
      // Reaching a change order means reaching one of its designs, and the
      // relation that decides that is change_order_designs — `items.designId`,
      // which createChangeOrder sets, is NULL on every ECO the application
      // builds. Linked directly rather than through addDesignToEco so the
      // fixture does not also create a branch and a commit. The design carries
      // no programId, so membership is not what is under test here.
      await testDb.db.insert(changeOrderDesigns).values({
        changeOrderId: changeOrder.id,
        designId,
        mergeStatus: 'pending',
      })
      await testDb.db
        .update(workflowInstances)
        .set({ workflowDefinitionId: defId })
        .where(eq(workflowInstances.itemId, changeOrder.id))

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
