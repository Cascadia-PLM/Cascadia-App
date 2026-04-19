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
} from 'vitest'
import { ItemService } from '../items/services/ItemService'
import {
  CheckoutService,
  computeFieldChanges,
  computeInitialFieldValues,
} from './CheckoutService'
import { BranchService } from './BranchService'
import { DesignService } from './DesignService'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { NotFoundError, ValidationError } from '@/lib/errors'
import { itemVersions, programs } from '@/lib/db/schema'

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
    const [program] = await testDb.db
      .insert(programs)
      .values({
        name: 'Test Program',
        code: `PROG-${uniquePrefix}`,
        createdBy: user.id,
      })
      .returning()

    programId = program.id

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
      ).rejects.toThrow(ValidationError)
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
      expect(result.item.revision).toBe('DRAFT')
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
      expect(result.item.revision).toBe('DRAFT')
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

      const branchItems = await Promise.all(
        parts.map((p) =>
          CheckoutService.checkout(
            { itemMasterId: p.masterId, branchId: ecoBranchId },
            user.id,
          ),
        ),
      )

      expect(branchItems.length).toBe(3)
      branchItems.forEach((bi, i) => {
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
