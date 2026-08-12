// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * ChangeOrderMergeService Tests
 *
 * Integration tests for the ChangeOrderMergeService class.
 * Tests cover change order merge, conflict detection, and revision assignment.
 *
 * Run: npm run test -- src/lib/services/ChangeOrderMergeService.test.ts
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
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
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
  changeOrders,
  designs,
  itemRelationships,
  items,
  parts,
  programs,
  tags,
  upstreamChanges,
  vaultFiles,
  workflowDefinitions,
  workflowInstances,
} from '@/lib/db/schema'
import { ItemTypeRegistry } from '@/lib/items/registry'
import { LIFECYCLE_IDS } from '@/lib/items/lifecycle-ids'
import { seedStandardPartLifecycle } from '@/__tests__/fixtures/lifecycles'
import { takeFirst } from '@/lib/db/take-first'
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
              finalKind: 'release',
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
        lifecycleType: 'Driving',
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
    const program = takeFirst(
      await testDb.db
        .insert(programs)
        .values({
          name: 'Test Program',
          code: `PROG-${uniquePrefix}`,
          createdBy: user.id,
        })
        .returning(),
    )

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

    designId = design.id!
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
    // Real change orders accumulate their affected items as branch content is
    // created - CheckoutService registers each one, so what merges and what
    // reviewers approved are the same set, and the merge refuses to release
    // branch content the change order does not list. These fixtures insert
    // branch rows directly, so mirror that registration before releasing.
    const ecoDesignsForSync = await ChangeOrderService.getEcoDesigns(ecoId)
    for (const ecoDesign of ecoDesignsForSync) {
      if (!ecoDesign.branchId) continue
      const branchRows = await testDb.db
        .select()
        .from(branchItems)
        .where(
          and(
            eq(branchItems.branchId, ecoDesign.branchId),
            isNotNull(branchItems.changeType),
          ),
        )
      for (const row of branchRows) {
        await ChangeOrderService.registerBranchChange(
          ecoDesign.branchId,
          row.itemMasterId,
          row.currentItemId,
          user.id,
        )
      }
    }

    await testDb.db
      .update(items)
      .set({ state: 'Approved' })
      .where(eq(items.id, ecoId))

    await testDb.db
      .update(workflowInstances)
      .set({ currentState: 'Approved' })
      .where(eq(workflowInstances.itemId, ecoId))
  }

  describe('validateMerge', () => {
    it('returns canMerge: false when branch not found', async () => {
      // Use a valid UUID format that doesn't exist
      const nonExistentUuid = '00000000-0000-0000-0000-000000000000'
      const result =
        await ChangeOrderMergeService.validateMerge(nonExistentUuid)

      expect(result.canMerge).toBe(false)
      expect(result.conflicts).toHaveLength(1)
      expect(result.conflicts[0]).toMatchObject({
        conflictType: 'branch_not_found',
      })
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

    it('does not warn about branch locking', async () => {
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
      // Nothing in the product locks an ECO branch — scope locking, not branch
      // locking, is what review freezes — so this warning fired on every single
      // release and trained users to ignore the panel carrying real problems.
      expect(result.warnings.some((w) => w.includes('not locked'))).toBe(false)
      expect(result.canMerge).toBe(true)
    })

    it('reports items still checked out as a warning, not a blocker', async () => {
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

      // `merge()` auto-checks-in the branch before validating it, so a held
      // checkout cannot block the merge. Treating it as a conflict meant an ECO
      // could never be released while an engineer still had an item open — and
      // saving keeps the checkout, so that was every ECO.
      expect(result.canMerge).toBe(true)
      expect(result.conflicts.some((c) => c.conflictType === 'checkout')).toBe(
        false,
      )
      expect(result.warnings.some((w) => w.includes('still checked out'))).toBe(
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

    it('persists isBaseline/baselineName and tags the design on release (regression: type-handler dropped both)', async () => {
      const part = await createPart('baseline-tag-test', 'Draft')
      const baselineName = `BL-${uniquePrefix}`

      const eco = await ItemService.create(
        'ChangeOrder',
        {
          revision: '-',
          name: 'Baseline ECO',
          changeType: 'ECO',
          priority: 'medium',
          reasonForChange: 'Baseline test',
          isBaseline: true,
          baselineName,
        } as any,
        user.id,
      )
      await testDb.db.insert(workflowInstances).values({
        workflowDefinitionId: workflowId,
        itemId: eco.id,
        currentState: 'Draft',
      })

      // The fix: the ChangeOrder type-handler must persist these, or the
      // merge-time auto-tag never fires.
      const [coRow] = await testDb.db
        .select()
        .from(changeOrders)
        .where(eq(changeOrders.itemId, eco.id))
      expect(coRow?.isBaseline).toBe(true)
      expect(coRow?.baselineName).toBe(baselineName)

      await ChangeOrderService.addAffectedItem(
        eco.id,
        { affectedItemId: part.id, changeAction: 'release' },
        user.id,
      )
      await approveEco(eco.id)
      await ChangeOrderMergeService.merge(eco.id, user.id)

      // On release the baseline tag lands on the affected design.
      const designTags = await testDb.db
        .select()
        .from(tags)
        .where(eq(tags.designId, designId))
      expect(designTags.some((t) => t.name === baselineName)).toBe(true)
    })

    it('carries BOM onto the working copy and honours branch edits (add + delete) on release', async () => {
      // Released assembly with two children. Create them all before anything is
      // Released — branch protection blocks creating on main once the design
      // holds released items — then flip them to Released.
      const assembly = await createPart('bom-assy')
      const keepChild = await createPart('bom-keep')
      const dropChild = await createPart('bom-drop')
      const addChild = await createPart('bom-add')
      for (const p of [assembly, keepChild, dropChild, addChild]) {
        await testDb.db
          .update(items)
          .set({ state: 'Released' })
          .where(eq(items.id, p.id))
      }
      await testDb.db.insert(itemRelationships).values([
        {
          sourceId: assembly.id,
          targetId: keepChild.id,
          relationshipType: 'BOM',
          quantity: '1',
          findNumber: 10,
          createdBy: user.id,
        },
        {
          sourceId: assembly.id,
          targetId: dropChild.id,
          relationshipType: 'BOM',
          quantity: '2',
          findNumber: 20,
          createdBy: user.id,
        },
      ])

      const eco = await createChangeOrder()
      const { workingCopyId } = await ChangeOrderService.addAffectedItem(
        eco.id,
        { affectedItemId: assembly.id, changeAction: 'revise' },
        user.id,
      )
      expect(workingCopyId).toBeTruthy()

      // The branch copy must arrive carrying the real structure, otherwise
      // there is nothing to edit on the ECO branch.
      const onBranch = await testDb.db
        .select()
        .from(itemRelationships)
        .where(eq(itemRelationships.sourceId, workingCopyId!))
      expect(onBranch.map((r) => r.targetId).sort()).toEqual(
        [keepChild.id, dropChild.id].sort(),
      )

      // Edit the BOM on the branch: drop one line, add another.
      await testDb.db
        .delete(itemRelationships)
        .where(
          and(
            eq(itemRelationships.sourceId, workingCopyId!),
            eq(itemRelationships.targetId, dropChild.id),
          ),
        )
      await testDb.db.insert(itemRelationships).values({
        sourceId: workingCopyId!,
        targetId: addChild.id,
        relationshipType: 'BOM',
        quantity: '3',
        findNumber: 30,
        createdBy: user.id,
      })

      await approveEco(eco.id)
      await ChangeOrderMergeService.merge(eco.id, user.id)

      // The released revision reflects the branch edits: deleted line gone,
      // added line present, untouched line kept.
      const released = await testDb.db
        .select()
        .from(items)
        .where(
          and(eq(items.masterId, assembly.masterId), eq(items.isCurrent, true)),
        )
        .then((r) => r.at(0))
      expect(released).toBeDefined()
      const finalBom = await testDb.db
        .select()
        .from(itemRelationships)
        .where(eq(itemRelationships.sourceId, released!.id))
      const targets = finalBom.map((r) => r.targetId)
      expect(targets).toContain(keepChild.id)
      expect(targets).toContain(addChild.id)
      expect(targets).not.toContain(dropChild.id)
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
      expect(deletedItem).toMatchObject({
        state: 'Obsolete',
        isDeleted: true,
      })
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

  /**
   * Files hang off an item *version* row, and release of an added item mints a
   * brand new row for the released revision. Without the merge carrying files
   * across, a part's CAD and attachments become invisible the moment the ECO
   * releases: every file listing resolves the item to its released row and
   * queries `vault_files.item_id` against it.
   *
   * The invariant under test is continuity, not row identity - what must hold
   * is that whatever a user could see on the branch, they can still see on the
   * released revision.
   */
  describe('file continuity across release', () => {
    async function attachFile(
      itemId: string,
      opts: {
        branchId?: string | null
        name?: string
        category?: string | null
        isPrimaryModel?: boolean
      } = {},
    ) {
      const name = opts.name ?? 'model.step'
      return takeFirst(
        await testDb.db
          .insert(vaultFiles)
          .values({
            itemId,
            branchId: opts.branchId ?? null,
            fileName: name,
            originalFileName: name,
            fileSize: 2048,
            mimeType: 'application/step',
            fileHash: randomUUID().replace(/-/g, ''),
            storagePath: `vault/${randomUUID()}/${name}`,
            fileCategory: opts.category ?? 'cad_model',
            isPrimaryModel: opts.isPrimaryModel ?? true,
            uploadedBy: user.id,
          })
          .returning(),
      )
    }

    /** What a file listing for this item version would return. */
    async function visibleFiles(itemId: string) {
      return testDb.db
        .select()
        .from(vaultFiles)
        .where(and(eq(vaultFiles.itemId, itemId), isNull(vaultFiles.deletedAt)))
    }

    it('keeps files reachable on the released revision of an added item', async () => {
      const eco = await createChangeOrder()
      const { branch } = await BranchService.getOrCreateEcoBranch(
        designId,
        eco.id,
        user.id,
      )

      // A part created on the ECO branch, with CAD uploaded against it there.
      const part = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-file-add`,
          revision: '-',
          name: 'Test Part file-add',
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
      await attachFile(part.id, { branchId: branch.id })

      await ChangeOrderMergeService.mergeBranchToMain(
        branch.id,
        eco.id,
        user.id,
      )

      // Resolve the item the way main now resolves it.
      const mainBranch = await BranchService.getMainBranch(designId)
      const released = takeFirst(
        await testDb.db
          .select()
          .from(branchItems)
          .where(
            and(
              eq(branchItems.branchId, mainBranch!.id),
              eq(branchItems.itemMasterId, part.masterId),
            ),
          ),
      )
      expect(released.currentItemId).not.toBe(part.id)

      const files = await visibleFiles(released.currentItemId!)
      expect(files).toHaveLength(1)
      expect(files[0]!.originalFileName).toBe('model.step')
      // Released content is visible everywhere, not scoped to the dead branch.
      expect(files[0]!.branchId).toBeNull()
    })

    it('carries the prior revision files onto a revised item, leaving the superseded revision its own', async () => {
      const part = await createPart('file-mod', 'Released')
      const mainBranch = await BranchService.getMainBranch(designId)
      await testDb.db.insert(branchItems).values({
        branchId: mainBranch!.id,
        itemMasterId: part.masterId!,
        currentItemId: part.id,
        baseItemId: part.id,
        changeType: null,
      })
      // CAD released on main against revision A.
      await attachFile(part.id, { name: 'revA.step' })

      const eco = await createChangeOrder()
      const { branch } = await BranchService.getOrCreateEcoBranch(
        designId,
        eco.id,
        user.id,
      )

      // The real revise path: a working copy on the ECO branch.
      const { workingCopy } =
        await ChangeOrderService.createRevisionWorkingCopy(
          part,
          branch.id,
          user.id,
        )

      // The engineer must see the inherited CAD while working on the branch.
      const onBranch = await visibleFiles(workingCopy.id)
      expect(onBranch.map((f) => f.originalFileName)).toContain('revA.step')

      await ChangeOrderMergeService.mergeBranchToMain(
        branch.id,
        eco.id,
        user.id,
      )

      const releasedRow = takeFirst(
        await testDb.db
          .select()
          .from(branchItems)
          .where(
            and(
              eq(branchItems.branchId, mainBranch!.id),
              eq(branchItems.itemMasterId, part.masterId),
            ),
          ),
      )
      const releasedFiles = await visibleFiles(releasedRow.currentItemId!)
      expect(releasedFiles.map((f) => f.originalFileName)).toContain(
        'revA.step',
      )

      // The superseded revision keeps its own attachments - the SUPERSEDED
      // watermark job stamps exactly those, and must not reach into the new one.
      const supersededFiles = await visibleFiles(part.id)
      expect(supersededFiles.map((f) => f.originalFileName)).toContain(
        'revA.step',
      )
      expect(supersededFiles[0]!.id).not.toBe(releasedFiles[0]!.id)
    })

    /**
     * The affected-item 'revise' action with no working copy mints the new
     * revision through ItemService.revise at release time - a different code
     * path to the branch merge, with the same version-row coupling.
     */
    it('keeps files on a revision minted by the affected-item revise action', async () => {
      const part = await createPart('file-revise', 'Released')
      await attachFile(part.id, { name: 'drawing.pdf', category: 'drawing' })

      const eco = await createChangeOrder()
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

      await ChangeOrderMergeService.merge(eco.id, user.id)

      const revisionB = takeFirst(
        await testDb.db
          .select()
          .from(items)
          .where(
            and(eq(items.masterId, part.masterId), eq(items.revision, 'B')),
          ),
      )

      const files = await visibleFiles(revisionB.id)
      expect(files.map((f) => f.originalFileName)).toEqual(['drawing.pdf'])
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

    it('previews affected-item releases when no branch content exists', async () => {
      // Regression: an initial-release ECO whose parts were added as
      // affected items (no branch content) previewed "0 items" while the
      // release applied them anyway — the preview only walked branches.
      const eco = await createChangeOrder()
      const part = await createPart('affected-preview', 'Draft')

      await ChangeOrderService.addAffectedItem(
        eco.id,
        { affectedItemId: part.id, changeAction: 'release' },
        user.id,
      )

      const preview = await ChangeOrderMergeService.previewMerge(eco.id)

      expect(preview.totalItems).toBe(1)
      const allItems = preview.designs.flatMap((d) => d.items)
      expect(allItems).toHaveLength(1)
      expect(allItems[0]).toMatchObject({
        itemNumber: part.itemNumber,
        newRevision: 'A',
      })
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
      expect(preview.designs[0]!.designName).toBe('Test Design')
      expect(preview.designs[0]!.items).toHaveLength(1)
      expect(preview.designs[0]!.items[0]).toMatchObject({
        changeType: 'added',
        newRevision: 'A',
      })
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

    it('still allows release when items are checked out', async () => {
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

      // The release checks items in for you, so a held checkout is reported as
      // a warning and does not make the preview say "cannot release"
      expect(
        preview.allConflicts.some((c) => c.conflictType === 'checkout'),
      ).toBe(false)
      expect(
        preview.validationIssues.some((i) => i.includes('still checked out')),
      ).toBe(true)
      expect(preview.canRelease).toBe(true)
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

      expect(preview.designs[0]!.items[0]).toMatchObject({
        currentRevision: 'C',
        newRevision: 'D',
      })
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
      const newRevision = takeFirst(
        await testDb.db
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
          .returning(),
      )

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
      const originalItem = takeFirst(
        await testDb.db.select().from(items).where(eq(items.id, part.id)),
      )

      const newRevision = takeFirst(
        await testDb.db
          .insert(items)
          .values({
            // Copy all fields from original item
            itemNumber: originalItem.itemNumber,
            itemType: originalItem.itemType,
            name: originalItem.name,
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
          .returning(),
      )

      // Carry the extension row onto the new revision, as a real release
      // does - the items row alone is not the item, and a revision missing
      // its type-specific data is a genuine difference, not a revision-only
      // change.
      const baseParts = takeFirst(
        await testDb.db.select().from(parts).where(eq(parts.itemId, part.id)),
      )
      const { itemId: _replaced, ...basePartFields } = baseParts
      await testDb.db
        .insert(parts)
        .values({ ...basePartFields, itemId: newRevision.id })

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

    it('flags a concurrent change confined to the extension table', async () => {
      const eco = await createChangeOrder()
      const { branch } = await BranchService.getOrCreateEcoBranch(
        designId,
        eco.id,
        user.id,
      )

      const part = await createPart('ext-only', 'Released')
      const mainBranch = await BranchService.getMainBranch(designId)

      await testDb.db.insert(branchItems).values({
        branchId: mainBranch!.id,
        itemMasterId: part.masterId!,
        currentItemId: part.id,
        baseItemId: part.id,
        changeType: null,
      })
      await testDb.db.insert(branchItems).values({
        branchId: branch.id,
        itemMasterId: part.masterId!,
        currentItemId: part.id,
        baseItemId: part.id,
        changeType: 'modified',
      })

      // Another change order released a new revision whose only difference is
      // the part weight. Weight lives on `parts`, so comparing `items`
      // columns alone saw nothing and let this branch merge straight over it.
      const originalItem = takeFirst(
        await testDb.db.select().from(items).where(eq(items.id, part.id)),
      )
      const newRevision = takeFirst(
        await testDb.db
          .insert(items)
          .values({
            itemNumber: originalItem.itemNumber,
            itemType: originalItem.itemType,
            name: originalItem.name,
            state: originalItem.state,
            masterId: originalItem.masterId,
            designId: originalItem.designId,
            inDesignStructure: originalItem.inDesignStructure,
            attributes: originalItem.attributes,
            metamodel: originalItem.metamodel,
            sysmlType: originalItem.sysmlType,
            usageOf: originalItem.usageOf,
            revision: 'B',
            isCurrent: true,
            createdBy: user.id,
            modifiedBy: user.id,
          })
          .returning(),
      )
      const baseParts = takeFirst(
        await testDb.db.select().from(parts).where(eq(parts.itemId, part.id)),
      )
      const { itemId: _replaced, ...basePartFields } = baseParts
      await testDb.db.insert(parts).values({
        ...basePartFields,
        itemId: newRevision.id,
        weight: '42.000',
      })

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

      expect(
        result.conflicts.filter(
          (c) => c.conflictType === 'concurrent_modification',
        ),
      ).toHaveLength(1)
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
      const [dbRecord] = await testDb.db
        .select()
        .from(changeOrders)
        .where(eq(changeOrders.itemId, eco.id))

      expect(dbRecord).toMatchObject({
        isBaseline: false,
        baselineName: null,
      })
    })
  })

  describe('affected-item actions alongside a merging branch', () => {
    // Give Parts a promote mapping for this scenario. The test transaction
    // rolls back, so this is local to the test — but the registry memoizes
    // lifecycle definitions, so a write straight to the table has to drop the
    // memo the way WorkflowService.update does.
    async function enablePromoteOnParts() {
      const lifecycle = takeFirst(
        await testDb.db
          .select()
          .from(workflowDefinitions)
          .where(eq(workflowDefinitions.id, LIFECYCLE_IDS.part)),
      )
      const definition = lifecycle.definition as Record<string, unknown>
      await testDb.db
        .update(workflowDefinitions)
        .set({
          definition: {
            ...definition,
            changeActionMappings: {
              ...(definition.changeActionMappings as Record<string, unknown>),
              promote: {
                fromState: 'Released',
                toState: 'Obsolete',
                assignsRevision: true,
              },
            },
          },
        })
        .where(eq(workflowDefinitions.id, LIFECYCLE_IDS.part))

      ItemTypeRegistry.invalidateLifecycleCache()
    }

    // An ECO branch carrying real content, so the branch merge runs and the
    // affected-items fallback path is skipped.
    async function ecoWithBranchContent() {
      const eco = await createChangeOrder()
      const { branch } = await BranchService.getOrCreateEcoBranch(
        designId,
        eco.id,
        user.id,
      )

      const branchNewPart = takeFirst(
        await testDb.db
          .insert(items)
          .values({
            itemNumber: `PN-${uniquePrefix}-branchnew`,
            itemType: 'Part',
            revision: '-abcdef12',
            name: 'Added on branch',
            state: 'Draft',
            masterId: randomUUID(),
            designId,
            isCurrent: false,
            createdBy: user.id,
            modifiedBy: user.id,
          })
          .returning(),
      )
      await testDb.db.insert(branchItems).values({
        branchId: branch.id,
        itemMasterId: branchNewPart.masterId,
        currentItemId: branchNewPart.id,
        baseItemId: null,
        changeType: 'added',
      })
      await testDb.db.insert(changeOrderDesigns).values({
        changeOrderId: eco.id,
        designId,
        branchId: branch.id,
        mergeStatus: 'pending',
      })

      return eco
    }

    it('promotes an affected item even when a branch merges', async () => {
      await enablePromoteOnParts()

      const part = await createPart('promo', 'Released')
      const eco = await ecoWithBranchContent()

      await testDb.db.insert(changeOrderAffectedItems).values({
        changeOrderId: eco.id,
        affectedItemId: part.id,
        affectedItemMasterId: part.masterId,
        changeAction: 'promote',
        currentState: 'Released',
        currentRevision: 'A',
        createdBy: user.id,
      })

      await approveEco(eco.id)
      await ChangeOrderMergeService.merge(eco.id, user.id)

      // The branch merge never performs a promote, so gating the
      // affected-item pass on an action allow-list dropped this silently:
      // the ECO completed and the part stayed exactly as it was.
      const promoted = await ItemService.findById(part.id)
      expect(promoted?.state).toBe('Obsolete')
      expect(promoted?.revision).toBe('B')
    })

    it('obsoletes an affected item even when a branch merges', async () => {
      const part = await createPart('obs-branch', 'Released')
      const eco = await ecoWithBranchContent()

      await testDb.db.insert(changeOrderAffectedItems).values({
        changeOrderId: eco.id,
        affectedItemId: part.id,
        affectedItemMasterId: part.masterId,
        changeAction: 'obsolete',
        currentState: 'Released',
        currentRevision: 'A',
        createdBy: user.id,
      })

      await approveEco(eco.id)
      await ChangeOrderMergeService.merge(eco.id, user.id)

      const obsoleted = await ItemService.findById(part.id)
      expect(obsoleted?.state).toBe('Obsolete')
    })

    it('refuses to release branch content the change order does not list', async () => {
      const eco = await ecoWithBranchContent()
      const ecoDesigns = await ChangeOrderService.getEcoDesigns(eco.id)
      const branchId = ecoDesigns[0]!.branchId!

      // A second item edited on the branch without ever being added to the
      // change order. The merge releases branch content, so before this gate
      // it would be revised and released while the affected items list -
      // what reviewers approved - never mentioned it.
      const stowaway = await createPart('stowaway', 'Released')
      const stowawayCopy = takeFirst(
        await testDb.db
          .insert(items)
          .values({
            itemNumber: stowaway.itemNumber,
            itemType: 'Part',
            revision: '-99999999',
            name: 'Edited without being in scope',
            state: 'Draft',
            masterId: stowaway.masterId,
            designId,
            isCurrent: false,
            createdBy: user.id,
            modifiedBy: user.id,
          })
          .returning(),
      )
      await testDb.db.insert(branchItems).values({
        branchId,
        itemMasterId: stowaway.masterId,
        currentItemId: stowawayCopy.id,
        baseItemId: stowaway.id,
        changeType: 'modified',
      })

      // Deliberately not calling approveEco's registration sync
      await testDb.db
        .update(items)
        .set({ state: 'Approved' })
        .where(eq(items.id, eco.id))
      await testDb.db
        .update(workflowInstances)
        .set({ currentState: 'Approved' })
        .where(eq(workflowInstances.itemId, eco.id))

      await expect(
        ChangeOrderMergeService.merge(eco.id, user.id),
      ).rejects.toThrow(ValidationError)

      // Nothing released
      const untouched = await ItemService.findById(stowaway.id)
      expect(untouched?.revision).toBe('A')
      expect(untouched?.isCurrent).toBe(true)
    })

    it('refuses an action the item can no longer take', async () => {
      // Draft item listed as 'obsolete', which the Part lifecycle only
      // allows from Released. Applying it unchecked would force a Draft item
      // straight to Obsolete.
      const part = await createPart('bad-action', 'Draft')
      const eco = await ecoWithBranchContent()

      await testDb.db.insert(changeOrderAffectedItems).values({
        changeOrderId: eco.id,
        affectedItemId: part.id,
        affectedItemMasterId: part.masterId,
        changeAction: 'obsolete',
        currentState: 'Draft',
        currentRevision: 'A',
        createdBy: user.id,
      })

      await approveEco(eco.id)

      await expect(
        ChangeOrderMergeService.merge(eco.id, user.id),
      ).rejects.toThrow(ValidationError)
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
      const workingCopy = takeFirst(
        await testDb.db
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
          .returning(),
      )

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
      })

      await approveEco(eco.id)

      // Release - should use the working copy from the branch via merge
      const result = await ChangeOrderMergeService.merge(eco.id, user.id)

      expect(result.designs.length).toBe(1)
      expect(result.designs[0]!.mergeResult.itemsMerged).toBe(1)

      // Verify working copy was released with revision B
      const releasedWorkingCopy = await ItemService.findById(workingCopy.id)
      expect(releasedWorkingCopy?.state).toBe('Released')
      expect(releasedWorkingCopy?.revision).toBe('B')
    })

    // Helper: put a Released part on main and hand back a ready ECO branch
    // carrying a working copy of it, forked from `baseItemId`.
    async function ecoWithWorkingCopy(
      part: { id: string; masterId: string; itemNumber: string; name?: string },
      baseItemId: string,
      workingRevision: string,
      workingName?: string,
    ) {
      const eco = await createChangeOrder()
      const { branch } = await BranchService.getOrCreateEcoBranch(
        designId,
        eco.id,
        user.id,
      )

      const workingCopy = takeFirst(
        await testDb.db
          .insert(items)
          .values({
            itemNumber: part.itemNumber,
            itemType: 'Part',
            revision: workingRevision,
            name: workingName ?? 'Working Copy',
            state: 'Draft',
            masterId: part.masterId,
            designId,
            isCurrent: false,
            createdBy: user.id,
            modifiedBy: user.id,
          })
          .returning(),
      )

      await testDb.db.insert(branchItems).values({
        branchId: branch.id,
        itemMasterId: part.masterId,
        currentItemId: workingCopy.id,
        baseItemId,
        changeType: 'modified',
      })

      await testDb.db.insert(changeOrderDesigns).values({
        changeOrderId: eco.id,
        designId,
        branchId: branch.id,
        mergeStatus: 'pending',
      })

      await approveEco(eco.id)
      return { eco, workingCopy }
    }

    it('never leaves two current versions when ECOs release in sequence', async () => {
      const part = await createPart('seq', 'Released')
      const mainBranch = await BranchService.getMainBranch(designId)
      await testDb.db.insert(branchItems).values({
        branchId: mainBranch!.id,
        itemMasterId: part.masterId!,
        currentItemId: part.id,
        baseItemId: part.id,
        changeType: null,
      })

      // Both ECOs keep the base-table fields identical, standing in for the
      // common case where the change is confined to the extension table
      // (weight, material, ...). validateMerge compares only `items`
      // columns, so it raises no concurrent-modification conflict and the
      // second merge proceeds over the first.
      const first = await ecoWithWorkingCopy(
        part,
        part.id,
        '-aaaaaaaa',
        part.name,
      )
      await ChangeOrderMergeService.merge(first.eco.id, user.id)

      // The second ECO forked from rev A and never saw rev B. Releasing it
      // as-is would supersede a version that is no longer main's current and
      // leave both B and C claiming isCurrent. It is refused instead: the
      // base it was built on has been superseded.
      const second = await ecoWithWorkingCopy(
        part,
        part.id,
        '-bbbbbbbb',
        part.name,
      )
      await expect(
        ChangeOrderMergeService.merge(second.eco.id, user.id),
      ).rejects.toThrow(MergeConflictError)

      // Whatever the outcome, one master never has two current versions.
      const currentRows = await testDb.db
        .select()
        .from(items)
        .where(
          and(eq(items.masterId, part.masterId), eq(items.isCurrent, true)),
        )

      expect(currentRows).toHaveLength(1)
      expect(currentRows[0]!.id).toBe(first.workingCopy.id)
      expect(currentRows[0]!.revision).toBe('B')
    })

    it('moves the superseded version to the revise mapping old-version state', async () => {
      const part = await createPart('sup', 'Released')
      const mainBranch = await BranchService.getMainBranch(designId)
      await testDb.db.insert(branchItems).values({
        branchId: mainBranch!.id,
        itemMasterId: part.masterId!,
        currentItemId: part.id,
        baseItemId: part.id,
        changeType: null,
      })

      const { eco } = await ecoWithWorkingCopy(part, part.id, '-cccccccc')
      await ChangeOrderMergeService.merge(eco.id, user.id)

      // A branch merge of a modified item is a revise, so the version it
      // replaces follows revise.oldVersionState rather than staying
      // 'Released' and being distinguishable only by isCurrent.
      const superseded = await ItemService.findById(part.id)
      expect(superseded?.state).toBe('Superseded')
      expect(superseded?.isCurrent).toBe(false)
    })

    it('releases a working copy stamped DRAFT at the next revision', async () => {
      const part = await createPart('draftrev', 'Released')
      const mainBranch = await BranchService.getMainBranch(designId)
      await testDb.db.insert(branchItems).values({
        branchId: mainBranch!.id,
        itemMasterId: part.masterId!,
        currentItemId: part.id,
        baseItemId: part.id,
        changeType: null,
      })

      // 'DRAFT' is what saveChanges and rebase historically wrote. Read as a
      // released revision it took the legacy path and minted 'A' from the
      // marker text - colliding with the existing rev A, or regressing main.
      const { eco, workingCopy } = await ecoWithWorkingCopy(
        part,
        part.id,
        'DRAFT',
      )
      await ChangeOrderMergeService.merge(eco.id, user.id)

      const released = await ItemService.findById(workingCopy.id)
      expect(released?.revision).toBe('B')
      expect(released?.isCurrent).toBe(true)
    })
  })

  describe('upstream change notification to derived MBOMs', () => {
    it('notifies MBOMs derived from the design when an ECO branch merges', async () => {
      // Regression: notifyDerivedMboms had no caller anywhere, so
      // upstream_changes was never written and the whole MBOM
      // upstream-review feature was unreachable — GET upstream-changes could
      // only ever return empty.
      const part = await createPart('upstream-notify', 'Released')
      const mainBranch = await BranchService.getMainBranch(designId)

      await testDb.db.insert(branchItems).values({
        branchId: mainBranch!.id,
        itemMasterId: part.masterId!,
        currentItemId: part.id,
        baseItemId: part.id,
        changeType: null,
      })

      // A Manufacturing design derived from this one. Inserted directly:
      // MbomService.createFromEbom is the only legal producer, and this test
      // only needs the sourceDesignId link it establishes.
      const mbom = takeFirst(
        await testDb.db
          .insert(designs)
          .values({
            programId,
            name: 'Derived MBOM',
            code: `MBOM-${uniquePrefix}`,
            designType: 'Manufacturing',
            sourceDesignId: designId,
            createdBy: user.id,
          })
          .returning(),
      )

      const eco = await createChangeOrder()
      const { branch } = await BranchService.getOrCreateEcoBranch(
        designId,
        eco.id,
        user.id,
      )

      const workingCopy = takeFirst(
        await testDb.db
          .insert(items)
          .values({
            itemNumber: part.itemNumber,
            itemType: 'Part',
            revision: '-',
            name: 'Branch Working Copy',
            state: 'Draft',
            masterId: part.masterId,
            designId: part.designId,
            isCurrent: false,
            createdBy: user.id,
            modifiedBy: user.id,
          })
          .returning(),
      )

      await testDb.db.insert(branchItems).values({
        branchId: branch.id,
        itemMasterId: part.masterId!,
        currentItemId: workingCopy.id,
        baseItemId: part.id,
        changeType: 'modified',
      })

      await testDb.db.insert(changeOrderDesigns).values({
        changeOrderId: eco.id,
        designId: designId,
        branchId: branch.id,
        mergeStatus: 'pending',
      })

      await approveEco(eco.id)
      await ChangeOrderMergeService.merge(eco.id, user.id)

      const notifications = await testDb.db
        .select()
        .from(upstreamChanges)
        .where(eq(upstreamChanges.targetDesignId, mbom.id))

      expect(notifications.length).toBe(1)
      expect(notifications[0]!.sourceDesignId).toBe(designId)
      expect(notifications[0]!.sourceEcoId).toBe(eco.id)
      expect(notifications[0]!.status).toBe('pending')

      // The payload must describe the change well enough to review it.
      const changed = notifications[0]!.changedItems
      expect(changed.length).toBe(1)
      expect(changed[0]!.masterId).toBe(part.masterId)
      expect(changed[0]!.itemNumber).toBe(part.itemNumber)
      expect(changed[0]!.changeType).toBe('modified')
      expect(changed[0]!.previousRevision).toBe('A')
      expect(changed[0]!.newRevision).toBe('B')
    })

    it('does not notify when the design has no derived MBOMs', async () => {
      const part = await createPart('upstream-none', 'Released')
      const mainBranch = await BranchService.getMainBranch(designId)

      await testDb.db.insert(branchItems).values({
        branchId: mainBranch!.id,
        itemMasterId: part.masterId!,
        currentItemId: part.id,
        baseItemId: part.id,
        changeType: null,
      })

      const eco = await createChangeOrder()
      const { branch } = await BranchService.getOrCreateEcoBranch(
        designId,
        eco.id,
        user.id,
      )

      const workingCopy = takeFirst(
        await testDb.db
          .insert(items)
          .values({
            itemNumber: part.itemNumber,
            itemType: 'Part',
            revision: '-',
            name: 'Branch Working Copy',
            state: 'Draft',
            masterId: part.masterId,
            designId: part.designId,
            isCurrent: false,
            createdBy: user.id,
            modifiedBy: user.id,
          })
          .returning(),
      )

      await testDb.db.insert(branchItems).values({
        branchId: branch.id,
        itemMasterId: part.masterId!,
        currentItemId: workingCopy.id,
        baseItemId: part.id,
        changeType: 'modified',
      })

      await testDb.db.insert(changeOrderDesigns).values({
        changeOrderId: eco.id,
        designId: designId,
        branchId: branch.id,
        mergeStatus: 'pending',
      })

      await approveEco(eco.id)
      await ChangeOrderMergeService.merge(eco.id, user.id)

      const notifications = await testDb.db
        .select()
        .from(upstreamChanges)
        .where(eq(upstreamChanges.sourceDesignId, designId))

      expect(notifications.length).toBe(0)
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
      const part = takeFirst(
        await testDb.db
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
          .returning(),
      )

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
      })

      await approveEco(eco.id)

      // Release should auto-checkin items before merge
      const result = await ChangeOrderMergeService.merge(eco.id, user.id)

      expect(result.designs.length).toBe(1)
      expect(result.designs[0]!.mergeResult.itemsAdded).toBe(1)

      // Verify the revision was assigned as 'A'
      expect(
        result.designs[0]!.mergeResult.revisionsAssigned[part.itemNumber],
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

    it('applies release/obsolete actions even when the ECO also merges a branch', async () => {
      // Regression: these actions used to be gated behind "no branches
      // merged", so an end-of-life ECO that both edited an assembly on its
      // branch AND obsoleted the superseded part silently dropped the
      // obsoletion. 'revise' stays the merge's job — it creates a new
      // version — but release/obsolete only restate an existing one.
      // Create every part while the design is still clean — branch protection
      // blocks creating on main once it holds released items — then release
      // the two that need to start out Released.
      const assembly = await createPart('branch-and-obsolete-assy')
      const eolPart = await createPart('branch-and-obsolete-eol')
      const draftPart = await createPart('branch-and-obsolete-draft')
      await testDb.db
        .update(items)
        .set({ state: 'Released' })
        .where(inArray(items.id, [assembly.id, eolPart.id]))

      const mainBranch = await BranchService.getMainBranch(designId)

      await testDb.db.insert(branchItems).values({
        branchId: mainBranch!.id,
        itemMasterId: assembly.masterId!,
        currentItemId: assembly.id,
        baseItemId: assembly.id,
        changeType: null,
      })

      const eco = await createChangeOrder()
      const { branch } = await BranchService.getOrCreateEcoBranch(
        designId,
        eco.id,
        user.id,
      )

      // Branch content: a working copy of the assembly, so a branch merges.
      const workingCopy = takeFirst(
        await testDb.db
          .insert(items)
          .values({
            itemNumber: assembly.itemNumber,
            itemType: 'Part',
            revision: '-',
            name: 'Branch Working Copy',
            state: 'Draft',
            masterId: assembly.masterId,
            designId: assembly.designId,
            isCurrent: false,
            createdBy: user.id,
            modifiedBy: user.id,
          })
          .returning(),
      )

      await testDb.db.insert(branchItems).values({
        branchId: branch.id,
        itemMasterId: assembly.masterId!,
        currentItemId: workingCopy.id,
        baseItemId: assembly.id,
        changeType: 'modified',
      })

      await testDb.db.insert(changeOrderDesigns).values({
        changeOrderId: eco.id,
        designId: designId,
        branchId: branch.id,
        mergeStatus: 'pending',
      })

      // Affected items that are NOT branch content: state-only actions.
      await testDb.db.insert(changeOrderAffectedItems).values([
        {
          changeOrderId: eco.id,
          affectedItemId: eolPart.id,
          affectedItemMasterId: eolPart.masterId,
          changeAction: 'obsolete',
          currentState: 'Released',
          targetState: 'Obsolete',
          createdBy: user.id,
        },
        {
          changeOrderId: eco.id,
          affectedItemId: draftPart.id,
          affectedItemMasterId: draftPart.masterId,
          changeAction: 'release',
          currentState: 'Draft',
          targetState: 'Released',
          createdBy: user.id,
        },
      ])

      await approveEco(eco.id)

      const result = await ChangeOrderMergeService.merge(eco.id, user.id)

      // The branch still merged — this does not replace the branch path.
      expect(result.designs.length).toBe(1)
      expect(result.designs[0]!.mergeResult.itemsMerged).toBe(1)
      const releasedAssembly = await ItemService.findById(workingCopy.id)
      expect(releasedAssembly?.state).toBe('Released')

      // ...and the state-only actions were applied rather than dropped.
      const obsoleted = await ItemService.findById(eolPart.id)
      expect(obsoleted?.state).toBe('Obsolete')

      const released = await ItemService.findById(draftPart.id)
      expect(released?.state).toBe('Released')
      expect(released?.revision).not.toBe('-')
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
      const newRevision = takeFirst(
        await testDb.db
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
          .returning(),
      )

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
      secondDesignId = secondDesign.id!
    })

    it('aggregates validation issues from all designs', async () => {
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
        },
        {
          changeOrderId: eco.id,
          designId: secondDesignId,
          branchId: branch2.id,
          mergeStatus: 'pending',
        },
      ])

      // Add checked out items to both branches (one warning each)
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

      // Both designs are validated and both report, each tagged with its own
      // design name — the point of the aggregation. Held checkouts are warnings
      // (the release checks them in), so they do not block.
      const checkoutIssues = preview.validationIssues.filter((i) =>
        i.includes('still checked out'),
      )
      expect(checkoutIssues.length).toBe(2)
      expect(preview.designs.length).toBe(2)
      expect(preview.canRelease).toBe(true)
    })
  })
  describe('release idempotency across designs', () => {
    let secondDesignId: string

    beforeEach(async () => {
      const secondDesign = await DesignService.create(
        {
          code: `DSN-${uniquePrefix}-RETRY`,
          name: 'Retry Design',
          programId,
          designType: 'Engineering',
        },
        user.id,
      )
      secondDesignId = secondDesign.id!
    })

    it('does not re-release a design a previous attempt already merged', async () => {
      const eco = await createChangeOrder()

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

      await testDb.db.insert(changeOrderDesigns).values([
        {
          changeOrderId: eco.id,
          designId,
          branchId: branch1.id,
          mergeStatus: 'pending',
        },
        {
          changeOrderId: eco.id,
          designId: secondDesignId,
          branchId: branch2.id,
          mergeStatus: 'pending',
        },
      ])

      const partA = await createPart('retry-a', 'Released')
      const workingA = takeFirst(
        await testDb.db
          .insert(items)
          .values({
            masterId: partA.masterId!,
            designId,
            itemNumber: partA.itemNumber!,
            revision: `-${branch1.id.substring(0, 8)}`,
            itemType: 'Part',
            name: 'Working A',
            state: 'Draft',
            isCurrent: false,
            createdBy: user.id,
            modifiedBy: user.id,
          })
          .returning(),
      )
      await testDb.db.insert(branchItems).values({
        branchId: branch1.id,
        itemMasterId: partA.masterId!,
        currentItemId: workingA.id,
        baseItemId: partA.id,
        changeType: 'modified',
      })

      const partB = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-retry-b`,
          revision: 'A',
          name: 'Retry Part B',
          designId: secondDesignId,
          state: 'Released',
        } as any,
        user.id,
      )
      const workingB = takeFirst(
        await testDb.db
          .insert(items)
          .values({
            masterId: partB.masterId!,
            designId: secondDesignId,
            itemNumber: partB.itemNumber!,
            revision: `-${branch2.id.substring(0, 8)}`,
            itemType: 'Part',
            name: 'Working B',
            state: 'Draft',
            isCurrent: false,
            createdBy: user.id,
            modifiedBy: user.id,
          })
          .returning(),
      )
      await testDb.db.insert(branchItems).values({
        branchId: branch2.id,
        itemMasterId: partB.masterId!,
        currentItemId: workingB.id,
        baseItemId: partB.id,
        changeType: 'modified',
      })

      await approveEco(eco.id)
      await ChangeOrderMergeService.merge(eco.id, user.id)

      const revisionAfterFirst = await testDb.db
        .select({ revision: items.revision })
        .from(items)
        .where(eq(items.id, workingA.id))
        .then((r) => r.at(0)?.revision)
      expect(revisionAfterFirst).toBe('B')

      // A release is retryable by design: a failure part-way leaves the change
      // order pre-final so the user can try again. The retry must not release
      // the designs that already succeeded a second time — without a
      // mergeStatus guard the per-design loop bumped their revisions again.
      await ChangeOrderMergeService.merge(eco.id, user.id)

      const revisionAfterRetry = await testDb.db
        .select({ revision: items.revision })
        .from(items)
        .where(eq(items.id, workingA.id))
        .then((r) => r.at(0)?.revision)
      expect(revisionAfterRetry).toBe('B')

      // and exactly one current version survives per master
      const currentA = await testDb.db
        .select({ id: items.id })
        .from(items)
        .where(
          and(eq(items.masterId, partA.masterId), eq(items.isCurrent, true)),
        )
      expect(currentA.length).toBe(1)
    })
  })

  describe('release never uses the stored revision prediction', () => {
    it('recomputes the revision at merge, ignoring targetRevision', async () => {
      const eco = await createChangeOrder()
      const part = await createPart('stale-target', 'Released')

      await ChangeOrderService.addAffectedItem(
        eco.id,
        { affectedItemId: part.id, changeAction: 'revise' },
        user.id,
      )

      // Simulate a prediction that has gone stale (or, before the dialogs
      // stopped guessing client-side, was never valid: `incrementRevision('Z')`
      // returned '['). It must never become the released revision.
      await testDb.db
        .update(changeOrderAffectedItems)
        .set({ targetRevision: '[' })
        .where(eq(changeOrderAffectedItems.changeOrderId, eco.id))

      // Drop the working copy so the merge takes the no-working-copy path,
      // which is the one that used to prefer the stored value
      await testDb.db
        .delete(branchItems)
        .where(eq(branchItems.itemMasterId, part.masterId))

      await approveEco(eco.id)
      await ChangeOrderMergeService.merge(eco.id, user.id)

      const released = await testDb.db
        .select({ revision: items.revision })
        .from(items)
        .where(
          and(eq(items.masterId, part.masterId), eq(items.isCurrent, true)),
        )
        .then((r) => r.at(0))

      expect(released?.revision).toBe('B')
    })
  })
})
