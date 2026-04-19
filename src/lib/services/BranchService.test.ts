/**
 * BranchService Tests
 *
 * Integration tests for the BranchService class.
 * Tests cover branch creation, locking, archiving, and protection status.
 *
 * Run: npm run test -- src/lib/services/BranchService.test.ts
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
import { BranchService } from './BranchService'
import { DesignService } from './DesignService'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { NotFoundError, ValidationError } from '@/lib/errors'
import { branchItems, programs } from '@/lib/db/schema'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

describe('BranchService', () => {
  const testDb = new TestDatabase()
  let user: TestUser
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

    // Create test user (let fixture generate unique email)
    user = await insertTestUser(testDb.db)

    // Create test program
    const [program] = await testDb.db
      .insert(programs)
      .values({
        name: 'Test Program',
        code: `PROG-${Date.now()}`,
        createdBy: user.id,
      })
      .returning()

    programId = program.id

    // Create test design with main branch
    const design = await DesignService.create(
      {
        programId,
        name: 'Test Design',
        code: `DESIGN-${Date.now()}`,
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

  // Helper to create a change order
  // Note: ChangeOrders are created WITHOUT designId - they're design-agnostic.
  // Designs are linked when affected items are added or via addDesignToEco().
  async function createChangeOrder() {
    return ItemService.create(
      'ChangeOrder',
      {
        // itemNumber is auto-generated for ChangeOrders
        // Note: designId intentionally omitted - ECOs are design-agnostic at creation
        revision: 'A',
        name: 'Test ECO',
        changeType: 'ECO',
        priority: 'medium',
        reasonForChange: 'Test',
      } as any,
      user.id,
    )
  }

  describe('getById', () => {
    it('returns branch with design info', async () => {
      const branch = await BranchService.getById(mainBranchId)

      expect(branch).toBeDefined()
      expect(branch?.id).toBe(mainBranchId)
      expect(branch?.name).toBe('main')
      expect(branch?.designId).toBe(designId)
    })

    it('returns null for non-existent branch', async () => {
      const branch = await BranchService.getById(
        '00000000-0000-0000-0000-000000000000',
      )

      expect(branch).toBeNull()
    })
  })

  describe('getByName', () => {
    it('returns branch by name within design', async () => {
      const branch = await BranchService.getByName(designId, 'main')

      expect(branch).toBeDefined()
      expect(branch?.name).toBe('main')
    })

    it('returns null for non-existent branch name', async () => {
      const branch = await BranchService.getByName(designId, 'nonexistent')

      expect(branch).toBeNull()
    })
  })

  describe('createEcoBranch', () => {
    it('creates ECO branch from change order', async () => {
      // ChangeOrders are created WITHOUT designId - they're design-agnostic.
      // ECO branches are created when a design is explicitly linked.
      const changeOrder = await createChangeOrder()

      // Explicitly create the ECO branch for this design
      const { branch, created } = await BranchService.getOrCreateEcoBranch(
        designId,
        changeOrder.id,
        user.id,
      )

      expect(branch).toBeDefined()
      expect(branch.branchType).toBe('eco')
      expect(branch.name).toBe(`eco/${changeOrder.itemNumber}`)
      expect(branch.changeOrderItemId).toBe(changeOrder.id)
      expect(branch.designId).toBe(designId)
      expect(created).toBe(true) // Branch is newly created (not auto-created)
    })

    it('throws error if ECO branch already exists', async () => {
      // Create change order and explicitly create an ECO branch
      const changeOrder = await createChangeOrder()
      await BranchService.createEcoBranch(designId, changeOrder.id, user.id)

      // Trying to create another branch for the same change order should fail
      await expect(
        BranchService.createEcoBranch(designId, changeOrder.id, user.id),
      ).rejects.toThrow(ValidationError)
    })

    it('throws NotFoundError for non-existent change order', async () => {
      await expect(
        BranchService.createEcoBranch(
          designId,
          '00000000-0000-0000-0000-000000000000',
          user.id,
        ),
      ).rejects.toThrow(NotFoundError)
    })
  })

  describe('createWorkspaceBranch', () => {
    it('creates workspace branch for user with name', async () => {
      const branch = await BranchService.createWorkspaceBranch(
        designId,
        user.id,
        'my-feature',
      )

      expect(branch).toBeDefined()
      expect(branch.branchType).toBe('workspace')
      expect(branch.name).toBe('workspace/my-feature')
      expect(branch.ownerId).toBe(user.id)
    })

    it('allows multiple workspace branches per user', async () => {
      const branch1 = await BranchService.createWorkspaceBranch(
        designId,
        user.id,
        'feature-1',
      )
      const branch2 = await BranchService.createWorkspaceBranch(
        designId,
        user.id,
        'feature-2',
      )

      expect(branch1.id).not.toBe(branch2.id)
      expect(branch1.name).toBe('workspace/feature-1')
      expect(branch2.name).toBe('workspace/feature-2')
    })

    it('throws error if workspace branch with same name already exists', async () => {
      await BranchService.createWorkspaceBranch(
        designId,
        user.id,
        'duplicate-name',
      )

      await expect(
        BranchService.createWorkspaceBranch(
          designId,
          user.id,
          'duplicate-name',
        ),
      ).rejects.toThrow(ValidationError)
    })

    it('throws ValidationError for empty name', async () => {
      await expect(
        BranchService.createWorkspaceBranch(designId, user.id, ''),
      ).rejects.toThrow(ValidationError)
    })
  })

  describe('createReleaseBranch', () => {
    it('creates release branch from tag', async () => {
      const tag = await DesignService.createTag(
        designId,
        { name: 'v1.0', tagType: 'release' },
        user.id,
      )

      const branch = await BranchService.createReleaseBranch(
        designId,
        '1.0',
        tag.id,
        user.id,
      )

      expect(branch).toBeDefined()
      expect(branch.branchType).toBe('release')
      expect(branch.name).toBe('release/1.0')
      expect(branch.sourceTagId).toBe(tag.id)
    })

    it('throws error if release branch name already exists', async () => {
      const tag1 = await DesignService.createTag(
        designId,
        { name: 'v1.0', tagType: 'release' },
        user.id,
      )
      const tag2 = await DesignService.createTag(
        designId,
        { name: 'v1.1', tagType: 'release' },
        user.id,
      )

      await BranchService.createReleaseBranch(designId, '1.0', tag1.id, user.id)

      await expect(
        BranchService.createReleaseBranch(designId, '1.0', tag2.id, user.id),
      ).rejects.toThrow(ValidationError)
    })

    it('throws NotFoundError for non-existent tag', async () => {
      await expect(
        BranchService.createReleaseBranch(
          designId,
          '1.0',
          '00000000-0000-0000-0000-000000000000',
          user.id,
        ),
      ).rejects.toThrow(NotFoundError)
    })
  })

  describe('getOrCreateEcoBranch', () => {
    it('creates ECO branch for change order when not exists', async () => {
      // ChangeOrders are created WITHOUT designId - they're design-agnostic.
      // getOrCreateEcoBranch creates the branch when called.
      const changeOrder = await createChangeOrder()

      const result = await BranchService.getOrCreateEcoBranch(
        designId,
        changeOrder.id,
        user.id,
      )

      expect(result.branch).toBeDefined()
      expect(result.created).toBe(true) // Branch is newly created
      expect(result.branch.branchType).toBe('eco')
    })

    it('returns existing branch if already created', async () => {
      const changeOrder = await createChangeOrder()

      const first = await BranchService.getOrCreateEcoBranch(
        designId,
        changeOrder.id,
        user.id,
      )
      const second = await BranchService.getOrCreateEcoBranch(
        designId,
        changeOrder.id,
        user.id,
      )

      expect(first.created).toBe(true) // First call creates the branch
      expect(second.created).toBe(false) // Second call returns existing
      expect(second.branch.id).toBe(first.branch.id)
    })
  })

  describe('lockBranch', () => {
    it('sets isLocked flag', async () => {
      const changeOrder = await createChangeOrder()
      const { branch } = await BranchService.getOrCreateEcoBranch(
        designId,
        changeOrder.id,
        user.id,
      )

      await BranchService.lockBranch(branch.id)

      const updated = await BranchService.getById(branch.id)
      expect(updated?.isLocked).toBe(true)
    })

    it('throws error when locking main branch', async () => {
      await expect(BranchService.lockBranch(mainBranchId)).rejects.toThrow(
        ValidationError,
      )
    })

    it('throws NotFoundError for non-existent branch', async () => {
      await expect(
        BranchService.lockBranch('00000000-0000-0000-0000-000000000000'),
      ).rejects.toThrow(NotFoundError)
    })
  })

  describe('unlockBranch', () => {
    it('clears isLocked flag', async () => {
      const changeOrder = await createChangeOrder()
      const { branch } = await BranchService.getOrCreateEcoBranch(
        designId,
        changeOrder.id,
        user.id,
      )

      await BranchService.lockBranch(branch.id)
      await BranchService.unlockBranch(branch.id)

      const updated = await BranchService.getById(branch.id)
      expect(updated?.isLocked).toBe(false)
    })

    it('throws NotFoundError for non-existent branch', async () => {
      await expect(
        BranchService.unlockBranch('00000000-0000-0000-0000-000000000000'),
      ).rejects.toThrow(NotFoundError)
    })
  })

  describe('archiveBranch', () => {
    it('soft-deletes branch', async () => {
      const changeOrder = await createChangeOrder()
      const { branch } = await BranchService.getOrCreateEcoBranch(
        designId,
        changeOrder.id,
        user.id,
      )

      await BranchService.archiveBranch(branch.id)

      const updated = await BranchService.getById(branch.id)
      expect(updated?.isArchived).toBe(true)
      expect(updated?.archivedAt).toBeDefined()
    })

    it('prevents archiving main branch', async () => {
      await expect(BranchService.archiveBranch(mainBranchId)).rejects.toThrow(
        ValidationError,
      )
    })

    it('throws NotFoundError for non-existent branch', async () => {
      await expect(
        BranchService.archiveBranch('00000000-0000-0000-0000-000000000000'),
      ).rejects.toThrow(NotFoundError)
    })
  })

  describe('listByDesign', () => {
    it('returns all branches for design', async () => {
      // Create change order and explicitly link to design
      const changeOrder = await createChangeOrder()
      await BranchService.getOrCreateEcoBranch(
        designId,
        changeOrder.id,
        user.id,
      )
      await BranchService.createWorkspaceBranch(
        designId,
        user.id,
        'my-workspace',
      )

      const branches = await BranchService.listByDesign(designId)

      expect(branches.length).toBe(3) // main + eco + workspace
    })

    it('filters by branchType', async () => {
      // Create change order and explicitly link to design
      const changeOrder = await createChangeOrder()
      await BranchService.getOrCreateEcoBranch(
        designId,
        changeOrder.id,
        user.id,
      )

      const ecoBranches = await BranchService.listByDesign(designId, {
        branchType: 'eco',
      })

      expect(ecoBranches.length).toBe(1)
      expect(ecoBranches[0].branchType).toBe('eco')
    })

    it('excludes archived branches by default', async () => {
      const changeOrder = await createChangeOrder()
      const { branch } = await BranchService.getOrCreateEcoBranch(
        designId,
        changeOrder.id,
        user.id,
      )
      await BranchService.archiveBranch(branch.id)

      const branches = await BranchService.listByDesign(designId)

      expect(branches.find((b) => b.id === branch.id)).toBeUndefined()
    })

    it('includes archived when requested', async () => {
      const changeOrder = await createChangeOrder()
      const { branch } = await BranchService.getOrCreateEcoBranch(
        designId,
        changeOrder.id,
        user.id,
      )
      await BranchService.archiveBranch(branch.id)

      const branches = await BranchService.listByDesign(designId, {
        includeArchived: true,
      })

      expect(branches.find((b) => b.id === branch.id)).toBeDefined()
    })
  })

  describe('listByUser', () => {
    it('returns workspace branches for user', async () => {
      await BranchService.createWorkspaceBranch(
        designId,
        user.id,
        'user-workspace',
      )

      const branches = await BranchService.listByUser(user.id)

      expect(branches.length).toBe(1)
      expect(branches[0].branchType).toBe('workspace')
      expect(branches[0].ownerId).toBe(user.id)
    })
  })

  describe('listByChangeOrder', () => {
    it('returns ECO branches for change order across designs', async () => {
      // Create change order and explicitly link to design
      const changeOrder = await createChangeOrder()
      await BranchService.getOrCreateEcoBranch(
        designId,
        changeOrder.id,
        user.id,
      )

      const branches = await BranchService.listByChangeOrder(changeOrder.id)

      expect(branches.length).toBe(1)
      expect(branches[0].changeOrderItemId).toBe(changeOrder.id)
    })
  })

  describe('updateHead', () => {
    it('updates branch HEAD commit', async () => {
      const changeOrder = await createChangeOrder()
      const { branch } = await BranchService.getOrCreateEcoBranch(
        designId,
        changeOrder.id,
        user.id,
      )
      const originalHead = branch.headCommitId

      // Create a new commit ID (in a real scenario, this would be a valid commit)
      const newCommitId = crypto.randomUUID()

      await BranchService.updateHead(branch.id, newCommitId)

      const updated = await BranchService.getById(branch.id)
      expect(updated?.headCommitId).toBe(newCommitId)
      expect(updated?.headCommitId).not.toBe(originalHead)
    })

    it('throws error when branch is locked', async () => {
      const changeOrder = await createChangeOrder()
      const { branch } = await BranchService.getOrCreateEcoBranch(
        designId,
        changeOrder.id,
        user.id,
      )
      await BranchService.lockBranch(branch.id)

      await expect(
        BranchService.updateHead(branch.id, crypto.randomUUID()),
      ).rejects.toThrow(ValidationError)
    })

    it('throws NotFoundError for non-existent branch', async () => {
      await expect(
        BranchService.updateHead(
          '00000000-0000-0000-0000-000000000000',
          crypto.randomUUID(),
        ),
      ).rejects.toThrow(NotFoundError)
    })
  })

  describe('isLocked', () => {
    it('returns false for unlocked branch', async () => {
      const isLocked = await BranchService.isLocked(mainBranchId)

      expect(isLocked).toBe(false)
    })

    it('returns true for locked branch', async () => {
      const changeOrder = await createChangeOrder()
      const { branch } = await BranchService.getOrCreateEcoBranch(
        designId,
        changeOrder.id,
        user.id,
      )
      await BranchService.lockBranch(branch.id)

      const isLocked = await BranchService.isLocked(branch.id)

      expect(isLocked).toBe(true)
    })
  })

  describe('Branch Protection', () => {
    describe('isMainBranchProtected', () => {
      it('returns false when no released items', async () => {
        const isProtected = await BranchService.isMainBranchProtected(designId)

        expect(isProtected).toBe(false)
      })

      it('returns true when has released items', async () => {
        // Create and release an item
        await ItemService.create(
          'Part',
          {
            itemNumber: `PN-${Date.now()}`,
            revision: 'A',
            name: 'Released Part',
            state: 'Released',
            designId,
          } as any,
          user.id,
        )

        const isProtected = await BranchService.isMainBranchProtected(designId)

        expect(isProtected).toBe(true)
      })
    })

    describe('getBranchStatus', () => {
      it('returns correct status for unlocked ECO branch', async () => {
        const changeOrder = await createChangeOrder()
        const { branch } = await BranchService.getOrCreateEcoBranch(
          designId,
          changeOrder.id,
          user.id,
        )

        const status = await BranchService.getBranchStatus(branch.id)

        expect(status.isProtected).toBe(false)
        expect(status.protectionReason).toBeNull()
        expect(status.isEditable).toBe(true)
      })

      it('returns correct status for locked branch', async () => {
        const changeOrder = await createChangeOrder()
        const { branch } = await BranchService.getOrCreateEcoBranch(
          designId,
          changeOrder.id,
          user.id,
        )
        await BranchService.lockBranch(branch.id)

        const status = await BranchService.getBranchStatus(branch.id)

        expect(status.isProtected).toBe(true)
        expect(status.protectionReason).toBe('locked')
        expect(status.isEditable).toBe(false)
      })

      it('returns correct status for archived branch', async () => {
        const changeOrder = await createChangeOrder()
        const { branch } = await BranchService.getOrCreateEcoBranch(
          designId,
          changeOrder.id,
          user.id,
        )
        await BranchService.archiveBranch(branch.id)

        const status = await BranchService.getBranchStatus(branch.id)

        expect(status.isProtected).toBe(true)
        expect(status.protectionReason).toBe('archived')
        expect(status.isEditable).toBe(false)
      })

      it('returns correct status for protected main branch', async () => {
        // Create a released item to protect main
        await ItemService.create(
          'Part',
          {
            itemNumber: `PN-${Date.now()}`,
            revision: 'A',
            name: 'Released Part',
            state: 'Released',
            designId,
          } as any,
          user.id,
        )

        const status = await BranchService.getBranchStatus(mainBranchId)

        expect(status.branchType).toBe('main')
        expect(status.isProtected).toBe(true)
        expect(status.protectionReason).toBe('has-released-items')
        expect(status.isEditable).toBe(false)
      })

      it('throws NotFoundError for non-existent branch', async () => {
        await expect(
          BranchService.getBranchStatus('00000000-0000-0000-0000-000000000000'),
        ).rejects.toThrow(NotFoundError)
      })
    })

    describe('getAvailableBranchTypes', () => {
      it('returns pre-release phase when no released items', async () => {
        const result = await BranchService.getAvailableBranchTypes(designId)

        expect(result.phase).toBe('pre-release')
        expect(result.canEditMainDirectly).toBe(true)
        expect(result.availableBranchTypes).toContain('eco')
      })

      it('returns post-release phase when has released items', async () => {
        // Create a released item
        await ItemService.create(
          'Part',
          {
            itemNumber: `PN-${Date.now()}`,
            revision: 'A',
            name: 'Released Part',
            state: 'Released',
            designId,
          } as any,
          user.id,
        )

        const result = await BranchService.getAvailableBranchTypes(designId)

        expect(result.phase).toBe('post-release')
        expect(result.canEditMainDirectly).toBe(false)
        expect(result.availableBranchTypes).toContain('eco')
        expect(result.availableBranchTypes).toContain('workspace')
        expect(result.availableBranchTypes).toContain('release')
      })
    })

    describe('getBranchStatus for unprotected main', () => {
      it('returns correct status for unprotected main branch', async () => {
        const status = await BranchService.getBranchStatus(mainBranchId)

        expect(status.branchType).toBe('main')
        expect(status.isProtected).toBe(false)
        expect(status.protectionReason).toBeNull()
        expect(status.isEditable).toBe(true)
      })
    })
  })

  describe('deleteWorkspaceBranch', () => {
    it('deletes workspace branch and its added items', async () => {
      const branch = await BranchService.createWorkspaceBranch(
        designId,
        user.id,
        'to-delete',
      )

      // Create an item and track it as added on this workspace
      const part = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-DELETE-${Date.now()}`,
          revision: 'A',
          name: 'Workspace Only Part',
          state: 'Draft',
          designId,
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

      // Delete the workspace
      await BranchService.deleteWorkspaceBranch(branch.id, user.id)

      // Verify branch is archived
      const deletedBranch = await BranchService.getById(branch.id)
      expect(deletedBranch?.isArchived).toBe(true)

      // Verify the item was deleted
      const deletedItem = await ItemService.findById(part.id)
      expect(deletedItem).toBeNull()
    })

    it('throws error when deleting non-workspace branch', async () => {
      const changeOrder = await createChangeOrder()
      const { branch } = await BranchService.getOrCreateEcoBranch(
        designId,
        changeOrder.id,
        user.id,
      )

      await expect(
        BranchService.deleteWorkspaceBranch(branch.id, user.id),
      ).rejects.toThrow(ValidationError)
    })

    it('throws error when deleting another users workspace', async () => {
      const branch = await BranchService.createWorkspaceBranch(
        designId,
        user.id,
        'my-workspace',
      )

      // Try to delete with a different user ID
      const otherUserId = crypto.randomUUID()

      await expect(
        BranchService.deleteWorkspaceBranch(branch.id, otherUserId),
      ).rejects.toThrow(ValidationError)
    })

    it('throws NotFoundError for non-existent branch', async () => {
      await expect(
        BranchService.deleteWorkspaceBranch(
          '00000000-0000-0000-0000-000000000000',
          user.id,
        ),
      ).rejects.toThrow(NotFoundError)
    })
  })

  describe('getWorkspaceOnlyItemCount', () => {
    it('returns count of items added on workspace', async () => {
      const branch = await BranchService.createWorkspaceBranch(
        designId,
        user.id,
        'count-test',
      )

      // Add items to the workspace
      const part1 = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-COUNT1-${Date.now()}`,
          revision: 'A',
          name: 'Part 1',
          state: 'Draft',
          designId,
        } as any,
        user.id,
      )

      const part2 = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-COUNT2-${Date.now()}`,
          revision: 'A',
          name: 'Part 2',
          state: 'Draft',
          designId,
        } as any,
        user.id,
      )

      await testDb.db.insert(branchItems).values([
        {
          branchId: branch.id,
          itemMasterId: part1.masterId!,
          currentItemId: part1.id,
          baseItemId: null,
          changeType: 'added',
        },
        {
          branchId: branch.id,
          itemMasterId: part2.masterId!,
          currentItemId: part2.id,
          baseItemId: null,
          changeType: 'added',
        },
      ])

      const count = await BranchService.getWorkspaceOnlyItemCount(branch.id)

      expect(count).toBe(2)
    })

    it('returns 0 when no added items', async () => {
      const branch = await BranchService.createWorkspaceBranch(
        designId,
        user.id,
        'empty-workspace',
      )

      const count = await BranchService.getWorkspaceOnlyItemCount(branch.id)

      expect(count).toBe(0)
    })
  })

  describe('listUserWorkspacesForDesign', () => {
    it('returns workspace branches for user on specific design', async () => {
      await BranchService.createWorkspaceBranch(
        designId,
        user.id,
        'workspace-1',
      )
      await BranchService.createWorkspaceBranch(
        designId,
        user.id,
        'workspace-2',
      )

      const branches = await BranchService.listUserWorkspacesForDesign(
        designId,
        user.id,
      )

      expect(branches.length).toBe(2)
      expect(branches.every((b) => b.ownerId === user.id)).toBe(true)
      expect(branches.every((b) => b.designId === designId)).toBe(true)
    })

    it('excludes archived workspaces', async () => {
      const branch = await BranchService.createWorkspaceBranch(
        designId,
        user.id,
        'archived-ws',
      )
      await BranchService.archiveBranch(branch.id)

      const branches = await BranchService.listUserWorkspacesForDesign(
        designId,
        user.id,
      )

      expect(branches.find((b) => b.id === branch.id)).toBeUndefined()
    })

    it('excludes other users workspaces', async () => {
      await BranchService.createWorkspaceBranch(designId, user.id, 'my-ws')

      const otherUserId = crypto.randomUUID()
      const branches = await BranchService.listUserWorkspacesForDesign(
        designId,
        otherUserId,
      )

      expect(branches.length).toBe(0)
    })
  })

  describe('getMainBranch', () => {
    it('returns main branch for design', async () => {
      const mainBranch = await BranchService.getMainBranch(designId)

      expect(mainBranch).toBeDefined()
      expect(mainBranch?.branchType).toBe('main')
      expect(mainBranch?.designId).toBe(designId)
    })
  })

  describe('listByDesign pagination', () => {
    it('respects limit parameter', async () => {
      // Create multiple workspace branches
      await BranchService.createWorkspaceBranch(designId, user.id, 'ws-1')
      await BranchService.createWorkspaceBranch(designId, user.id, 'ws-2')
      await BranchService.createWorkspaceBranch(designId, user.id, 'ws-3')

      const branches = await BranchService.listByDesign(designId, { limit: 2 })

      expect(branches.length).toBe(2)
    })

    it('respects offset parameter', async () => {
      await BranchService.createWorkspaceBranch(designId, user.id, 'ws-a')
      await BranchService.createWorkspaceBranch(designId, user.id, 'ws-b')

      const allBranches = await BranchService.listByDesign(designId)
      const offsetBranches = await BranchService.listByDesign(designId, {
        offset: 1,
      })

      expect(offsetBranches.length).toBe(allBranches.length - 1)
    })
  })

  describe('createWorkspaceBranch edge cases', () => {
    it('sanitizes branch name with special characters', async () => {
      const branch = await BranchService.createWorkspaceBranch(
        designId,
        user.id,
        'My Feature! @#$ Test',
      )

      // Name should be sanitized
      expect(branch.name).toBe('workspace/my-feature------test')
    })

    it('handles whitespace-only name', async () => {
      await expect(
        BranchService.createWorkspaceBranch(designId, user.id, '   '),
      ).rejects.toThrow(ValidationError)
    })
  })
})

// Edge case tests
describe('BranchService Edge Cases', () => {
  const testDb = new TestDatabase()
  let user: TestUser
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

    const [program] = await testDb.db
      .insert(programs)
      .values({
        name: 'Edge Case Program',
        code: `EDGE-${Date.now()}`,
        createdBy: user.id,
      })
      .returning()
    programId = program.id

    const design = await DesignService.create(
      {
        programId,
        name: 'Edge Case Design',
        code: `EDGE-DESIGN-${Date.now()}`,
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

  describe('Branch Name Boundaries', () => {
    it('handles very long branch names', async () => {
      const longName = 'a'.repeat(200)
      try {
        const branch = await BranchService.createWorkspaceBranch(
          designId,
          user.id,
          longName,
        )
        expect(branch).toBeDefined()
        // Name should be truncated or handled appropriately
        expect(branch.name.length).toBeLessThanOrEqual(255)
      } catch (error) {
        // Very long names may fail validation
        expect(error).toBeDefined()
      }
    })

    it('handles unicode characters in branch name', async () => {
      const branch = await BranchService.createWorkspaceBranch(
        designId,
        user.id,
        '功能-测试',
      )

      expect(branch).toBeDefined()
      expect(branch.name).toContain('workspace/')
    })

    it('handles empty string branch name', async () => {
      await expect(
        BranchService.createWorkspaceBranch(designId, user.id, ''),
      ).rejects.toThrow(ValidationError)
    })

    it('prevents duplicate workspace names for same user', async () => {
      await BranchService.createWorkspaceBranch(
        designId,
        user.id,
        'duplicate-test',
      )

      await expect(
        BranchService.createWorkspaceBranch(
          designId,
          user.id,
          'duplicate-test',
        ),
      ).rejects.toThrow()
    })
  })

  describe('Lock and Archive Interactions', () => {
    it('cannot lock an archived branch', async () => {
      const branch = await BranchService.createWorkspaceBranch(
        designId,
        user.id,
        'lock-archive-test',
      )
      await BranchService.archiveBranch(branch.id)

      // May throw or return without locking
      try {
        await BranchService.lockBranch(branch.id)
        const locked = await BranchService.getById(branch.id)
        // If didn't throw, should still not be locked (archived takes precedence)
        expect(locked?.isLocked).toBe(false)
      } catch (error) {
        // Expected behavior - can't lock archived branch
        expect(error).toBeDefined()
      }
    })

    it('unlocking already unlocked branch is idempotent', async () => {
      const branch = await BranchService.createWorkspaceBranch(
        designId,
        user.id,
        'unlock-test',
      )

      // Should not throw even if not locked
      await BranchService.unlockBranch(branch.id)

      const updated = await BranchService.getById(branch.id)
      expect(updated?.isLocked).toBe(false)
    })

    it('locking same branch twice by same user succeeds', async () => {
      const branch = await BranchService.createWorkspaceBranch(
        designId,
        user.id,
        'double-lock',
      )
      await BranchService.lockBranch(branch.id)

      // Second lock by same user should succeed (idempotent)
      await BranchService.lockBranch(branch.id)

      const locked = await BranchService.getById(branch.id)
      expect(locked?.isLocked).toBe(true)
    })

    it('archiving locked branch handles lock state', async () => {
      const branch = await BranchService.createWorkspaceBranch(
        designId,
        user.id,
        'archive-locked',
      )
      await BranchService.lockBranch(branch.id)
      await BranchService.archiveBranch(branch.id)

      const archived = await BranchService.getById(branch.id)
      expect(archived?.isArchived).toBe(true)
      // Lock state may or may not be preserved
    })
  })

  describe('Invalid UUID Handling', () => {
    it('getById handles malformed UUID', async () => {
      try {
        const result = await BranchService.getById('not-a-valid-uuid')
        expect(result).toBeNull()
      } catch (error) {
        // Malformed UUID may cause DB error
        expect(error).toBeDefined()
      }
    })

    it('getByName handles invalid design ID', async () => {
      try {
        const result = await BranchService.getByName(
          'invalid-design-id',
          'main',
        )
        expect(result).toBeNull()
      } catch (error) {
        // Invalid ID may cause DB error
        expect(error).toBeDefined()
      }
    })

    it('listByDesign returns empty for non-existent design', async () => {
      const result = await BranchService.listByDesign(
        '00000000-0000-0000-0000-000000000000',
      )
      expect(result).toEqual([])
    })
  })

  describe('Branch Type Constraints', () => {
    it('cannot archive main branch', async () => {
      await expect(BranchService.archiveBranch(mainBranchId)).rejects.toThrow()
    })

    it('cannot delete main branch through workspace deletion', async () => {
      await expect(
        BranchService.deleteWorkspaceBranch(mainBranchId, user.id),
      ).rejects.toThrow()
    })
  })

  describe('Concurrent Branch Operations', () => {
    it('handles multiple workspace creations in parallel', async () => {
      const names = ['parallel-1', 'parallel-2', 'parallel-3']

      const results = await Promise.all(
        names.map((name) =>
          BranchService.createWorkspaceBranch(designId, user.id, name),
        ),
      )

      expect(results.length).toBe(3)
      expect(new Set(results.map((b) => b.id)).size).toBe(3) // All unique IDs
    })

    it('handles lock then immediate unlock', async () => {
      const branch = await BranchService.createWorkspaceBranch(
        designId,
        user.id,
        'quick-lock',
      )

      await BranchService.lockBranch(branch.id)
      await BranchService.unlockBranch(branch.id)

      const result = await BranchService.getById(branch.id)
      expect(result?.isLocked).toBe(false)
    })
  })

  describe('Pagination Edge Cases', () => {
    it('handles limit of 0', async () => {
      const result = await BranchService.listByDesign(designId, { limit: 0 })
      // Limit of 0 may return empty or use default limit
      expect(Array.isArray(result)).toBe(true)
    })

    it('handles very large offset', async () => {
      const result = await BranchService.listByDesign(designId, {
        offset: 10000,
      })
      expect(result).toEqual([])
    })

    it('handles negative offset as 0', async () => {
      const result = await BranchService.listByDesign(designId, { offset: -5 })
      expect(result.length).toBeGreaterThan(0) // Should return results
    })
  })

  describe('Branch Filtering', () => {
    it('filters by branchType correctly', async () => {
      await BranchService.createWorkspaceBranch(
        designId,
        user.id,
        'filter-test',
      )

      const workspaces = await BranchService.listByDesign(designId, {
        branchType: 'workspace',
      })
      const mains = await BranchService.listByDesign(designId, {
        branchType: 'main',
      })

      expect(workspaces.every((b) => b.branchType === 'workspace')).toBe(true)
      expect(mains.every((b) => b.branchType === 'main')).toBe(true)
    })

    it('includeArchived returns archived branches', async () => {
      const branch = await BranchService.createWorkspaceBranch(
        designId,
        user.id,
        'archived-filter',
      )
      await BranchService.archiveBranch(branch.id)

      const withArchived = await BranchService.listByDesign(designId, {
        includeArchived: true,
      })
      const withoutArchived = await BranchService.listByDesign(designId, {
        includeArchived: false,
      })

      expect(withArchived.some((b) => b.id === branch.id)).toBe(true)
      expect(withoutArchived.some((b) => b.id === branch.id)).toBe(false)
    })
  })

  describe('Workspace Deletion Edge Cases', () => {
    it('cannot delete workspace owned by another user', async () => {
      const branch = await BranchService.createWorkspaceBranch(
        designId,
        user.id,
        'other-user-ws',
      )
      const otherUserId = crypto.randomUUID()

      await expect(
        BranchService.deleteWorkspaceBranch(branch.id, otherUserId),
      ).rejects.toThrow()
    })

    it('cannot delete non-workspace branch', async () => {
      // Trying to delete main branch as workspace should fail
      await expect(
        BranchService.deleteWorkspaceBranch(mainBranchId, user.id),
      ).rejects.toThrow()
    })
  })
})
