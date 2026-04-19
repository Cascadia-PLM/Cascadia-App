/**
 * CommitService Tests
 *
 * Integration tests for the CommitService class.
 *
 * Run: npm run test -- src/lib/services/CommitService.test.ts
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
import { CommitService } from './CommitService'
import { BranchService } from './BranchService'
import { DesignService } from './DesignService'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { changeOrders, items, programs, tags } from '@/lib/db/schema'
import { NotFoundError, ValidationError } from '@/lib/errors'

const NON_EXISTENT_UUID = '00000000-0000-0000-0000-000000000000'

describe('CommitService', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let programId: string
  let uniquePrefix: string

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

    const [program] = await testDb.db
      .insert(programs)
      .values({
        name: 'Test Program',
        code: `PROG-${uniquePrefix}`,
        createdBy: user.id,
      })
      .returning()

    programId = program.id
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  describe('getById', () => {
    it('returns commit by ID', async () => {
      const design = await DesignService.create(
        {
          programId,
          name: 'Test Design',
          code: `${uniquePrefix}-DES`,
          designType: 'Engineering',
        },
        user.id,
      )

      const commit = await CommitService.getById(design.initialCommit!.id)

      expect(commit).toBeDefined()
      expect(commit?.id).toBe(design.initialCommit!.id)
    })

    it('returns null for non-existent commit', async () => {
      const commit = await CommitService.getById(NON_EXISTENT_UUID)

      expect(commit).toBeNull()
    })
  })

  describe('getByBranch', () => {
    it('returns commits for a branch', async () => {
      const design = await DesignService.create(
        {
          programId,
          name: 'Test Design',
          code: `${uniquePrefix}-DES`,
          designType: 'Engineering',
        },
        user.id,
      )

      const commits = await CommitService.getByBranch(design.mainBranch!.id)

      expect(commits.length).toBeGreaterThanOrEqual(1)
      expect(commits[0].branchId).toBe(design.mainBranch!.id)
    })

    it('supports pagination with limit and offset', async () => {
      const design = await DesignService.create(
        {
          programId,
          name: 'Test Design',
          code: `${uniquePrefix}-DES`,
          designType: 'Engineering',
        },
        user.id,
      )

      // Create additional commits
      const masterId = crypto.randomUUID()
      const [item] = await testDb.db
        .insert(items)
        .values({
          masterId,
          itemNumber: `${uniquePrefix}-PART-001`,
          revision: 'A',
          itemType: 'Part',
          name: 'Test Part',
          state: 'Draft',
          isCurrent: true,
          createdBy: user.id,
          modifiedBy: user.id,
          designId: design.id,
        })
        .returning()

      await CommitService.create(
        {
          branchId: design.mainBranch!.id,
          message: 'Second commit',
          itemChanges: [{ itemId: item.id, changeType: 'added' }],
        },
        user.id,
      )

      const page1 = await CommitService.getByBranch(design.mainBranch!.id, {
        limit: 1,
        offset: 0,
      })
      const page2 = await CommitService.getByBranch(design.mainBranch!.id, {
        limit: 1,
        offset: 1,
      })

      expect(page1.length).toBe(1)
      expect(page2.length).toBe(1)
      expect(page1[0].id).not.toBe(page2[0].id)
    })

    it('returns empty array for branch with no commits', async () => {
      const commits = await CommitService.getByBranch(NON_EXISTENT_UUID)

      expect(commits).toEqual([])
    })
  })

  describe('create', () => {
    it('creates a commit with item changes', async () => {
      const design = await DesignService.create(
        {
          programId,
          name: 'Test Design',
          code: `${uniquePrefix}-DES`,
          designType: 'Engineering',
        },
        user.id,
      )

      const masterId = crypto.randomUUID()
      const [item] = await testDb.db
        .insert(items)
        .values({
          masterId,
          itemNumber: `${uniquePrefix}-PART-001`,
          revision: 'A',
          itemType: 'Part',
          name: 'Test Part',
          state: 'Draft',
          isCurrent: true,
          createdBy: user.id,
          modifiedBy: user.id,
          designId: design.id,
        })
        .returning()

      const commit = await CommitService.create(
        {
          branchId: design.mainBranch!.id,
          message: 'Add test part',
          itemChanges: [{ itemId: item.id, changeType: 'added' }],
        },
        user.id,
      )

      expect(commit).toBeDefined()
      expect(commit.message).toBe('Add test part')
      expect(commit.itemsAdded).toBe(1)
      expect(commit.itemsChanged).toBe(0)
      expect(commit.itemsDeleted).toBe(0)
    })

    it('creates commit with field-level changes', async () => {
      const design = await DesignService.create(
        {
          programId,
          name: 'Test Design',
          code: `${uniquePrefix}-DES`,
          designType: 'Engineering',
        },
        user.id,
      )

      const masterId = crypto.randomUUID()
      const [item] = await testDb.db
        .insert(items)
        .values({
          masterId,
          itemNumber: `${uniquePrefix}-PART-002`,
          revision: 'A',
          itemType: 'Part',
          name: 'Field Change Part',
          state: 'Draft',
          isCurrent: true,
          createdBy: user.id,
          modifiedBy: user.id,
          designId: design.id,
        })
        .returning()

      const commit = await CommitService.create(
        {
          branchId: design.mainBranch!.id,
          message: 'Modify part',
          itemChanges: [
            {
              itemId: item.id,
              changeType: 'modified',
              fieldChanges: [
                {
                  fieldName: 'name',
                  oldValue: 'Old Name',
                  newValue: 'New Name',
                  fieldCategory: 'core',
                },
              ],
            },
          ],
        },
        user.id,
      )

      expect(commit).toBeDefined()
      expect(commit.itemsChanged).toBe(1)
    })

    it('throws error for locked branch', async () => {
      const design = await DesignService.create(
        {
          programId,
          name: 'Test Design',
          code: `${uniquePrefix}-DES`,
          designType: 'Engineering',
        },
        user.id,
      )

      // Create a workspace branch (can't lock main branch)
      const workspaceBranch = await BranchService.createWorkspaceBranch(
        design.id,
        user.id,
        `workspace-lock-${Date.now()}`,
      )

      await BranchService.lockBranch(workspaceBranch.id)

      const masterId = crypto.randomUUID()
      const [item] = await testDb.db
        .insert(items)
        .values({
          masterId,
          itemNumber: `${uniquePrefix}-PART-003`,
          revision: 'A',
          itemType: 'Part',
          name: 'Locked Part',
          state: 'Draft',
          isCurrent: true,
          createdBy: user.id,
          modifiedBy: user.id,
          designId: design.id,
        })
        .returning()

      await expect(
        CommitService.create(
          {
            branchId: workspaceBranch.id,
            message: 'Should fail',
            itemChanges: [{ itemId: item.id, changeType: 'added' }],
          },
          user.id,
        ),
      ).rejects.toThrow(ValidationError)
    })

    it('throws error for non-existent branch', async () => {
      await expect(
        CommitService.create(
          {
            branchId: NON_EXISTENT_UUID,
            message: 'Should fail',
            itemChanges: [],
          },
          user.id,
        ),
      ).rejects.toThrow(NotFoundError)
    })

    it('updates branch HEAD after commit', async () => {
      const design = await DesignService.create(
        {
          programId,
          name: 'Test Design',
          code: `${uniquePrefix}-DES`,
          designType: 'Engineering',
        },
        user.id,
      )

      const originalHead = design.mainBranch!.headCommitId

      const masterId = crypto.randomUUID()
      const [item] = await testDb.db
        .insert(items)
        .values({
          masterId,
          itemNumber: `${uniquePrefix}-PART-004`,
          revision: 'A',
          itemType: 'Part',
          name: 'HEAD Update Part',
          state: 'Draft',
          isCurrent: true,
          createdBy: user.id,
          modifiedBy: user.id,
          designId: design.id,
        })
        .returning()

      const commit = await CommitService.create(
        {
          branchId: design.mainBranch!.id,
          message: 'Update HEAD',
          itemChanges: [{ itemId: item.id, changeType: 'added' }],
        },
        user.id,
      )

      const updatedBranch = await BranchService.getById(design.mainBranch!.id)

      expect(updatedBranch?.headCommitId).toBe(commit.id)
      expect(updatedBranch?.headCommitId).not.toBe(originalHead)
    })
  })

  describe('createMergeCommit', () => {
    it('creates merge commit from ECO branch to main', async () => {
      const design = await DesignService.create(
        {
          programId,
          name: 'Test Design',
          code: `${uniquePrefix}-DES`,
          designType: 'Engineering',
        },
        user.id,
      )

      // Create ECO branch
      const coMasterId = crypto.randomUUID()
      const [coItem] = await testDb.db
        .insert(items)
        .values({
          masterId: coMasterId,
          itemNumber: `${uniquePrefix}-ECO-001`,
          revision: 'A',
          itemType: 'ChangeOrder',
          name: 'Test ECO',
          state: 'Draft',
          isCurrent: true,
          createdBy: user.id,
          modifiedBy: user.id,
          designId: design.id,
        })
        .returning()

      await testDb.db.insert(changeOrders).values({
        itemId: coItem.id,
        changeType: 'ECO',
        priority: 'Medium',
      })

      const ecoBranch = await BranchService.createEcoBranch(
        design.id,
        coItem.id,
        user.id,
      )

      // Create a test item to include in the merge
      const partMasterId = crypto.randomUUID()
      const [partItem] = await testDb.db
        .insert(items)
        .values({
          masterId: partMasterId,
          itemNumber: `${uniquePrefix}-MERGE-PART`,
          revision: 'A',
          itemType: 'Part',
          name: 'Merge Test Part',
          state: 'Draft',
          isCurrent: true,
          createdBy: user.id,
          modifiedBy: user.id,
          designId: design.id,
        })
        .returning()

      // Provide non-empty itemChanges to avoid getBranchChanges call that can cause deadlock in tests
      const mergeCommit = await CommitService.createMergeCommit(
        {
          targetBranchId: design.mainBranch!.id,
          sourceBranchId: ecoBranch.id,
          message: 'Merge ECO branch',
          itemChanges: [{ itemId: partItem.id, changeType: 'added' }],
        },
        user.id,
      )

      expect(mergeCommit).toBeDefined()
      expect(mergeCommit.mergeParentId).toBe(ecoBranch.headCommitId)
      expect(mergeCommit.message).toBe('Merge ECO branch')
    })

    it('throws error when merging to non-main branch', async () => {
      const design = await DesignService.create(
        {
          programId,
          name: 'Test Design',
          code: `${uniquePrefix}-DES`,
          designType: 'Engineering',
        },
        user.id,
      )

      // Create two ECO branches
      const coMasterId1 = crypto.randomUUID()
      const [coItem1] = await testDb.db
        .insert(items)
        .values({
          masterId: coMasterId1,
          itemNumber: `${uniquePrefix}-ECO-002`,
          revision: 'A',
          itemType: 'ChangeOrder',
          name: 'ECO 1',
          state: 'Draft',
          isCurrent: true,
          createdBy: user.id,
          modifiedBy: user.id,
          designId: design.id,
        })
        .returning()

      await testDb.db.insert(changeOrders).values({
        itemId: coItem1.id,
        changeType: 'ECO',
        priority: 'Medium',
      })

      const ecoBranch1 = await BranchService.createEcoBranch(
        design.id,
        coItem1.id,
        user.id,
      )

      const coMasterId2 = crypto.randomUUID()
      const [coItem2] = await testDb.db
        .insert(items)
        .values({
          masterId: coMasterId2,
          itemNumber: `${uniquePrefix}-ECO-003`,
          revision: 'A',
          itemType: 'ChangeOrder',
          name: 'ECO 2',
          state: 'Draft',
          isCurrent: true,
          createdBy: user.id,
          modifiedBy: user.id,
          designId: design.id,
        })
        .returning()

      await testDb.db.insert(changeOrders).values({
        itemId: coItem2.id,
        changeType: 'ECO',
        priority: 'Medium',
      })

      const ecoBranch2 = await BranchService.createEcoBranch(
        design.id,
        coItem2.id,
        user.id,
      )

      await expect(
        CommitService.createMergeCommit(
          {
            targetBranchId: ecoBranch1.id,
            sourceBranchId: ecoBranch2.id,
            message: 'Should fail',
          },
          user.id,
        ),
      ).rejects.toThrow(ValidationError)
    })

    it('throws error for non-existent source branch', async () => {
      const design = await DesignService.create(
        {
          programId,
          name: 'Test Design',
          code: `${uniquePrefix}-DES`,
          designType: 'Engineering',
        },
        user.id,
      )

      await expect(
        CommitService.createMergeCommit(
          {
            targetBranchId: design.mainBranch!.id,
            sourceBranchId: NON_EXISTENT_UUID,
            message: 'Should fail',
          },
          user.id,
        ),
      ).rejects.toThrow(NotFoundError)
    })
  })

  describe('getHistory', () => {
    it('returns commit history for branch', async () => {
      const design = await DesignService.create(
        {
          programId,
          name: 'Test Design',
          code: `${uniquePrefix}-DES`,
          designType: 'Engineering',
        },
        user.id,
      )

      const history = await CommitService.getHistory(design.mainBranch!.id)

      expect(history.length).toBeGreaterThanOrEqual(1)
    })

    it('filters by date range', async () => {
      const design = await DesignService.create(
        {
          programId,
          name: 'Test Design',
          code: `${uniquePrefix}-DES`,
          designType: 'Engineering',
        },
        user.id,
      )

      const now = new Date()
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000)

      const history = await CommitService.getHistory(design.mainBranch!.id, {
        since: yesterday,
        until: tomorrow,
      })

      expect(history.length).toBeGreaterThanOrEqual(1)
      history.forEach((commit) => {
        expect(commit.createdAt >= yesterday).toBe(true)
        expect(commit.createdAt <= tomorrow).toBe(true)
      })
    })

    it('supports pagination', async () => {
      const design = await DesignService.create(
        {
          programId,
          name: 'Test Design',
          code: `${uniquePrefix}-DES`,
          designType: 'Engineering',
        },
        user.id,
      )

      // Create additional commits
      for (let i = 0; i < 3; i++) {
        const masterId = crypto.randomUUID()
        const [item] = await testDb.db
          .insert(items)
          .values({
            masterId,
            itemNumber: `${uniquePrefix}-HIST-00${i}`,
            revision: 'A',
            itemType: 'Part',
            name: `History Part ${i}`,
            state: 'Draft',
            isCurrent: true,
            createdBy: user.id,
            modifiedBy: user.id,
            designId: design.id,
          })
          .returning()

        await CommitService.create(
          {
            branchId: design.mainBranch!.id,
            message: `Commit ${i}`,
            itemChanges: [{ itemId: item.id, changeType: 'added' }],
          },
          user.id,
        )
      }

      const page1 = await CommitService.getHistory(design.mainBranch!.id, {
        limit: 2,
        offset: 0,
      })
      const page2 = await CommitService.getHistory(design.mainBranch!.id, {
        limit: 2,
        offset: 2,
      })

      expect(page1.length).toBe(2)
      if (page1.length > 0 && page2.length > 0) {
        expect(page1[0].id).not.toBe(page2[0].id)
      }
    })
  })

  describe('getDiff', () => {
    it('returns diff for a commit', async () => {
      const design = await DesignService.create(
        {
          programId,
          name: 'Test Design',
          code: `${uniquePrefix}-DES`,
          designType: 'Engineering',
        },
        user.id,
      )

      const masterId = crypto.randomUUID()
      const [item] = await testDb.db
        .insert(items)
        .values({
          masterId,
          itemNumber: `${uniquePrefix}-DIFF-001`,
          revision: 'A',
          itemType: 'Part',
          name: 'Diff Part',
          state: 'Draft',
          isCurrent: true,
          createdBy: user.id,
          modifiedBy: user.id,
          designId: design.id,
        })
        .returning()

      const commit = await CommitService.create(
        {
          branchId: design.mainBranch!.id,
          message: 'Add diff part',
          itemChanges: [{ itemId: item.id, changeType: 'added' }],
        },
        user.id,
      )

      const diff = await CommitService.getDiff(commit.id)

      expect(diff).toBeDefined()
      expect(diff?.commit.id).toBe(commit.id)
      expect(diff?.items.length).toBe(1)
      expect(diff?.items[0].changeType).toBe('added')
    })

    it('returns null for non-existent commit', async () => {
      const diff = await CommitService.getDiff(NON_EXISTENT_UUID)

      expect(diff).toBeNull()
    })
  })

  describe('getItemCommits', () => {
    it('returns commits affecting a specific item', async () => {
      const design = await DesignService.create(
        {
          programId,
          name: 'Test Design',
          code: `${uniquePrefix}-DES`,
          designType: 'Engineering',
        },
        user.id,
      )

      const masterId = crypto.randomUUID()
      const [item] = await testDb.db
        .insert(items)
        .values({
          masterId,
          itemNumber: `${uniquePrefix}-ITEM-001`,
          revision: 'A',
          itemType: 'Part',
          name: 'Item Commits Part',
          state: 'Draft',
          isCurrent: true,
          createdBy: user.id,
          modifiedBy: user.id,
          designId: design.id,
        })
        .returning()

      await CommitService.create(
        {
          branchId: design.mainBranch!.id,
          message: 'Add item',
          itemChanges: [{ itemId: item.id, changeType: 'added' }],
        },
        user.id,
      )

      const history = await CommitService.getItemCommits(masterId, design.id)

      expect(history.length).toBeGreaterThanOrEqual(1)
      expect(history[0].item.masterId).toBe(masterId)
    })

    it('returns empty array for non-existent item', async () => {
      const design = await DesignService.create(
        {
          programId,
          name: 'Test Design',
          code: `${uniquePrefix}-DES`,
          designType: 'Engineering',
        },
        user.id,
      )

      const history = await CommitService.getItemCommits(
        NON_EXISTENT_UUID,
        design.id,
      )

      expect(history).toEqual([])
    })

    it('filters by branch', async () => {
      const design = await DesignService.create(
        {
          programId,
          name: 'Test Design',
          code: `${uniquePrefix}-DES`,
          designType: 'Engineering',
        },
        user.id,
      )

      const masterId = crypto.randomUUID()
      const [item] = await testDb.db
        .insert(items)
        .values({
          masterId,
          itemNumber: `${uniquePrefix}-BRANCH-001`,
          revision: 'A',
          itemType: 'Part',
          name: 'Branch Filter Part',
          state: 'Draft',
          isCurrent: true,
          createdBy: user.id,
          modifiedBy: user.id,
          designId: design.id,
        })
        .returning()

      await CommitService.create(
        {
          branchId: design.mainBranch!.id,
          message: 'Add on main',
          itemChanges: [{ itemId: item.id, changeType: 'added' }],
        },
        user.id,
      )

      const history = await CommitService.getItemCommits(masterId, design.id, {
        branchId: design.mainBranch!.id,
      })

      expect(history.length).toBeGreaterThanOrEqual(1)
      expect(
        history.every((h) => h.commit.branchId === design.mainBranch!.id),
      ).toBe(true)
    })
  })

  describe('compareTags', () => {
    it('compares commits between two tags', async () => {
      const design = await DesignService.create(
        {
          programId,
          name: 'Test Design',
          code: `${uniquePrefix}-DES`,
          designType: 'Engineering',
        },
        user.id,
      )

      // Create first tag
      const [tag1] = await testDb.db
        .insert(tags)
        .values({
          designId: design.id,
          name: 'v1.0',
          commitId: design.initialCommit!.id,
          createdBy: user.id,
        })
        .returning()

      // Add a commit
      const masterId = crypto.randomUUID()
      const [item] = await testDb.db
        .insert(items)
        .values({
          masterId,
          itemNumber: `${uniquePrefix}-TAG-001`,
          revision: 'A',
          itemType: 'Part',
          name: 'Tag Part',
          state: 'Draft',
          isCurrent: true,
          createdBy: user.id,
          modifiedBy: user.id,
          designId: design.id,
        })
        .returning()

      const commit2 = await CommitService.create(
        {
          branchId: design.mainBranch!.id,
          message: 'Add tag part',
          itemChanges: [{ itemId: item.id, changeType: 'added' }],
        },
        user.id,
      )

      // Create second tag
      const [tag2] = await testDb.db
        .insert(tags)
        .values({
          designId: design.id,
          name: 'v2.0',
          commitId: commit2.id,
          createdBy: user.id,
        })
        .returning()

      const diffs = await CommitService.compareTags(tag1.id, tag2.id)

      expect(diffs.length).toBeGreaterThanOrEqual(1)
    })

    it('throws error for non-existent tag', async () => {
      const design = await DesignService.create(
        {
          programId,
          name: 'Test Design',
          code: `${uniquePrefix}-DES`,
          designType: 'Engineering',
        },
        user.id,
      )

      const [tag1] = await testDb.db
        .insert(tags)
        .values({
          designId: design.id,
          name: 'v1.0',
          commitId: design.initialCommit!.id,
          createdBy: user.id,
        })
        .returning()

      await expect(
        CommitService.compareTags(tag1.id, NON_EXISTENT_UUID),
      ).rejects.toThrow(NotFoundError)
    })
  })

  describe('getBranchChanges', () => {
    it('returns changes made on a branch', async () => {
      const design = await DesignService.create(
        {
          programId,
          name: 'Test Design',
          code: `${uniquePrefix}-DES`,
          designType: 'Engineering',
        },
        user.id,
      )

      // Create ECO branch
      const coMasterId = crypto.randomUUID()
      const [coItem] = await testDb.db
        .insert(items)
        .values({
          masterId: coMasterId,
          itemNumber: `${uniquePrefix}-ECO-CHANGES`,
          revision: 'A',
          itemType: 'ChangeOrder',
          name: 'Changes ECO',
          state: 'Draft',
          isCurrent: true,
          createdBy: user.id,
          modifiedBy: user.id,
          designId: design.id,
        })
        .returning()

      await testDb.db.insert(changeOrders).values({
        itemId: coItem.id,
        changeType: 'ECO',
        priority: 'Medium',
      })

      const ecoBranch = await BranchService.createEcoBranch(
        design.id,
        coItem.id,
        user.id,
      )

      // Add item on ECO branch
      const masterId = crypto.randomUUID()
      const [item] = await testDb.db
        .insert(items)
        .values({
          masterId,
          itemNumber: `${uniquePrefix}-CHANGES-001`,
          revision: 'A',
          itemType: 'Part',
          name: 'Changes Part',
          state: 'Draft',
          isCurrent: true,
          createdBy: user.id,
          modifiedBy: user.id,
          designId: design.id,
        })
        .returning()

      await CommitService.create(
        {
          branchId: ecoBranch.id,
          message: 'Add part on ECO',
          itemChanges: [{ itemId: item.id, changeType: 'added' }],
        },
        user.id,
      )

      const changes = await CommitService.getBranchChanges(ecoBranch.id)

      expect(changes.length).toBeGreaterThanOrEqual(1)
      expect(changes.some((c) => c.itemId === item.id)).toBe(true)
    })

    it('returns empty array for non-existent branch', async () => {
      const changes = await CommitService.getBranchChanges(NON_EXISTENT_UUID)

      expect(changes).toEqual([])
    })
  })

  describe('getWithAuthor', () => {
    it('returns commit with author info', async () => {
      const design = await DesignService.create(
        {
          programId,
          name: 'Test Design',
          code: `${uniquePrefix}-DES`,
          designType: 'Engineering',
        },
        user.id,
      )

      const result = await CommitService.getWithAuthor(design.initialCommit!.id)

      expect(result).toBeDefined()
      expect(result?.commit.id).toBe(design.initialCommit!.id)
      expect(result?.author.id).toBe(user.id)
    })

    it('returns null for non-existent commit', async () => {
      const result = await CommitService.getWithAuthor(NON_EXISTENT_UUID)

      expect(result).toBeNull()
    })
  })

  describe('additional edge cases', () => {
    describe('create - edge cases', () => {
      it('creates commit with empty itemChanges array', async () => {
        const design = await DesignService.create(
          {
            programId,
            name: 'Test Design',
            code: `${uniquePrefix}-DES`,
            designType: 'Engineering',
          },
          user.id,
        )

        const commit = await CommitService.create(
          {
            branchId: design.mainBranch!.id,
            message: 'Empty commit',
            itemChanges: [],
          },
          user.id,
        )

        expect(commit).toBeDefined()
        expect(commit.itemsAdded).toBe(0)
        expect(commit.itemsChanged).toBe(0)
        expect(commit.itemsDeleted).toBe(0)
      })

      it('creates commit with multiple change types', async () => {
        const design = await DesignService.create(
          {
            programId,
            name: 'Test Design',
            code: `${uniquePrefix}-DES`,
            designType: 'Engineering',
          },
          user.id,
        )

        // Create items for different change types
        const addedMasterId = crypto.randomUUID()
        const [addedItem] = await testDb.db
          .insert(items)
          .values({
            masterId: addedMasterId,
            itemNumber: `${uniquePrefix}-MULTI-ADD`,
            revision: 'A',
            itemType: 'Part',
            name: 'Added Part',
            state: 'Draft',
            isCurrent: true,
            createdBy: user.id,
            modifiedBy: user.id,
            designId: design.id,
          })
          .returning()

        const modifiedMasterId = crypto.randomUUID()
        const [modifiedItem] = await testDb.db
          .insert(items)
          .values({
            masterId: modifiedMasterId,
            itemNumber: `${uniquePrefix}-MULTI-MOD`,
            revision: 'A',
            itemType: 'Part',
            name: 'Modified Part',
            state: 'Draft',
            isCurrent: true,
            createdBy: user.id,
            modifiedBy: user.id,
            designId: design.id,
          })
          .returning()

        const deletedMasterId = crypto.randomUUID()
        const [deletedItem] = await testDb.db
          .insert(items)
          .values({
            masterId: deletedMasterId,
            itemNumber: `${uniquePrefix}-MULTI-DEL`,
            revision: 'A',
            itemType: 'Part',
            name: 'Deleted Part',
            state: 'Draft',
            isCurrent: true,
            createdBy: user.id,
            modifiedBy: user.id,
            designId: design.id,
          })
          .returning()

        const commit = await CommitService.create(
          {
            branchId: design.mainBranch!.id,
            message: 'Multiple changes',
            itemChanges: [
              { itemId: addedItem.id, changeType: 'added' },
              { itemId: modifiedItem.id, changeType: 'modified' },
              { itemId: deletedItem.id, changeType: 'deleted' },
            ],
          },
          user.id,
        )

        expect(commit.itemsAdded).toBe(1)
        expect(commit.itemsChanged).toBe(1)
        expect(commit.itemsDeleted).toBe(1)
      })

      it('creates commit with changeOrderItemId and revisionsAssigned', async () => {
        const design = await DesignService.create(
          {
            programId,
            name: 'Test Design',
            code: `${uniquePrefix}-DES`,
            designType: 'Engineering',
          },
          user.id,
        )

        const coMasterId = crypto.randomUUID()
        const [coItem] = await testDb.db
          .insert(items)
          .values({
            masterId: coMasterId,
            itemNumber: `${uniquePrefix}-ECO-REV`,
            revision: 'A',
            itemType: 'ChangeOrder',
            name: 'Revision ECO',
            state: 'Draft',
            isCurrent: true,
            createdBy: user.id,
            modifiedBy: user.id,
            designId: design.id,
          })
          .returning()

        const masterId = crypto.randomUUID()
        const [item] = await testDb.db
          .insert(items)
          .values({
            masterId,
            itemNumber: `${uniquePrefix}-REV-PART`,
            revision: 'A',
            itemType: 'Part',
            name: 'Revision Part',
            state: 'Draft',
            isCurrent: true,
            createdBy: user.id,
            modifiedBy: user.id,
            designId: design.id,
          })
          .returning()

        const commit = await CommitService.create(
          {
            branchId: design.mainBranch!.id,
            message: 'Release commit',
            itemChanges: [{ itemId: item.id, changeType: 'added' }],
            changeOrderItemId: coItem.id,
            revisionsAssigned: { [item.itemNumber]: 'A' },
          },
          user.id,
        )

        expect(commit.changeOrderItemId).toBe(coItem.id)
        expect(commit.revisionsAssigned).toEqual({ [item.itemNumber]: 'A' })
      })
    })

    describe('createMergeCommit - edge cases', () => {
      it('throws error when merging branches from different designs', async () => {
        const design1 = await DesignService.create(
          {
            programId,
            name: 'Design 1',
            code: `${uniquePrefix}-DES1`,
            designType: 'Engineering',
          },
          user.id,
        )

        const design2 = await DesignService.create(
          {
            programId,
            name: 'Design 2',
            code: `${uniquePrefix}-DES2`,
            designType: 'Engineering',
          },
          user.id,
        )

        // Create ECO branch on design2
        const coMasterId = crypto.randomUUID()
        const [coItem] = await testDb.db
          .insert(items)
          .values({
            masterId: coMasterId,
            itemNumber: `${uniquePrefix}-ECO-CROSS`,
            revision: 'A',
            itemType: 'ChangeOrder',
            name: 'Cross Design ECO',
            state: 'Draft',
            isCurrent: true,
            createdBy: user.id,
            modifiedBy: user.id,
            designId: design2.id,
          })
          .returning()

        await testDb.db.insert(changeOrders).values({
          itemId: coItem.id,
          changeType: 'ECO',
          priority: 'Medium',
        })

        const ecoBranch = await BranchService.createEcoBranch(
          design2.id,
          coItem.id,
          user.id,
        )

        // Try to merge from design2's ECO branch to design1's main branch
        await expect(
          CommitService.createMergeCommit(
            {
              targetBranchId: design1.mainBranch!.id,
              sourceBranchId: ecoBranch.id,
              message: 'Should fail',
              itemChanges: [],
            },
            user.id,
          ),
        ).rejects.toThrow(ValidationError)
      })

      it('throws error for non-existent target branch', async () => {
        const design = await DesignService.create(
          {
            programId,
            name: 'Test Design',
            code: `${uniquePrefix}-DES`,
            designType: 'Engineering',
          },
          user.id,
        )

        await expect(
          CommitService.createMergeCommit(
            {
              targetBranchId: NON_EXISTENT_UUID,
              sourceBranchId: design.mainBranch!.id,
              message: 'Should fail',
            },
            user.id,
          ),
        ).rejects.toThrow(NotFoundError)
      })

      it('creates merge commit with changeOrderItemId and revisionsAssigned', async () => {
        const design = await DesignService.create(
          {
            programId,
            name: 'Test Design',
            code: `${uniquePrefix}-DES`,
            designType: 'Engineering',
          },
          user.id,
        )

        const coMasterId = crypto.randomUUID()
        const [coItem] = await testDb.db
          .insert(items)
          .values({
            masterId: coMasterId,
            itemNumber: `${uniquePrefix}-ECO-MERGE-REV`,
            revision: 'A',
            itemType: 'ChangeOrder',
            name: 'Merge Rev ECO',
            state: 'Draft',
            isCurrent: true,
            createdBy: user.id,
            modifiedBy: user.id,
            designId: design.id,
          })
          .returning()

        await testDb.db.insert(changeOrders).values({
          itemId: coItem.id,
          changeType: 'ECO',
          priority: 'Medium',
        })

        const ecoBranch = await BranchService.createEcoBranch(
          design.id,
          coItem.id,
          user.id,
        )

        const partMasterId = crypto.randomUUID()
        const [partItem] = await testDb.db
          .insert(items)
          .values({
            masterId: partMasterId,
            itemNumber: `${uniquePrefix}-MERGE-REV-PART`,
            revision: 'A',
            itemType: 'Part',
            name: 'Merge Rev Part',
            state: 'Draft',
            isCurrent: true,
            createdBy: user.id,
            modifiedBy: user.id,
            designId: design.id,
          })
          .returning()

        const mergeCommit = await CommitService.createMergeCommit(
          {
            targetBranchId: design.mainBranch!.id,
            sourceBranchId: ecoBranch.id,
            message: 'Merge with revision info',
            itemChanges: [{ itemId: partItem.id, changeType: 'added' }],
            changeOrderItemId: coItem.id,
            revisionsAssigned: { [partItem.itemNumber]: 'A' },
          },
          user.id,
        )

        expect(mergeCommit.changeOrderItemId).toBe(coItem.id)
        expect(mergeCommit.revisionsAssigned).toEqual({
          [partItem.itemNumber]: 'A',
        })
      })
    })

    describe('getItemCommits - advanced scenarios', () => {
      it('filters history by untilCommitId', async () => {
        const design = await DesignService.create(
          {
            programId,
            name: 'Test Design',
            code: `${uniquePrefix}-DES`,
            designType: 'Engineering',
          },
          user.id,
        )

        const masterId = crypto.randomUUID()
        const [item] = await testDb.db
          .insert(items)
          .values({
            masterId,
            itemNumber: `${uniquePrefix}-CUTOFF-001`,
            revision: 'A',
            itemType: 'Part',
            name: 'Cutoff Part',
            state: 'Draft',
            isCurrent: true,
            createdBy: user.id,
            modifiedBy: user.id,
            designId: design.id,
          })
          .returning()

        // Create first commit
        const commit1 = await CommitService.create(
          {
            branchId: design.mainBranch!.id,
            message: 'First commit',
            itemChanges: [{ itemId: item.id, changeType: 'added' }],
          },
          user.id,
        )

        // Create a second item version
        const [item2] = await testDb.db
          .insert(items)
          .values({
            masterId,
            itemNumber: `${uniquePrefix}-CUTOFF-001`,
            revision: 'B',
            itemType: 'Part',
            name: 'Cutoff Part Modified',
            state: 'Draft',
            isCurrent: true,
            createdBy: user.id,
            modifiedBy: user.id,
            designId: design.id,
          })
          .returning()

        // Mark original as not current
        await testDb.db
          .update(items)
          .set({ isCurrent: false })
          .where(eq(items.id, item.id))

        await CommitService.create(
          {
            branchId: design.mainBranch!.id,
            message: 'Second commit',
            itemChanges: [
              {
                itemId: item2.id,
                changeType: 'modified',
                previousItemId: item.id,
              },
            ],
          },
          user.id,
        )

        // Get history with cutoff at first commit
        const historyWithCutoff = await CommitService.getItemCommits(
          masterId,
          design.id,
          {
            untilCommitId: commit1.id,
          },
        )

        // Should only return the first commit
        expect(historyWithCutoff.length).toBe(1)
        expect(historyWithCutoff[0].changeType).toBe('added')
      })

      it('includes field changes in history entries', async () => {
        const design = await DesignService.create(
          {
            programId,
            name: 'Test Design',
            code: `${uniquePrefix}-DES`,
            designType: 'Engineering',
          },
          user.id,
        )

        const masterId = crypto.randomUUID()
        const [item] = await testDb.db
          .insert(items)
          .values({
            masterId,
            itemNumber: `${uniquePrefix}-FIELD-HISTORY`,
            revision: 'A',
            itemType: 'Part',
            name: 'Field History Part',
            state: 'Draft',
            isCurrent: true,
            createdBy: user.id,
            modifiedBy: user.id,
            designId: design.id,
          })
          .returning()

        await CommitService.create(
          {
            branchId: design.mainBranch!.id,
            message: 'Add with field changes',
            itemChanges: [
              {
                itemId: item.id,
                changeType: 'modified',
                fieldChanges: [
                  {
                    fieldName: 'name',
                    oldValue: 'Old Name',
                    newValue: 'New Name',
                    fieldCategory: 'core',
                  },
                  {
                    fieldName: 'weight',
                    fieldPath: 'attributes.weight',
                    oldValue: 100,
                    newValue: 150,
                    fieldCategory: 'attribute',
                  },
                ],
              },
            ],
          },
          user.id,
        )

        const history = await CommitService.getItemCommits(masterId, design.id)

        expect(history.length).toBeGreaterThanOrEqual(1)
        const modifiedEntry = history.find((h) => h.changeType === 'modified')
        expect(modifiedEntry?.fieldChanges.length).toBe(2)
        expect(
          modifiedEntry?.fieldChanges.some((f) => f.fieldName === 'name'),
        ).toBe(true)
        expect(
          modifiedEntry?.fieldChanges.some((f) => f.fieldName === 'weight'),
        ).toBe(true)
      })

      it('shows commits from ECO branch plus main branch history', async () => {
        const design = await DesignService.create(
          {
            programId,
            name: 'Test Design',
            code: `${uniquePrefix}-DES`,
            designType: 'Engineering',
          },
          user.id,
        )

        const masterId = crypto.randomUUID()
        const [item] = await testDb.db
          .insert(items)
          .values({
            masterId,
            itemNumber: `${uniquePrefix}-ECO-HIST`,
            revision: 'A',
            itemType: 'Part',
            name: 'ECO History Part',
            state: 'Draft',
            isCurrent: true,
            createdBy: user.id,
            modifiedBy: user.id,
            designId: design.id,
          })
          .returning()

        // Create commit on main
        await CommitService.create(
          {
            branchId: design.mainBranch!.id,
            message: 'Add on main',
            itemChanges: [{ itemId: item.id, changeType: 'added' }],
          },
          user.id,
        )

        // Create ECO branch
        const coMasterId = crypto.randomUUID()
        const [coItem] = await testDb.db
          .insert(items)
          .values({
            masterId: coMasterId,
            itemNumber: `${uniquePrefix}-ECO-HIST-ECO`,
            revision: 'A',
            itemType: 'ChangeOrder',
            name: 'History ECO',
            state: 'Draft',
            isCurrent: true,
            createdBy: user.id,
            modifiedBy: user.id,
            designId: design.id,
          })
          .returning()

        await testDb.db.insert(changeOrders).values({
          itemId: coItem.id,
          changeType: 'ECO',
          priority: 'Medium',
        })

        const ecoBranch = await BranchService.createEcoBranch(
          design.id,
          coItem.id,
          user.id,
        )

        // Create second version on ECO branch
        const [item2] = await testDb.db
          .insert(items)
          .values({
            masterId,
            itemNumber: `${uniquePrefix}-ECO-HIST`,
            revision: 'B',
            itemType: 'Part',
            name: 'ECO History Part Modified',
            state: 'Draft',
            isCurrent: true,
            createdBy: user.id,
            modifiedBy: user.id,
            designId: design.id,
          })
          .returning()

        await testDb.db
          .update(items)
          .set({ isCurrent: false })
          .where(eq(items.id, item.id))

        await CommitService.create(
          {
            branchId: ecoBranch.id,
            message: 'Modify on ECO',
            itemChanges: [
              {
                itemId: item2.id,
                changeType: 'modified',
                previousItemId: item.id,
              },
            ],
          },
          user.id,
        )

        // Get history from ECO branch perspective
        const ecoHistory = await CommitService.getItemCommits(
          masterId,
          design.id,
          {
            branchId: ecoBranch.id,
          },
        )

        // Should see at least the ECO branch commit
        // Note: Main branch history at fork point may be included depending on timing
        expect(ecoHistory.length).toBeGreaterThanOrEqual(1)
        // Verify ECO branch commit is present
        const ecoCommit = ecoHistory.find(
          (h) => h.commit.branchId === ecoBranch.id,
        )
        expect(ecoCommit).toBeDefined()
        expect(ecoCommit?.changeType).toBe('modified')
      })
    })

    describe('compareTags - edge cases', () => {
      it('handles tags in reverse chronological order', async () => {
        const design = await DesignService.create(
          {
            programId,
            name: 'Test Design',
            code: `${uniquePrefix}-DES`,
            designType: 'Engineering',
          },
          user.id,
        )

        // Create first tag on initial commit
        const [tag1] = await testDb.db
          .insert(tags)
          .values({
            designId: design.id,
            name: 'v1.0-reverse',
            commitId: design.initialCommit!.id,
            createdBy: user.id,
          })
          .returning()

        // Add commit
        const masterId = crypto.randomUUID()
        const [item] = await testDb.db
          .insert(items)
          .values({
            masterId,
            itemNumber: `${uniquePrefix}-REVERSE-001`,
            revision: 'A',
            itemType: 'Part',
            name: 'Reverse Part',
            state: 'Draft',
            isCurrent: true,
            createdBy: user.id,
            modifiedBy: user.id,
            designId: design.id,
          })
          .returning()

        const commit2 = await CommitService.create(
          {
            branchId: design.mainBranch!.id,
            message: 'Add reverse part',
            itemChanges: [{ itemId: item.id, changeType: 'added' }],
          },
          user.id,
        )

        // Create second tag
        const [tag2] = await testDb.db
          .insert(tags)
          .values({
            designId: design.id,
            name: 'v2.0-reverse',
            commitId: commit2.id,
            createdBy: user.id,
          })
          .returning()

        // Compare tags in reverse order (newer to older)
        const diffsReverse = await CommitService.compareTags(tag2.id, tag1.id)

        // Compare tags in normal order (older to newer)
        const diffsNormal = await CommitService.compareTags(tag1.id, tag2.id)

        // Both should return the same commits
        expect(diffsReverse.length).toBe(diffsNormal.length)
      })

      it('returns results when both tags point to same commit', async () => {
        const design = await DesignService.create(
          {
            programId,
            name: 'Test Design',
            code: `${uniquePrefix}-DES`,
            designType: 'Engineering',
          },
          user.id,
        )

        // Create two tags pointing to the same commit
        const [tag1] = await testDb.db
          .insert(tags)
          .values({
            designId: design.id,
            name: 'v1.0-same',
            commitId: design.initialCommit!.id,
            createdBy: user.id,
          })
          .returning()

        const [tag2] = await testDb.db
          .insert(tags)
          .values({
            designId: design.id,
            name: 'v1.0-alias',
            commitId: design.initialCommit!.id,
            createdBy: user.id,
          })
          .returning()

        const diffs = await CommitService.compareTags(tag1.id, tag2.id)

        // When both tags point to the same commit, the comparison is valid
        // Returns empty if the commit has no item changes recorded
        expect(Array.isArray(diffs)).toBe(true)
      })
    })

    describe('getBranchChanges - edge cases', () => {
      it('tracks latest change per item when same item is modified multiple times', async () => {
        const design = await DesignService.create(
          {
            programId,
            name: 'Test Design',
            code: `${uniquePrefix}-DES`,
            designType: 'Engineering',
          },
          user.id,
        )

        const coMasterId = crypto.randomUUID()
        const [coItem] = await testDb.db
          .insert(items)
          .values({
            masterId: coMasterId,
            itemNumber: `${uniquePrefix}-ECO-MULTI-MOD`,
            revision: 'A',
            itemType: 'ChangeOrder',
            name: 'Multi Mod ECO',
            state: 'Draft',
            isCurrent: true,
            createdBy: user.id,
            modifiedBy: user.id,
            designId: design.id,
          })
          .returning()

        await testDb.db.insert(changeOrders).values({
          itemId: coItem.id,
          changeType: 'ECO',
          priority: 'Medium',
        })

        const ecoBranch = await BranchService.createEcoBranch(
          design.id,
          coItem.id,
          user.id,
        )

        const partMasterId = crypto.randomUUID()
        const [item1] = await testDb.db
          .insert(items)
          .values({
            masterId: partMasterId,
            itemNumber: `${uniquePrefix}-MULTI-MOD-PART`,
            revision: 'A',
            itemType: 'Part',
            name: 'Multi Mod Part v1',
            state: 'Draft',
            isCurrent: true,
            createdBy: user.id,
            modifiedBy: user.id,
            designId: design.id,
          })
          .returning()

        // First commit - add
        await CommitService.create(
          {
            branchId: ecoBranch.id,
            message: 'Add part',
            itemChanges: [{ itemId: item1.id, changeType: 'added' }],
          },
          user.id,
        )

        // Create second version
        const [item2] = await testDb.db
          .insert(items)
          .values({
            masterId: partMasterId,
            itemNumber: `${uniquePrefix}-MULTI-MOD-PART`,
            revision: 'B',
            itemType: 'Part',
            name: 'Multi Mod Part v2',
            state: 'Draft',
            isCurrent: true,
            createdBy: user.id,
            modifiedBy: user.id,
            designId: design.id,
          })
          .returning()

        await testDb.db
          .update(items)
          .set({ isCurrent: false })
          .where(eq(items.id, item1.id))

        // Second commit - modify
        await CommitService.create(
          {
            branchId: ecoBranch.id,
            message: 'Modify part',
            itemChanges: [
              {
                itemId: item2.id,
                changeType: 'modified',
                previousItemId: item1.id,
              },
            ],
          },
          user.id,
        )

        const changes = await CommitService.getBranchChanges(ecoBranch.id)

        // Should only have one entry for this masterId, with the latest itemId
        const partChanges = changes.filter(
          (c) => c.itemId === item1.id || c.itemId === item2.id,
        )
        expect(partChanges.length).toBe(1)
        // When added first, then modified, should keep 'added' type (original was added to branch)
        expect(partChanges[0].changeType).toBe('added')
      })
    })
  })
})
