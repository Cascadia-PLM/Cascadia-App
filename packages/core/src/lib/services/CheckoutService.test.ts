// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * CheckoutService Tests
 *
 * Integration tests for the CheckoutService class.
 * Tests cover checkout/checkin workflow, branch operations, and validation.
 *
 * Run: npm run test -- src/lib/services/CheckoutService.test.ts
 */

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
import { and, eq, isNotNull } from 'drizzle-orm'
import { ItemService } from '../items/services/ItemService'
import { ChangeOrderService } from '../items/services/ChangeOrderService'
import {
  CheckoutService,
  computeFieldChanges,
  computeInitialFieldValues,
} from './CheckoutService'
import { BranchService } from './BranchService'
import { DesignService } from './DesignService'
import { RevisionService } from './RevisionService'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import {
  BranchProtectionError,
  ItemCheckoutRequiredError,
  NotFoundError,
  ResourceLockedError,
  ValidationError,
} from '@/lib/errors'
import {
  branchItems,
  changeOrderAffectedItems,
  itemFieldChanges,
  itemRelationships,
  itemVersions,
  items,
  programMembers,
  programs,
  requirements,
  workInstructionOperations,
  workInstructionPartAttachments,
  workInstructionSteps,
  workInstructions,
} from '@/lib/db/schema'
import {
  workflowDefinitions,
  workflowInstances,
} from '@/lib/db/schema/workflows'
import { itemTypeConfigs } from '@/lib/db/schema/config'
import { ItemTypeRegistry } from '@/lib/items/registry'
import { LIFECYCLE_IDS } from '@/lib/items/lifecycle-ids'
import { SYSTEM_USER_ID } from '@/__tests__/fixtures/lifecycles'
import { takeFirst } from '@/lib/db/take-first'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

