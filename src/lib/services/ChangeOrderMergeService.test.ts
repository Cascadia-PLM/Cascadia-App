/**
 * ChangeOrderMergeService Tests
 *
 * Integration tests for the ChangeOrderMergeService class.
 * Tests cover change order merge, conflict detection, and revision assignment.
 *
 * Run: npm run test -- src/lib/services/ChangeOrderMergeService.test.ts
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
import { ChangeOrderMergeService } from './ChangeOrderMergeService'
import { BranchService } from './BranchService'
import { DesignService } from './DesignService'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import {
  branchItems,
  changeOrderAffectedItems,
  changeOrderDesigns,
  items,
  programs,
  workflowDefinitions,
  workflowInstances,
} from '@/lib/db/schema'
import { ItemTypeRegistry } from '@/lib/items/registry'
import { seedStandardPartLifecycle } from '@/__tests__/fixtures/lifecycles'
import {
  MergeConflictError,
  NotFoundError,
  ValidationError,
} from '@/lib/errors'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

// Well-known test workflow ID for ChangeOrderMergeService ECO workflow
const MERGE_TEST_WORKFLOW_ID = '00000000-0000-4000-8000-000000000201'

describe('ChangeOrderMergeService', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let programId: string
  let designId: string
  let workflowId: string
  let uniquePrefix: string

  beforeAll(async () => {
    await testDb.setup()

    // System user + Part lifecycle + Part item-type link via shared fixture
    await seedStandardPartLifecycle(testDb.db)

    // ECO workflow is specific to these merge tests — unique ID avoids races
    // with other test files that define their own ECO workflows.
    await testDb.db
      .insert(workflowDefinitions)
      .values({
        id: MERGE_TEST_WORKFLOW_ID,
        name: 'Test ECO Workflow - MergeService',
        version: 1,
        workflowType: 'strict',
        definition: {
          states: [
            { id: 'Draft', name: 'Draft', isInitial: true, isFinal: false },
            {
              id: 'Submitted',
              name: 'Submitted',
              isInitial: false,
              isFinal: false,
            },
            {
              id: 'Approved',
              name: 'Approved',
              isInitial: false,
              isFinal: false,
            },
            {
              id: 'Released',
              name: 'Released',
              isInitial: false,
              isFinal: true,
            },
          ],
          transitions: [
            {
              id: 't1',
              name: 'Submit',
              fromStateId: 'Draft',
              toStateId: 'Submitted',
            },
            {
              id: 't2',
              name: 'Approve',
              fromStateId: 'Submitted',
              toStateId: 'Approved',
            },
            {
              id: 't3',
              name: 'Release',
              fromStateId: 'Approved',
              toStateId: 'Released',
            },
          ],
          definitionType: 'workflow',
          applicableItemTypes: ['ChangeOrder'],
        },
        isActive: true,
      })
      .onConflictDoNothing()

    workflowId = MERGE_TEST_WORKFLOW_ID

    // Reload ItemTypeRegistry to pick up the Part lifecycle
    await ItemTypeRegistry.reload()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()

    // Generate unique prefix for this test run
    uniquePrefix = `T${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`

    // Create test user
    user = await insertTestUser(testDb.db)

    // Create test program
    const [program] = await testDb.db
      .insert(programs)
      .values({
        name: 'Test Program',
        code: `PROG-${uniquePrefix}`,
        createdBy: user.id,
      })
      .returning()

    programId = program.id

    // Create test design with main branch
    const design = await DesignService.create(
      {
        programId,
        name: 'Test Design',
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

  // Helper to create a part
  async function createPart(suffix: string = '', state: string = 'Draft') {
    return ItemService.create(
      'Part',
      {
        itemNumber: `PN-${uniquePrefix}-${suffix || Math.random().toString(36).slice(2, 6)}`,
        revision: 'A',
        name: `Test Part ${suffix}`,
        designId,
        state,
      } as any,
      user.id,
    )
  }

  // Helper to create a change order
  // Note: ChangeOrders use auto-generated item numbers
  async function createChangeOrder() {
    const eco = await ItemService.create(
      'ChangeOrder',
      {
        // itemNumber is auto-generated for ChangeOrders
        revision: '-',
        name: 'Test ECO',
        changeType: 'ECO',
        priority: 'medium',
        reasonForChange: 'Test',
      } as any,
      user.id,
    )

    // Start workflow instance for the ECO
    await testDb.db.insert(workflowInstances).values({
      workflowDefinitionId: workflowId,
      itemId: eco.id,
      currentState: 'Draft',
    })

    return eco
  }

  // Helper to approve an ECO (skip workflow for testing)
  async function approveEco(ecoId: string) {
    await testDb.db
      .update(items)
      .set({ state: 'Approved' })
      .where(eq(items.id, ecoId))

    await testDb.db
      .update(workflowInstances)
      .set({ currentState: 'Approved' })
      .where(eq(workflowInstances.itemId, ecoId))
  }

  describe('getNextRevision', () => {
    it('returns A for empty revision', () => {
      expect(ChangeOrderMergeService.getNextRevision('')).toBe('A')
    })

    it('returns A for DRAFT revision', () => {
      expect(ChangeOrderMergeService.getNextRevision('DRAFT')).toBe('A')
    })

    it('returns A for dash revision', () => {
      expect(ChangeOrderMergeService.getNextRevision('-')).toBe('A')
    })

    it('increments A to B', () => {
      expect(ChangeOrderMergeService.getNextRevision('A')).toBe('B')
    })

    it('increments Y to Z', () => {
      expect(ChangeOrderMergeService.getNextRevision('Y')).toBe('Z')
    })

    it('increments Z to AA', () => {
      expect(ChangeOrderMergeService.getNextRevision('Z')).toBe('AA')
    })

    it('increments AA to AB', () => {
      expect(ChangeOrderMergeService.getNextRevision('AA')).toBe('AB')
    })

    it('increments AZ to BA', () => {
      expect(ChangeOrderMergeService.getNextRevision('AZ')).toBe('BA')
    })

    it('increments ZZ to AAA', () => {
      expect(ChangeOrderMergeService.getNextRevision('ZZ')).toBe('AAA')
    })

    it('handles lowercase input', () => {
      expect(ChangeOrderMergeService.getNextRevision('a')).toBe('B')
    })
  })

  describe('validateMerge', () => {
    it('returns canMerge: false when branch not found', async () => {
      // Use a valid UUID format that doesn't exist
      const nonExistentUuid = '00000000-0000-0000-0000-000000000000'
      const result =
        await ChangeOrderMergeService.validateMerge(nonExistentUuid)

      expect(result.canMerge).toBe(false)
      expect(result.conflicts).toHaveLength(1)
      expect(result.conflicts[0].conflictType).toBe('branch_not_found')
    })

    it('returns canMerge: false when no changes to merge', async () => {
      const eco = await createChangeOrder()

      // Create ECO branch with no changes
      const { branch } = await BranchService.getOrCreateEcoBranch(
        designId,
        eco.id,
        user.id,
      )

      const result = await ChangeOrderMergeService.validateMerge(branch.id)

      expect(result.canMerge).toBe(false)
      expect(
        result.conflicts.some((c) => c.conflictType === 'no_changes'),
      ).toBe(true)
    })

    it('returns warning when branch is not locked', async () => {
      const eco = await createChangeOrder()

      // Create ECO branch directly (without checkout flow)
      const { branch } = await BranchService.getOrCreateEcoBranch(
        designId,
        eco.id,
        user.id,
      )

      // Add a branch item with a change (simulating a checkout without the full flow)
      const part = await createPart('unlocked', 'Released')
      await testDb.db.insert(branchItems).values({
        branchId: branch.id,
        itemMasterId: part.id,
        currentItemId: part.id,
        baseItemId: part.id,
        changeType: 'modify',
      })

      const result = await ChangeOrderMergeService.validateMerge(branch.id)
      // Branch is not locked, so warning should be present
      expect(result.warnings).toContain(
        'Branch is not locked - consider locking before merge',
      )
    })

    it('detects items still checked out', async () => {
      const eco = await createChangeOrder()

      // Create ECO branch directly
      const { branch } = await BranchService.getOrCreateEcoBranch(
        designId,
        eco.id,
        user.id,
      )

      // Add a branch item that is checked out
      const part = await createPart('checkout', 'Released')
      await testDb.db.insert(branchItems).values({
        branchId: branch.id,
        itemMasterId: part.id,
        currentItemId: part.id,
        baseItemId: part.id,
        changeType: 'modify',
        checkedOutBy: user.id, // Mark as checked out
      })

      const result = await ChangeOrderMergeService.validateMerge(branch.id)

      expect(result.canMerge).toBe(false)
      expect(result.conflicts.some((c) => c.conflictType === 'checkout')).toBe(
        true,
      )
    })
  })

  describe('previewRelease', () => {
    it('returns empty preview when no designs associated', async () => {
      const eco = await createChangeOrder()

      const preview = await ChangeOrderMergeService.previewMerge(eco.id)

      expect(preview.designs).toHaveLength(0)
      expect(preview.totalItems).toBe(0)
      expect(preview.canRelease).toBe(false) // ECO is in Draft state
    })
  })

  describe('merge', () => {
    // Note: State validation removed - merge() is only called after workflow transition
    // has already succeeded. The transition API validates state transitions.

    it('throws error when no affected items or designs', async () => {
      const eco = await createChangeOrder()
      await approveEco(eco.id)

      await expect(
        ChangeOrderMergeService.merge(eco.id, user.id),
      ).rejects.toThrow(ValidationError)
    })

    it('throws error when change order not found', async () => {
      const nonExistentId = '00000000-0000-0000-0000-000000000000'

      await expect(
        ChangeOrderMergeService.merge(nonExistentId, user.id),
      ).rejects.toThrow(NotFoundError)
    })

    it('releases affected items with release action', async () => {
      // Create a Draft part
      const part = await createPart('release-test', 'Draft')

      // Create and approve ECO
      const eco = await createChangeOrder()

      // Add affected item with release action
      await testDb.db.insert(changeOrderAffectedItems).values({
        changeOrderId: eco.id,
        affectedItemId: part.id,
        affectedItemMasterId: part.masterId,
        changeAction: 'release',
        currentState: 'Draft',
        targetState: 'Released',
        createdBy: user.id,
      })

      await approveEco(eco.id)

      // Release the ECO
      const result = await ChangeOrderMergeService.merge(eco.id, user.id)

      expect(result.totalRevisionsAssigned).toBe(1)

      // Verify item state changed to Released
      const updatedPart = await ItemService.findById(part.id)
      expect(updatedPart?.state).toBe('Released')
    })

    it('releases affected items with obsolete action', async () => {
      // Create a Released part
      const part = await createPart('obsolete-test', 'Released')

      // Create and approve ECO
      const eco = await createChangeOrder()

      // Add affected item with obsolete action
      await testDb.db.insert(changeOrderAffectedItems).values({
        changeOrderId: eco.id,
        affectedItemId: part.id,
        affectedItemMasterId: part.masterId,
        changeAction: 'obsolete',
        currentState: 'Released',
        targetState: 'Obsolete',
        createdBy: user.id,
      })

      await approveEco(eco.id)

      // Release the ECO
      const result = await ChangeOrderMergeService.merge(eco.id, user.id)

      expect(result.designs).toBeDefined()

      // Verify item state changed to Obsolete
      const updatedPart = await ItemService.findById(part.id)
      expect(updatedPart?.state).toBe('Obsolete')
    })

    it('creates new revision for revise action without working copy', async () => {
      // Create a Released part
      const part = await createPart('revise-test', 'Released')

      // Create and approve ECO
      const eco = await createChangeOrder()

      // Add affected item with revise action
      await testDb.db.insert(changeOrderAffectedItems).values({
        changeOrderId: eco.id,
        affectedItemId: part.id,
        affectedItemMasterId: part.masterId,
        changeAction: 'revise',
        currentState: 'Released',
        currentRevision: 'A',
        targetRevision: 'B',
        createdBy: user.id,
      })

      await approveEco(eco.id)

      // Release the ECO
      const result = await ChangeOrderMergeService.merge(eco.id, user.id)

      expect(result.totalRevisionsAssigned).toBe(1)

      // Verify original item is no longer current
      const originalPart = await ItemService.findById(part.id)
      expect(originalPart?.isCurrent).toBe(false)

      // Verify new revision was created
      const allRevisions = await testDb.db
        .select()
        .from(items)
        .where(eq(items.masterId, part.masterId))

      expect(allRevisions.length).toBe(2)
      const newRevision = allRevisions.find((r) => r.revision === 'B')
      expect(newRevision).toBeDefined()
      expect(newRevision?.state).toBe('Released')
      expect(newRevision?.isCurrent).toBe(true)
    })

    it('skips add/remove actions during release', async () => {
      // Create a Draft part
      const part = await createPart('add-test', 'Draft')

      // Create and approve ECO
      const eco = await createChangeOrder()

      // Add affected item with add action (membership action)
      await testDb.db.insert(changeOrderAffectedItems).values({
        changeOrderId: eco.id,
        affectedItemId: part.id,
        affectedItemMasterId: part.masterId,
        changeAction: 'add',
        createdBy: user.id,
      })

      await approveEco(eco.id)

      // Release the ECO - should not throw
      await ChangeOrderMergeService.merge(eco.id, user.id)

      // Item state should be unchanged (add action doesn't modify state)
      const updatedPart = await ItemService.findById(part.id)
      expect(updatedPart?.state).toBe('Draft')
    })

    it('releases ECO with design association via ChangeOrderService', async () => {
      // Create a Draft part
      const part = await createPart('design-assoc-test', 'Draft')

      // Create ECO
      const eco = await createChangeOrder()

      // Add affected item using ChangeOrderService (which handles design association automatically)
      await ChangeOrderService.addAffectedItem(
        eco.id,
        {
          affectedItemId: part.id,
          changeAction: 'release',
        },
        user.id,
      )

      await approveEco(eco.id)

      // Release the ECO
      const result = await ChangeOrderMergeService.merge(eco.id, user.id)

      // The release should succeed
      expect(result.totalRevisionsAssigned).toBe(1)

      // Verify design association was created
      const ecoDesigns = await ChangeOrderService.getEcoDesigns(eco.id)
      expect(ecoDesigns.length).toBeGreaterThan(0)

      // Verify the part was released
      const releasedPart = await ItemService.findById(part.id)
      expect(releasedPart?.state).toBe('Released')
    })
  })

  describe('mergeBranchToMain', () => {
    it('throws error when branch not found', async () => {
      const nonExistentId = '00000000-0000-0000-0000-000000000000'
      const eco = await createChangeOrder()

      await expect(
        ChangeOrderMergeService.mergeBranchToMain(
          nonExistentId,
          eco.id,
          user.id,
        ),
      ).rejects.toThrow(NotFoundError)
    })

    it('throws error when branch is not ECO type', async () => {
      // Get main branch (which is not an ECO branch)
      const mainBranch = await BranchService.getMainBranch(designId)
      const eco = await createChangeOrder()

      await expect(
        ChangeOrderMergeService.mergeBranchToMain(
          mainBranch!.id,
          eco.id,
          user.id,
        ),
      ).rejects.toThrow(ValidationError)
    })

    it('throws error when no changes to merge', async () => {
      const eco = await createChangeOrder()
      const { branch } = await BranchService.getOrCreateEcoBranch(
        designId,
        eco.id,
        user.id,
      )

      await expect(
        ChangeOrderMergeService.mergeBranchToMain(branch.id, eco.id, user.id),
      ).rejects.toThrow(ValidationError)
    })

    it('merges added items and assigns revision A', async () => {
      const eco = await createChangeOrder()
      const { branch } = await BranchService.getOrCreateEcoBranch(
        designId,
        eco.id,
        user.id,
      )

      // Create a new part with placeholder revision (simulating adding on ECO branch)
      const part = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-merge-add`,
          revision: '-', // Placeholder revision
          name: 'Test Part merge-add',
          designId,
          state: 'Draft',
        } as any,
        user.id,
      )

      // Track it on the ECO branch as added
      await testDb.db.insert(branchItems).values({
        branchId: branch.id,
        itemMasterId: part.masterId!,
        currentItemId: part.id,
        baseItemId: null,
        changeType: 'added',
      })

      // Merge
      const result = await ChangeOrderMergeService.mergeBranchToMain(
        branch.id,
        eco.id,
        user.id,
      )

      expect(result.itemsAdded).toBe(1)
      expect(result.revisionsAssigned[part.itemNumber!]).toBe('A')

      // Verify branch was archived
      const archivedBranch = await BranchService.getById(branch.id)
      expect(archivedBranch?.archivedAt).toBeDefined()
    })

    it('merges modified items and increments revision', async () => {
      const eco = await createChangeOrder()
      const { branch } = await BranchService.getOrCreateEcoBranch(
        designId,
        eco.id,
        user.id,
      )

      // Create a Released part on main
      const part = await createPart('merge-modify', 'Released')
      const mainBranch = await BranchService.getMainBranch(designId)

      // Track it on main branch
      await testDb.db.insert(branchItems).values({
        branchId: mainBranch!.id,
        itemMasterId: part.masterId!,
        currentItemId: part.id,
        baseItemId: part.id,
        changeType: null,
      })

      // Track modification on ECO branch
      await testDb.db.insert(branchItems).values({
        branchId: branch.id,
        itemMasterId: part.masterId!,
        currentItemId: part.id,
        baseItemId: part.id,
        changeType: 'modified',
      })

      // Merge
      const result = await ChangeOrderMergeService.mergeBranchToMain(
        branch.id,
        eco.id,
        user.id,
      )

      expect(result.itemsMerged).toBe(1)
      expect(result.revisionsAssigned[part.itemNumber!]).toBe('B')
    })

    it('marks deleted items as obsolete', async () => {
      const eco = await createChangeOrder()
      const { branch } = await BranchService.getOrCreateEcoBranch(
        designId,
        eco.id,
        user.id,
      )

      // Create a Released part on main
      const part = await createPart('merge-delete', 'Released')
      const mainBranch = await BranchService.getMainBranch(designId)

      // Track it on main branch
      await testDb.db.insert(branchItems).values({
        branchId: mainBranch!.id,
        itemMasterId: part.masterId!,
        currentItemId: part.id,
        baseItemId: part.id,
        changeType: null,
      })

      // Track deletion on ECO branch
      await testDb.db.insert(branchItems).values({
        branchId: branch.id,
        itemMasterId: part.masterId!,
        currentItemId: part.id,
        baseItemId: part.id,
        changeType: 'deleted',
      })

      // Merge
      const result = await ChangeOrderMergeService.mergeBranchToMain(
        branch.id,
        eco.id,
        user.id,
      )

      expect(result.itemsDeleted).toBe(1)

      // Verify item was marked as obsolete (bypass notDeleted filter with direct query)
      const [deletedItem] = await testDb.db
        .select()
        .from(items)
        .where(eq(items.id, part.id))
        .limit(1)
      expect(deletedItem).toBeDefined()
      expect(deletedItem.state).toBe('Obsolete')
      expect(deletedItem.isDeleted).toBe(true)
    })

    it('creates merge commit with revision information', async () => {
      const eco = await createChangeOrder()
      const { branch } = await BranchService.getOrCreateEcoBranch(
        designId,
        eco.id,
        user.id,
      )

      // Create and track an added part with placeholder revision
      const part = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-commit-test`,
          revision: '-', // Placeholder revision
          name: 'Test Part commit-test',
          designId,
          state: 'Draft',
        } as any,
        user.id,
      )
      await testDb.db.insert(branchItems).values({
        branchId: branch.id,
        itemMasterId: part.masterId!,
        currentItemId: part.id,
        baseItemId: null,
        changeType: 'added',
      })

      // Merge
      const result = await ChangeOrderMergeService.mergeBranchToMain(
        branch.id,
        eco.id,
        user.id,
      )

      expect(result.mergeCommit).toBeDefined()
      expect(result.mergeCommit.message).toContain('Merged ECO branch')
    })
  })

  describe('previewRelease', () => {
    it('returns empty preview when no designs associated', async () => {
      const eco = await createChangeOrder()

      const preview = await ChangeOrderMergeService.previewMerge(eco.id)

      expect(preview.designs).toHaveLength(0)
      expect(preview.totalItems).toBe(0)
      expect(preview.canRelease).toBe(false) // ECO is in Draft state
    })

    it('throws error when change order not found', async () => {
      const nonExistentId = '00000000-0000-0000-0000-000000000000'

      await expect(
        ChangeOrderMergeService.previewMerge(nonExistentId),
      ).rejects.toThrow(NotFoundError)
    })

    it('returns preview with items and revisions', async () => {
      const eco = await createChangeOrder()
      const { branch } = await BranchService.getOrCreateEcoBranch(
        designId,
        eco.id,
        user.id,
      )

      // Associate design with ECO
      await testDb.db.insert(changeOrderDesigns).values({
        changeOrderId: eco.id,
        designId: designId,
        branchId: branch.id,
        mergeStatus: 'pending',
        itemsAffected: 1,
      })

      // Create and track an added part
      const part = await createPart('preview-test', 'Draft')
      await testDb.db.insert(branchItems).values({
        branchId: branch.id,
        itemMasterId: part.masterId!,
        currentItemId: part.id,
        baseItemId: null,
        changeType: 'added',
      })

      const preview = await ChangeOrderMergeService.previewMerge(eco.id)

      expect(preview.designs).toHaveLength(1)
      expect(preview.designs[0].designName).toBe('Test Design')
      expect(preview.designs[0].items).toHaveLength(1)
      expect(preview.designs[0].items[0].changeType).toBe('added')
      expect(preview.designs[0].items[0].newRevision).toBe('A')
      expect(preview.totalItems).toBe(1)
    })

    it('returns canRelease true when ECO is approved and no conflicts', async () => {
      const eco = await createChangeOrder()
      const { branch } = await BranchService.getOrCreateEcoBranch(
        designId,
        eco.id,
        user.id,
      )

      // Associate design with ECO
      await testDb.db.insert(changeOrderDesigns).values({
        changeOrderId: eco.id,
        designId: designId,
        branchId: branch.id,
        mergeStatus: 'pending',
        itemsAffected: 1,
      })

      // Create and track an added part
      const part = await createPart('canrelease-test', 'Draft')
      await testDb.db.insert(branchItems).values({
        branchId: branch.id,
        itemMasterId: part.masterId!,
        currentItemId: part.id,
        baseItemId: null,
        changeType: 'added',
      })

      // Approve the ECO
      await approveEco(eco.id)

      const preview = await ChangeOrderMergeService.previewMerge(eco.id)

      expect(preview.canRelease).toBe(true)
      expect(preview.allConflicts).toHaveLength(0)
    })

    it('returns canRelease false when items are checked out', async () => {
      const eco = await createChangeOrder()
      const { branch } = await BranchService.getOrCreateEcoBranch(
        designId,
        eco.id,
        user.id,
      )

      // Associate design with ECO
      await testDb.db.insert(changeOrderDesigns).values({
        changeOrderId: eco.id,
        designId: designId,
        branchId: branch.id,
        mergeStatus: 'pending',
        itemsAffected: 1,
      })

      // Create and track a part that's checked out
      const part = await createPart('checkout-preview', 'Released')
      await testDb.db.insert(branchItems).values({
        branchId: branch.id,
        itemMasterId: part.masterId!,
        currentItemId: part.id,
        baseItemId: part.id,
        changeType: 'modified',
        checkedOutBy: user.id,
      })

      // Approve the ECO
      await approveEco(eco.id)

      const preview = await ChangeOrderMergeService.previewMerge(eco.id)

      expect(preview.canRelease).toBe(false)
      expect(
        preview.allConflicts.some((c) => c.conflictType === 'checkout'),
      ).toBe(true)
    })

    it('calculates correct revision for modified items', async () => {
      const eco = await createChangeOrder()
      const { branch } = await BranchService.getOrCreateEcoBranch(
        designId,
        eco.id,
        user.id,
      )

      // Associate design with ECO
      await testDb.db.insert(changeOrderDesigns).values({
        changeOrderId: eco.id,
        designId: designId,
        branchId: branch.id,
        mergeStatus: 'pending',
        itemsAffected: 1,
      })

      // Create a Released part at revision C
      const part = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-rev-test`,
          revision: 'C',
          name: 'Revision Test Part',
          designId,
          state: 'Released',
        } as any,
        user.id,
      )

      // Track modification
      await testDb.db.insert(branchItems).values({
        branchId: branch.id,
        itemMasterId: part.masterId!,
        currentItemId: part.id,
        baseItemId: part.id,
        changeType: 'modified',
      })

      const preview = await ChangeOrderMergeService.previewMerge(eco.id)

      expect(preview.designs[0].items[0].currentRevision).toBe('C')
      expect(preview.designs[0].items[0].newRevision).toBe('D')
    })
  })

  describe('validateMerge advanced scenarios', () => {
    it('returns canMerge: true when branch has valid changes', async () => {
      const eco = await createChangeOrder()
      const { branch } = await BranchService.getOrCreateEcoBranch(
        designId,
        eco.id,
        user.id,
      )

      // Create and track an added part
      const part = await createPart('valid-change', 'Draft')
      await testDb.db.insert(branchItems).values({
        branchId: branch.id,
        itemMasterId: part.masterId!,
        currentItemId: part.id,
        baseItemId: null,
        changeType: 'added',
      })

      // Lock the branch
      await BranchService.lockBranch(branch.id)

      const result = await ChangeOrderMergeService.validateMerge(branch.id)

      expect(result.canMerge).toBe(true)
      expect(result.conflicts).toHaveLength(0)
      expect(result.warnings).toHaveLength(0)
    })

    it('detects concurrent modification conflicts', async () => {
      const eco = await createChangeOrder()
      const { branch } = await BranchService.getOrCreateEcoBranch(
        designId,
        eco.id,
        user.id,
      )

      // Create a Released part
      const part = await createPart('concurrent-test', 'Released')
      const mainBranch = await BranchService.getMainBranch(designId)

      // Track on main branch
      await testDb.db.insert(branchItems).values({
        branchId: mainBranch!.id,
        itemMasterId: part.masterId!,
        currentItemId: part.id,
        baseItemId: part.id,
        changeType: null,
      })

      // Track on ECO branch with the same base
      await testDb.db.insert(branchItems).values({
        branchId: branch.id,
        itemMasterId: part.masterId!,
        currentItemId: part.id,
        baseItemId: part.id,
        changeType: 'modified',
      })

      // Simulate concurrent modification: create a new revision on main with DIFFERENT name
      const [newRevision] = await testDb.db
        .insert(items)
        .values({
          itemNumber: part.itemNumber,
          itemType: 'Part',
          revision: 'B',
          name: 'MODIFIED NAME', // Different name to trigger conflict
          state: 'Released',
          masterId: part.masterId,
          designId: part.designId,
          isCurrent: true,
          createdBy: user.id,
          modifiedBy: user.id,
        })
        .returning()

      // Update main branch to point to new revision
      await testDb.db
        .update(branchItems)
        .set({ currentItemId: newRevision.id })
        .where(
          and(
            eq(branchItems.branchId, mainBranch!.id),
            eq(branchItems.itemMasterId, part.masterId),
          ),
        )

      // Mark old revision as not current
      await testDb.db
        .update(items)
        .set({ isCurrent: false })
        .where(eq(items.id, part.id))

      const result = await ChangeOrderMergeService.validateMerge(branch.id)

      // Should detect that main has changed since branch was created
      expect(
        result.conflicts.some(
          (c) => c.conflictType === 'concurrent_modification',
        ),
      ).toBe(true)
    })

    it('does not flag concurrent modification for revision-only changes', async () => {
      const eco = await createChangeOrder()
      const { branch } = await BranchService.getOrCreateEcoBranch(
        designId,
        eco.id,
        user.id,
      )

      // Create a Released part
      const part = await createPart('rev-only-test', 'Released')
      const mainBranch = await BranchService.getMainBranch(designId)

      // Track on main branch
      await testDb.db.insert(branchItems).values({
        branchId: mainBranch!.id,
        itemMasterId: part.masterId!,
        currentItemId: part.id,
        baseItemId: part.id,
        changeType: null,
      })

      // Track on ECO branch with the same base
      await testDb.db.insert(branchItems).values({
        branchId: branch.id,
        itemMasterId: part.masterId!,
        currentItemId: part.id,
        baseItemId: part.id,
        changeType: 'modified',
      })

      // Create a new revision on main that only differs by revision (no field changes)
      // Get full item data to copy ALL fields and avoid false positive conflicts
      const [originalItem] = await testDb.db
        .select()
        .from(items)
        .where(eq(items.id, part.id))

      const [newRevision] = await testDb.db
        .insert(items)
        .values({
          // Copy all fields from original item
          itemNumber: originalItem.itemNumber,
          itemType: originalItem.itemType,
          name: originalItem.name,
          description: originalItem.description,
          state: originalItem.state,
          masterId: originalItem.masterId,
          designId: originalItem.designId,
          inDesignStructure: originalItem.inDesignStructure,
          attributes: originalItem.attributes,
          metamodel: originalItem.metamodel,
          sysmlType: originalItem.sysmlType,
          usageOf: originalItem.usageOf,
          // Only change the revision and metadata fields
          revision: 'B',
          isCurrent: true,
          createdBy: user.id,
          modifiedBy: user.id,
        })
        .returning()

      // Update main branch to point to new revision
      await testDb.db
        .update(branchItems)
        .set({ currentItemId: newRevision.id })
        .where(
          and(
            eq(branchItems.branchId, mainBranch!.id),
            eq(branchItems.itemMasterId, part.masterId),
          ),
        )

      const result = await ChangeOrderMergeService.validateMerge(branch.id)

      // Should NOT flag as conflict since only revision changed (no meaningful field changes)
      expect(
        result.conflicts.filter(
          (c) => c.conflictType === 'concurrent_modification',
        ),
      ).toHaveLength(0)
    })
  })

  describe('multi-design ECO release', () => {
    it('releases ECO affecting items from same design', async () => {
      // Create parts in same design (multi-design is complex, test single design with multiple items)
      const part1 = await createPart('multi-item1', 'Draft')
      const part2 = await createPart('multi-item2', 'Draft')

      // Create ECO
      const eco = await createChangeOrder()

      // Add affected items
      await testDb.db.insert(changeOrderAffectedItems).values([
        {
          changeOrderId: eco.id,
          affectedItemId: part1.id,
          affectedItemMasterId: part1.masterId,
          changeAction: 'release',
          currentState: 'Draft',
          targetState: 'Released',
          createdBy: user.id,
        },
        {
          changeOrderId: eco.id,
          affectedItemId: part2.id,
          affectedItemMasterId: part2.masterId,
          changeAction: 'release',
          currentState: 'Draft',
          targetState: 'Released',
          createdBy: user.id,
        },
      ])

      await approveEco(eco.id)

      // Release the ECO
      const result = await ChangeOrderMergeService.merge(eco.id, user.id)

      expect(result.totalRevisionsAssigned).toBe(2)

      // Verify both items were released
      const releasedPart1 = await ItemService.findById(part1.id)
      const releasedPart2 = await ItemService.findById(part2.id)
      expect(releasedPart1?.state).toBe('Released')
      expect(releasedPart2?.state).toBe('Released')
    })

    it('creates release commit with all affected items', async () => {
      // Create parts
      const part1 = await createPart('commit-d1', 'Draft')
      const part2 = await createPart('commit-d2', 'Draft')

      // Create ECO and add affected items
      const eco = await createChangeOrder()

      await testDb.db.insert(changeOrderAffectedItems).values([
        {
          changeOrderId: eco.id,
          affectedItemId: part1.id,
          affectedItemMasterId: part1.masterId,
          changeAction: 'release',
          currentState: 'Draft',
          targetState: 'Released',
          createdBy: user.id,
        },
        {
          changeOrderId: eco.id,
          affectedItemId: part2.id,
          affectedItemMasterId: part2.masterId,
          changeAction: 'release',
          currentState: 'Draft',
          targetState: 'Released',
          createdBy: user.id,
        },
      ])

      await approveEco(eco.id)

      // Release the ECO
      await ChangeOrderMergeService.merge(eco.id, user.id)

      // Verify release commits were created on the design's main branch
      const { commits } = await import('@/lib/db/schema')
      const ecoItem = await ItemService.findById(eco.id)
      const releaseCommits = await testDb.db
        .select()
        .from(commits)
        .where(eq(commits.message, `Released via ECO: ${ecoItem?.itemNumber}`))

      // Should have one commit for the design
      expect(releaseCommits.length).toBe(1)
    })
  })

  describe('baseline ECO functionality', () => {
    it('defaults isBaseline to false when creating ECO', async () => {
      // Create standard ECO (without baseline flag)
      const eco = await createChangeOrder()

      // Query change_orders table directly to verify default behavior
      const { changeOrders } = await import('@/lib/db/schema')
      const [dbRecord] = await testDb.db
        .select()
        .from(changeOrders)
        .where(eq(changeOrders.itemId, eco.id))

      expect(dbRecord).toBeDefined()
      expect(dbRecord.isBaseline).toBe(false)
      expect(dbRecord.baselineName).toBeNull()
    })
  })

  describe('working copy handling in revise action', () => {
    it('creates revision when no working copy exists', async () => {
      // This test covers the fallback path where no working copy exists
      // and a new revision must be created at release time
      const part = await createPart('wc-fallback', 'Released')

      // Create ECO
      const eco = await createChangeOrder()

      // Add affected item without workingCopyId (will use fallback path)
      await testDb.db.insert(changeOrderAffectedItems).values({
        changeOrderId: eco.id,
        affectedItemId: part.id,
        affectedItemMasterId: part.masterId,
        changeAction: 'revise',
        currentState: 'Released',
        currentRevision: 'A',
        targetRevision: 'B',
        createdBy: user.id,
      })

      await approveEco(eco.id)

      // Release the ECO
      const result = await ChangeOrderMergeService.merge(eco.id, user.id)

      expect(result.totalRevisionsAssigned).toBe(1)

      // Verify new revision was created
      const allRevisions = await testDb.db
        .select()
        .from(items)
        .where(eq(items.masterId, part.masterId))

      expect(allRevisions.length).toBe(2)
      const newRevision = allRevisions.find((r) => r.revision === 'B')
      expect(newRevision).toBeDefined()
      expect(newRevision?.state).toBe('Released')
      expect(newRevision?.isCurrent).toBe(true)

      // Verify original is no longer current
      const originalPart = await ItemService.findById(part.id)
      expect(originalPart?.isCurrent).toBe(false)
    })

    it('finds working copy on ECO branch via merge workflow', async () => {
      // Create a Released part
      const part = await createPart('wc-merge', 'Released')
      const mainBranch = await BranchService.getMainBranch(designId)

      // Track on main branch
      await testDb.db.insert(branchItems).values({
        branchId: mainBranch!.id,
        itemMasterId: part.masterId!,
        currentItemId: part.id,
        baseItemId: part.id,
        changeType: null,
      })

      // Create ECO with branch
      const eco = await createChangeOrder()
      const { branch } = await BranchService.getOrCreateEcoBranch(
        designId,
        eco.id,
        user.id,
      )

      // Create a Draft working copy on the branch with placeholder revision
      const [workingCopy] = await testDb.db
        .insert(items)
        .values({
          itemNumber: part.itemNumber,
          itemType: 'Part',
          revision: '-', // Placeholder revision
          name: 'Branch Working Copy',
          state: 'Draft',
          masterId: part.masterId,
          designId: part.designId,
          isCurrent: false,
          createdBy: user.id,
          modifiedBy: user.id,
        })
        .returning()

      // Track working copy on ECO branch as modified
      await testDb.db.insert(branchItems).values({
        branchId: branch.id,
        itemMasterId: part.masterId!,
        currentItemId: workingCopy.id,
        baseItemId: part.id,
        changeType: 'modified',
      })

      // Associate design with ECO
      await testDb.db.insert(changeOrderDesigns).values({
        changeOrderId: eco.id,
        designId: designId,
        branchId: branch.id,
        mergeStatus: 'pending',
        itemsAffected: 1,
      })

      await approveEco(eco.id)

      // Release - should use the working copy from the branch via merge
      const result = await ChangeOrderMergeService.merge(eco.id, user.id)

      expect(result.designs.length).toBe(1)
      expect(result.designs[0].mergeResult.itemsMerged).toBe(1)

      // Verify working copy was released with revision B
      const releasedWorkingCopy = await ItemService.findById(workingCopy.id)
      expect(releasedWorkingCopy?.state).toBe('Released')
      expect(releasedWorkingCopy?.revision).toBe('B')
    })
  })

  describe('auto-checkin before merge', () => {
    it('releases checkout locks when merging branch', async () => {
      const eco = await createChangeOrder()
      const { branch } = await BranchService.getOrCreateEcoBranch(
        designId,
        eco.id,
        user.id,
      )

      // Create a part with placeholder revision using a generated masterId
      const masterId = crypto.randomUUID()
      const [part] = await testDb.db
        .insert(items)
        .values({
          itemNumber: `PN-${uniquePrefix}-auto-checkin`,
          masterId: masterId,
          itemType: 'Part',
          revision: '-', // Placeholder revision for new item
          name: 'Test Part auto-checkin',
          state: 'Draft',
          designId: designId,
          isCurrent: true,
          createdBy: user.id,
          modifiedBy: user.id,
        })
        .returning()

      // Track it as checked out on the branch
      await testDb.db.insert(branchItems).values({
        branchId: branch.id,
        itemMasterId: masterId,
        currentItemId: part.id,
        baseItemId: null,
        changeType: 'added',
        checkedOutBy: user.id,
        checkedOutAt: new Date(),
      })

      // Associate design with ECO
      await testDb.db.insert(changeOrderDesigns).values({
        changeOrderId: eco.id,
        designId: designId,
        branchId: branch.id,
        mergeStatus: 'pending',
        itemsAffected: 1,
      })

      await approveEco(eco.id)

      // Release should auto-checkin items before merge
      const result = await ChangeOrderMergeService.merge(eco.id, user.id)

      expect(result.designs.length).toBe(1)
      expect(result.designs[0].mergeResult.itemsAdded).toBe(1)

      // Verify the revision was assigned as 'A'
      expect(
        result.designs[0].mergeResult.revisionsAssigned[part.itemNumber],
      ).toBe('A')
    })
  })

  describe('branch skipping when no changes', () => {
    it('skips branches with no changes and processes affected items', async () => {
      // Create a part
      const part = await createPart('skip-branch', 'Draft')

      // Create ECO with a branch but no changes on it
      const eco = await createChangeOrder()
      const { branch } = await BranchService.getOrCreateEcoBranch(
        designId,
        eco.id,
        user.id,
      )

      // Associate design with ECO (branch has no changes)
      await testDb.db.insert(changeOrderDesigns).values({
        changeOrderId: eco.id,
        designId: designId,
        branchId: branch.id,
        mergeStatus: 'pending',
        itemsAffected: 0,
      })

      // Add affected item directly (not through branch)
      await testDb.db.insert(changeOrderAffectedItems).values({
        changeOrderId: eco.id,
        affectedItemId: part.id,
        affectedItemMasterId: part.masterId,
        changeAction: 'release',
        currentState: 'Draft',
        targetState: 'Released',
        createdBy: user.id,
      })

      await approveEco(eco.id)

      // Release should skip the empty branch and process affected items
      const result = await ChangeOrderMergeService.merge(eco.id, user.id)

      expect(result.totalRevisionsAssigned).toBe(1)

      // Verify part was released
      const releasedPart = await ItemService.findById(part.id)
      expect(releasedPart?.state).toBe('Released')

      // Verify branch was marked as skipped
      const ecoDesign = await testDb.db
        .select()
        .from(changeOrderDesigns)
        .where(eq(changeOrderDesigns.changeOrderId, eco.id))
        .limit(1)
        .then((r) => r.at(0))

      expect(ecoDesign?.mergeStatus).toBe('skipped')
    })
  })

  describe('multiple affected items with different actions', () => {
    it('handles release and obsolete actions in single ECO', async () => {
      // Create parts with different states
      const draftPart = await createPart('multi-draft', 'Draft')
      const releasedPartForObsolete = await createPart(
        'multi-obsolete',
        'Released',
      )

      // Create ECO
      const eco = await createChangeOrder()

      // Add affected items with different actions
      await testDb.db.insert(changeOrderAffectedItems).values([
        {
          changeOrderId: eco.id,
          affectedItemId: draftPart.id,
          affectedItemMasterId: draftPart.masterId,
          changeAction: 'release',
          currentState: 'Draft',
          targetState: 'Released',
          createdBy: user.id,
        },
        {
          changeOrderId: eco.id,
          affectedItemId: releasedPartForObsolete.id,
          affectedItemMasterId: releasedPartForObsolete.masterId,
          changeAction: 'obsolete',
          currentState: 'Released',
          targetState: 'Obsolete',
          createdBy: user.id,
        },
      ])

      await approveEco(eco.id)

      // Release the ECO
      const result = await ChangeOrderMergeService.merge(eco.id, user.id)

      // 1 revision assigned (release only, obsolete doesn't count)
      expect(result.totalRevisionsAssigned).toBe(1)

      // Verify each action was applied correctly
      const releasedDraft = await ItemService.findById(draftPart.id)
      expect(releasedDraft?.state).toBe('Released')

      const obsoletedPart = await ItemService.findById(
        releasedPartForObsolete.id,
      )
      expect(obsoletedPart?.state).toBe('Obsolete')
    })
  })

  describe('error handling', () => {
    it('throws error when lifecycle action cannot be applied', async () => {
      // Create a part in a state that can't transition
      const part = await createPart('bad-state', 'Obsolete')

      // Create ECO
      const eco = await createChangeOrder()

      // Try to release an Obsolete item (invalid transition)
      await testDb.db.insert(changeOrderAffectedItems).values({
        changeOrderId: eco.id,
        affectedItemId: part.id,
        affectedItemMasterId: part.masterId,
        changeAction: 'release',
        currentState: 'Obsolete',
        targetState: 'Released',
        createdBy: user.id,
      })

      await approveEco(eco.id)

      // Should throw because lifecycle action is invalid
      await expect(
        ChangeOrderMergeService.merge(eco.id, user.id),
      ).rejects.toThrow(ValidationError)
    })

    it('throws error when merge has concurrent modification conflicts', async () => {
      const eco = await createChangeOrder()
      const { branch } = await BranchService.getOrCreateEcoBranch(
        designId,
        eco.id,
        user.id,
      )

      // Create a Released part
      const part = await createPart('conflict-test', 'Released')
      const mainBranch = await BranchService.getMainBranch(designId)

      // Track on main branch
      await testDb.db.insert(branchItems).values({
        branchId: mainBranch!.id,
        itemMasterId: part.masterId!,
        currentItemId: part.id,
        baseItemId: part.id,
        changeType: null,
      })

      // Track on ECO branch
      await testDb.db.insert(branchItems).values({
        branchId: branch.id,
        itemMasterId: part.masterId!,
        currentItemId: part.id,
        baseItemId: part.id,
        changeType: 'modified',
      })

      // Simulate concurrent modification: create a new revision on main with DIFFERENT name
      const [newRevision] = await testDb.db
        .insert(items)
        .values({
          itemNumber: part.itemNumber,
          itemType: 'Part',
          revision: 'B',
          name: 'MODIFIED NAME BY ANOTHER ECO', // Different name to trigger conflict
          state: 'Released',
          masterId: part.masterId,
          designId: part.designId,
          isCurrent: true,
          createdBy: user.id,
          modifiedBy: user.id,
        })
        .returning()

      // Update main branch to point to new revision
      await testDb.db
        .update(branchItems)
        .set({ currentItemId: newRevision.id })
        .where(
          and(
            eq(branchItems.branchId, mainBranch!.id),
            eq(branchItems.itemMasterId, part.masterId),
          ),
        )

      // Mark old revision as not current
      await testDb.db
        .update(items)
        .set({ isCurrent: false })
        .where(eq(items.id, part.id))

      // Associate design with ECO
      await testDb.db.insert(changeOrderDesigns).values({
        changeOrderId: eco.id,
        designId: designId,
        branchId: branch.id,
        mergeStatus: 'pending',
        itemsAffected: 1,
      })

      await approveEco(eco.id)

      // Should throw because of concurrent modification conflict
      await expect(
        ChangeOrderMergeService.merge(eco.id, user.id),
      ).rejects.toThrow(MergeConflictError)
    })
  })

  describe('revision assignment during release', () => {
    it('assigns revision A when item already in Released state (skipped state change path)', async () => {
      // Simulate the case where lifecycle effects already set state to Released
      // during workflow transition, but revision is still a placeholder
      const part = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-already-released`,
          revision: '-', // Placeholder revision (not yet assigned)
          name: 'Already Released Part',
          designId,
          state: 'Released', // Lifecycle effects already set this
        } as any,
        user.id,
      )

      // Create ECO
      const eco = await createChangeOrder()

      // Add affected item with release action - item is already Released
      await testDb.db.insert(changeOrderAffectedItems).values({
        changeOrderId: eco.id,
        affectedItemId: part.id,
        affectedItemMasterId: part.masterId,
        changeAction: 'release',
        currentState: 'Draft',
        targetState: 'Released',
        createdBy: user.id,
      })

      await approveEco(eco.id)

      // Release the ECO
      const result = await ChangeOrderMergeService.merge(eco.id, user.id)

      // Revision should still be assigned even though state was skipped
      expect(result.totalRevisionsAssigned).toBe(1)

      // Verify revision was assigned
      const updatedPart = await ItemService.findById(part.id)
      expect(updatedPart?.revision).toBe('A')
      expect(updatedPart?.state).toBe('Released')
    })

    it('preserves existing revision when item already has a real revision', async () => {
      // Item already has a real revision (e.g., from a previous release)
      const part = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-has-revision`,
          revision: 'B', // Already has a real revision
          name: 'Previously Released Part',
          designId,
          state: 'Released',
        } as any,
        user.id,
      )

      // Create ECO
      const eco = await createChangeOrder()

      // Add affected item with release action
      await testDb.db.insert(changeOrderAffectedItems).values({
        changeOrderId: eco.id,
        affectedItemId: part.id,
        affectedItemMasterId: part.masterId,
        changeAction: 'release',
        currentState: 'Released',
        targetState: 'Released',
        createdBy: user.id,
      })

      await approveEco(eco.id)

      // Release the ECO
      const result = await ChangeOrderMergeService.merge(eco.id, user.id)

      // No revision assigned because it already has one
      expect(result.totalRevisionsAssigned).toBe(0)

      // Verify revision is unchanged
      const updatedPart = await ItemService.findById(part.id)
      expect(updatedPart?.revision).toBe('B')
    })

    it('assigns revision A when releasing Draft item with DRAFT placeholder', async () => {
      // Item has 'DRAFT' as revision placeholder
      const part = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-draft-placeholder`,
          revision: 'DRAFT',
          name: 'Draft Placeholder Part',
          designId,
          state: 'Draft',
        } as any,
        user.id,
      )

      // Create ECO
      const eco = await createChangeOrder()

      await testDb.db.insert(changeOrderAffectedItems).values({
        changeOrderId: eco.id,
        affectedItemId: part.id,
        affectedItemMasterId: part.masterId,
        changeAction: 'release',
        currentState: 'Draft',
        targetState: 'Released',
        createdBy: user.id,
      })

      await approveEco(eco.id)

      const result = await ChangeOrderMergeService.merge(eco.id, user.id)

      expect(result.totalRevisionsAssigned).toBe(1)

      const updatedPart = await ItemService.findById(part.id)
      expect(updatedPart?.revision).toBe('A')
      expect(updatedPart?.state).toBe('Released')
    })

    it('assigns revision A when releasing item with dash-prefixed placeholder', async () => {
      // Item has '-abc12345' as revision placeholder (used when entering new phase)
      const part = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-dash-prefix`,
          revision: '-abc12345',
          name: 'Dash Prefix Part',
          designId,
          state: 'Draft',
        } as any,
        user.id,
      )

      // Create ECO
      const eco = await createChangeOrder()

      await testDb.db.insert(changeOrderAffectedItems).values({
        changeOrderId: eco.id,
        affectedItemId: part.id,
        affectedItemMasterId: part.masterId,
        changeAction: 'release',
        currentState: 'Draft',
        targetState: 'Released',
        createdBy: user.id,
      })

      await approveEco(eco.id)

      const result = await ChangeOrderMergeService.merge(eco.id, user.id)

      expect(result.totalRevisionsAssigned).toBe(1)

      const updatedPart = await ItemService.findById(part.id)
      expect(updatedPart?.revision).toBe('A')
      expect(updatedPart?.state).toBe('Released')
    })
  })

  describe('preview with multiple designs', () => {
    let secondDesignId: string

    beforeEach(async () => {
      const secondDesign = await DesignService.create(
        {
          programId,
          name: 'Preview Second Design',
          code: `PREVIEW2-${uniquePrefix}`,
          designType: 'Engineering',
        },
        user.id,
      )
      secondDesignId = secondDesign.id
    })

    it('aggregates conflicts from all designs', async () => {
      const eco = await createChangeOrder()

      // Create branches for both designs
      const { branch: branch1 } = await BranchService.getOrCreateEcoBranch(
        designId,
        eco.id,
        user.id,
      )
      const { branch: branch2 } = await BranchService.getOrCreateEcoBranch(
        secondDesignId,
        eco.id,
        user.id,
      )

      // Associate both designs
      await testDb.db.insert(changeOrderDesigns).values([
        {
          changeOrderId: eco.id,
          designId: designId,
          branchId: branch1.id,
          mergeStatus: 'pending',
          itemsAffected: 1,
        },
        {
          changeOrderId: eco.id,
          designId: secondDesignId,
          branchId: branch2.id,
          mergeStatus: 'pending',
          itemsAffected: 1,
        },
      ])

      // Add checked out items to both branches (conflicts)
      const part1 = await createPart('preview-conflict1', 'Released')
      const part2 = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-preview-conflict2`,
          revision: 'A',
          name: 'Preview Conflict Part 2',
          designId: secondDesignId,
          state: 'Released',
        } as any,
        user.id,
      )

      await testDb.db.insert(branchItems).values([
        {
          branchId: branch1.id,
          itemMasterId: part1.masterId!,
          currentItemId: part1.id,
          baseItemId: part1.id,
          changeType: 'modified',
          checkedOutBy: user.id,
        },
        {
          branchId: branch2.id,
          itemMasterId: part2.masterId!,
          currentItemId: part2.id,
          baseItemId: part2.id,
          changeType: 'modified',
          checkedOutBy: user.id,
        },
      ])

      await approveEco(eco.id)

      const preview = await ChangeOrderMergeService.previewMerge(eco.id)

      // Should have conflicts from both designs
      expect(preview.allConflicts.length).toBe(2)
      expect(preview.canRelease).toBe(false)
    })
  })
})
