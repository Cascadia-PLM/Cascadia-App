// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

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
import type {
  ItemFilters,
  PaginatedItemsResult,
  VersionContext,
} from './VersionResolver'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { setTestDb } from '@/lib/db'
import { takeFirst } from '@/lib/db/take-first'
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
      designId = design.id!
      mainBranchId = design.mainBranch!.id

      // Create a part item (Rev A)
      const masterId = crypto.randomUUID()
      const itemRevA = takeFirst(
        await testDb.db
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
          .returning(),
      )

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
        const coItem = takeFirst(
          await testDb.db
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
            .returning(),
        )

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
        const itemRevB = takeFirst(
          await testDb.db
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
            .returning(),
        )

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
        const newItem = takeFirst(
          await testDb.db
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
            .returning(),
        )

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
        const tag = takeFirst(
          await testDb.db
            .insert(tags)
            .values({
              designId,
              name: 'v1.0',
              commitId: mainBranch!.headCommitId!,
              createdBy: user.id,
            })
            .returning(),
        )

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
        const itemRevB = takeFirst(
          await testDb.db
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
            .returning(),
        )

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
      designId = design.id!
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
      const coItem = takeFirst(
        await testDb.db
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
          .returning(),
      )

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
      designId = design.id!
      initialCommitId = design.initialCommit!.id

      // Create a part item
      const masterId = crypto.randomUUID()
      const itemRevA = takeFirst(
        await testDb.db
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
          .returning(),
      )

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
        itemId: doc[0]!.id,
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
        const item = takeFirst(
          await testDb.db
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
            .returning(),
        )

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
        expect(page1.items[0]!.id).not.toBe(page2.items[0]!.id)
      }
    })

    it('returns items at tag context', async () => {
      // Create a tag
      const mainBranch = await DesignService.getDefaultBranch(designId)
      const tag = takeFirst(
        await testDb.db
          .insert(tags)
          .values({
            designId,
            name: 'v1.0-items',
            commitId: mainBranch!.headCommitId!,
            createdBy: user.id,
          })
          .returning(),
      )

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

  describe('released context excludes unreleased working copies', () => {
    it('does not serve a branch working copy as the released version', async () => {
      const design = await DesignService.create(
        {
          programId,
          name: 'Draft Leak Design',
          code: `${uniquePrefix}-LEAK`,
          designType: 'Engineering',
        },
        user.id,
      )

      // An item that only ever existed on a branch: no commit on main links
      // it, so the commit walk finds nothing and the direct-query fallbacks
      // answer instead. Carrying isCurrent and a branch working revision,
      // it used to come back as this design's released version.
      const masterId = crypto.randomUUID()
      await testDb.db.insert(items).values({
        masterId,
        itemNumber: `${uniquePrefix}-LEAK-001`,
        revision: '-abcd1234',
        itemType: 'Part',
        name: 'Only on a branch',
        state: 'Draft',
        isCurrent: true,
        createdBy: user.id,
        modifiedBy: user.id,
        designId: design.id,
      })

      const resolved = await VersionResolver.getReleasedVersion(
        masterId,
        design.id,
      )
      expect(resolved).toBeNull()

      const listed = await VersionResolver.getItemsAtContext(design.id, {
        type: 'released',
        designId: design.id,
      })
      expect(listed.items.some((i) => i.masterId === masterId)).toBe(false)
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
      const item = takeFirst(
        await testDb.db
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
          .returning(),
      )

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
      const item = takeFirst(
        await testDb.db
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
          .returning(),
      )

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
      const item = takeFirst(
        await testDb.db
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
          .returning(),
      )

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
      designId = design.id!
    })

    it('returns "Released (main)" for released context', async () => {
      const context: VersionContext = { type: 'released', designId }

      const description = await VersionResolver.getContextDescription(context)

      expect(description).toBe('Released (main)')
    })

    it('returns branch name for branch context', async () => {
      // Create ECO branch
      const coMasterId = crypto.randomUUID()
      const coItem = takeFirst(
        await testDb.db
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
          .returning(),
      )

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
      const tag = takeFirst(
        await testDb.db
          .insert(tags)
          .values({
            designId,
            name: 'release-1.0',
            commitId: mainBranch!.headCommitId!,
            createdBy: user.id,
          })
          .returning(),
      )

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
      designId = design.id!
      initialCommitId = design.initialCommit!.id

      // Create a part
      const masterId = crypto.randomUUID()
      const item = takeFirst(
        await testDb.db
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
          .returning(),
      )

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
      const coItem = takeFirst(
        await testDb.db
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
          .returning(),
      )

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
        )[0]!.id,
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
      designId = design.id!
      initialCommitId = design.initialCommit!.id

      // Create a part on main
      const masterId = crypto.randomUUID()
      const mainItem = takeFirst(
        await testDb.db
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
          .returning(),
      )

      itemMasterId = masterId

      await testDb.db.insert(itemVersions).values({
        itemId: mainItem.id,
        commitId: initialCommitId,
        changeType: 'added',
      })

      // Create ECO branch
      const coMasterId = crypto.randomUUID()
      const coItem = takeFirst(
        await testDb.db
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
          .returning(),
      )

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
      const branchItem = takeFirst(
        await testDb.db
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
          .returning(),
      )

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
      const newItem = takeFirst(
        await testDb.db
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
          .returning(),
      )

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

  describe('deterministic commit-ancestry resolution (VER-4)', () => {
    let designId: string
    let mainBranchId: string
    let initialCommitId: string

    beforeEach(async () => {
      const design = await DesignService.create(
        {
          programId,
          name: 'Ancestry Design',
          code: `${uniquePrefix}-ANC`,
          designType: 'Engineering',
        },
        user.id,
      )
      designId = design.id!
      mainBranchId = design.mainBranch!.id
      initialCommitId = design.initialCommit!.id
    })

    async function insertRow(input: {
      masterId: string
      itemNumber: string
      revision: string
      name: string
      createdAt: Date
      isCurrent: boolean
    }) {
      return takeFirst(
        await testDb.db
          .insert(items)
          .values({
            masterId: input.masterId,
            itemNumber: input.itemNumber,
            revision: input.revision,
            itemType: 'Part',
            name: input.name,
            state: 'Released',
            isCurrent: input.isCurrent,
            createdBy: user.id,
            modifiedBy: user.id,
            designId,
            createdAt: input.createdAt,
          })
          .returning(),
      )
    }

    /**
     * The in-place-promotion interleaving that split the grid from the
     * detail page: ECO-1 mints a working copy at T1; ECO-2 releases rev B at
     * T2 > T1; ECO-1's promotion then updates the T1 row in place to rev C
     * with a NEWER commit — so the newest revision carries the OLDEST
     * createdAt, and a createdAt sort serves rev B while the ancestry walk
     * serves rev C.
     */
    async function seedPromotionInterleaving() {
      const masterId = crypto.randomUUID()
      const number = `${uniquePrefix}-INTERLEAVE`

      const revA = await insertRow({
        masterId,
        itemNumber: number,
        revision: 'A',
        name: 'Rev A',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        isCurrent: true,
      })
      await testDb.db.insert(itemVersions).values({
        itemId: revA.id,
        commitId: initialCommitId,
        changeType: 'added',
      })

      // ECO-1's working copy, minted first (T1) — not current, no commit yet.
      const workingCopy = await insertRow({
        masterId,
        itemNumber: number,
        revision: '-ab12cd34',
        name: 'ECO-1 working copy',
        createdAt: new Date('2026-01-02T00:00:00Z'),
        isCurrent: false,
      })

      // ECO-2 releases rev B second (T2), committing on main.
      const revB = await insertRow({
        masterId,
        itemNumber: number,
        revision: 'B',
        name: 'Rev B',
        createdAt: new Date('2026-01-03T00:00:00Z'),
        isCurrent: false,
      })
      await testDb.db
        .update(items)
        .set({ isCurrent: false })
        .where(eq(items.id, revA.id))
      await testDb.db
        .update(items)
        .set({ isCurrent: true })
        .where(eq(items.id, revB.id))
      const commitB = await CommitService.create(
        {
          branchId: mainBranchId,
          message: 'ECO-2 releases rev B',
          itemChanges: [
            {
              itemId: revB.id,
              changeType: 'modified',
              previousItemId: revA.id,
            },
          ],
        },
        user.id,
      )

      // ECO-1's release promotes the working copy IN PLACE to rev C — its
      // createdAt stays at T1 while its commit moves ahead of rev B's.
      await testDb.db
        .update(items)
        .set({ isCurrent: false })
        .where(eq(items.id, revB.id))
      await testDb.db
        .update(items)
        .set({ revision: 'C', isCurrent: true })
        .where(eq(items.id, workingCopy.id))
      const commitC = await CommitService.create(
        {
          branchId: mainBranchId,
          message: 'ECO-1 promotes to rev C',
          itemChanges: [
            {
              itemId: workingCopy.id,
              changeType: 'modified',
              previousItemId: revB.id,
            },
          ],
        },
        user.id,
      )

      return {
        masterId,
        revA,
        revB,
        promoted: workingCopy,
        commits: [initialCommitId, commitB.id, commitC.id],
        headCommitId: commitC.id,
      }
    }

    it('the grid and the detail page agree after an in-place promotion, on rev C', async () => {
      const fixture = await seedPromotionInterleaving()

      const single = await VersionResolver.getItemAtCommit(
        fixture.masterId,
        fixture.headCommitId,
      )
      const list = await VersionResolver.getItemsAtCommit(fixture.headCommitId)
      const listRow = list.items.find((i) => i.masterId === fixture.masterId)

      expect(single).not.toBeNull()
      expect(listRow).toBeDefined()
      // Same row, and it is the promotion — not the other ECO's earlier
      // release that createdAt-ordering used to serve.
      expect(listRow!.id).toBe(single!.id)
      expect(listRow!.revision).toBe('C')
      expect(listRow!.id).toBe(fixture.promoted.id)
    })

    it('getItemsAtCommit and getItemAtCommit agree at every commit in the history', async () => {
      const fixture = await seedPromotionInterleaving()

      for (const commitId of fixture.commits) {
        const single = await VersionResolver.getItemAtCommit(
          fixture.masterId,
          commitId,
        )
        const list = await VersionResolver.getItemsAtCommit(commitId)
        const listRow = list.items.find((i) => i.masterId === fixture.masterId)
        expect(listRow?.id, `at commit ${commitId}`).toBe(single?.id)
      }
    })

    it('resolves the same commit to identical item sets in identical order, repeatedly', async () => {
      const fixture = await seedPromotionInterleaving()

      const first = (
        await VersionResolver.getItemsAtCommit(fixture.headCommitId)
      ).items.map((i) => i.id)
      expect(first.length).toBeGreaterThan(0)
      for (let run = 0; run < 19; run++) {
        const next = (
          await VersionResolver.getItemsAtCommit(fixture.headCommitId)
        ).items.map((i) => i.id)
        expect(next).toEqual(first)
      }
    })

    it('getReleasedVersion returns the same row across repeated calls when candidates tie', async () => {
      // No commits carry this master, so resolution lands in the direct
      // fallbacks — where two non-current rows share the sort window.
      const masterId = crypto.randomUUID()
      const number = `${uniquePrefix}-TIE`
      const shared = new Date('2026-02-01T00:00:00Z')
      for (const revision of ['A', 'B']) {
        const row = await insertRow({
          masterId,
          itemNumber: number,
          revision,
          name: `Tie ${revision}`,
          createdAt: shared,
          isCurrent: false,
        })
        await testDb.db
          .update(items)
          .set({ modifiedAt: shared })
          .where(eq(items.id, row.id))
      }

      const first = await VersionResolver.getReleasedVersion(masterId, designId)
      expect(first).not.toBeNull()
      for (let run = 0; run < 19; run++) {
        const next = await VersionResolver.getReleasedVersion(
          masterId,
          designId,
        )
        expect(next?.id).toBe(first!.id)
      }
    })
  })

  /**
   * VER-6 pushed commit resolution into SQL. These compare the two paths on a
   * dataset big enough that the difference matters, and pin the statement
   * count so a later edit cannot quietly reintroduce "load the whole design,
   * then filter it in Node".
   */
  describe('SQL commit resolution matches the in-memory path', () => {
    // The in-memory resolver is a private fallback, reached here by name
    // because it is the reference these tests exist to compare against.
    const resolveInMemory = (
      VersionResolver as unknown as {
        getItemsAtCommitInMemory: (
          commitId: string,
          filters?: ItemFilters,
        ) => Promise<PaginatedItemsResult>
      }
    ).getItemsAtCommitInMemory.bind(VersionResolver)

    const MASTERS = 200
    let designId: string
    let mainBranchId: string
    let history: Array<string>

    /** Ids only, so a mismatch reports something a human can read. */
    const idsOf = (result: PaginatedItemsResult) =>
      result.items.map((item) => item.id)

    beforeEach(async () => {
      const design = await DesignService.create(
        {
          programId,
          name: 'Equivalence Design',
          code: `${uniquePrefix}-EQV`,
          designType: 'Engineering',
        },
        user.id,
      )
      designId = design.id
      mainBranchId = design.mainBranch!.id
      history = [design.initialCommit!.id]

      const masterIds = Array.from({ length: MASTERS }, () =>
        crypto.randomUUID(),
      )

      // Three revisions per master, each landing in its own commit and
      // staggered across three lanes, so no commit holds every master and the
      // ancestry walk reaches back a different distance for each one.
      for (const [wave, revision] of ['A', 'B', 'C'].entries()) {
        for (const lane of [0, 1, 2]) {
          const changes: Array<{
            itemId: string
            changeType: 'added' | 'modified'
          }> = []

          for (const [index, masterId] of masterIds.entries()) {
            if (index % 3 !== lane) continue
            const row = takeFirst(
              await testDb.db
                .insert(items)
                .values({
                  masterId,
                  itemNumber: `${uniquePrefix}-EQ-${String(index).padStart(4, '0')}`,
                  revision,
                  itemType: index % 5 === 0 ? 'Document' : 'Part',
                  name: `Equivalence item ${index} rev ${revision}`,
                  state: index % 4 === 0 ? 'In Work' : 'Released',
                  isCurrent: false,
                  createdBy: user.id,
                  modifiedBy: user.id,
                  designId,
                })
                .returning(),
            )
            changes.push({
              itemId: row.id,
              changeType: wave === 0 ? 'added' : 'modified',
            })
          }

          const commit = await CommitService.create(
            {
              branchId: mainBranchId,
              message: `wave ${wave} lane ${lane}`,
              itemChanges: changes,
            },
            user.id,
          )
          history.push(commit.id)
        }
      }

      // A final commit retiring a slice, so the "winning version is a delete"
      // arm is live at the tip and absent from every commit before it.
      const designRows = await testDb.db
        .select()
        .from(items)
        .where(eq(items.designId, designId))
      const deletions = designRows
        .filter((row) => row.revision === 'C')
        .slice(0, 20)
        .map((row) => ({ itemId: row.id, changeType: 'deleted' as const }))

      const deleteCommit = await CommitService.create(
        {
          branchId: mainBranchId,
          message: 'retire a slice',
          itemChanges: deletions,
        },
        user.id,
      )
      history.push(deleteCommit.id)
    })

    it('returns the same items as the in-memory path at every commit', async () => {
      expect(history.length).toBeGreaterThanOrEqual(10)

      for (const commitId of history) {
        const sqlPath = await VersionResolver.getItemsAtCommit(commitId)
        const oracle = await resolveInMemory(commitId)

        expect(sqlPath.total, `total at ${commitId}`).toBe(oracle.total)
        // The in-memory path returns rows in whatever order an unordered
        // SELECT yielded, so the comparable quantity is the set.
        expect(idsOf(sqlPath).sort(), `items at ${commitId}`).toEqual(
          idsOf(oracle).sort(),
        )
      }
    })

    it('returns the same items as the in-memory path under filters', async () => {
      const tip = history[history.length - 1]!
      const filterSets: Array<ItemFilters> = [
        { itemType: 'Part' },
        { itemType: 'Document' },
        { state: 'Released' },
        { state: 'In Work', itemType: 'Part' },
        { search: 'EQ-0001' },
        { globalSearch: 'rev C' },
        { search: 'EQ-00', state: 'Released' },
        { search: 'no such item anywhere' },
      ]

      for (const filters of filterSets) {
        const label = JSON.stringify(filters)
        const sqlPath = await VersionResolver.getItemsAtCommit(tip, filters)
        const oracle = await resolveInMemory(tip, filters)

        expect(sqlPath.total, `total for ${label}`).toBe(oracle.total)
        expect(idsOf(sqlPath).sort(), `items for ${label}`).toEqual(
          idsOf(oracle).sort(),
        )
      }
    })

    it('treats LIKE wildcards in a search term as literal characters', async () => {
      const tip = history[history.length - 1]!
      // `_` is a single-character wildcard to ILIKE and an ordinary character
      // to String.includes. Both paths must find nothing.
      for (const term of ['EQ_0001', 'EQ%0001']) {
        const sqlPath = await VersionResolver.getItemsAtCommit(tip, {
          search: term,
        })
        const oracle = await resolveInMemory(tip, { search: term })
        expect(sqlPath.total, `total for ${term}`).toBe(oracle.total)
        expect(sqlPath.total, `${term} must not match as a wildcard`).toBe(0)
      }
    })

    it('does not fall through to the fallback chain on an empty page', async () => {
      // `getReleasedItems` decides whether commit resolution worked by asking
      // whether it returned any rows. Paginate past the end and it returns
      // none — which is not the same as "commit resolution found nothing", and
      // used to send the query on to the branchItems fallback to be answered
      // from a different source.
      const all = await VersionResolver.getReleasedItems(designId)
      expect(all.total).toBeGreaterThan(0)

      const pastTheEnd = await VersionResolver.getReleasedItems(designId, {
        limit: 50,
        offset: all.total + 50,
      })

      expect(pastTheEnd.items).toEqual([])
      expect(pastTheEnd.total, 'the count is of the whole set').toBe(all.total)
    })

    it('paginates over a stable order', async () => {
      const tip = history[history.length - 1]!
      const all = await VersionResolver.getItemsAtCommit(tip)

      const pageSize = 50
      const walked: Array<string> = []
      for (let offset = 0; offset < all.total; offset += pageSize) {
        const page = await VersionResolver.getItemsAtCommit(tip, {
          limit: pageSize,
          offset,
        })
        expect(page.total, 'total is the pre-pagination count').toBe(all.total)
        expect(page.items.length).toBeLessThanOrEqual(pageSize)
        walked.push(...idsOf(page))
      }

      // Walking the pages reproduces the whole set exactly once. That is the
      // property an unordered LIMIT/OFFSET cannot promise, and the reason this
      // path orders by item_number rather than by nothing.
      expect(walked).toEqual(idsOf(all))
      expect(new Set(walked).size).toBe(walked.length)
    })

    it('serves a page with one resolution query and no full-design read', async () => {
      const tip = history[history.length - 1]!

      // Every row the database hands back to Node, per statement. `db` is a
      // proxy over an injectable handle, so the harness's own injection point
      // is where a counting wrapper goes — `vi.spyOn` cannot see through it.
      const rowsReturned: Array<number> = []
      const inner = testDb.db
      const count = <T>(result: T): T => {
        if (Array.isArray(result)) rowsReturned.push(result.length)
        return result
      }

      setTestDb(
        new Proxy(inner, {
          get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver) as unknown
            if (prop === 'execute' && typeof value === 'function') {
              return (...args: Array<unknown>) =>
                (value as (...a: Array<unknown>) => Promise<unknown>)
                  .apply(target, args)
                  .then(count)
            }
            if (prop === 'select' && typeof value === 'function') {
              return (...args: Array<unknown>) => {
                const builder = (
                  value as (...a: Array<unknown>) => Record<string, unknown>
                ).apply(target, args)
                return new Proxy(builder, {
                  get(b, p, r) {
                    if (p === 'then') {
                      return (
                        onOk?: (v: unknown) => unknown,
                        onErr?: (e: unknown) => unknown,
                      ) =>
                        Promise.resolve(b as unknown as PromiseLike<unknown>)
                          .then(count)
                          .then(onOk, onErr)
                    }
                    return Reflect.get(b, p, r) as unknown
                  },
                })
              }
            }
            return value
          },
        }),
      )

      try {
        const page = await VersionResolver.getItemsAtCommit(tip, { limit: 50 })
        expect(page.items.length).toBe(50)
        expect(page.total).toBeGreaterThan(150)
      } finally {
        setTestDb(inner)
      }

      // Two statements: the resolution query and the hydration select. The
      // in-memory path issues three, two of which return every item and every
      // item-version in the design.
      expect(rowsReturned.length).toBeLessThanOrEqual(3)

      // Nothing came back bigger than the page. This is the property VER-6 is
      // for: a fifty-row page no longer costs a full-design read into Node.
      // The design here holds well over 500 item rows.
      for (const size of rowsReturned) {
        expect(size).toBeLessThanOrEqual(50)
      }
    })
  })

  /**
   * The branch overlay — main's contents with this branch's versions
   * substituted in — also moved into SQL. The four cases the in-memory merge
   * distinguishes are subtle enough that these compare the two directly on a
   * branch carrying all of them at once.
   */
  describe('SQL branch overlay matches the in-memory merge', () => {
    const mergeInMemory = (
      VersionResolver as unknown as {
        getBranchItemsInMemory: (
          branchId: string,
          filters?: ItemFilters,
        ) => Promise<PaginatedItemsResult>
      }
    ).getBranchItemsInMemory.bind(VersionResolver)

    let designId: string
    let ecoBranchId: string

    const idsOf = (result: PaginatedItemsResult) =>
      result.items.map((item) => item.id).sort()

    beforeEach(async () => {
      const design = await DesignService.create(
        {
          programId,
          name: 'Overlay Design',
          code: `${uniquePrefix}-OVL`,
          designType: 'Engineering',
        },
        user.id,
      )
      designId = design.id
      const mainBranchId = design.mainBranch!.id

      // Sixty masters released on main.
      const masterIds = Array.from({ length: 60 }, () => crypto.randomUUID())
      const releasedIds: Array<string> = []
      const changes: Array<{ itemId: string; changeType: 'added' }> = []

      for (const [index, masterId] of masterIds.entries()) {
        const row = takeFirst(
          await testDb.db
            .insert(items)
            .values({
              masterId,
              itemNumber: `${uniquePrefix}-OV-${String(index).padStart(3, '0')}`,
              revision: 'A',
              itemType: index % 4 === 0 ? 'Document' : 'Part',
              name: `Overlay item ${index}`,
              state: 'Released',
              isCurrent: true,
              createdBy: user.id,
              modifiedBy: user.id,
              designId,
            })
            .returning(),
        )
        releasedIds.push(row.id)
        changes.push({ itemId: row.id, changeType: 'added' })
      }

      await CommitService.create(
        {
          branchId: mainBranchId,
          message: 'release the overlay set',
          itemChanges: changes,
        },
        user.id,
      )

      // An ECO branch off main, then every shape a branch_items row can take.
      const coItem = takeFirst(
        await testDb.db
          .insert(items)
          .values({
            masterId: crypto.randomUUID(),
            itemNumber: `${uniquePrefix}-OVECO-001`,
            revision: 'A',
            itemType: 'ChangeOrder',
            name: 'Overlay ECO',
            state: 'Draft',
            isCurrent: true,
            createdBy: user.id,
            modifiedBy: user.id,
            designId,
          })
          .returning(),
      )
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

      const workingCopy = async (index: number, deleted = false) => {
        const row = takeFirst(
          await testDb.db
            .insert(items)
            .values({
              masterId: masterIds[index]!,
              itemNumber: `${uniquePrefix}-OV-${String(index).padStart(3, '0')}`,
              revision: '-',
              itemType: index % 4 === 0 ? 'Document' : 'Part',
              name: `Overlay item ${index} (working)`,
              state: 'In Work',
              isCurrent: false,
              isDeleted: deleted,
              createdBy: user.id,
              modifiedBy: user.id,
              designId,
            })
            .returning(),
        )
        return row.id
      }

      // 0–9 modified on the branch: the branch version wins.
      for (let index = 0; index < 10; index++) {
        await testDb.db.insert(branchItems).values({
          branchId: ecoBranchId,
          itemMasterId: masterIds[index]!,
          currentItemId: await workingCopy(index),
          changeType: 'modified',
        })
      }

      // 10–14 deleted on the branch: they disappear from the branch view.
      for (let index = 10; index < 15; index++) {
        await testDb.db.insert(branchItems).values({
          branchId: ecoBranchId,
          itemMasterId: masterIds[index]!,
          currentItemId: releasedIds[index]!,
          changeType: 'deleted',
        })
      }

      // 15–19 tracked with no version yet: main's version still stands.
      for (let index = 15; index < 20; index++) {
        await testDb.db.insert(branchItems).values({
          branchId: ecoBranchId,
          itemMasterId: masterIds[index]!,
          currentItemId: null,
          changeType: 'modified',
        })
      }

      // 20–22 point at a working copy that has since been soft-deleted. The
      // item is not on the branch, and main's version must not resurface.
      for (let index = 20; index < 23; index++) {
        await testDb.db.insert(branchItems).values({
          branchId: ecoBranchId,
          itemMasterId: masterIds[index]!,
          currentItemId: await workingCopy(index, true),
          changeType: 'modified',
        })
      }

      // Five masters that exist only on the branch.
      for (let index = 0; index < 5; index++) {
        const masterId = crypto.randomUUID()
        const row = takeFirst(
          await testDb.db
            .insert(items)
            .values({
              masterId,
              itemNumber: `${uniquePrefix}-OVNEW-${index}`,
              revision: '-',
              itemType: 'Part',
              name: `Branch-only item ${index}`,
              state: 'In Work',
              isCurrent: false,
              createdBy: user.id,
              modifiedBy: user.id,
              designId,
            })
            .returning(),
        )
        await testDb.db.insert(branchItems).values({
          branchId: ecoBranchId,
          itemMasterId: masterId,
          currentItemId: row.id,
          changeType: 'added',
        })
      }

      // 23–27 exist only in branch_items, never in item_versions — the shape
      // left behind by pre-release data added straight to a branch.
      for (let index = 23; index < 28; index++) {
        const masterId = crypto.randomUUID()
        const row = takeFirst(
          await testDb.db
            .insert(items)
            .values({
              masterId,
              itemNumber: `${uniquePrefix}-OVUNV-${index}`,
              revision: '-',
              itemType: 'Part',
              name: `Unversioned item ${index}`,
              state: 'In Work',
              isCurrent: false,
              createdBy: user.id,
              modifiedBy: user.id,
              designId,
            })
            .returning(),
        )
        await testDb.db.insert(branchItems).values({
          branchId: ecoBranchId,
          itemMasterId: masterId,
          currentItemId: row.id,
          changeType: 'modified',
        })
      }
    })

    it('returns the same items as the in-memory merge', async () => {
      const sqlPath = await VersionResolver.getBranchItems(ecoBranchId)
      const oracle = await mergeInMemory(ecoBranchId)

      expect(sqlPath.total).toBe(oracle.total)
      expect(idsOf(sqlPath)).toEqual(idsOf(oracle))

      // The fixture is only meaningful if every arm actually contributed:
      // 60 released, minus 5 deleted on the branch, minus 3 whose working copy
      // is deleted, plus 5 branch-only and 5 unversioned.
      expect(sqlPath.total).toBe(62)
    })

    it('returns the same items as the in-memory merge under filters', async () => {
      const filterSets: Array<ItemFilters> = [
        { itemType: 'Part' },
        { itemType: 'Document' },
        { state: 'In Work' },
        { state: 'Released' },
        { search: 'OVNEW' },
        { search: 'working' },
        { globalSearch: 'Overlay item' },
      ]

      for (const filters of filterSets) {
        const label = JSON.stringify(filters)
        const sqlPath = await VersionResolver.getBranchItems(
          ecoBranchId,
          filters,
        )
        const oracle = await mergeInMemory(ecoBranchId, filters)

        expect(sqlPath.total, `total for ${label}`).toBe(oracle.total)
        expect(idsOf(sqlPath), `items for ${label}`).toEqual(idsOf(oracle))
      }
    })

    it('paginates the branch view over a stable order', async () => {
      const all = await VersionResolver.getBranchItems(ecoBranchId)
      const walked: Array<string> = []

      for (let offset = 0; offset < all.total; offset += 20) {
        const page = await VersionResolver.getBranchItems(ecoBranchId, {
          limit: 20,
          offset,
        })
        expect(page.total).toBe(all.total)
        walked.push(...page.items.map((item) => item.id))
      }

      expect(walked.length).toBe(all.total)
      expect(new Set(walked).size).toBe(walked.length)
      expect(walked.sort()).toEqual(idsOf(all))
    })

    it('falls back to the in-memory merge when main has no commit history', async () => {
      // A design whose items were never committed — the seeded/pre-release
      // shape. Commit resolution finds nothing, so the fallback chain has to
      // answer, and the SQL overlay must stand aside for it.
      const design = await DesignService.create(
        {
          programId,
          name: 'Uncommitted Design',
          code: `${uniquePrefix}-UNC`,
          designType: 'Engineering',
        },
        user.id,
      )
      const mainBranchId = design.mainBranch!.id

      const row = takeFirst(
        await testDb.db
          .insert(items)
          .values({
            masterId: crypto.randomUUID(),
            itemNumber: `${uniquePrefix}-UNC-001`,
            revision: 'A',
            itemType: 'Part',
            name: 'Uncommitted part',
            state: 'Released',
            isCurrent: true,
            createdBy: user.id,
            modifiedBy: user.id,
            designId: design.id,
          })
          .returning(),
      )
      await testDb.db.insert(branchItems).values({
        branchId: mainBranchId,
        itemMasterId: row.masterId,
        currentItemId: row.id,
        changeType: 'added',
      })

      const result = await VersionResolver.getBranchItems(mainBranchId)
      const oracle = await mergeInMemory(mainBranchId)

      expect(result.total).toBe(oracle.total)
      expect(idsOf(result)).toEqual(idsOf(oracle))
      expect(result.items.map((item) => item.id)).toContain(row.id)
    })
  })
})
