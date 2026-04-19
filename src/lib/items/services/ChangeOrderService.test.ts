/**
 * ChangeOrderService Tests
 *
 * Integration tests for the ChangeOrderService class.
 * Tests cover affected items, workflow transitions, validation, and ECO-as-branch functionality.
 *
 * Run: npm run test -- src/lib/items/services/ChangeOrderService.test.ts
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
import { eq } from 'drizzle-orm'
import { ChangeOrderService } from './ChangeOrderService'
import { ItemService } from './ItemService'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import {
  branches,
  changeOrderRisks,
  changeOrders,
  commits,
  designs,
} from '@/lib/db/schema'
import {
  workflowDefinitions,
  workflowInstances,
} from '@/lib/db/schema/workflows'
import { itemTypeConfigs } from '@/lib/db/schema/config'
import { ItemTypeRegistry } from '@/lib/items/registry'
import {
  SYSTEM_USER_ID,
  seedStandardPartLifecycle,
} from '@/__tests__/fixtures/lifecycles'
import { ValidationError } from '@/lib/errors'

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
    },
    {
      id: 'Rejected',
      name: 'Rejected',
      color: 'red',
      description: 'ECO was rejected',
      isInitial: false,
      isFinal: true,
    },
    {
      id: 'Cancelled',
      name: 'Cancelled',
      color: 'gray',
      description: 'ECO was cancelled',
      isInitial: false,
      isFinal: true,
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
    await testDb.db
      .insert(itemTypeConfigs)
      .values({
        itemType: 'ChangeOrder',
        config: {
          lifecycleDefinitionId: TEST_WORKFLOW_ID,
          workflowsByChangeType: {
            ECO: TEST_WORKFLOW_ID,
            ECN: TEST_WORKFLOW_ID,
            Deviation: TEST_WORKFLOW_ID,
            MCO: TEST_WORKFLOW_ID,
          },
        },
        modifiedBy: SYSTEM_USER_ID,
      })
      .onConflictDoUpdate({
        target: itemTypeConfigs.itemType,
        set: {
          config: {
            lifecycleDefinitionId: TEST_WORKFLOW_ID,
            workflowsByChangeType: {
              ECO: TEST_WORKFLOW_ID,
              ECN: TEST_WORKFLOW_ID,
              Deviation: TEST_WORKFLOW_ID,
              MCO: TEST_WORKFLOW_ID,
            },
          },
          modifiedBy: SYSTEM_USER_ID,
        },
      })

    // Reload ItemTypeRegistry to pick up the test workflow configuration
    await ItemTypeRegistry.reload()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  // Generate unique prefix for test isolation
  let uniquePrefix: string

  beforeEach(async () => {
    await testDb.beginTransaction()

    // Generate unique prefix for this test run
    uniquePrefix = `T${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`

    // Create test user (let fixture generate unique email)
    user = await insertTestUser(testDb.db)

    // Create test design with branch structure
    const [createdDesign] = await testDb.db
      .insert(designs)
      .values({
        name: 'Test Design',
        code: `PROD-${uniquePrefix}`,
        designType: 'Engineering',
        createdBy: user.id,
      })
      .returning()

    const [initialCommit] = await testDb.db
      .insert(commits)
      .values({
        designId: createdDesign.id,
        branchId: createdDesign.id,
        message: 'Initial commit',
        createdBy: user.id,
      })
      .returning()

    const [mainBranch] = await testDb.db
      .insert(branches)
      .values({
        designId: createdDesign.id,
        name: 'main',
        branchType: 'main',
        headCommitId: initialCommit.id,
        baseCommitId: initialCommit.id,
        createdBy: user.id,
      })
      .returning()

    await testDb.db
      .update(commits)
      .set({ branchId: mainBranch.id })
      .where(eq(commits.id, initialCommit.id))

    const [updated] = await testDb.db
      .update(designs)
      .set({ defaultBranchId: mainBranch.id })
      .where(eq(designs.id, createdDesign.id))
      .returning()

    designId = updated.id
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

  describe('addAffectedItem', () => {
    it('adds an affected item with release action', async () => {
      const changeOrder = await createChangeOrder()
      const part = await createPart()

      const affected = await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        {
          affectedItemId: part.id,
          changeAction: 'release',
          currentState: 'Draft',
          targetState: 'Released',
        },
        user.id,
      )

      expect(affected).toBeDefined()
      expect(affected.id).toBeDefined()
      expect(affected.changeOrderId).toBe(changeOrder.id)
      expect(affected.affectedItemId).toBe(part.id)
      expect(affected.changeAction).toBe('release')
    })

    it('adds an affected item with revise action', async () => {
      const changeOrder = await createChangeOrder()
      const part = await createPart({ state: 'Released' })

      const affected = await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        {
          affectedItemId: part.id,
          changeAction: 'revise',
          currentRevision: 'A',
          targetRevision: 'B',
        },
        user.id,
      )

      expect(affected.changeAction).toBe('revise')
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
          changeAction: 'add',
          newItemType: 'Part',
          newItemData: { name: 'New Part', itemNumber: newItemNumber },
          targetState: 'Released',
        },
        user.id,
      )

      expect(affected.changeAction).toBe('add')
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
        .where(eq(commits.branchId, ecoDesigns[0].branchId!))

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

      await ChangeOrderService.removeAffectedItem(affected.id!)

      const items = await ChangeOrderService.getAffectedItems(changeOrder.id)
      expect(items).toHaveLength(0)
    })

    it('handles non-existent affected item gracefully', async () => {
      // Should not throw
      await expect(
        ChangeOrderService.removeAffectedItem(
          '00000000-0000-0000-0000-000000000000',
        ),
      ).resolves.not.toThrow()
    })
  })

  describe('updateAffectedItem', () => {
    it('updates affected item fields', async () => {
      const changeOrder = await createChangeOrder()
      // 'revise' action requires the item to be in 'Released' state
      const part = await createPart({ state: 'Released' })

      const affected = await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        {
          affectedItemId: part.id,
          changeAction: 'revise',
          targetRevision: 'B',
        },
        user.id,
      )

      const updated = await ChangeOrderService.updateAffectedItem(
        affected.id!,
        {
          targetRevision: 'C',
          changeDescription: 'Changed target revision',
        },
      )

      expect(updated.targetRevision).toBe('C')
      expect(updated.changeDescription).toBe('Changed target revision')
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
      expect(items[0].affectedItemDetails).toBeDefined()
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

  describe('validateRelease', () => {
    it('returns error for already released item', async () => {
      const part = await createPart({ state: 'Released' })

      const result = await ChangeOrderService.validateRelease(part.id)

      expect(result.valid).toBe(false)
      expect(result.severity).toBe('error')
      expect(result.message).toContain('already released')
    })

    it('returns warning when item has unreleased BOM children', async () => {
      const parent = await createPart({
        name: 'Parent Assembly',
        state: 'Draft',
      })
      const child = await createPart({
        name: 'Child Component',
        state: 'Draft',
      })

      await ItemService.addRelationship(parent.id, child.id, 'BOM', user.id, {
        quantity: '1',
      })

      const result = await ChangeOrderService.validateRelease(parent.id)

      expect(result.valid).toBe(false)
      expect(result.severity).toBe('warning')
      expect(result.message).toContain('BOM components are not released')
    })

    it('returns warning for item without documents', async () => {
      const part = await createPart({ state: 'Draft' })

      const result = await ChangeOrderService.validateRelease(part.id)

      expect(result.valid).toBe(true)
      expect(result.severity).toBe('warning')
      expect(result.message).toContain('No documents attached')
    })

    it('returns success for valid release candidate with documents', async () => {
      const part = await createPart({ state: 'Draft' })
      const doc = await ItemService.create(
        'Document',
        {
          itemNumber: `DOC-${Date.now()}`,
          revision: 'A',
          name: 'Test Document',
          designId,
        } as any,
        user.id,
      )

      await ItemService.addRelationship(part.id, doc.id, 'Document', user.id)

      const result = await ChangeOrderService.validateRelease(part.id)

      expect(result.valid).toBe(true)
      expect(result.severity).toBe('info')
      expect(result.message).toContain('Ready to release')
    })

    it('returns error for non-existent item', async () => {
      const result = await ChangeOrderService.validateRelease(
        '00000000-0000-0000-0000-000000000000',
      )

      expect(result.valid).toBe(false)
      expect(result.severity).toBe('error')
      expect(result.message).toContain('not found')
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
      expect(risks[0].category).toBe('production')
      expect(risks[0].severity).toBe('high')
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

      const [risk] = await testDb.db
        .insert(changeOrderRisks)
        .values({
          changeOrderId: changeOrder.id,
          category: 'production',
          severity: 'critical',
          description: 'Critical risk requiring acknowledgement',
          requiresAcknowledgement: true,
        })
        .returning()

      await ChangeOrderService.acknowledgeRisk(risk.id, user.id)

      const risks = await ChangeOrderService.getRisks(changeOrder.id)

      expect(risks[0].acknowledgedBy).toBe(user.id)
      expect(risks[0].acknowledgedAt).toBeDefined()
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

      await ChangeOrderService.submit(changeOrder.id, user.id)

      const updated = await ItemService.findById(changeOrder.id)
      expect(updated?.state).toBe('InReview')
    })

    it('throws error when no affected items', async () => {
      const changeOrder = await createChangeOrder()

      await expect(
        ChangeOrderService.submit(changeOrder.id, user.id),
      ).rejects.toThrow('Cannot submit change order without affected items')
    })

    it('updates submittedAt timestamp', async () => {
      const changeOrder = await createChangeOrder()
      const part = await createPart()

      await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        { affectedItemId: part.id, changeAction: 'release' },
        user.id,
      )

      await ChangeOrderService.submit(changeOrder.id, user.id)

      const coRecord = await testDb.db
        .select()
        .from(changeOrders)
        .where(eq(changeOrders.itemId, changeOrder.id))
        .limit(1)

      expect(coRecord[0].submittedAt).toBeDefined()
    })
  })

  describe('approve', () => {
    it('transitions change order to Approved state', async () => {
      const changeOrder = await createChangeOrder()
      const part = await createPart()

      await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        { affectedItemId: part.id, changeAction: 'release' },
        user.id,
      )

      await ChangeOrderService.submit(changeOrder.id, user.id)
      const result = await ChangeOrderService.approve(changeOrder.id, user.id)

      expect(result.changeOrder?.state).toBe('Approved')
    })

    it('throws error when critical risks are not acknowledged', async () => {
      const changeOrder = await createChangeOrder()
      const part = await createPart()

      await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        { affectedItemId: part.id, changeAction: 'release' },
        user.id,
      )

      // Add unacknowledged critical risk
      await testDb.db.insert(changeOrderRisks).values({
        changeOrderId: changeOrder.id,
        category: 'production',
        severity: 'critical',
        description: 'Critical risk',
        requiresAcknowledgement: true,
      })

      await ChangeOrderService.submit(changeOrder.id, user.id)

      await expect(
        ChangeOrderService.approve(changeOrder.id, user.id),
      ).rejects.toThrow('critical risks require acknowledgement')
    })

    it('updates approvedAt and approvedBy fields', async () => {
      const changeOrder = await createChangeOrder()
      const part = await createPart()

      await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        { affectedItemId: part.id, changeAction: 'release' },
        user.id,
      )

      await ChangeOrderService.submit(changeOrder.id, user.id)
      await ChangeOrderService.approve(changeOrder.id, user.id)

      const coRecord = await testDb.db
        .select()
        .from(changeOrders)
        .where(eq(changeOrders.itemId, changeOrder.id))
        .limit(1)

      expect(coRecord[0].approvedAt).toBeDefined()
      expect(coRecord[0].approvedBy).toBe(user.id)
    })
  })

  describe('reject', () => {
    it('transitions change order to Rejected state', async () => {
      const changeOrder = await createChangeOrder()
      const part = await createPart()

      await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        { affectedItemId: part.id, changeAction: 'release' },
        user.id,
      )

      await ChangeOrderService.submit(changeOrder.id, user.id)
      await ChangeOrderService.reject(
        changeOrder.id,
        user.id,
        'Insufficient justification',
      )

      const updated = await ItemService.findById(changeOrder.id)
      expect(updated?.state).toBe('Rejected')
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
      await ChangeOrderService.submit(changeOrder.id, user.id)
      await ChangeOrderService.approve(changeOrder.id, user.id)
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

      await ChangeOrderService.submit(changeOrder.id, user.id)
      await ChangeOrderService.approve(changeOrder.id, user.id)
      await ChangeOrderService.close(changeOrder.id, user.id)

      const coRecord = await testDb.db
        .select()
        .from(changeOrders)
        .where(eq(changeOrders.itemId, changeOrder.id))
        .limit(1)

      expect(coRecord[0].closedAt).toBeDefined()
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
  })

  describe('validateObsolescence', () => {
    it('returns success for item not used in released assemblies', async () => {
      const part = await createPart({ state: 'Released' })

      const result = await ChangeOrderService.validateObsolescence(part.id)

      expect(result.valid).toBe(true)
      expect(result.message).toContain('not currently used')
    })

    it('returns success with replacement for used item', async () => {
      const parent = await createPart({ name: 'Parent', state: 'Released' })
      const child = await createPart({ name: 'Child', state: 'Released' })
      const replacement = await createPart({
        name: 'Replacement',
        state: 'Released',
      })

      await ItemService.addRelationship(parent.id, child.id, 'BOM', user.id)

      const result = await ChangeOrderService.validateObsolescence(
        child.id,
        replacement.id,
      )

      // Should be valid when replacement is provided
      expect(result.valid).toBe(true)
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
      await ChangeOrderService.submit(changeOrder.id, user.id)

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
      ).rejects.toThrow('Change order not found')
    })

    it('throws error when change order not in Draft or InReview state', async () => {
      const changeOrder = await createChangeOrder()
      const part = await createPart()

      await ChangeOrderService.addAffectedItem(
        changeOrder.id,
        { affectedItemId: part.id, changeAction: 'release' },
        user.id,
      )

      await ChangeOrderService.submit(changeOrder.id, user.id)
      await ChangeOrderService.approve(changeOrder.id, user.id)

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

  describe('getEcoSummary', () => {
    it('returns summary for ECO with no designs', async () => {
      const changeOrder = await createChangeOrder()

      const summary = await ChangeOrderService.getEcoSummary(changeOrder.id)

      expect(summary.changeOrder).toBeDefined()
      expect(summary.designs).toEqual([])
      expect(summary.totalItemsAffected).toBe(0)
      expect(summary.canSubmit).toBe(true) // No checked out items
    })

    it('throws error for non-existent change order', async () => {
      await expect(
        ChangeOrderService.getEcoSummary(
          '00000000-0000-0000-0000-000000000000',
        ),
      ).rejects.toThrow('Change order not found')
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
      ).rejects.toThrow('Change order not found')
    })

    it('throws error when item is not a change order', async () => {
      const part1 = await createPart()
      const part2 = await createPart()

      // Try to use a Part as change order
      await expect(
        ChangeOrderService.checkoutItemToEco(part1.id, part2.id, user.id),
      ).rejects.toThrow('Item is not a change order')
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
      await ChangeOrderService.submit(changeOrder.id, user.id)
      await ChangeOrderService.approve(changeOrder.id, user.id)

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
      ).rejects.toThrow('Item not found')
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

      await expect(
        ChangeOrderService.transitionWorkflow(
          changeOrder.id,
          'Submitted',
          user.id,
        ),
      ).rejects.toThrow('No workflow found')
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
            targetRevision: 'B',
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
          changeAction: 'add',
          newItemType: 'Part',
          newItemData: { itemNumber: newItemNumber, name: 'New Part' },
          targetState: 'Released',
        },
        user.id,
      )

      expect(affected.changeAction).toBe('add')
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
})
