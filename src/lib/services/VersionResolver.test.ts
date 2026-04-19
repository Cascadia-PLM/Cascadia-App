/**
 * VersionResolver Tests
 *
 * Unit tests for the VersionResolver service that resolves item versions
 * at different version contexts (main, branch, commit, tag).
 *
 * Run: npm run test -- src/lib/services/VersionResolver.test.ts
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
import { VersionResolver } from './VersionResolver'
import { DesignService } from './DesignService'
import { BranchService } from './BranchService'
import { CommitService } from './CommitService'
import type { VersionContext } from './VersionResolver'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import {
  branchItems,
  changeOrders,
  itemVersions,
  items,
  parts,
  programs,
  tags,
} from '@/lib/db/schema'

// Valid UUID format for non-existent IDs
const NON_EXISTENT_UUID = '00000000-0000-0000-0000-000000000000'

describe('VersionResolver', () => {
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

    // Generate unique prefix for this test run
    uniquePrefix = `T${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`

    // Create test user (let fixture generate unique email)
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
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  describe('parseContext', () => {
    it('returns commit context when commitId is provided', () => {
      const context = VersionResolver.parseContext({
        designId: 'design-1',
        commit: 'commit-123',
        tag: 'tag-456',
        branch: 'branch-789',
      })

      expect(context).toEqual({ type: 'commit', commitId: 'commit-123' })
    })

    it('returns tag context when tagId is provided (and no commit)', () => {
      const context = VersionResolver.parseContext({
        designId: 'design-1',
        tag: 'tag-456',
        branch: 'branch-789',
      })

      expect(context).toEqual({ type: 'tag', tagId: 'tag-456' })
    })

    it('returns branch context when branchId is provided (and no commit/tag)', () => {
      const context = VersionResolver.parseContext({
        designId: 'design-1',
        branch: 'branch-789',
      })

      expect(context).toEqual({ type: 'branch', branchId: 'branch-789' })
    })

    it('returns released context when only designId is provided', () => {
      const context = VersionResolver.parseContext({
        designId: 'design-1',
      })

      expect(context).toEqual({ type: 'released', designId: 'design-1' })
    })

    it('returns null when no context params are provided', () => {
      const context = VersionResolver.parseContext({})

      expect(context).toBeNull()
    })
  })

  describe('getItemAtContext', () => {
    let designId: string
    let mainBranchId: string
    let itemMasterId: string
    let itemRevAId: string

    beforeEach(async () => {
      // Create a design with main branch
      const design = await DesignService.create(
        {
          programId,
          name: 'Test Design',
          code: `${uniquePrefix}-DES`,
          designType: 'Engineering',
        },
        user.id,
      )
      designId = design.id
      mainBranchId = design.mainBranch!.id

      // Create a part item (Rev A)
      const masterId = crypto.randomUUID()
      const [itemRevA] = await testDb.db
        .insert(items)
        .values({
          masterId,
          itemNumber: `${uniquePrefix}-PART-001`,
          revision: 'A',
          itemType: 'Part',
          name: 'Test Part Rev A',
          state: 'Released',
          isCurrent: true,
          createdBy: user.id,
          modifiedBy: user.id,
          designId,
          commitId: design.initialCommit!.id,
        })
        .returning()

      itemMasterId = masterId
      itemRevAId = itemRevA.id

      // Create part-specific data
      await testDb.db.insert(parts).values({
        itemId: itemRevA.id,
        description: 'Test part description',
        partType: 'Manufacture',
        material: 'Steel',
      })

      // Add itemVersion entry for Rev A at initial commit
      await testDb.db.insert(itemVersions).values({
        itemId: itemRevA.id,
        commitId: design.initialCommit!.id,
        changeType: 'added',
      })
    })

    describe('released context', () => {
      it('returns the item at main branch HEAD', async () => {
        const context: VersionContext = { type: 'released', designId }

        const result = await VersionResolver.getItemAtContext(
          itemMasterId,
          designId,
          context,
        )

        expect(result).not.toBeNull()
        expect(result?.id).toBe(itemRevAId)
        expect(result?.revision).toBe('A')
        expect(result?.state).toBe('Released')
      })

      it('returns null for non-existent item master', async () => {
        const context: VersionContext = { type: 'released', designId }

        const result = await VersionResolver.getItemAtContext(
          NON_EXISTENT_UUID,
          designId,
          context,
        )

        expect(result).toBeNull()
      })
    })

    describe('branch context', () => {
      let ecoBranchId: string
      let itemRevBId: string
      let changeOrderItemId: string

      beforeEach(async () => {
        // Create a change order item first (required for ECO branch)
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
            designId,
          })
          .returning()

        changeOrderItemId = coItem.id

        // Create change order specific data
        await testDb.db.insert(changeOrders).values({
          itemId: coItem.id,
          changeType: 'ECO',
          priority: 'Medium',
        })

        // Create an ECO branch
        const ecoBranch = await BranchService.createEcoBranch(
          designId,
          changeOrderItemId,
          user.id,
        )
        ecoBranchId = ecoBranch.id

        // Create Rev B on the ECO branch
        const [itemRevB] = await testDb.db
          .insert(items)
          .values({
            masterId: itemMasterId,
            itemNumber: `${uniquePrefix}-PART-001`,
            revision: 'B',
            itemType: 'Part',
            name: 'Test Part Rev B',
            state: 'Draft',
            isCurrent: false,
            createdBy: user.id,
            modifiedBy: user.id,
            designId,
          })
          .returning()

        itemRevBId = itemRevB.id

        // Create part-specific data for Rev B
        await testDb.db.insert(parts).values({
          itemId: itemRevB.id,
          description: 'Updated test part description',
          partType: 'Manufacture',
          material: 'Aluminum',
        })

        // Add branchItem entry pointing to Rev B
        await testDb.db.insert(branchItems).values({
          branchId: ecoBranchId,
          itemMasterId,
          currentItemId: itemRevBId,
        })
      })

      it('returns branch-specific version when viewing branch', async () => {
        const context: VersionContext = {
          type: 'branch',
          branchId: ecoBranchId,
        }

        const result = await VersionResolver.getItemAtContext(
          itemMasterId,
          designId,
          context,
        )

        expect(result).not.toBeNull()
        expect(result?.id).toBe(itemRevBId)
        expect(result?.revision).toBe('B')
        expect(result?.state).toBe('Draft')
      })

      it('falls back to main branch when item not modified on branch', async () => {
        // Create a new item that only exists on main
        const newMasterId = crypto.randomUUID()
        const [newItem] = await testDb.db
          .insert(items)
          .values({
            masterId: newMasterId,
            itemNumber: `${uniquePrefix}-PART-002`,
            revision: 'A',
            itemType: 'Part',
            name: 'Unmodified Part',
            state: 'Released',
            isCurrent: true,
            createdBy: user.id,
            modifiedBy: user.id,
            designId,
          })
          .returning()

        // Get main branch HEAD commit
        const mainBranch = await DesignService.getDefaultBranch(designId)

        // Add itemVersion for the new item
        await testDb.db.insert(itemVersions).values({
          itemId: newItem.id,
          commitId: mainBranch!.headCommitId!,
          changeType: 'added',
        })

        const context: VersionContext = {
          type: 'branch',
          branchId: ecoBranchId,
        }

        const result = await VersionResolver.getItemAtContext(
          newMasterId,
          designId,
          context,
        )

        // Should return the main branch version
        expect(result).not.toBeNull()
        expect(result?.id).toBe(newItem.id)
        expect(result?.revision).toBe('A')
      })
    })

    describe('tag context', () => {
      let tagId: string

      beforeEach(async () => {
        // Create a tag at the initial commit
        const mainBranch = await DesignService.getDefaultBranch(designId)
        const [tag] = await testDb.db
          .insert(tags)
          .values({
            designId,
            name: 'v1.0',
            commitId: mainBranch!.headCommitId!,
            createdBy: user.id,
          })
          .returning()

        tagId = tag.id
      })

      it('returns item at the tag commit', async () => {
        const context: VersionContext = { type: 'tag', tagId }

        const result = await VersionResolver.getItemAtContext(
          itemMasterId,
          designId,
          context,
        )

        expect(result).not.toBeNull()
        expect(result?.id).toBe(itemRevAId)
        expect(result?.revision).toBe('A')
      })

      it('returns null for non-existent tag', async () => {
        const context: VersionContext = {
          type: 'tag',
          tagId: NON_EXISTENT_UUID,
        }

        const result = await VersionResolver.getItemAtContext(
          itemMasterId,
          designId,
          context,
        )

        expect(result).toBeNull()
      })
    })

    describe('commit context', () => {
      it('returns item at the specific commit', async () => {
        const mainBranch = await DesignService.getDefaultBranch(designId)
        const context: VersionContext = {
          type: 'commit',
          commitId: mainBranch!.headCommitId!,
        }

        const result = await VersionResolver.getItemAtContext(
          itemMasterId,
          designId,
          context,
        )

        expect(result).not.toBeNull()
        expect(result?.id).toBe(itemRevAId)
        expect(result?.revision).toBe('A')
      })

      it('returns null for non-existent commit', async () => {
        const context: VersionContext = {
          type: 'commit',
          commitId: NON_EXISTENT_UUID,
        }

        const result = await VersionResolver.getItemAtContext(
          itemMasterId,
          designId,
          context,
        )

        expect(result).toBeNull()
      })
    })

    describe('item history across versions', () => {
      let commit2Id: string
      let itemRevBId: string

      beforeEach(async () => {
        // Create Rev B
        const [itemRevB] = await testDb.db
          .insert(items)
          .values({
            masterId: itemMasterId,
            itemNumber: `${uniquePrefix}-PART-001`,
            revision: 'B',
            itemType: 'Part',
            name: 'Test Part Rev B',
            state: 'Released',
            isCurrent: true,
            createdBy: user.id,
            modifiedBy: user.id,
            designId,
          })
          .returning()

        itemRevBId = itemRevB.id

        // Update Rev A to not be current
        await testDb.db
          .update(items)
          .set({ isCurrent: false })
          .where(eq(items.id, itemRevAId))

        // Create part-specific data for Rev B
        await testDb.db.insert(parts).values({
          itemId: itemRevB.id,
          description: 'Updated description',
          partType: 'Manufacture',
          material: 'Titanium',
        })

        // Create a second commit with Rev B using proper API
        // Note: CommitService.create already creates itemVersions entries
        const commit2 = await CommitService.create(
          {
            branchId: mainBranchId,
            message: 'Update part to Rev B',
            itemChanges: [
              {
                itemId: itemRevBId,
                changeType: 'modified',
                previousItemId: itemRevAId,
              },
            ],
          },
          user.id,
        )
        commit2Id = commit2.id
      })

      it('returns different versions at different commits', async () => {
        // At the latest commit, should return Rev B
        const latestContext: VersionContext = {
          type: 'commit',
          commitId: commit2Id,
        }
        const latestResult = await VersionResolver.getItemAtContext(
          itemMasterId,
          designId,
          latestContext,
        )

        expect(latestResult).not.toBeNull()
        expect(latestResult?.revision).toBe('B')
      })
    })
  })

  describe('resolveBranchContext', () => {
    let designId: string

    beforeEach(async () => {
      const design = await DesignService.create(
        {
          programId,
          name: 'Test Design',
          code: `${uniquePrefix}-DES`,
          designType: 'Engineering',
        },
        user.id,
      )
      designId = design.id
    })

    it('returns released context for "main" branch name', async () => {
      const context = await VersionResolver.resolveBranchContext(
        designId,
        'main',
      )

      expect(context).toEqual({ type: 'released', designId })
    })

    it('returns released context for "released" branch name', async () => {
      const context = await VersionResolver.resolveBranchContext(
        designId,
        'released',
      )

      expect(context).toEqual({ type: 'released', designId })
    })

    it('returns branch context for named branch', async () => {
      // Create a change order item first (required for ECO branch)
      const coMasterId = crypto.randomUUID()
      const [coItem] = await testDb.db
        .insert(items)
        .values({
          masterId: coMasterId,
          itemNumber: `${uniquePrefix}-ECO-002`,
          revision: 'A',
          itemType: 'ChangeOrder',
          name: 'Test ECO for Branch',
          state: 'Draft',
          isCurrent: true,
          createdBy: user.id,
          modifiedBy: user.id,
          designId,
        })
        .returning()

      // Create change order specific data
      await testDb.db.insert(changeOrders).values({
        itemId: coItem.id,
        changeType: 'ECO',
        priority: 'Medium',
      })

      // Create an ECO branch (name will be eco/ECO-002)
      const branch = await BranchService.createEcoBranch(
        designId,
        coItem.id,
        user.id,
      )

      const context = await VersionResolver.resolveBranchContext(
        designId,
        branch.name,
      )

      expect(context).toEqual({ type: 'branch', branchId: branch.id })
    })

    it('returns null for non-existent branch', async () => {
      const context = await VersionResolver.resolveBranchContext(
        designId,
        'non-existent-branch',
      )

      expect(context).toBeNull()
    })
  })

  describe('getItemsAtContext', () => {
    let designId: string
    let itemRevAId: string
    let initialCommitId: string

    beforeEach(async () => {
      // Create a design with main branch
      const design = await DesignService.create(
        {
          programId,
          name: 'Items Context Design',
          code: `${uniquePrefix}-ICD`,
          designType: 'Engineering',
        },
        user.id,
      )
      designId = design.id
      initialCommitId = design.initialCommit!.id

      // Create a part item
      const masterId = crypto.randomUUID()
      const [itemRevA] = await testDb.db
        .insert(items)
        .values({
          masterId,
          itemNumber: `${uniquePrefix}-IPART-001`,
          revision: 'A',
          itemType: 'Part',
          name: 'Test Part',
          state: 'Released',
          isCurrent: true,
          createdBy: user.id,
          modifiedBy: user.id,
          designId,
          commitId: initialCommitId,
        })
        .returning()

      itemRevAId = itemRevA.id

      // Add itemVersion entry
      await testDb.db.insert(itemVersions).values({
        itemId: itemRevA.id,
        commitId: initialCommitId,
        changeType: 'added',
      })
    })

    it('returns items at released context', async () => {
      const context: VersionContext = { type: 'released', designId }

      const result = await VersionResolver.getItemsAtContext(designId, context)

      expect(result.items.length).toBeGreaterThanOrEqual(1)
      expect(result.items.some((item) => item.id === itemRevAId)).toBe(true)
    })

    it('returns empty array for design with no commits', async () => {
      // Create design without committing items
      const emptyDesign = await DesignService.create(
        {
          programId,
          name: 'Empty Design',
          code: `${uniquePrefix}-EMPTY`,
          designType: 'Engineering',
        },
        user.id,
      )

      const context: VersionContext = {
        type: 'released',
        designId: emptyDesign.id,
      }

      const result = await VersionResolver.getItemsAtContext(
        emptyDesign.id,
        context,
      )

      // No items committed yet
      expect(result.items).toEqual([])
      expect(result.total).toBe(0)
    })

    it('applies itemType filter', async () => {
      // Create a document item
      const docMasterId = crypto.randomUUID()
      await testDb.db.insert(items).values({
        masterId: docMasterId,
        itemNumber: `${uniquePrefix}-DOC-001`,
        revision: 'A',
        itemType: 'Document',
        name: 'Test Document',
        state: 'Released',
        isCurrent: true,
        createdBy: user.id,
        modifiedBy: user.id,
        designId,
        commitId: initialCommitId,
      })

      // Add itemVersion entry
      const doc = await testDb.db
        .select()
        .from(items)
        .where(eq(items.masterId, docMasterId))
        .limit(1)

      await testDb.db.insert(itemVersions).values({
        itemId: doc[0].id,
        commitId: initialCommitId,
        changeType: 'added',
      })

      const context: VersionContext = { type: 'released', designId }

      const partsOnly = await VersionResolver.getItemsAtContext(
        designId,
        context,
        { itemType: 'Part' },
      )
      const docsOnly = await VersionResolver.getItemsAtContext(
        designId,
        context,
        { itemType: 'Document' },
      )

      expect(partsOnly.items.every((item) => item.itemType === 'Part')).toBe(
        true,
      )
      expect(docsOnly.items.every((item) => item.itemType === 'Document')).toBe(
        true,
      )
    })

    it('applies search filter', async () => {
      const context: VersionContext = { type: 'released', designId }

      const result = await VersionResolver.getItemsAtContext(
        designId,
        context,
        { search: 'IPART' },
      )

      expect(result.items.length).toBeGreaterThanOrEqual(1)
      expect(
        result.items.every(
          (item) =>
            item.itemNumber.includes('IPART') || item.name?.includes('IPART'),
        ),
      ).toBe(true)
    })

    it('applies pagination with limit and offset', async () => {
      // Create multiple items
      for (let i = 0; i < 3; i++) {
        const masterId = crypto.randomUUID()
        const [item] = await testDb.db
          .insert(items)
          .values({
            masterId,
            itemNumber: `${uniquePrefix}-PAGE-00${i}`,
            revision: 'A',
            itemType: 'Part',
            name: `Pagination Part ${i}`,
            state: 'Released',
            isCurrent: true,
            createdBy: user.id,
            modifiedBy: user.id,
            designId,
            commitId: initialCommitId,
          })
          .returning()

        await testDb.db.insert(itemVersions).values({
          itemId: item.id,
          commitId: initialCommitId,
          changeType: 'added',
        })
      }

      const context: VersionContext = { type: 'released', designId }

      const page1 = await VersionResolver.getItemsAtContext(designId, context, {
        limit: 2,
        offset: 0,
      })
      const page2 = await VersionResolver.getItemsAtContext(designId, context, {
        limit: 2,
        offset: 2,
      })

      expect(page1.items.length).toBeLessThanOrEqual(2)
      // Total should be consistent across pages
      expect(page1.total).toBe(page2.total)
      // Page 2 should have different items than page 1
      if (page1.items.length > 0 && page2.items.length > 0) {
        expect(page1.items[0].id).not.toBe(page2.items[0].id)
      }
    })

    it('returns items at tag context', async () => {
      // Create a tag
      const mainBranch = await DesignService.getDefaultBranch(designId)
      const [tag] = await testDb.db
        .insert(tags)
        .values({
          designId,
          name: 'v1.0-items',
          commitId: mainBranch!.headCommitId!,
          createdBy: user.id,
        })
        .returning()

      const context: VersionContext = { type: 'tag', tagId: tag.id }

      const result = await VersionResolver.getItemsAtContext(designId, context)

      expect(result.items.some((item) => item.id === itemRevAId)).toBe(true)
    })

    it('returns empty array for non-existent tag', async () => {
      const context: VersionContext = { type: 'tag', tagId: NON_EXISTENT_UUID }

      const result = await VersionResolver.getItemsAtContext(designId, context)

      expect(result.items).toEqual([])
      expect(result.total).toBe(0)
    })
  })

  describe('getReleasedItems fallback chain', () => {
    it('returns items via branchItems when no itemVersions exist', async () => {
      // Simulate pre-release data: items on main branch via branchItems but no commits with itemVersions
      const design = await DesignService.create(
        {
          programId,
          name: 'BranchItems Fallback Design',
          code: `${uniquePrefix}-BIFALL`,
          designType: 'Engineering',
        },
        user.id,
      )
      const mainBranch = await DesignService.getDefaultBranch(design.id)

      // Create a part assigned to this design
      const masterId = crypto.randomUUID()
      const [item] = await testDb.db
        .insert(items)
        .values({
          masterId,
          itemNumber: `${uniquePrefix}-FALL-001`,
          revision: 'A',
          itemType: 'Part',
          name: 'Fallback Part',
          state: 'Released',
          isCurrent: true,
          createdBy: user.id,
          modifiedBy: user.id,
          designId: design.id,
        })
        .returning()

      // Track on main branch via branchItems (but NOT in itemVersions)
      await testDb.db.insert(branchItems).values({
        branchId: mainBranch!.id,
        itemMasterId: masterId,
        currentItemId: item.id,
      })

      // Query released items - should find via branchItems fallback
      const context: VersionContext = { type: 'released', designId: design.id }
      const result = await VersionResolver.getItemsAtContext(design.id, context)

      expect(result.items.length).toBeGreaterThanOrEqual(1)
      expect(result.items.some((i) => i.id === item.id)).toBe(true)
    })

    it('returns items via isCurrent fallback when no branchItems exist', async () => {
      // Simulate data with no branchItems and no itemVersions - only isCurrent items
      const design = await DesignService.create(
        {
          programId,
          name: 'IsCurrent Fallback Design',
          code: `${uniquePrefix}-ICFALL`,
          designType: 'Engineering',
        },
        user.id,
      )

      // Create a part with isCurrent=true and designId set, but no branchItems tracking
      const masterId = crypto.randomUUID()
      const [item] = await testDb.db
        .insert(items)
        .values({
          masterId,
          itemNumber: `${uniquePrefix}-ICPART-001`,
          revision: 'A',
          itemType: 'Part',
          name: 'IsCurrent Part',
          state: 'Released',
          isCurrent: true,
          createdBy: user.id,
          modifiedBy: user.id,
          designId: design.id,
        })
        .returning()

      // No branchItems, no itemVersions - should find via isCurrent fallback
      const context: VersionContext = { type: 'released', designId: design.id }
      const result = await VersionResolver.getItemsAtContext(design.id, context)

      expect(result.items.length).toBeGreaterThanOrEqual(1)
      expect(result.items.some((i) => i.id === item.id)).toBe(true)
    })

    it('prefers commit-based resolution over fallbacks when itemVersions exist', async () => {
      // Standard case: items tracked in itemVersions should use commit-based resolution
      const design = await DesignService.create(
        {
          programId,
          name: 'Commit Priority Design',
          code: `${uniquePrefix}-CPRI`,
          designType: 'Engineering',
        },
        user.id,
      )
      const initialCommitId = design.initialCommit!.id

      // Create a part with itemVersion entry (standard path)
      const masterId = crypto.randomUUID()
      const [item] = await testDb.db
        .insert(items)
        .values({
          masterId,
          itemNumber: `${uniquePrefix}-CPRI-001`,
          revision: 'A',
          itemType: 'Part',
          name: 'Commit Priority Part',
          state: 'Released',
          isCurrent: true,
          createdBy: user.id,
          modifiedBy: user.id,
          designId: design.id,
          commitId: initialCommitId,
        })
        .returning()

      await testDb.db.insert(itemVersions).values({
        itemId: item.id,
        commitId: initialCommitId,
        changeType: 'added',
      })

      // Also create a DIFFERENT isCurrent item that should NOT appear
      // (commit-based resolution should take priority)
      const staleMasterId = crypto.randomUUID()
      await testDb.db.insert(items).values({
        masterId: staleMasterId,
        itemNumber: `${uniquePrefix}-CPRI-STALE`,
        revision: 'A',
        itemType: 'Part',
        name: 'Stale Part',
        state: 'Released',
        isCurrent: true,
        createdBy: user.id,
        modifiedBy: user.id,
        designId: design.id,
        // No commitId, no itemVersion - only exists via isCurrent
      })

      const context: VersionContext = { type: 'released', designId: design.id }
      const result = await VersionResolver.getItemsAtContext(design.id, context)

      // Should find the committed item
      expect(result.items.some((i) => i.id === item.id)).toBe(true)
      // Should NOT include the stale item (commit-based resolution takes priority)
      expect(result.items.some((i) => i.masterId === staleMasterId)).toBe(false)
    })

    it('returns empty for design with no items at all', async () => {
      const design = await DesignService.create(
        {
          programId,
          name: 'Empty Items Design',
          code: `${uniquePrefix}-EMPTY2`,
          designType: 'Engineering',
        },
        user.id,
      )

      const context: VersionContext = { type: 'released', designId: design.id }
      const result = await VersionResolver.getItemsAtContext(design.id, context)

      expect(result.items).toEqual([])
      expect(result.total).toBe(0)
    })
  })

  describe('getContextDescription', () => {
    let designId: string

    beforeEach(async () => {
      const design = await DesignService.create(
        {
          programId,
          name: 'Context Desc Design',
          code: `${uniquePrefix}-CTX`,
          designType: 'Engineering',
        },
        user.id,
      )
      designId = design.id
    })

    it('returns "Released (main)" for released context', async () => {
      const context: VersionContext = { type: 'released', designId }

      const description = await VersionResolver.getContextDescription(context)

      expect(description).toBe('Released (main)')
    })

    it('returns branch name for branch context', async () => {
      // Create ECO branch
      const coMasterId = crypto.randomUUID()
      const [coItem] = await testDb.db
        .insert(items)
        .values({
          masterId: coMasterId,
          itemNumber: `${uniquePrefix}-ECO-CTX`,
          revision: 'A',
          itemType: 'ChangeOrder',
          name: 'Context ECO',
          state: 'Draft',
          isCurrent: true,
          createdBy: user.id,
          modifiedBy: user.id,
          designId,
        })
        .returning()

      await testDb.db.insert(changeOrders).values({
        itemId: coItem.id,
        changeType: 'ECO',
        priority: 'Medium',
      })

      const branch = await BranchService.createEcoBranch(
        designId,
        coItem.id,
        user.id,
      )
      const context: VersionContext = { type: 'branch', branchId: branch.id }

      const description = await VersionResolver.getContextDescription(context)

      expect(description).toContain('Branch:')
      expect(description).toContain(branch.name)
    })

    it('returns "Unknown branch" for non-existent branch', async () => {
      const context: VersionContext = {
        type: 'branch',
        branchId: NON_EXISTENT_UUID,
      }

      const description = await VersionResolver.getContextDescription(context)

      expect(description).toBe('Unknown branch')
    })

    it('returns commit message for commit context', async () => {
      const mainBranch = await DesignService.getDefaultBranch(designId)
      const context: VersionContext = {
        type: 'commit',
        commitId: mainBranch!.headCommitId!,
      }

      const description = await VersionResolver.getContextDescription(context)

      expect(description).toContain('Commit:')
    })

    it('returns "Unknown commit" for non-existent commit', async () => {
      const context: VersionContext = {
        type: 'commit',
        commitId: NON_EXISTENT_UUID,
      }

      const description = await VersionResolver.getContextDescription(context)

      expect(description).toBe('Unknown commit')
    })

    it('returns tag name for tag context', async () => {
      const mainBranch = await DesignService.getDefaultBranch(designId)
      const [tag] = await testDb.db
        .insert(tags)
        .values({
          designId,
          name: 'release-1.0',
          commitId: mainBranch!.headCommitId!,
          createdBy: user.id,
        })
        .returning()

      const context: VersionContext = { type: 'tag', tagId: tag.id }

      const description = await VersionResolver.getContextDescription(context)

      expect(description).toContain('Tag:')
      expect(description).toContain('release-1.0')
    })

    it('returns "Unknown tag" for non-existent tag', async () => {
      const context: VersionContext = { type: 'tag', tagId: NON_EXISTENT_UUID }

      const description = await VersionResolver.getContextDescription(context)

      expect(description).toBe('Unknown tag')
    })
  })

  describe('getAvailableContextsForItem', () => {
    let designId: string
    let itemMasterId: string
    let initialCommitId: string

    beforeEach(async () => {
      const design = await DesignService.create(
        {
          programId,
          name: 'Available Contexts Design',
          code: `${uniquePrefix}-AVAIL`,
          designType: 'Engineering',
        },
        user.id,
      )
      designId = design.id
      initialCommitId = design.initialCommit!.id

      // Create a part
      const masterId = crypto.randomUUID()
      const [item] = await testDb.db
        .insert(items)
        .values({
          masterId,
          itemNumber: `${uniquePrefix}-AVAIL-001`,
          revision: 'A',
          itemType: 'Part',
          name: 'Available Part',
          state: 'Released',
          isCurrent: true,
          createdBy: user.id,
          modifiedBy: user.id,
          designId,
          commitId: initialCommitId,
        })
        .returning()

      itemMasterId = masterId

      // Add itemVersion entry
      await testDb.db.insert(itemVersions).values({
        itemId: item.id,
        commitId: initialCommitId,
        changeType: 'added',
      })
    })

    it('returns main branch with item existing', async () => {
      const contexts = await VersionResolver.getAvailableContextsForItem(
        itemMasterId,
        designId,
      )

      expect(contexts.branches.length).toBeGreaterThanOrEqual(1)
      const mainBranch = contexts.branches.find((b) => b.branchType === 'main')
      expect(mainBranch).toBeDefined()
      expect(mainBranch?.exists).toBe(true)
    })

    it('returns tags where item exists', async () => {
      const mainBranch = await DesignService.getDefaultBranch(designId)
      await testDb.db.insert(tags).values({
        designId,
        name: 'avail-tag',
        commitId: mainBranch!.headCommitId!,
        createdBy: user.id,
      })

      const contexts = await VersionResolver.getAvailableContextsForItem(
        itemMasterId,
        designId,
      )

      expect(contexts.tags.length).toBeGreaterThanOrEqual(1)
      const tagContext = contexts.tags.find((t) => t.name === 'avail-tag')
      expect(tagContext?.exists).toBe(true)
    })

    it('marks ECO branch with exists=true only when item is tracked', async () => {
      // Create ECO branch
      const coMasterId = crypto.randomUUID()
      const [coItem] = await testDb.db
        .insert(items)
        .values({
          masterId: coMasterId,
          itemNumber: `${uniquePrefix}-ECO-AVAIL`,
          revision: 'A',
          itemType: 'ChangeOrder',
          name: 'Avail ECO',
          state: 'Draft',
          isCurrent: true,
          createdBy: user.id,
          modifiedBy: user.id,
          designId,
        })
        .returning()

      await testDb.db.insert(changeOrders).values({
        itemId: coItem.id,
        changeType: 'ECO',
        priority: 'Medium',
      })

      const ecoBranch = await BranchService.createEcoBranch(
        designId,
        coItem.id,
        user.id,
      )

      // Without tracking the item on ECO branch
      let contexts = await VersionResolver.getAvailableContextsForItem(
        itemMasterId,
        designId,
      )
      let ecoBranchContext = contexts.branches.find(
        (b) => b.id === ecoBranch.id,
      )
      expect(ecoBranchContext?.exists).toBe(false)

      // Track the item on ECO branch
      await testDb.db.insert(branchItems).values({
        branchId: ecoBranch.id,
        itemMasterId,
        currentItemId: (
          await testDb.db
            .select()
            .from(items)
            .where(eq(items.masterId, itemMasterId))
            .limit(1)
        )[0].id,
        changeType: 'modified',
      })

      // Now item should exist on ECO branch
      contexts = await VersionResolver.getAvailableContextsForItem(
        itemMasterId,
        designId,
      )
      ecoBranchContext = contexts.branches.find((b) => b.id === ecoBranch.id)
      expect(ecoBranchContext?.exists).toBe(true)
    })

    it('returns empty arrays for non-existent item', async () => {
      const contexts = await VersionResolver.getAvailableContextsForItem(
        NON_EXISTENT_UUID,
        designId,
      )

      // Main branch should still be returned but exists=false
      const mainBranch = contexts.branches.find((b) => b.branchType === 'main')
      expect(mainBranch?.exists).toBe(false)
    })
  })

  describe('getBranchItems', () => {
    let designId: string
    let ecoBranchId: string
    let itemMasterId: string
    let branchItemId: string
    let initialCommitId: string

    beforeEach(async () => {
      const design = await DesignService.create(
        {
          programId,
          name: 'Branch Items Design',
          code: `${uniquePrefix}-BITEMS`,
          designType: 'Engineering',
        },
        user.id,
      )
      designId = design.id
      initialCommitId = design.initialCommit!.id

      // Create a part on main
      const masterId = crypto.randomUUID()
      const [mainItem] = await testDb.db
        .insert(items)
        .values({
          masterId,
          itemNumber: `${uniquePrefix}-BITEM-001`,
          revision: 'A',
          itemType: 'Part',
          name: 'Main Part',
          state: 'Released',
          isCurrent: true,
          createdBy: user.id,
          modifiedBy: user.id,
          designId,
          commitId: initialCommitId,
        })
        .returning()

      itemMasterId = masterId

      await testDb.db.insert(itemVersions).values({
        itemId: mainItem.id,
        commitId: initialCommitId,
        changeType: 'added',
      })

      // Create ECO branch
      const coMasterId = crypto.randomUUID()
      const [coItem] = await testDb.db
        .insert(items)
        .values({
          masterId: coMasterId,
          itemNumber: `${uniquePrefix}-ECO-BITEM`,
          revision: 'A',
          itemType: 'ChangeOrder',
          name: 'Branch Items ECO',
          state: 'Draft',
          isCurrent: true,
          createdBy: user.id,
          modifiedBy: user.id,
          designId,
        })
        .returning()

      await testDb.db.insert(changeOrders).values({
        itemId: coItem.id,
        changeType: 'ECO',
        priority: 'Medium',
      })

      const ecoBranch = await BranchService.createEcoBranch(
        designId,
        coItem.id,
        user.id,
      )
      ecoBranchId = ecoBranch.id

      // Create modified version on branch
      const [branchItem] = await testDb.db
        .insert(items)
        .values({
          masterId,
          itemNumber: `${uniquePrefix}-BITEM-001`,
          revision: 'B',
          itemType: 'Part',
          name: 'Modified Part',
          state: 'Draft',
          isCurrent: false,
          createdBy: user.id,
          modifiedBy: user.id,
          designId,
        })
        .returning()

      branchItemId = branchItem.id

      // Track on branch
      await testDb.db.insert(branchItems).values({
        branchId: ecoBranchId,
        itemMasterId: masterId,
        currentItemId: branchItem.id,
        changeType: 'modified',
      })
    })

    it('returns branch-specific versions for modified items', async () => {
      const result = await VersionResolver.getBranchItems(ecoBranchId)

      const modifiedItem = result.items.find((i) => i.masterId === itemMasterId)
      expect(modifiedItem?.id).toBe(branchItemId)
      expect(modifiedItem?.revision).toBe('B')
    })

    it('returns empty array for non-existent branch', async () => {
      const result = await VersionResolver.getBranchItems(NON_EXISTENT_UUID)

      expect(result.items).toEqual([])
      expect(result.total).toBe(0)
    })

    it('includes items added on branch', async () => {
      // Add a new item on the branch
      const newMasterId = crypto.randomUUID()
      const [newItem] = await testDb.db
        .insert(items)
        .values({
          masterId: newMasterId,
          itemNumber: `${uniquePrefix}-BITEM-NEW`,
          revision: 'A',
          itemType: 'Part',
          name: 'New Branch Part',
          state: 'Draft',
          isCurrent: false,
          createdBy: user.id,
          modifiedBy: user.id,
          designId,
        })
        .returning()

      await testDb.db.insert(branchItems).values({
        branchId: ecoBranchId,
        itemMasterId: newMasterId,
        currentItemId: newItem.id,
        changeType: 'added',
      })

      const result = await VersionResolver.getBranchItems(ecoBranchId)

      const addedItem = result.items.find((i) => i.masterId === newMasterId)
      expect(addedItem).toBeDefined()
      expect(addedItem?.name).toBe('New Branch Part')
    })

    it('excludes deleted items', async () => {
      // Mark item as deleted on branch
      await testDb.db
        .update(branchItems)
        .set({ changeType: 'deleted' })
        .where(eq(branchItems.branchId, ecoBranchId))

      const result = await VersionResolver.getBranchItems(ecoBranchId)

      const deletedItem = result.items.find((i) => i.masterId === itemMasterId)
      expect(deletedItem).toBeUndefined()
    })
  })
})