describe('CheckoutService', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let otherUser: TestUser
  let programId: string
  let designId: string
  let mainBranchId: string
  let initialCommitId: string
  let ecoBranchId: string
  let changeOrderId: string

  beforeAll(async () => {
    await testDb.setup()
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

    // Create test users (let fixture generate unique emails)
    user = await insertTestUser(testDb.db)
    otherUser = await insertTestUser(testDb.db)

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

    // The program's creator is not automatically a member when the row is
    // inserted directly (ProgramService.create is what enrols them), and
    // ItemService.update/delete now refuse a write to a design the caller
    // cannot reach. Enrol the acting user so these cases exercise their own
    // subject rather than the program boundary.
    // otherUser is enrolled too: the edit-lock cases below are about who holds
    // the checkout, and an outsider would be turned away before reaching it.
    for (const member of [user, otherUser]) {
      await testDb.db.insert(programMembers).values({
        programId,
        userId: member.id,
        role: 'engineer',
        invitedBy: user.id,
      })
    }

    // Create test design
    const design = await DesignService.create(
      {
        programId,
        name: 'Test Design',
        code: `DES-${uniquePrefix}`,
        designType: 'Engineering',
      },
      user.id,
    )

    designId = design.id
    mainBranchId = design.mainBranch!.id
    initialCommitId = design.initialCommit!.id

    // Create an ECO branch for testing
    // ChangeOrders are exempt from branch protection (workflow control objects)
    // Note: ChangeOrders use auto-generated item numbers
    const changeOrder = await ItemService.create(
      'ChangeOrder',
      {
        // itemNumber is auto-generated for ChangeOrders
        revision: 'A',
        name: 'Test ECO',
        changeType: 'ECO',
        priority: 'medium',
        reasonForChange: 'Test',
        designId,
      } as any,
      user.id,
    )

    changeOrderId = changeOrder.id

    const { branch } = await BranchService.getOrCreateEcoBranch(
      designId,
      changeOrder.id,
      user.id,
    )
    ecoBranchId = branch.id
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  // Helper to create a released part and link it to the initial commit
  // Bypasses branch protection since these tests focus on checkout logic
  async function createReleasedPart(overrides: Record<string, any> = {}) {
    const part = await ItemService.create(
      'Part',
      {
        itemNumber: `PN-${uniquePrefix}-${Math.random().toString(36).slice(2, 7)}`,
        revision: 'A',
        name: 'Test Part',
        state: 'Released',
        designId,
        ...overrides,
      } as any,
      user.id,
      { bypassBranchProtection: true },
    )

    // Link the item to the initial commit so VersionResolver can find it
    await testDb.db.insert(itemVersions).values({
      commitId: initialCommitId,
      itemId: part.id,
      changeType: 'added',
    })

    return part
  }

  // Same shape for a Requirement. Requirements are the type whose update
  // schema admits fields no column or handler stores, which is what the
  // audit-trail invariant below exercises.
  async function createReleasedRequirement(
    overrides: Record<string, any> = {},
  ) {
    const requirement = await ItemService.create(
      'Requirement',
      {
        itemNumber: `REQ-${uniquePrefix}-${Math.random().toString(36).slice(2, 7)}`,
        revision: 'A',
        name: 'Test Requirement',
        state: 'Released',
        designId,
        ...overrides,
      } as any,
      user.id,
      { bypassBranchProtection: true },
    )

    await testDb.db.insert(itemVersions).values({
      commitId: initialCommitId,
      itemId: requirement.id,
      changeType: 'added',
    })

    return requirement
  }

  describe('checkout', () => {
    it('creates branchItem record on checkout', async () => {
      const part = await createReleasedPart()

      const branchItem = await CheckoutService.checkout(
        {
          itemMasterId: part.masterId,
          branchId: ecoBranchId,
        },
        user.id,
      )

      expect(branchItem).toBeDefined()
      expect(branchItem.itemMasterId).toBe(part.masterId)
      expect(branchItem.branchId).toBe(ecoBranchId)
      expect(branchItem.checkedOutBy).toBe(user.id)
      expect(branchItem.checkedOutAt).toBeDefined()
    })

    it('sets checkedOutBy user', async () => {
      const part = await createReleasedPart()

      const branchItem = await CheckoutService.checkout(
        {
          itemMasterId: part.masterId,
          branchId: ecoBranchId,
        },
        user.id,
      )

      expect(branchItem.checkedOutBy).toBe(user.id)
    })

    it('throws error when checking out on main branch', async () => {
      const part = await createReleasedPart()

      await expect(
        CheckoutService.checkout(
          {
            itemMasterId: part.masterId,
            branchId: mainBranchId,
          },
          user.id,
        ),
      ).rejects.toThrow(ValidationError)
    })

    it('throws error when checking out on locked branch', async () => {
      const part = await createReleasedPart()
      await BranchService.lockBranch(ecoBranchId)

      await expect(
        CheckoutService.checkout(
          {
            itemMasterId: part.masterId,
            branchId: ecoBranchId,
          },
          user.id,
        ),
      ).rejects.toThrow(ValidationError)
    })

    it('returns existing branchItem if already checked out by same user', async () => {
      const part = await createReleasedPart()

      const first = await CheckoutService.checkout(
        {
          itemMasterId: part.masterId,
          branchId: ecoBranchId,
        },
        user.id,
      )

      const second = await CheckoutService.checkout(
        {
          itemMasterId: part.masterId,
          branchId: ecoBranchId,
        },
        user.id,
      )

      expect(second.id).toBe(first.id)
    })

    it('throws error if checked out by another user', async () => {
      const part = await createReleasedPart()

      await CheckoutService.checkout(
        {
          itemMasterId: part.masterId,
          branchId: ecoBranchId,
        },
        user.id,
      )

      await expect(
        CheckoutService.checkout(
          {
            itemMasterId: part.masterId,
            branchId: ecoBranchId,
          },
          otherUser.id,
        ),
      ).rejects.toThrow(ResourceLockedError)
    })

    it('throws NotFoundError for non-existent branch', async () => {
      const part = await createReleasedPart()

      await expect(
        CheckoutService.checkout(
          {
            itemMasterId: part.masterId,
            branchId: '00000000-0000-0000-0000-000000000000',
          },
          user.id,
        ),
      ).rejects.toThrow(NotFoundError)
    })
  })

  describe('getCheckoutStatus', () => {
    it('returns isCheckedOut false when not checked out', async () => {
      const part = await createReleasedPart()

      const status = await CheckoutService.getCheckoutStatus(
        part.masterId,
        ecoBranchId,
      )

      expect(status.isCheckedOut).toBe(false)
      expect(status.checkedOutBy).toBeUndefined()
    })

    it('returns checkout details when checked out', async () => {
      const part = await createReleasedPart()
      await CheckoutService.checkout(
        {
          itemMasterId: part.masterId,
          branchId: ecoBranchId,
        },
        user.id,
      )

      const status = await CheckoutService.getCheckoutStatus(
        part.masterId,
        ecoBranchId,
      )

      expect(status.isCheckedOut).toBe(true)
      expect(status.checkedOutBy?.id).toBe(user.id)
      expect(status.checkedOutAt).toBeDefined()
      expect(status.branchItem).toBeDefined()
    })
  })

  describe('cancelCheckout', () => {
    it('removes checkout when no changes made', async () => {
      const part = await createReleasedPart()
      await CheckoutService.checkout(
        {
          itemMasterId: part.masterId,
          branchId: ecoBranchId,
        },
        user.id,
      )

      await CheckoutService.cancelCheckout(part.masterId, ecoBranchId, user.id)

      const status = await CheckoutService.getCheckoutStatus(
        part.masterId,
        ecoBranchId,
      )
      expect(status.isCheckedOut).toBe(false)
    })

    it('throws error if not checked out by user', async () => {
      const part = await createReleasedPart()
      await CheckoutService.checkout(
        {
          itemMasterId: part.masterId,
          branchId: ecoBranchId,
        },
        user.id,
      )

      await expect(
        CheckoutService.cancelCheckout(
          part.masterId,
          ecoBranchId,
          otherUser.id,
        ),
      ).rejects.toThrow(ValidationError)
    })

    it('throws NotFoundError when item not on branch', async () => {
      const part = await createReleasedPart()

      await expect(
        CheckoutService.cancelCheckout(part.masterId, ecoBranchId, user.id),
      ).rejects.toThrow(NotFoundError)
    })
  })

  describe('ECO scope enforcement at the branch layer', () => {
    async function lockEcoScope() {
      const branch = await BranchService.getById(ecoBranchId)
      // These fixtures create the change order directly, so give it the
      // workflow instance a real one carries before locking its scope.
      await testDb.db.insert(workflowInstances).values({
        itemId: branch!.changeOrderItemId!,
        currentState: 'InReview',
        scopeLocked: true,
        scopeLockedAt: new Date(),
      })
    }

    it('records checked-out items on the owning change order', async () => {
      const part = await createReleasedPart()

      await CheckoutService.checkout(
        { itemMasterId: part.masterId, branchId: ecoBranchId },
        user.id,
      )

      // The merge releases branch content, so anything reachable on an ECO
      // branch has to appear in the scope reviewers approve. This route is
      // reachable directly (the checkout dialog, the item routes, the AI
      // tools) and used to leave no trace on the change order at all.
      const branch = await BranchService.getById(ecoBranchId)
      const affected = await ChangeOrderService.getAffectedItems(
        branch!.changeOrderItemId!,
      )
      expect(
        affected.some((a) => a.affectedItemMasterId === part.masterId),
      ).toBe(true)
    })

    it('eager working-copy mint registers the item on the owning change order', async () => {
      const part = await createReleasedPart()

      // The checkout routes mint the working copy before taking the lock, so
      // checkout finds the row and claims it — the claim path never
      // registers, deliberately (that is the row-creator's job). The mint is
      // the row creator here, so registration is its job.
      await CheckoutService.ensureRevisionWorkingCopy(
        part,
        ecoBranchId,
        user.id,
      )
      const branchItem = await CheckoutService.checkout(
        { itemMasterId: part.masterId, branchId: ecoBranchId },
        user.id,
      )

      expect(branchItem.changeType).toBe('modified')
      expect(branchItem.currentItemId).not.toBe(part.id)
      expect(branchItem.checkedOutBy).toBe(user.id)

      const affected = await ChangeOrderService.getAffectedItems(changeOrderId)
      const listed = affected.filter(
        (a) => a.affectedItemMasterId === part.masterId,
      )
      expect(listed).toHaveLength(1)
      expect(listed[0]!.changeAction).toBe('revise')
    })

    it('converges with addAffectedItem: checkout after scope management neither duplicates nor repoints', async () => {
      const part = await createReleasedPart()

      await ChangeOrderService.addAffectedItem(
        changeOrderId,
        { affectedItemId: part.id, changeAction: 'revise' },
        user.id,
      )
      const before = takeFirst(
        await testDb.db
          .select()
          .from(branchItems)
          .where(
            and(
              eq(branchItems.branchId, ecoBranchId),
              eq(branchItems.itemMasterId, part.masterId),
            ),
          ),
      )

      await CheckoutService.ensureRevisionWorkingCopy(
        part,
        ecoBranchId,
        user.id,
      )
      const branchItem = await CheckoutService.checkout(
        { itemMasterId: part.masterId, branchId: ecoBranchId },
        user.id,
      )

      // Same working copy, still exactly one row in the reviewed scope
      expect(branchItem.currentItemId).toBe(before.currentItemId)
      const affected = await ChangeOrderService.getAffectedItems(changeOrderId)
      expect(
        affected.filter((a) => a.affectedItemMasterId === part.masterId),
      ).toHaveLength(1)
    })

    it('refuses the eager working-copy mint for a new item once scope is locked', async () => {
      await lockEcoScope()

      const latecomer = await createReleasedPart()
      await expect(
        CheckoutService.ensureRevisionWorkingCopy(
          latecomer,
          ecoBranchId,
          user.id,
        ),
      ).rejects.toThrow(ValidationError)

      // Refused means refused: no branch row, no working copy, no scope row
      const rows = await testDb.db
        .select()
        .from(branchItems)
        .where(
          and(
            eq(branchItems.branchId, ecoBranchId),
            eq(branchItems.itemMasterId, latecomer.masterId),
          ),
        )
      expect(rows).toHaveLength(0)
      const versions = await testDb.db
        .select()
        .from(items)
        .where(eq(items.masterId, latecomer.masterId))
      expect(versions).toHaveLength(1)
      const affected = await ChangeOrderService.getAffectedItems(changeOrderId)
      expect(
        affected.some((a) => a.affectedItemMasterId === latecomer.masterId),
      ).toBe(false)
    })

    it('still mints the working copy during review for an item already in scope', async () => {
      const part = await createReleasedPart()
      await CheckoutService.checkout(
        { itemMasterId: part.masterId, branchId: ecoBranchId },
        user.id,
      )

      await lockEcoScope()

      // Scope locking freezes WHAT the change order covers, not the detail
      // work on it — same rule the lazy mint in saveChanges follows.
      await CheckoutService.ensureRevisionWorkingCopy(
        part,
        ecoBranchId,
        user.id,
      )

      const row = takeFirst(
        await testDb.db
          .select()
          .from(branchItems)
          .where(
            and(
              eq(branchItems.branchId, ecoBranchId),
              eq(branchItems.itemMasterId, part.masterId),
            ),
          ),
      )
      expect(row.changeType).toBe('modified')
      expect(row.currentItemId).not.toBe(part.id)
      expect(row.checkedOutBy).toBe(user.id) // lock preserved through upsert

      const affected = await ChangeOrderService.getAffectedItems(changeOrderId)
      expect(
        affected.filter((a) => a.affectedItemMasterId === part.masterId),
      ).toHaveLength(1)
    })

    it('refuses to bring a new item onto a scope-locked ECO branch', async () => {
      const alreadyIn = await createReleasedPart()
      await CheckoutService.checkout(
        { itemMasterId: alreadyIn.masterId, branchId: ecoBranchId },
        user.id,
      )

      await lockEcoScope()

      const latecomer = await createReleasedPart()
      await expect(
        CheckoutService.checkout(
          { itemMasterId: latecomer.masterId, branchId: ecoBranchId },
          user.id,
        ),
      ).rejects.toThrow(ValidationError)
    })

    it('still allows editing items already in scope while locked', async () => {
      const part = await createReleasedPart()
      await CheckoutService.checkout(
        { itemMasterId: part.masterId, branchId: ecoBranchId },
        user.id,
      )

      await lockEcoScope()

      // Scope locking freezes WHAT the change order covers, not the detail
      // work on it - reviewers fix the scope, engineers keep refining.
      const saved = await CheckoutService.saveChanges(
        {
          branchId: ecoBranchId,
          itemId: part.id,
          changes: { name: 'Refined during review' },
          commitMessage: 'refine',
        },
        user.id,
      )
      expect(saved.item.name).toBe('Refined during review')
    })

    it('refuses to create a new item on a scope-locked ECO branch', async () => {
      await lockEcoScope()

      await expect(
        CheckoutService.createOnBranch(
          {
            designId,
            itemNumber: `PN-LATE-${Date.now()}`,
            itemType: 'Part',
          },
          ecoBranchId,
          'Added after scope lock',
          user.id,
        ),
      ).rejects.toThrow(ValidationError)
    })

    // Deleting a master the branch does not track yet mints branch content
    // for it, which is new scope like any other. Without this gate the delete
    // succeeded and left content the change order could not list, and the
    // release then refused the ECO with nothing the user could do in-app.
    it('refuses to delete a master the branch does not track once scope is locked', async () => {
      await lockEcoScope()

      const latecomer = await createReleasedPart()
      await expect(
        CheckoutService.deleteOnBranch(
          latecomer.masterId,
          ecoBranchId,
          'Deleted after scope lock',
          user.id,
        ),
      ).rejects.toThrow(ValidationError)

      const rows = await testDb.db
        .select()
        .from(branchItems)
        .where(
          and(
            eq(branchItems.branchId, ecoBranchId),
            eq(branchItems.itemMasterId, latecomer.masterId),
          ),
        )
      expect(rows).toHaveLength(0)
    })

    // The invariant this whole issue exists for: every master the branch
    // records a change for has to appear in the change order's scope, or the
    // release refuses. Deleting registered nothing at all.
    it('leaves nothing unlisted after deleting a master the branch did not track', async () => {
      const part = await createReleasedPart()

      await CheckoutService.deleteOnBranch(
        part.masterId,
        ecoBranchId,
        'Deleted straight off the branch',
        user.id,
      )

      const affected = await ChangeOrderService.getAffectedItems(changeOrderId)
      const listed = affected.filter(
        (a) => a.affectedItemMasterId === part.masterId,
      )
      expect(listed).toHaveLength(1)
      // The merge retires the base item, so the scope row says obsolete.
      expect(listed[0]!.changeAction).toBe('obsolete')

      // The same comparison `findUnlistedBranchContent` makes: no branch row
      // carrying a change type may be missing from the affected-items list.
      const changed = await testDb.db
        .select({ itemMasterId: branchItems.itemMasterId })
        .from(branchItems)
        .where(
          and(
            eq(branchItems.branchId, ecoBranchId),
            isNotNull(branchItems.changeType),
          ),
        )
      const listedMasters = new Set(affected.map((a) => a.affectedItemMasterId))
      expect(
        changed.filter((c) => !listedMasters.has(c.itemMasterId)),
      ).toHaveLength(0)
    })

    // Registration and creation are one transaction now. It used to run on
    // the pool after the transaction had committed, so a failure there left
    // branch content no affected-items row listed — the same shape the
    // release refuses.
    it('rolls the whole creation back when registering it on the change order fails', async () => {
      const itemNumber = `PN-ATOMIC-${uniquePrefix}`
      const spy = vi
        .spyOn(ChangeOrderService, 'registerBranchChange')
        .mockRejectedValue(new Error('registration exploded'))

      try {
        await expect(
          CheckoutService.createOnBranch(
            { designId, itemNumber, itemType: 'Part', name: 'Doomed' },
            ecoBranchId,
            'Added new part',
            user.id,
          ),
        ).rejects.toThrow()
      } finally {
        spy.mockRestore()
      }

      const orphanItems = await testDb.db
        .select({ masterId: items.masterId })
        .from(items)
        .where(eq(items.itemNumber, itemNumber))
      expect(orphanItems).toHaveLength(0)

      const branchRows = await testDb.db
        .select()
        .from(branchItems)
        .where(eq(branchItems.branchId, ecoBranchId))
      expect(branchRows).toHaveLength(0)
    })
  })

  describe('saveChanges', () => {
    it('leaves the released version as the only current one', async () => {
      const part = await createReleasedPart()
      await CheckoutService.checkout(
        { itemMasterId: part.masterId, branchId: ecoBranchId },
        user.id,
      )

      await CheckoutService.saveChanges(
        {
          branchId: ecoBranchId,
          itemId: part.id,
          changes: { name: 'Edited on branch' },
          commitMessage: 'edit',
        },
        user.id,
      )

      // Only the merge promotes a version onto main. A branch draft that
      // claims isCurrent gives the master two current rows, and every
      // `isCurrent = true ... limit(1)` reader then picks arbitrarily.
      const currentRows = await testDb.db
        .select()
        .from(items)
        .where(
          and(eq(items.masterId, part.masterId), eq(items.isCurrent, true)),
        )
      expect(currentRows).toHaveLength(1)
      expect(currentRows[0]!.id).toBe(part.id)
    })

    it('supports repeated saves on the same branch', async () => {
      const part = await createReleasedPart()
      await CheckoutService.checkout(
        { itemMasterId: part.masterId, branchId: ecoBranchId },
        user.id,
      )

      await CheckoutService.saveChanges(
        {
          branchId: ecoBranchId,
          itemId: part.id,
          changes: { name: 'First edit' },
          commitMessage: 'first',
        },
        user.id,
      )

      const afterFirst = await CheckoutService.getCheckoutStatus(
        part.masterId,
        ecoBranchId,
      )

      // Working copies are branch-scoped by revision, so a second save must
      // edit the copy this branch already owns rather than inserting another
      // row with the same (itemNumber, revision, designId, itemType).
      const second = await CheckoutService.saveChanges(
        {
          branchId: ecoBranchId,
          itemId: afterFirst.branchItem!.currentItemId!,
          changes: { name: 'Second edit' },
          commitMessage: 'second',
        },
        user.id,
      )

      expect(second.item.name).toBe('Second edit')
    })

    it('keeps working copies of the same item on separate branches apart', async () => {
      const part = await createReleasedPart()

      const otherEco = await ItemService.create(
        'ChangeOrder',
        {
          revision: 'A',
          name: 'Second ECO',
          changeType: 'ECO',
          priority: 'medium',
          reasonForChange: 'Test',
          designId,
        } as any,
        user.id,
      )
      const { branch: otherBranch } = await BranchService.getOrCreateEcoBranch(
        designId,
        otherEco.id,
        user.id,
      )

      for (const branchId of [ecoBranchId, otherBranch.id]) {
        await CheckoutService.checkout(
          { itemMasterId: part.masterId, branchId },
          user.id,
        )
        await CheckoutService.saveChanges(
          {
            branchId,
            itemId: part.id,
            changes: { name: `Edited on ${branchId}` },
            commitMessage: 'edit',
          },
          user.id,
        )
      }

      // Two ECOs revising one item concurrently is the core ECO-as-branch
      // promise; a shared working-revision marker would collide here.
      const drafts = await testDb.db
        .select()
        .from(items)
        .where(
          and(eq(items.masterId, part.masterId), eq(items.isCurrent, false)),
        )
      expect(drafts.length).toBeGreaterThanOrEqual(2)
    })

    it('records only field changes readable back on the stored item', async () => {
      const requirement = await createReleasedRequirement()
      await CheckoutService.checkout(
        { itemMasterId: requirement.masterId, branchId: ecoBranchId },
        user.id,
      )

      // First save mints the branch-local working copy.
      await CheckoutService.saveChanges(
        {
          branchId: ecoBranchId,
          itemId: requirement.id,
          changes: { name: 'First edit' },
          commitMessage: 'first',
        },
        user.id,
      )

      const afterFirst = await CheckoutService.getCheckoutStatus(
        requirement.masterId,
        ecoBranchId,
      )
      const workingCopyId = afterFirst.branchItem!.currentItemId!

      // Second save takes the in-place path. `requirementType` is an API
      // alias the handler folds onto the `type` column, so history records it
      // under the column's own name; `rationale` has no column and no handler
      // at all, so nothing is written for it - and the commit must not claim
      // otherwise.
      const second = await CheckoutService.saveChanges(
        {
          branchId: ecoBranchId,
          itemId: workingCopyId,
          changes: {
            name: 'Second edit',
            description: 'stored on the extension row',
            requirementType: 'Functional',
            rationale: 'nothing stores this',
          },
          commitMessage: 'second',
        },
        user.id,
      )

      const recorded = await testDb.db
        .select({
          fieldName: itemFieldChanges.fieldName,
          fieldPath: itemFieldChanges.fieldPath,
          newValue: itemFieldChanges.newValue,
        })
        .from(itemFieldChanges)
        .innerJoin(
          itemVersions,
          eq(itemFieldChanges.itemVersionId, itemVersions.id),
        )
        .where(eq(itemVersions.commitId, second.commit.id))

      const storedItem = takeFirst(
        await testDb.db.select().from(items).where(eq(items.id, workingCopyId)),
      )
      const storedExt = takeFirst(
        await testDb.db
          .select()
          .from(requirements)
          .where(eq(requirements.itemId, workingCopyId)),
      )
      const stored: Record<string, unknown> = { ...storedItem, ...storedExt }

      // The invariant: history is a diff of what was stored. Every value the
      // commit claims must be readable back on the item it names - a row for
      // a field nothing persisted has no truthful value to report.
      expect(recorded.length).toBeGreaterThan(0)
      for (const row of recorded) {
        const actual = row.fieldPath
          ? (stored.attributes as Record<string, unknown> | null)?.[
              row.fieldName
            ]
          : stored[row.fieldName]
        expect({ field: row.fieldName, value: actual }).toEqual({
          field: row.fieldName,
          value: row.newValue,
        })
      }
    })
  })

  describe('checkin', () => {
    it('clears checkedOutBy but keeps branchItem', async () => {
      const part = await createReleasedPart()
      await CheckoutService.checkout(
        {
          itemMasterId: part.masterId,
          branchId: ecoBranchId,
        },
        user.id,
      )

      await CheckoutService.checkin(part.masterId, ecoBranchId, user.id)

      const status = await CheckoutService.getCheckoutStatus(
        part.masterId,
        ecoBranchId,
      )
      expect(status.isCheckedOut).toBe(false)
    })

    it('throws error if not checked out by user', async () => {
      const part = await createReleasedPart()
      await CheckoutService.checkout(
        {
          itemMasterId: part.masterId,
          branchId: ecoBranchId,
        },
        user.id,
      )

      await expect(
        CheckoutService.checkin(part.masterId, ecoBranchId, otherUser.id),
      ).rejects.toThrow(ValidationError)
    })

    it('throws NotFoundError when item not on branch', async () => {
      const part = await createReleasedPart()

      await expect(
        CheckoutService.checkin(part.masterId, ecoBranchId, user.id),
      ).rejects.toThrow(NotFoundError)
    })
  })

  describe('listUserCheckouts', () => {
    it('returns items checked out by user', async () => {
      const part1 = await createReleasedPart({ name: 'Part 1' })
      const part2 = await createReleasedPart({ name: 'Part 2' })

      await CheckoutService.checkout(
        { itemMasterId: part1.masterId, branchId: ecoBranchId },
        user.id,
      )
      await CheckoutService.checkout(
        { itemMasterId: part2.masterId, branchId: ecoBranchId },
        user.id,
      )

      const checkouts = await CheckoutService.listUserCheckouts(user.id)

      expect(checkouts.length).toBe(2)
      expect(
        checkouts.every((c) => c.branchItem.checkedOutBy === user.id),
      ).toBe(true)
    })

    it('returns empty array when no checkouts', async () => {
      const checkouts = await CheckoutService.listUserCheckouts(user.id)

      expect(checkouts).toEqual([])
    })

    it('does not include items checked out by other users', async () => {
      const part = await createReleasedPart()
      await CheckoutService.checkout(
        { itemMasterId: part.masterId, branchId: ecoBranchId },
        user.id,
      )

      const checkouts = await CheckoutService.listUserCheckouts(otherUser.id)

      expect(checkouts).toEqual([])
    })
  })

  describe('listBranchCheckouts', () => {
    it('returns items checked out on branch', async () => {
      const part1 = await createReleasedPart({ name: 'Part 1' })
      const part2 = await createReleasedPart({ name: 'Part 2' })

      await CheckoutService.checkout(
        { itemMasterId: part1.masterId, branchId: ecoBranchId },
        user.id,
      )
      await CheckoutService.checkout(
        { itemMasterId: part2.masterId, branchId: ecoBranchId },
        otherUser.id,
      )

      const checkouts = await CheckoutService.listBranchCheckouts(ecoBranchId)

      expect(checkouts.length).toBe(2)
    })

    it('throws NotFoundError for non-existent branch', async () => {
      await expect(
        CheckoutService.listBranchCheckouts(
          '00000000-0000-0000-0000-000000000000',
        ),
      ).rejects.toThrow(NotFoundError)
    })
  })

  describe('createOnBranch', () => {
    it('creates new item on branch with branchItem', async () => {
      const result = await CheckoutService.createOnBranch(
        {
          designId,
          itemNumber: `PN-NEW-${Date.now()}`,
          itemType: 'Part',
          name: 'New Part on Branch',
        },
        ecoBranchId,
        'Added new part',
        user.id,
      )

      expect(result.item).toBeDefined()
      // Unreleased until the merge assigns a real revision. The marker is
      // branch-scoped rather than a shared literal so the same item number
      // can be drafted on two branches at once.
      expect(RevisionService.isWorkingRevision(result.item.revision)).toBe(true)
      expect(result.commit).toBeDefined()
    })

    it('throws error when creating on protected main branch', async () => {
      // Main branch is only protected when design has released items
      await createReleasedPart({ name: 'Released Part' })

      await expect(
        CheckoutService.createOnBranch(
          {
            designId,
            itemNumber: `PN-NEW-${Date.now()}`,
            itemType: 'Part',
          },
          mainBranchId,
          'Added new part',
          user.id,
        ),
      ).rejects.toThrow(ValidationError)
    })

    it('allows creating on unprotected main branch (pre-release)', async () => {
      // When no released items exist, main branch is editable
      const result = await CheckoutService.createOnBranch(
        {
          designId,
          itemNumber: `PN-NEW-${Date.now()}`,
          itemType: 'Part',
          name: 'New Part on Main',
        },
        mainBranchId,
        'Added new part',
        user.id,
      )

      expect(result.item).toBeDefined()
      expect(RevisionService.isWorkingRevision(result.item.revision)).toBe(true)
    })

    it('throws error when creating on locked branch', async () => {
      await BranchService.lockBranch(ecoBranchId)

      await expect(
        CheckoutService.createOnBranch(
          {
            designId,
            itemNumber: `PN-NEW-${Date.now()}`,
            itemType: 'Part',
          },
          ecoBranchId,
          'Added new part',
          user.id,
        ),
      ).rejects.toThrow(ValidationError)
    })

    it('throws NotFoundError for non-existent branch', async () => {
      await expect(
        CheckoutService.createOnBranch(
          {
            designId,
            itemNumber: `PN-NEW-${Date.now()}`,
            itemType: 'Part',
          },
          '00000000-0000-0000-0000-000000000000',
          'Added new part',
          user.id,
        ),
      ).rejects.toThrow(NotFoundError)
    })

    // The merge releases branch content and refuses to release what the
    // change order does not list, so authoring an item on an ECO branch has
    // to put it in scope there and then - not leave it to be discovered at
    // release, after review.
    it('lists the new item on the change order that owns the branch', async () => {
      const { item } = await CheckoutService.createOnBranch(
        {
          designId,
          itemNumber: `PN-SCOPE-${uniquePrefix}`,
          itemType: 'Part',
          name: 'Authored on the ECO',
        },
        ecoBranchId,
        'Added new part',
        user.id,
      )

      const affected = await ChangeOrderService.getAffectedItems(changeOrderId)
      const listed = affected.find(
        (a) => a.affectedItemMasterId === item.masterId,
      )
      expect(listed).toBeDefined()
      // A first release, and it will carry the scheme's initial revision
      expect(listed?.changeAction).toBe('release')
      expect(listed?.targetRevision).toBe('A')
    })

    // The type-specific row used to be written after the transaction had
    // already committed, so a type handler that refuses its input left the
    // base row, its branch tracking, the commit and the change order's scope
    // row behind with nothing to extend them — and `findById` spreads absent
    // type data, so the wreckage reads back as an ordinary fieldless item
    // rather than an error. A failed create must leave the branch untouched.
    it('leaves no branch content behind when the type handler refuses the item', async () => {
      const affectedBefore =
        await ChangeOrderService.getAffectedItems(changeOrderId)
      const branchRowsBefore = await testDb.db
        .select()
        .from(branchItems)
        .where(eq(branchItems.branchId, ecoBranchId))

      await expect(
        ItemService.createOnBranch(
          'WorkInstruction',
          {
            name: 'Procedure with no output part',
            // Names nothing: the handler's own existence check throws, from
            // inside what is now the creating transaction
            outputPartId: '00000000-0000-0000-0000-000000000000',
          } as any,
          ecoBranchId,
          'Added work instruction',
          user.id,
        ),
      ).rejects.toThrow(ValidationError)

      const strays = await testDb.db
        .select()
        .from(items)
        .where(
          and(
            eq(items.designId, designId),
            eq(items.itemType, 'WorkInstruction'),
          ),
        )
      expect(strays).toHaveLength(0)

      const branchRowsAfter = await testDb.db
        .select()
        .from(branchItems)
        .where(eq(branchItems.branchId, ecoBranchId))
      expect(branchRowsAfter).toHaveLength(branchRowsBefore.length)

      expect(
        await ChangeOrderService.getAffectedItems(changeOrderId),
      ).toHaveLength(affectedBefore.length)
    })
  })

  describe('deleteOnBranch', () => {
    it('marks item as deleted on branch', async () => {
      const part = await createReleasedPart()
      await CheckoutService.checkout(
        { itemMasterId: part.masterId, branchId: ecoBranchId },
        user.id,
      )

      const commit = await CheckoutService.deleteOnBranch(
        part.masterId,
        ecoBranchId,
        'Deleted part',
        user.id,
      )

      expect(commit).toBeDefined()
    })

    it('throws error when deleting on main branch', async () => {
      const part = await createReleasedPart()

      await expect(
        CheckoutService.deleteOnBranch(
          part.masterId,
          mainBranchId,
          'Deleted part',
          user.id,
        ),
      ).rejects.toThrow(ValidationError)
    })

    it('throws error when deleting on locked branch', async () => {
      const part = await createReleasedPart()
      await BranchService.lockBranch(ecoBranchId)

      await expect(
        CheckoutService.deleteOnBranch(
          part.masterId,
          ecoBranchId,
          'Deleted part',
          user.id,
        ),
      ).rejects.toThrow(ValidationError)
    })

    it('throws NotFoundError for non-existent branch', async () => {
      const part = await createReleasedPart()

      await expect(
        CheckoutService.deleteOnBranch(
          part.masterId,
          '00000000-0000-0000-0000-000000000000',
          'Deleted part',
          user.id,
        ),
      ).rejects.toThrow(NotFoundError)
    })

    it('removes branchItem when deleting added item', async () => {
      // Create a new item on branch (marked as 'added')
      const { item } = await CheckoutService.createOnBranch(
        {
          designId,
          itemNumber: `PN-ADD-DEL-${Date.now()}`,
          itemType: 'Part',
          name: 'Add then Delete Part',
        },
        ecoBranchId,
        'Added new part',
        user.id,
      )

      // Delete the added item - should remove branchItem entirely
      const commit = await CheckoutService.deleteOnBranch(
        item.masterId,
        ecoBranchId,
        'Deleted added part',
        user.id,
      )

      expect(commit).toBeDefined()
    })

    // The item existed only on the branch, so nothing is left for the change
    // order to release. A scope row left behind would be applied by the
    // branchless merge path, releasing a draft the user had deleted.
    it('drops the item from the change order when deleting what the branch added', async () => {
      const { item } = await CheckoutService.createOnBranch(
        {
          designId,
          itemNumber: `PN-ADD-SCOPE-${uniquePrefix}`,
          itemType: 'Part',
          name: 'Add then Delete Part',
        },
        ecoBranchId,
        'Added new part',
        user.id,
      )
      expect(
        (await ChangeOrderService.getAffectedItems(changeOrderId)).some(
          (a) => a.affectedItemMasterId === item.masterId,
        ),
      ).toBe(true)

      await CheckoutService.deleteOnBranch(
        item.masterId,
        ecoBranchId,
        'Deleted added part',
        user.id,
      )

      const stillListed = await testDb.db
        .select()
        .from(changeOrderAffectedItems)
        .where(
          and(
            eq(changeOrderAffectedItems.changeOrderId, changeOrderId),
            eq(changeOrderAffectedItems.affectedItemMasterId, item.masterId),
          ),
        )
      expect(stillListed).toHaveLength(0)
    })

    // Retiring the tracking alone orphaned the working copy: the `items` row
    // stayed current and undeleted, owned by no branch, so global search —
    // which reads `items` directly and never consults branch_items — kept
    // answering with a draft every version-resolved view had stopped showing,
    // and nothing could delete it again. The retirement is soft, so the
    // deletion's own history entry survives.
    it('retires the working copy of what the branch added, keeping its history', async () => {
      const { item } = await CheckoutService.createOnBranch(
        {
          designId,
          itemNumber: `PN-ADD-ORPHAN-${uniquePrefix}`,
          itemType: 'Part',
          name: 'Add then Delete Part',
        },
        ecoBranchId,
        'Added new part',
        user.id,
      )

      const commit = await CheckoutService.deleteOnBranch(
        item.masterId,
        ecoBranchId,
        'Deleted added part',
        user.id,
      )

      const stored = takeFirst(
        await testDb.db.select().from(items).where(eq(items.id, item.id)),
      )
      expect(stored.isDeleted).toBe(true)
      expect(stored.isCurrent).toBe(false)
      expect(stored.deletedBy).toBe(user.id)

      const tracking = await testDb.db
        .select()
        .from(branchItems)
        .where(eq(branchItems.currentItemId, item.id))
      expect(tracking).toHaveLength(0)

      // The deletion is still readable in the item's history
      const versions = await testDb.db
        .select()
        .from(itemVersions)
        .where(
          and(
            eq(itemVersions.commitId, commit.id),
            eq(itemVersions.itemId, item.id),
          ),
        )
      expect(versions).toHaveLength(1)
    })

    it('creates branchItem when deleting item not on branch', async () => {
      const part = await createReleasedPart()
      // Don't checkout - go straight to delete

      const commit = await CheckoutService.deleteOnBranch(
        part.masterId,
        ecoBranchId,
        'Deleted part directly',
        user.id,
      )

      expect(commit).toBeDefined()
    })

    // Security gate. The checkout is an exclusive lock and every other writer
    // refuses a non-holder; deleting used to clear the lock instead, handing
    // one engineer's in-progress working copy to whoever deleted next.
    it('refuses a delete by someone other than the checkout holder', async () => {
      const part = await createReleasedPart()
      await CheckoutService.checkout(
        { itemMasterId: part.masterId, branchId: ecoBranchId },
        user.id,
      )

      await expect(
        CheckoutService.deleteOnBranch(
          part.masterId,
          ecoBranchId,
          'Deleted out from under the holder',
          otherUser.id,
        ),
      ).rejects.toBeInstanceOf(ResourceLockedError)

      // The lock survived, and so did the branch row's change type.
      const row = takeFirst(
        await testDb.db
          .select()
          .from(branchItems)
          .where(
            and(
              eq(branchItems.branchId, ecoBranchId),
              eq(branchItems.itemMasterId, part.masterId),
            ),
          ),
      )
      expect(row.checkedOutBy).toBe(user.id)
      expect(row.changeType).not.toBe('deleted')
    })

    it('lets the checkout holder delete what they hold', async () => {
      const part = await createReleasedPart()
      await CheckoutService.checkout(
        { itemMasterId: part.masterId, branchId: ecoBranchId },
        user.id,
      )

      await CheckoutService.deleteOnBranch(
        part.masterId,
        ecoBranchId,
        'Deleted my own checkout',
        user.id,
      )

      const row = takeFirst(
        await testDb.db
          .select()
          .from(branchItems)
          .where(
            and(
              eq(branchItems.branchId, ecoBranchId),
              eq(branchItems.itemMasterId, part.masterId),
            ),
          ),
      )
      expect(row.changeType).toBe('deleted')
      expect(row.checkedOutBy).toBeNull()
    })
  })

  // Note: saveChanges tests removed due to transaction complexity causing timeouts
  // These are covered by E2E tests instead

  describe('multiple item checkouts', () => {
    it('allows checking out multiple items to same branch', async () => {
      const parts = await Promise.all([
        createReleasedPart({ name: 'Multi Part 1' }),
        createReleasedPart({ name: 'Multi Part 2' }),
        createReleasedPart({ name: 'Multi Part 3' }),
      ])

      const checkoutRows = await Promise.all(
        parts.map((p) =>
          CheckoutService.checkout(
            { itemMasterId: p.masterId, branchId: ecoBranchId },
            user.id,
          ),
        ),
      )

      expect(checkoutRows.length).toBe(3)
      checkoutRows.forEach((bi, i) => {
        expect(bi.itemMasterId).toBe(parts[i].masterId)
        expect(bi.branchId).toBe(ecoBranchId)
      })
    })

    it('allows same item to be on multiple ECO branches by different users', async () => {
      // Create a second ECO branch
      const secondCO = await ItemService.create(
        'ChangeOrder',
        {
          revision: 'A',
          name: 'Second ECO',
          changeType: 'ECO',
          priority: 'medium',
          reasonForChange: 'Second Test',
          designId,
        } as any,
        otherUser.id,
      )

      const { branch: secondBranch } = await BranchService.getOrCreateEcoBranch(
        designId,
        secondCO.id,
        otherUser.id,
      )

      const part = await createReleasedPart()

      // Checkout on first branch
      const firstBranchItem = await CheckoutService.checkout(
        { itemMasterId: part.masterId, branchId: ecoBranchId },
        user.id,
      )

      // Checkout same item on second branch
      const secondBranchItem = await CheckoutService.checkout(
        { itemMasterId: part.masterId, branchId: secondBranch.id },
        otherUser.id,
      )

      expect(firstBranchItem.branchId).toBe(ecoBranchId)
      expect(secondBranchItem.branchId).toBe(secondBranch.id)
      expect(firstBranchItem.itemMasterId).toBe(secondBranchItem.itemMasterId)
    })
  })

  describe('checkout and checkin cycles', () => {
    it('allows re-checkout after checkin', async () => {
      const part = await createReleasedPart()

      // First checkout
      await CheckoutService.checkout(
        { itemMasterId: part.masterId, branchId: ecoBranchId },
        user.id,
      )

      // Checkin
      await CheckoutService.checkin(part.masterId, ecoBranchId, user.id)

      // Re-checkout should succeed
      const reCheckout = await CheckoutService.checkout(
        { itemMasterId: part.masterId, branchId: ecoBranchId },
        user.id,
      )

      expect(reCheckout.checkedOutBy).toBe(user.id)
    })

    it('allows different user to checkout after original user checks in', async () => {
      const part = await createReleasedPart()

      // First user checkout
      await CheckoutService.checkout(
        { itemMasterId: part.masterId, branchId: ecoBranchId },
        user.id,
      )

      // First user checkin
      await CheckoutService.checkin(part.masterId, ecoBranchId, user.id)

      // Second user checkout should succeed after checkin
      const newCheckout = await CheckoutService.checkout(
        { itemMasterId: part.masterId, branchId: ecoBranchId },
        otherUser.id,
      )

      expect(newCheckout.checkedOutBy).toBe(otherUser.id)
    })

    it('allows re-checkout after cancel', async () => {
      const part = await createReleasedPart()

      // First checkout
      await CheckoutService.checkout(
        { itemMasterId: part.masterId, branchId: ecoBranchId },
        user.id,
      )

      // Cancel
      await CheckoutService.cancelCheckout(part.masterId, ecoBranchId, user.id)

      // Re-checkout should succeed
      const reCheckout = await CheckoutService.checkout(
        { itemMasterId: part.masterId, branchId: ecoBranchId },
        user.id,
      )

      expect(reCheckout.checkedOutBy).toBe(user.id)
    })
  })

  describe('branch state validation', () => {
    it('allows operations on unlocked branch after unlock', async () => {
      const part = await createReleasedPart()

      // Lock branch
      await BranchService.lockBranch(ecoBranchId)

      // Should fail while locked
      await expect(
        CheckoutService.checkout(
          { itemMasterId: part.masterId, branchId: ecoBranchId },
          user.id,
        ),
      ).rejects.toThrow(ValidationError)

      // Unlock branch
      await BranchService.unlockBranch(ecoBranchId)

      // Should succeed after unlock
      const branchItem = await CheckoutService.checkout(
        { itemMasterId: part.masterId, branchId: ecoBranchId },
        user.id,
      )

      expect(branchItem.checkedOutBy).toBe(user.id)
    })
  })

  // The Edit button is a server-side checkout flag: content mutations on
  // branch working copies are rejected unless the caller HOLDS the checkout,
  // and a foreign lock always blocks. These invariants are what keeps
  // concurrent editing of shared items safe.
  describe('edit-lock enforcement (Edit = server-side checkout)', () => {
    async function createUnlockedWorkingCopy() {
      const part = await createReleasedPart()
      const { workingCopy } =
        await ChangeOrderService.createRevisionWorkingCopy(
          part,
          ecoBranchId,
          user.id,
        )
      return { part, workingCopy }
    }

    it('rejects field updates on a working copy without a held checkout', async () => {
      const { workingCopy } = await createUnlockedWorkingCopy()

      await expect(
        ItemService.update(workingCopy.id, { name: 'Edited' }, user.id),
      ).rejects.toThrow(ItemCheckoutRequiredError)
    })

    it('allows field updates for the checkout holder and blocks other users', async () => {
      const { part, workingCopy } = await createUnlockedWorkingCopy()

      await CheckoutService.checkout(
        { itemMasterId: part.masterId, branchId: ecoBranchId },
        user.id,
      )

      const updated = await ItemService.update(
        workingCopy.id,
        { name: 'Edited by holder' },
        user.id,
      )
      expect(updated.name).toBe('Edited by holder')

      await expect(
        ItemService.update(workingCopy.id, { name: 'Stomped' }, otherUser.id),
      ).rejects.toThrow(ResourceLockedError)
    })

    it('enforces the lock on relationship mutations of the source item', async () => {
      const { part, workingCopy } = await createUnlockedWorkingCopy()
      const child = await createReleasedPart({ name: 'Child Part' })

      // No checkout held → structural edit rejected
      await expect(
        ItemService.addRelationship(workingCopy.id, child.id, 'BOM', user.id),
      ).rejects.toThrow(ItemCheckoutRequiredError)

      // Holder can edit structure
      await CheckoutService.checkout(
        { itemMasterId: part.masterId, branchId: ecoBranchId },
        user.id,
      )
      const relationship = await ItemService.addRelationship(
        workingCopy.id,
        child.id,
        'BOM',
        user.id,
        { quantity: '2' },
      )
      expect(relationship.sourceId).toBe(workingCopy.id)

      // Another user cannot remove it while the lock is held
      await expect(
        ItemService.removeRelationship(relationship.id, otherUser.id),
      ).rejects.toThrow(ResourceLockedError)

      // The holder can
      await ItemService.removeRelationship(relationship.id, user.id)
    })

    it('blocks BOM edits on released items on protected main', async () => {
      const parent = await createReleasedPart({ name: 'Released Parent' })
      const child = await createReleasedPart({ name: 'Released Child' })

      // Design has released items → main is protected → structure immutable
      await expect(
        ItemService.addRelationship(parent.id, child.id, 'BOM', user.id),
      ).rejects.toThrow(BranchProtectionError)
    })

    it('allows checkout on unprotected main and enforces mutual exclusion there', async () => {
      // Fresh design with no released items → main unprotected
      const draft = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-DRAFTLOCK`,
          revision: 'A',
          name: 'Draft Part',
          state: 'Draft',
          designId,
        } as any,
        user.id,
      )

      const branchItem = await CheckoutService.checkout(
        { itemMasterId: draft.masterId, branchId: mainBranchId },
        user.id,
      )
      expect(branchItem.checkedOutBy).toBe(user.id)

      // Lock holder edits fine; another user is excluded
      await ItemService.update(draft.id, { name: 'Locked edit' }, user.id)
      await expect(
        ItemService.update(draft.id, { name: 'Stomped' }, otherUser.id),
      ).rejects.toThrow(ResourceLockedError)

      // Releasing the lock reopens direct editing for others
      await CheckoutService.cancelCheckout(
        draft.masterId,
        mainBranchId,
        user.id,
      )
      const updated = await ItemService.update(
        draft.id,
        { name: 'Free again' },
        otherUser.id,
      )
      expect(updated.name).toBe('Free again')
    })

    it('rejects checkout on protected main', async () => {
      const part = await createReleasedPart()

      await expect(
        CheckoutService.checkout(
          { itemMasterId: part.masterId, branchId: mainBranchId },
          user.id,
        ),
      ).rejects.toThrow(ValidationError)
    })

    it('checkoutItemToEco acquires the edit lock on the working copy', async () => {
      const part = await createReleasedPart()
      const eco = await ItemService.create(
        'ChangeOrder',
        {
          revision: 'A',
          name: 'Lock ECO',
          changeType: 'ECO',
          priority: 'medium',
          reasonForChange: 'Lock test',
          designId,
        } as any,
        user.id,
      )

      const { branchItem } = await ChangeOrderService.checkoutItemToEco(
        eco.id,
        part.id,
        user.id,
      )

      expect(branchItem.checkedOutBy).toBe(user.id)
      expect(branchItem.changeType).toBe('modified')
      expect(branchItem.currentItemId).not.toBe(part.id)
    })

    it('createRevisionWorkingCopy repoints an existing checkout row and keeps the lock', async () => {
      const part = await createReleasedPart()

      // Plain checkout first: row points at the shared released version
      const plain = await CheckoutService.checkout(
        { itemMasterId: part.masterId, branchId: ecoBranchId },
        user.id,
      )
      expect(plain.currentItemId).toBe(part.id)
      expect(plain.changeType).toBeNull()

      const { workingCopy } =
        await ChangeOrderService.createRevisionWorkingCopy(
          part,
          ecoBranchId,
          user.id,
        )

      const [row] = await testDb.db
        .select()
        .from(branchItems)
        .where(
          and(
            eq(branchItems.branchId, ecoBranchId),
            eq(branchItems.itemMasterId, part.masterId),
          ),
        )
        .limit(1)

      expect(row!.currentItemId).toBe(workingCopy.id)
      expect(row!.changeType).toBe('modified')
      expect(row!.checkedOutBy).toBe(user.id) // lock preserved through upsert
    })
  })

  // saveChanges must isolate branch edits from the shared released row and
  // must not collide with the (itemNumber, revision, designId, itemType)
  // unique constraint on repeated saves or across branches.
  describe('saveChanges working-copy isolation', () => {
    it('first save creates a branch-local working copy; the released row is untouched', async () => {
      const part = await createReleasedPart({ name: 'Original Name' })

      await CheckoutService.checkout(
        { itemMasterId: part.masterId, branchId: ecoBranchId },
        user.id,
      )

      const first = await CheckoutService.saveChanges(
        {
          branchId: ecoBranchId,
          itemId: part.id,
          changes: { name: 'Branch Edit' },
          commitMessage: 'First edit',
        },
        user.id,
      )

      expect(first.item.id).not.toBe(part.id)
      expect(first.item.name).toBe('Branch Edit')
      expect(first.item.revision).toBe(`-${ecoBranchId.substring(0, 8)}`)
      expect(first.item.isCurrent).toBe(false)
      expect(first.item.state).toBe('Draft') // Released base resets to initial state

      const [releasedRow] = await testDb.db
        .select()
        .from(items)
        .where(eq(items.id, part.id))
        .limit(1)
      expect(releasedRow!.name).toBe('Original Name')
      expect(releasedRow!.state).toBe('Released')
    })

    it('first save carries the base version relationships onto the working copy', async () => {
      // A field edit mints the working copy, and the copy's edges are what
      // the merge releases as the item's structure — so a copy created by
      // editing a description must not release an assembly with an empty BOM.
      const parent = await createReleasedPart({ name: 'Assembly' })
      const child = await createReleasedPart({ name: 'Child' })
      await testDb.db.insert(itemRelationships).values({
        sourceId: parent.id,
        targetId: child.id,
        relationshipType: 'BOM',
        quantity: '2.5',
        findNumber: 10,
        createdBy: user.id,
      })

      await CheckoutService.checkout(
        { itemMasterId: parent.masterId, branchId: ecoBranchId },
        user.id,
      )
      const saved = await CheckoutService.saveChanges(
        {
          branchId: ecoBranchId,
          itemId: parent.id,
          changes: { name: 'Renamed Assembly' },
          commitMessage: 'Field-only edit',
        },
        user.id,
      )

      const carried = await testDb.db
        .select()
        .from(itemRelationships)
        .where(eq(itemRelationships.sourceId, saved.item.id))
      expect(carried).toHaveLength(1)
      expect(carried[0]!.targetId).toBe(child.id)
      expect(parseFloat(carried[0]!.quantity ?? '')).toBe(2.5)
      expect(carried[0]!.findNumber).toBe(10)
    })

    it('subsequent saves update the working copy in place (no revision collision)', async () => {
      const part = await createReleasedPart()

      await CheckoutService.checkout(
        { itemMasterId: part.masterId, branchId: ecoBranchId },
        user.id,
      )

      const first = await CheckoutService.saveChanges(
        {
          branchId: ecoBranchId,
          itemId: part.id,
          changes: { name: 'Edit 1' },
          commitMessage: 'Edit 1',
        },
        user.id,
      )

      const second = await CheckoutService.saveChanges(
        {
          branchId: ecoBranchId,
          itemId: first.item.id,
          changes: { name: 'Edit 2' },
          commitMessage: 'Edit 2',
        },
        user.id,
      )

      expect(second.item.id).toBe(first.item.id)
      expect(second.item.name).toBe('Edit 2')
    })

    it('saves addressed to the shared base row land on the existing working copy', async () => {
      const part = await createReleasedPart({ name: 'Base Name' })

      // Revise-checkout shape: the checkout routes mint the working copy up
      // front, and the detail page still addresses the save by the row in
      // its URL — the released base.
      await ChangeOrderService.createRevisionWorkingCopy(
        part,
        ecoBranchId,
        user.id,
      )
      await CheckoutService.checkout(
        { itemMasterId: part.masterId, branchId: ecoBranchId },
        user.id,
      )

      const saved = await CheckoutService.saveChanges(
        {
          branchId: ecoBranchId,
          itemId: part.id,
          changes: { name: 'Branch Edit' },
          commitMessage: 'Edit addressed by the base id',
        },
        user.id,
      )

      const [row] = await testDb.db
        .select()
        .from(branchItems)
        .where(
          and(
            eq(branchItems.branchId, ecoBranchId),
            eq(branchItems.itemMasterId, part.masterId),
          ),
        )
        .limit(1)
      expect(saved.item.id).toBe(row!.currentItemId)
      expect(saved.item.id).not.toBe(part.id)
      expect(saved.item.name).toBe('Branch Edit')

      // The shared released row is untouched
      const [releasedRow] = await testDb.db
        .select()
        .from(items)
        .where(eq(items.id, part.id))
        .limit(1)
      expect(releasedRow!.name).toBe('Base Name')
      expect(releasedRow!.state).toBe('Released')
    })

    it('field updates on a checked-out shared row route through the working copy', async () => {
      const part = await createReleasedPart({ name: 'Shared Base' })

      await CheckoutService.checkout(
        { itemMasterId: part.masterId, branchId: ecoBranchId },
        user.id,
      )

      // Legacy path: PUT /parts/:id style update against the released row id.
      // The update must land on a new working copy, never the released row.
      const updated = await ItemService.update(
        part.id,
        { name: 'Rerouted Edit' },
        user.id,
      )

      expect(updated.id).not.toBe(part.id)
      expect(updated.name).toBe('Rerouted Edit')

      const [releasedRow] = await testDb.db
        .select()
        .from(items)
        .where(eq(items.id, part.id))
        .limit(1)
      expect(releasedRow!.name).toBe('Shared Base')

      const [row] = await testDb.db
        .select()
        .from(branchItems)
        .where(
          and(
            eq(branchItems.branchId, ecoBranchId),
            eq(branchItems.itemMasterId, part.masterId),
          ),
        )
        .limit(1)
      expect(row!.currentItemId).toBe(updated.id)
      expect(row!.changeType).toBe('modified')
    })
  })

  // Work-instruction content lives in sub-tables keyed by the item version
  // id — a revision working copy must carry all of it or the ECO revise flow
  // silently loses the instruction content.
  describe('work instruction revision copies', () => {
    it('copies extension row, operations, steps, and part attachments', async () => {
      const outputPart = await createReleasedPart({ name: 'Output Part' })
      const wi = await ItemService.create(
        'WorkInstruction',
        {
          itemNumber: `WI-${uniquePrefix}-COPY`,
          revision: 'A',
          name: 'Released WI',
          state: 'Released',
          designId,
          description: 'Assembly instructions',
          estimatedTime: 45,
          outputPartId: outputPart.id,
        } as any,
        user.id,
        { bypassBranchProtection: true },
      )
      await testDb.db.insert(itemVersions).values({
        commitId: initialCommitId,
        itemId: wi.id,
        changeType: 'added',
      })

      const op = takeFirst(
        await testDb.db
          .insert(workInstructionOperations)
          .values({
            workInstructionId: wi.id,
            orderIndex: 0,
            title: 'Assembly',
          })
          .returning(),
      )
      await testDb.db.insert(workInstructionSteps).values([
        {
          workInstructionId: wi.id,
          operationId: op.id,
          orderIndex: 0,
          title: 'Step in operation',
          content: { blocks: [] },
        },
        {
          workInstructionId: wi.id,
          operationId: null,
          orderIndex: 1,
          title: 'Ungrouped step',
          content: { blocks: [] },
        },
      ])
      const attachedPart = await createReleasedPart({ name: 'Attached Part' })
      await testDb.db.insert(workInstructionPartAttachments).values({
        workInstructionId: wi.id,
        partId: attachedPart.id,
        inheritToMBOM: true,
        createdBy: user.id,
      })

      const { workingCopy } =
        await ChangeOrderService.createRevisionWorkingCopy(
          wi,
          ecoBranchId,
          user.id,
        )

      const [wcExt] = await testDb.db
        .select()
        .from(workInstructions)
        .where(eq(workInstructions.itemId, workingCopy.id))
        .limit(1)
      expect(wcExt!.description).toBe('Assembly instructions')
      expect(wcExt!.estimatedTime).toBe(45)

      const wcOps = await testDb.db
        .select()
        .from(workInstructionOperations)
        .where(eq(workInstructionOperations.workInstructionId, workingCopy.id))
      expect(wcOps.length).toBe(1)
      expect(wcOps[0]!.title).toBe('Assembly')
      expect(wcOps[0]!.id).not.toBe(op.id) // new id, not shared

      const wcSteps = await testDb.db
        .select()
        .from(workInstructionSteps)
        .where(eq(workInstructionSteps.workInstructionId, workingCopy.id))
      expect(wcSteps.length).toBe(2)
      const grouped = wcSteps.find((s) => s.title === 'Step in operation')
      const ungrouped = wcSteps.find((s) => s.title === 'Ungrouped step')
      expect(grouped!.operationId).toBe(wcOps[0]!.id) // remapped to the copy
      expect(ungrouped!.operationId).toBeNull()

      const wcAttachments = await testDb.db
        .select()
        .from(workInstructionPartAttachments)
        .where(
          eq(workInstructionPartAttachments.workInstructionId, workingCopy.id),
        )
      expect(wcAttachments.length).toBe(2)

      // The output part has to survive the revision: it is what the new
      // version's designId is derived from, so losing the flag would leave the
      // working copy in a design with nothing anchoring it there.
      const wcOutput = wcAttachments.find((a) => a.isOutput)
      expect(wcOutput!.partId).toBe(outputPart.id)

      const wcExtra = wcAttachments.find((a) => !a.isOutput)
      expect(wcExtra!.partId).toBe(attachedPart.id)
      expect(wcExtra!.inheritToMBOM).toBe(true)
    })
  })
  // The edit-lock policy must work on lifecycles whose states are named
  // nothing the code has ever heard of — membership in the released family
  // derives from the change-action mappings, never from names. Documents get
  // a fully renamed lifecycle here (this file's other tests only use Parts);
  // everything runs inside the gate transaction and the config is restored
  // before rollback so the per-process registry cache never diverges from
  // the database.
  describe('edit-lock with a fully renamed lifecycle', () => {
    const RENAMED_LIFECYCLE_ID = '00000000-0000-4000-8000-000000000517'

    const RENAMED_DEFINITION = {
      states: [
        { id: 'Intake', name: 'Intake', isInitial: true, isFinal: false },
        { id: 'Frozen', name: 'Frozen', isInitial: false, isFinal: false },
        { id: 'Retired', name: 'Retired', isInitial: false, isFinal: true },
        { id: 'Withdrawn', name: 'Withdrawn', isInitial: false, isFinal: true },
      ],
      transitions: [],
      changeActionMappings: {
        release: {
          fromState: 'Intake',
          toState: 'Frozen',
          assignsRevision: true,
        },
        revise: {
          fromState: 'Frozen',
          newVersionState: 'Frozen',
          oldVersionState: 'Retired',
          assignsRevision: true,
        },
        obsolete: {
          fromState: 'Frozen',
          toState: 'Withdrawn',
          assignsRevision: false,
        },
      },
      lifecycleType: 'Driven',
      applicableItemTypes: ['Document'],
    }

    // test-config-hygiene: this override runs inside the per-test gate
    // transaction (beforeEach), and afterEach re-links Document to
    // LIFECYCLE_IDS.document before the rollback — so nothing outlives the
    // test and there is no permanent row for overrideItemTypeConfig to undo.
    async function linkDocumentLifecycle(definitionId: string) {
      const config = { lifecycleDefinitionId: definitionId }
      await testDb.db
        .insert(itemTypeConfigs)
        .values({ itemType: 'Document', config, modifiedBy: SYSTEM_USER_ID })
        .onConflictDoUpdate({
          target: itemTypeConfigs.itemType,
          set: { config, modifiedBy: SYSTEM_USER_ID },
        })
      await ItemTypeRegistry.reload()
    }

    beforeEach(async () => {
      await testDb.db
        .insert(workflowDefinitions)
        .values({
          id: RENAMED_LIFECYCLE_ID,
          name: 'Document - Renamed Lifecycle',
          version: 1,
          workflowType: 'strict',
          definition: RENAMED_DEFINITION,
          isActive: true,
          lifecycleType: 'Driven',
          drivers: [],
        })
        .onConflictDoNothing()
      await linkDocumentLifecycle(RENAMED_LIFECYCLE_ID)
    })

    afterEach(async () => {
      // Point Document back at its default before the outer rollback removes
      // the renamed rows, so the registry's per-process cache stays truthful
      await linkDocumentLifecycle(LIFECYCLE_IDS.document)
    })

    it('creation starts at the renamed initial state', async () => {
      const doc = await ItemService.create(
        'Document',
        {
          itemNumber: `DOC-${uniquePrefix}-RN1`,
          revision: '-',
          name: 'Renamed Lifecycle Doc',
          designId,
        } as any,
        user.id,
        { bypassBranchProtection: true },
      )
      expect(doc.state).toBe('Intake')
    })

    it('blocks structural edits on a shared base in a renamed released state', async () => {
      // A released document under the renamed lifecycle: state 'Frozen' is in
      // the released family purely via the release mapping
      const doc = await ItemService.create(
        'Document',
        {
          itemNumber: `DOC-${uniquePrefix}-RN2`,
          revision: 'A',
          name: 'Frozen Doc',
          state: 'Frozen',
          designId,
        } as any,
        user.id,
        { bypassBranchProtection: true },
      )
      const other = await ItemService.create(
        'Document',
        {
          itemNumber: `DOC-${uniquePrefix}-RN3`,
          revision: 'A',
          name: 'Other Doc',
          state: 'Frozen',
          designId,
        } as any,
        user.id,
        { bypassBranchProtection: true },
      )
      await testDb.db.insert(itemVersions).values({
        commitId: initialCommitId,
        itemId: doc.id,
        changeType: 'added',
      })

      // Checkout onto the ECO branch: the branch row still points at the
      // shared Frozen version (changeType null) until a working copy exists
      await CheckoutService.checkout(
        { itemMasterId: doc.masterId, branchId: ecoBranchId },
        user.id,
      )

      // Structural edits cannot reroute through saveChanges, so they must be
      // rejected — under the literal-list check this slipped through, because
      // 'Frozen' is not named 'Released'
      await expect(
        ItemService.addRelationship(doc.id, other.id, 'Reference', user.id),
      ).rejects.toThrow(ValidationError)
    })
  })
})

describe('computeInitialFieldValues', () => {
  it('returns field changes for non-empty values', () => {
    const item = {
      name: 'Test Part',
      state: 'Draft',
      revision: 'A',
      description: 'A test description',
    }

    const changes = computeInitialFieldValues(item, 'Part')

    expect(changes.length).toBeGreaterThan(0)
    expect(changes.find((c) => c.fieldName === 'name')).toBeDefined()
    expect(changes.every((c) => c.oldValue === null)).toBe(true)
  })

  it('skips null and empty values', () => {
    const item = {
      name: 'Test Part',
      state: 'Draft',
      description: null,
      material: '',
    }

    const changes = computeInitialFieldValues(item, 'Part')

    expect(changes.find((c) => c.fieldName === 'description')).toBeUndefined()
    expect(changes.find((c) => c.fieldName === 'material')).toBeUndefined()
  })

  it('skips ignored metadata fields', () => {
    const item = {
      id: 'some-id',
      masterId: 'master-id',
      createdAt: new Date(),
      createdBy: 'user-id',
      name: 'Test Part',
    }

    const changes = computeInitialFieldValues(item, 'Part')

    expect(changes.find((c) => c.fieldName === 'id')).toBeUndefined()
    expect(changes.find((c) => c.fieldName === 'masterId')).toBeUndefined()
    expect(changes.find((c) => c.fieldName === 'createdAt')).toBeUndefined()
    expect(changes.find((c) => c.fieldName === 'createdBy')).toBeUndefined()
    expect(changes.find((c) => c.fieldName === 'name')).toBeDefined()
  })

  it('categorizes core fields correctly', () => {
    const item = {
      name: 'Test Part',
      state: 'Draft',
      revision: 'A',
      itemNumber: 'PN-001',
    }

    const changes = computeInitialFieldValues(item, 'Part')

    const nameChange = changes.find((c) => c.fieldName === 'name')
    expect(nameChange?.fieldCategory).toBe('core')
  })

  it('categorizes type-specific fields correctly', () => {
    const item = {
      name: 'Test Part',
      material: 'Aluminum',
      partType: 'Manufacture',
    }

    const changes = computeInitialFieldValues(item, 'Part')

    const materialChange = changes.find((c) => c.fieldName === 'material')
    expect(materialChange?.fieldCategory).toBe('type')
  })

  it('handles nested attributes', () => {
    const item = {
      name: 'Test Part',
      attributes: {
        customField: 'custom value',
        anotherField: 123,
      },
    }

    const changes = computeInitialFieldValues(item, 'Part')

    const customChange = changes.find((c) => c.fieldName === 'customField')
    expect(customChange).toBeDefined()
    expect(customChange?.fieldPath).toBe('attributes.customField')
    expect(customChange?.fieldCategory).toBe('attribute')
  })
})

describe('computeFieldChanges', () => {
  it('returns empty array when no old item', () => {
    const newItem = { name: 'Test', state: 'Draft' }

    const changes = computeFieldChanges(null, newItem, 'Part')

    expect(changes).toEqual([])
  })

  it('detects changed fields', () => {
    const oldItem = {
      name: 'Old Name',
      state: 'Draft',
      description: 'Old desc',
    }
    const newItem = {
      name: 'New Name',
      state: 'Draft',
      description: 'New desc',
    }

    const changes = computeFieldChanges(oldItem, newItem, 'Part')

    expect(changes.length).toBe(2)
    const nameChange = changes.find((c) => c.fieldName === 'name')
    expect(nameChange?.oldValue).toBe('Old Name')
    expect(nameChange?.newValue).toBe('New Name')
  })

  it('ignores unchanged fields', () => {
    const oldItem = { name: 'Same Name', state: 'Draft' }
    const newItem = { name: 'Same Name', state: 'Draft' }

    const changes = computeFieldChanges(oldItem, newItem, 'Part')

    expect(changes.length).toBe(0)
  })

  it('skips ignored metadata fields', () => {
    const oldItem = {
      id: 'old-id',
      modifiedAt: new Date(2023, 1, 1),
      name: 'Test',
    }
    const newItem = {
      id: 'new-id',
      modifiedAt: new Date(2024, 1, 1),
      name: 'Test',
    }

    const changes = computeFieldChanges(oldItem, newItem, 'Part')

    expect(changes.find((c) => c.fieldName === 'id')).toBeUndefined()
    expect(changes.find((c) => c.fieldName === 'modifiedAt')).toBeUndefined()
  })

  it('handles nested attribute changes', () => {
    const oldItem = {
      name: 'Test',
      attributes: { color: 'red', size: 'large' },
    }
    const newItem = {
      name: 'Test',
      attributes: { color: 'blue', size: 'large' },
    }

    const changes = computeFieldChanges(oldItem, newItem, 'Part')

    const colorChange = changes.find((c) => c.fieldName === 'color')
    expect(colorChange).toBeDefined()
    expect(colorChange?.oldValue).toBe('red')
    expect(colorChange?.newValue).toBe('blue')
    expect(colorChange?.fieldPath).toBe('attributes.color')
  })

  it('detects added fields', () => {
    const oldItem = { name: 'Test' }
    const newItem = { name: 'Test', description: 'New description' }

    const changes = computeFieldChanges(oldItem, newItem, 'Part')

    const descChange = changes.find((c) => c.fieldName === 'description')
    expect(descChange).toBeDefined()
    expect(descChange?.oldValue).toBeUndefined()
    expect(descChange?.newValue).toBe('New description')
  })

  it('detects removed fields', () => {
    const oldItem = { name: 'Test', description: 'Old description' }
    const newItem = { name: 'Test' }

    const changes = computeFieldChanges(oldItem, newItem, 'Part')

    const descChange = changes.find((c) => c.fieldName === 'description')
    expect(descChange).toBeDefined()
    expect(descChange?.oldValue).toBe('Old description')
    expect(descChange?.newValue).toBeUndefined()
  })
})
