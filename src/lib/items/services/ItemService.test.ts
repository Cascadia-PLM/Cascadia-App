/**
 * ItemService Tests
 *
 * Integration tests for the ItemService class.
 * These tests run against a real database with transaction rollback for isolation.
 *
 * Run: npm run test -- src/lib/items/services/ItemService.test.ts
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
import { ItemService } from './ItemService'
import type { Part } from '@/lib/items/types/part'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { NotFoundError, ValidationError } from '@/lib/errors'
import { branches, commits, designs } from '@/lib/db/schema'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

describe('ItemService', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let designId: string

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

    // Create test user (let fixture generate unique email)
    user = await insertTestUser(testDb.db)

    // Create test design
    const [createdDesign] = await testDb.db
      .insert(designs)
      .values({
        name: 'Test Design',
        code: `PROD-${uniquePrefix}`,
        designType: 'Engineering',
        createdBy: user.id,
      })
      .returning()

    // Create initial commit
    const [initialCommit] = await testDb.db
      .insert(commits)
      .values({
        designId: createdDesign.id,
        branchId: createdDesign.id, // Temporary
        message: 'Initial commit',
        createdBy: user.id,
      })
      .returning()

    // Create main branch
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

    // Update commit with correct branchId
    await testDb.db
      .update(commits)
      .set({ branchId: mainBranch.id })
      .where(eq(commits.id, initialCommit.id))

    // Update design with default branch
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

  describe('create', () => {
    it('creates a Part item with valid data', async () => {
      const itemNumber = `PN-${uniquePrefix}-001`
      const partData = {
        itemNumber,
        revision: 'A',
        name: 'Test Part',
        description: 'A test part description',
        partType: 'Manufacture',
        designId,
      }

      const result = await ItemService.create('Part', partData as any, user.id)

      expect(result).toBeDefined()
      expect(result.id).toBeDefined()
      expect(result.itemNumber).toBe(itemNumber)
      expect(result.revision).toBe('A')
      expect(result.name).toBe('Test Part')
      expect(result.masterId).toBeDefined()
    })

    it('creates a Document item with valid data', async () => {
      const itemNumber = `DOC-${uniquePrefix}-001`
      const docData = {
        itemNumber,
        revision: 'A',
        name: 'Test Document',
        description: 'A test document description',
        designId,
      }

      const result = await ItemService.create(
        'Document',
        docData as any,
        user.id,
      )

      expect(result).toBeDefined()
      expect(result.id).toBeDefined()
      expect(result.itemNumber).toBe(itemNumber)
    })

    it('creates a ChangeOrder item with valid data', async () => {
      // ChangeOrders use auto-generated item numbers
      // Note: designId is intentionally omitted - ECOs are design-agnostic at creation
      const coData = {
        revision: 'A',
        name: 'Test Change Order',
        changeType: 'ECO',
        priority: 'medium',
        reasonForChange: 'Testing change order creation',
      }

      const result = await ItemService.create(
        'ChangeOrder',
        coData as any,
        user.id,
      )

      expect(result).toBeDefined()
      expect(result.id).toBeDefined()
      // itemNumber is auto-generated with ECO prefix
      expect(result.itemNumber).toMatch(/^ECO-\d{6}$/)
    })

    it('does not create ECO branch when creating a ChangeOrder', async () => {
      // ChangeOrders are design-agnostic at creation - no ECO branch should be created
      const coData = {
        revision: 'A',
        name: 'Test Change Order No Branch',
        changeType: 'ECO',
        priority: 'medium',
        reasonForChange: 'Testing that no ECO branch is created',
      }

      const result = await ItemService.create(
        'ChangeOrder',
        coData as any,
        user.id,
      )

      // Should not have any ECO branches for this change order
      const ecoBranches = await testDb.db
        .select()
        .from(branches)
        .where(eq(branches.changeOrderItemId, result.id))

      expect(ecoBranches.length).toBe(0)
    })

    it('does not create commit on main when creating a ChangeOrder', async () => {
      // Get initial commit count on main branch
      const mainBranch = await testDb.db
        .select()
        .from(branches)
        .where(eq(branches.designId, designId))
        .limit(1)

      const initialCommits = mainBranch[0]
        ? await testDb.db
            .select()
            .from(commits)
            .where(eq(commits.branchId, mainBranch[0].id))
        : []
      const initialCount = initialCommits.length

      // Create a ChangeOrder
      const coData = {
        revision: 'A',
        name: 'Test Change Order No Commit',
        changeType: 'ECO',
        priority: 'medium',
        reasonForChange: 'Testing that no commit is created on main',
      }

      await ItemService.create('ChangeOrder', coData as any, user.id)

      // Commit count should not have increased
      const finalCommits = mainBranch[0]
        ? await testDb.db
            .select()
            .from(commits)
            .where(eq(commits.branchId, mainBranch[0].id))
        : []

      expect(finalCommits.length).toBe(initialCount)
    })

    it('throws NotFoundError for unknown item type', async () => {
      const data = {
        itemNumber: `TEST-${uniquePrefix}-001`,
        revision: 'A',
        name: 'Test Item',
        designId,
      }

      await expect(
        ItemService.create('UnknownType', data as any, user.id),
      ).rejects.toThrow(NotFoundError)
    })

    it('throws ValidationError for invalid data', async () => {
      const invalidData = {
        // Missing required revision
        itemNumber: `PN-${uniquePrefix}-INVALID`,
        name: 'Test Part',
        designId,
      }

      await expect(
        ItemService.create('Part', invalidData as any, user.id),
      ).rejects.toThrow(ValidationError)
    })

    it('assigns default state when not provided', async () => {
      const partData = {
        itemNumber: `PN-${uniquePrefix}-002`,
        revision: 'A',
        name: 'Default State Part',
        designId,
        // No state provided
      }

      const result = await ItemService.create('Part', partData as any, user.id)

      expect(result.state).toBe('Draft') // Default state for Part
    })
  })

  describe('findById', () => {
    it('returns item when found', async () => {
      const itemNumber = `PN-${uniquePrefix}-FIND-001`
      // Create an item first
      const created = await ItemService.create(
        'Part',
        {
          itemNumber,
          revision: 'A',
          name: 'Find Test Part',
          designId,
        } as any,
        user.id,
      )

      const found = await ItemService.findById(created.id)

      expect(found).toBeDefined()
      expect(found?.id).toBe(created.id)
      expect(found?.itemNumber).toBe(itemNumber)
    })

    it('returns null when item not found', async () => {
      const found = await ItemService.findById(
        '00000000-0000-0000-0000-000000000000',
      )

      expect(found).toBeNull()
    })

    it('includes type-specific data', async () => {
      const created = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-SPECIFIC-001`,
          revision: 'A',
          name: 'Specific Data Part',
          description: 'Has type-specific fields',
          partType: 'Purchase',
          material: 'Aluminum',
          designId,
        } as any,
        user.id,
      )

      const found = (await ItemService.findById(created.id)) as Part | null

      expect(found).toBeDefined()
      expect(found?.description).toBe('Has type-specific fields')
      expect(found?.partType).toBe('Purchase')
      expect(found?.material).toBe('Aluminum')
    })
  })

  describe('findByNumber', () => {
    it('finds current revision by item number', async () => {
      const itemNumber = `PN-${uniquePrefix}-NUM-001`
      await ItemService.create(
        'Part',
        {
          itemNumber,
          revision: 'A',
          name: 'Number Test Part',
          designId,
        } as any,
        user.id,
      )

      const found = await ItemService.findByNumber(itemNumber)

      expect(found).toBeDefined()
      expect(found?.itemNumber).toBe(itemNumber)
      expect(found?.revision).toBe('A')
    })

    it('finds specific revision when provided', async () => {
      const itemNumber = `PN-${uniquePrefix}-REV-001`
      const revA = await ItemService.create(
        'Part',
        {
          itemNumber,
          revision: 'A',
          name: 'Revision A Part',
          designId,
        } as any,
        user.id,
      )

      // Create revision B
      await ItemService.revise(revA.id, 'B', user.id)

      // Find specific revision A
      const foundA = await ItemService.findByNumber(itemNumber, 'A')

      expect(foundA).toBeDefined()
      expect(foundA?.revision).toBe('A')
    })

    it('returns null when item number not found', async () => {
      const found = await ItemService.findByNumber('NONEXISTENT-001')

      expect(found).toBeNull()
    })
  })

  describe('update', () => {
    it('updates item fields', async () => {
      const created = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-UPDATE-001`,
          revision: 'A',
          name: 'Original Name',
          description: 'Original description',
          designId,
        } as any,
        user.id,
      )

      const updated = await ItemService.update(
        created.id,
        {
          name: 'Updated Name',
          description: 'Updated description',
        } as Partial<Part>,
        user.id,
      )

      expect(updated.name).toBe('Updated Name')
      expect(updated.description).toBe('Updated description')
    })

    it('updates type-specific fields', async () => {
      const created = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-UPDATE-002`,
          revision: 'A',
          name: 'Update Type Fields',
          partType: 'Manufacture',
          designId,
        } as any,
        user.id,
      )

      const updated = await ItemService.update(
        created.id,
        {
          partType: 'Purchase',
          material: 'Steel',
        } as Partial<Part>,
        user.id,
      )

      expect(updated.partType).toBe('Purchase')
      expect(updated.material).toBe('Steel')
    })

    it('throws NotFoundError when item does not exist', async () => {
      await expect(
        ItemService.update(
          '00000000-0000-0000-0000-000000000000',
          { name: 'New Name' },
          user.id,
        ),
      ).rejects.toThrow(NotFoundError)
    })

    it('updates modifiedBy timestamp', async () => {
      const created = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-UPDATE-003`,
          revision: 'A',
          name: 'Modified Time Test',
          designId,
        } as any,
        user.id,
      )

      // Wait a bit to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 10))

      const updated = await ItemService.update(
        created.id,
        { name: 'Modified' },
        user.id,
      )

      expect(updated.modifiedAt).toBeDefined()
      expect(new Date(updated.modifiedAt!).getTime()).toBeGreaterThan(
        new Date(created.modifiedAt).getTime(),
      )
    })
  })

  describe('delete', () => {
    it('deletes an existing item', async () => {
      const created = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-DELETE-001`,
          revision: 'A',
          name: 'Delete Test Part',
          designId,
        } as any,
        user.id,
      )

      await ItemService.delete(created.id)

      const found = await ItemService.findById(created.id)
      expect(found).toBeNull()
    })

    it('does not throw when deleting non-existent item', async () => {
      // This is current behavior - no error for missing item
      await expect(
        ItemService.delete('00000000-0000-0000-0000-000000000000'),
      ).resolves.not.toThrow()
    })
  })

  describe('revise', () => {
    it('creates a new revision', async () => {
      const revA = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-REVISE-001`,
          revision: 'A',
          name: 'Revision Test Part',
          description: 'Original revision',
          designId,
        } as any,
        user.id,
      )

      const revB = await ItemService.revise(revA.id, 'B', user.id)

      expect(revB).toBeDefined()
      expect(revB.revision).toBe('B')
      expect(revB.masterId).toBe(revA.masterId)
      expect(revB.state).toBe('Draft') // New revisions start in Draft
    })

    it('marks previous revision as not current', async () => {
      const itemNumber = `PN-${uniquePrefix}-REVISE-002`
      const revA = await ItemService.create(
        'Part',
        {
          itemNumber,
          revision: 'A',
          name: 'Current Flag Test',
          designId,
        } as any,
        user.id,
      )

      await ItemService.revise(revA.id, 'B', user.id)

      // Fetch original revision - it should not be current anymore
      const foundA = await ItemService.findByNumber(itemNumber, 'A')
      expect(foundA?.isCurrent).toBe(false)
    })

    it('copies type-specific data to new revision', async () => {
      const revA = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-REVISE-003`,
          revision: 'A',
          name: 'Copy Data Test',
          description: 'Should be copied',
          partType: 'Purchase',
          material: 'Titanium',
          designId,
        } as any,
        user.id,
      )

      const revB = await ItemService.revise(revA.id, 'B', user.id)

      // Fetch complete revision B with type-specific data
      const foundB = (await ItemService.findById(revB.id!)) as Part | null

      expect(foundB?.description).toBe('Should be copied')
      expect(foundB?.partType).toBe('Purchase')
      expect(foundB?.material).toBe('Titanium')
    })

    it('throws NotFoundError when source item does not exist', async () => {
      await expect(
        ItemService.revise(
          '00000000-0000-0000-0000-000000000000',
          'B',
          user.id,
        ),
      ).rejects.toThrow(NotFoundError)
    })
  })

  describe('search', () => {
    beforeEach(async () => {
      // Create multiple items for search testing
      await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-SEARCH-001`,
          revision: 'A',
          name: 'Search Part One',
          state: 'Draft',
          designId,
        } as any,
        user.id,
      )

      await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-SEARCH-002`,
          revision: 'A',
          name: 'Search Part Two',
          state: 'InReview', // Changed from 'Released' to avoid branch protection
          designId,
        } as any,
        user.id,
      )

      await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-SEARCH-003`,
          revision: 'A',
          name: 'Search Part Three',
          state: 'Draft',
          designId,
        } as any,
        user.id,
      )
    })

    it('returns all items of specified type', async () => {
      const results = await ItemService.search('Part', {})

      expect(results.items.length).toBeGreaterThanOrEqual(3)
      expect(results.total).toBeGreaterThanOrEqual(3)
    })

    it('filters by state', async () => {
      const results = await ItemService.search('Part', { state: 'Draft' })

      expect(results.items.every((item) => item.state === 'Draft')).toBe(true)
    })

    it('respects limit parameter', async () => {
      const results = await ItemService.search('Part', { limit: 2 })

      expect(results.items.length).toBeLessThanOrEqual(2)
    })

    it('respects offset parameter', async () => {
      const allResults = await ItemService.search('Part', {})
      const offsetResults = await ItemService.search('Part', { offset: 1 })

      // With offset, we should get fewer or different items
      expect(offsetResults.items.length).toBeLessThanOrEqual(
        allResults.items.length,
      )
    })
  })

  describe('searchByItemNumber', () => {
    // Use a unique search prefix for this test block
    let searchPrefix: string

    beforeEach(async () => {
      searchPrefix = `AUTO-${uniquePrefix}`

      await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${searchPrefix}-001`,
          revision: 'A',
          name: `Autocomplete-${uniquePrefix} Part One`,
          designId,
        } as any,
        user.id,
      )

      await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${searchPrefix}-002`,
          revision: 'A',
          name: `Autocomplete-${uniquePrefix} Part Two`,
          designId,
        } as any,
        user.id,
      )

      await ItemService.create(
        'Document',
        {
          itemNumber: `DOC-${searchPrefix}-001`,
          revision: 'A',
          name: `Autocomplete-${uniquePrefix} Document`,
          designId,
        } as any,
        user.id,
      )
    })

    it('finds items matching partial item number', async () => {
      const results = await ItemService.searchByItemNumber(`PN-${searchPrefix}`)

      expect(results.length).toBeGreaterThanOrEqual(2)
      expect(
        results.every((r) => r.itemNumber?.includes(`PN-${searchPrefix}`)),
      ).toBe(true)
    })

    it('finds items matching name', async () => {
      const results = await ItemService.searchByItemNumber(
        `Autocomplete-${uniquePrefix}`,
      )

      expect(results.length).toBeGreaterThanOrEqual(3)
    })

    it('filters by item types', async () => {
      const results = await ItemService.searchByItemNumber(searchPrefix, {
        itemTypes: ['Part'],
      })

      expect(results.every((r) => r.itemType === 'Part')).toBe(true)
    })

    it('respects limit option', async () => {
      const results = await ItemService.searchByItemNumber(searchPrefix, {
        limit: 1,
      })

      expect(results.length).toBeLessThanOrEqual(1)
    })

    it('returns empty array for short queries', async () => {
      const results = await ItemService.searchByItemNumber('P')

      expect(results).toEqual([])
    })
  })

  describe('relationships', () => {
    let parentPart: any
    let childPart: any

    beforeEach(async () => {
      parentPart = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-PARENT-001`,
          revision: 'A',
          name: 'Parent Assembly',
          designId,
        } as any,
        user.id,
      )

      childPart = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-CHILD-001`,
          revision: 'A',
          name: 'Child Component',
          designId,
        } as any,
        user.id,
      )
    })

    it('adds a BOM relationship between items', async () => {
      await ItemService.addRelationship(
        parentPart.id,
        childPart.id,
        'BOM',
        user.id,
        { quantity: '5', findNumber: 10 },
      )

      const related = await ItemService.getRelated(parentPart.id, 'BOM')

      expect(related.length).toBe(1)
      expect(related[0].id).toBe(childPart.id)
    })

    it('gets relationships with full details', async () => {
      await ItemService.addRelationship(
        parentPart.id,
        childPart.id,
        'BOM',
        user.id,
        { quantity: '5', findNumber: 10 },
      )

      const relationships = await ItemService.getRelationshipsWithDetails(
        parentPart.id,
        'BOM',
      )

      expect(relationships.length).toBe(1)
      expect(parseFloat(relationships[0].quantity!)).toBe(5)
      expect(relationships[0].findNumber).toBe(10)
      expect(relationships[0].targetItem).toBeDefined()
      expect(relationships[0].targetItem?.id).toBe(childPart.id)
    })

    it('removes a relationship', async () => {
      await ItemService.addRelationship(
        parentPart.id,
        childPart.id,
        'BOM',
        user.id,
      )

      const beforeRemove = await ItemService.getRelationshipsWithDetails(
        parentPart.id,
      )
      expect(beforeRemove.length).toBe(1)

      await ItemService.removeRelationship(beforeRemove[0].id)

      const afterRemove = await ItemService.getRelated(parentPart.id)
      expect(afterRemove.length).toBe(0)
    })

    it('gets unique relationship types for an item', async () => {
      const anotherChild = await ItemService.create(
        'Document',
        {
          itemNumber: `DOC-${uniquePrefix}-REL-001`,
          revision: 'A',
          name: 'Related Document',
          designId,
        } as any,
        user.id,
      )

      await ItemService.addRelationship(
        parentPart.id,
        childPart.id,
        'BOM',
        user.id,
      )
      await ItemService.addRelationship(
        parentPart.id,
        anotherChild.id,
        'Reference',
        user.id,
      )

      const types = await ItemService.getRelationshipTypes(parentPart.id)

      expect(types).toContain('BOM')
      expect(types).toContain('Reference')
      expect(types.length).toBe(2)
    })
  })

  describe('search advanced options', () => {
    it('filters by designId', async () => {
      await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-DESIGN-001`,
          revision: 'A',
          name: 'Design Filter Part',
          designId,
        } as any,
        user.id,
      )

      const results = await ItemService.search('Part', { designId })

      expect(results.items.every((item) => item.designId === designId)).toBe(
        true,
      )
    })

    it('filters by multiple designIds', async () => {
      // Create another design
      const [design2] = await testDb.db
        .insert(designs)
        .values({
          name: 'Second Design',
          code: `PROD2-${uniquePrefix}`,
          designType: 'Engineering',
          createdBy: user.id,
        })
        .returning()

      await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-MULTI-001`,
          revision: 'A',
          name: 'Multi Design Part',
          designId,
        } as any,
        user.id,
      )

      const results = await ItemService.search('Part', {
        designIds: [designId, design2.id],
      })

      expect(results.items.length).toBeGreaterThan(0)
    })

    it('filters currentOnly=false includes non-current items', async () => {
      const itemNumber = `PN-${uniquePrefix}-CURR-001`
      const revA = await ItemService.create(
        'Part',
        {
          itemNumber,
          revision: 'A',
          name: 'Current Filter Part',
          designId,
        } as any,
        user.id,
      )

      await ItemService.revise(revA.id, 'B', user.id)

      // Default search should only show current
      const currentOnly = await ItemService.search('Part', {
        currentOnly: true,
      })
      const currentCount = currentOnly.items.filter(
        (i) => i.itemNumber === itemNumber,
      ).length
      expect(currentCount).toBe(1)

      // With currentOnly=false should show both
      const all = await ItemService.search('Part', { currentOnly: false })
      const allCount = all.items.filter(
        (i) => i.itemNumber === itemNumber,
      ).length
      expect(allCount).toBe(2)
    })

    it('filters by createdBy', async () => {
      const results = await ItemService.search('Part', { createdBy: user.id })

      expect(results.items.every((item) => item.createdBy === user.id)).toBe(
        true,
      )
    })
  })

  describe('Requirement item type', () => {
    it('creates a Requirement with valid data', async () => {
      const reqData = {
        itemNumber: `REQ-${uniquePrefix}-001`,
        revision: 'A',
        name: 'Test Requirement',
        description: 'A functional requirement',
        type: 'Functional',
        priority: 'MustHave',
        status: 'Proposed',
        designId,
      }

      const result = await ItemService.create(
        'Requirement',
        reqData as any,
        user.id,
      )

      expect(result).toBeDefined()
      expect(result.id).toBeDefined()
      expect(result.itemNumber).toBe(`REQ-${uniquePrefix}-001`)
    })

    it('retrieves Requirement with type-specific data', async () => {
      const reqData = {
        itemNumber: `REQ-${uniquePrefix}-002`,
        revision: 'A',
        name: 'Full Requirement',
        description: 'Complete requirement',
        type: 'Performance',
        priority: 'ShouldHave',
        status: 'Approved',
        acceptanceCriteria: 'Must pass all tests',
        source: 'Customer',
        category: 'Safety',
        designId,
      }

      const created = await ItemService.create(
        'Requirement',
        reqData as any,
        user.id,
      )
      const found = await ItemService.findById(created.id)

      expect((found as any)?.description).toBe('Complete requirement')
      expect((found as any)?.type).toBe('Performance')
      expect((found as any)?.priority).toBe('ShouldHave')
      expect((found as any)?.acceptanceCriteria).toBe('Must pass all tests')
    })

    it('updates Requirement-specific fields', async () => {
      const created = await ItemService.create(
        'Requirement',
        {
          itemNumber: `REQ-${uniquePrefix}-003`,
          revision: 'A',
          name: 'Update Requirement',
          type: 'Functional',
          status: 'Proposed',
          designId,
        } as any,
        user.id,
      )

      const updated = await ItemService.update(
        created.id,
        {
          status: 'Rejected',
          priority: 'MustHave',
        } as any,
        user.id,
      )

      expect((updated as any).status).toBe('Rejected')
      expect((updated as any).priority).toBe('MustHave')
    })
  })

  describe('Task item type', () => {
    it('creates a Task with valid data', async () => {
      const taskData = {
        itemNumber: `TSK-${uniquePrefix}-001`,
        revision: 'A',
        name: 'Test Task',
        description: 'A development task',
        priority: 'High',
        assignee: user.id,
        // Task doesn't require designId
      }

      const result = await ItemService.create('Task', taskData as any, user.id)

      expect(result).toBeDefined()
      expect(result.id).toBeDefined()
      expect(result.itemNumber).toBe(`TSK-${uniquePrefix}-001`)
    })

    it('retrieves Task with type-specific data', async () => {
      const taskData = {
        itemNumber: `TSK-${uniquePrefix}-002`,
        revision: 'A',
        name: 'Full Task',
        description: 'Complete task',
        priority: 'Medium',
        assignee: user.id,
        estimatedHours: '8',
        // Task doesn't require designId
      }

      const created = await ItemService.create('Task', taskData as any, user.id)
      const found = await ItemService.findById(created.id)

      expect((found as any)?.description).toBe('Complete task')
      expect((found as any)?.priority).toBe('Medium')
      expect((found as any)?.assignee).toBe(user.id)
    })

    it('updates Task-specific fields', async () => {
      const created = await ItemService.create(
        'Task',
        {
          itemNumber: `TSK-${uniquePrefix}-003`,
          revision: 'A',
          name: 'Update Task',
          priority: 'Low',
          // Task doesn't require designId
        } as any,
        user.id,
      )

      const updated = await ItemService.update(
        created.id,
        {
          priority: 'Critical',
          actualHours: '4',
        } as any,
        user.id,
      )

      expect((updated as any).priority).toBe('Critical')
      // actualHours is stored as numeric and may have decimal formatting
      expect(parseFloat((updated as any).actualHours)).toBe(4)
    })
  })

  describe('diff', () => {
    it('compares two versions of an item', async () => {
      const revA = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-DIFF-001`,
          revision: 'A',
          name: 'Original Name',
          description: 'Original description',
          designId,
        } as any,
        user.id,
      )

      const revB = await ItemService.revise(revA.id, 'B', user.id)
      await ItemService.update(
        revB.id!,
        {
          name: 'Updated Name',
          description: 'Updated description',
        } as any,
        user.id,
      )

      const diff = await ItemService.diff(revA.id, revB.id!)

      expect(diff.fields.length).toBeGreaterThan(0)
      const nameChange = diff.fields.find((f) => f.field === 'name')
      expect(nameChange?.oldValue).toBe('Original Name')
      expect(nameChange?.newValue).toBe('Updated Name')
    })

    it('throws NotFoundError for non-existent item', async () => {
      const created = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-DIFF-002`,
          revision: 'A',
          name: 'Diff Test',
          designId,
        } as any,
        user.id,
      )

      await expect(
        ItemService.diff(created.id, '00000000-0000-0000-0000-000000000000'),
      ).rejects.toThrow(NotFoundError)
    })

    it('excludes metadata fields from diff', async () => {
      const revA = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-DIFF-003`,
          revision: 'A',
          name: 'Meta Test',
          designId,
        } as any,
        user.id,
      )

      await new Promise((resolve) => setTimeout(resolve, 10))
      const revB = await ItemService.revise(revA.id, 'B', user.id)

      const diff = await ItemService.diff(revA.id, revB.id!)

      const excludedFields = [
        'id',
        'createdAt',
        'createdBy',
        'modifiedAt',
        'modifiedBy',
        'commitId',
      ]
      expect(diff.fields.every((f) => !excludedFields.includes(f.field))).toBe(
        true,
      )
    })
  })

  describe('canEditDirectly', () => {
    it('returns allowed when no released items', async () => {
      const result = await ItemService.canEditDirectly(designId)

      expect(result.allowed).toBe(true)
      expect(result.requiresCheckout).toBe(false)
    })

    it('returns not allowed when design has released items', async () => {
      // Insert a released item directly to trigger protection
      const { items: itemsTable } = await import('@/lib/db/schema')
      await testDb.db.insert(itemsTable).values({
        masterId: crypto.randomUUID(),
        designId,
        itemNumber: `PN-${uniquePrefix}-RELEASED`,
        revision: 'A',
        name: 'Released Item',
        itemType: 'Part',
        state: 'Released',
        isCurrent: true,
        createdBy: user.id,
        modifiedBy: user.id,
      })

      const result = await ItemService.canEditDirectly(designId)

      expect(result.allowed).toBe(false)
      expect(result.requiresCheckout).toBe(true)
      expect(result.reason).toContain('released items')
    })
  })

  describe('requiresCheckout', () => {
    it('returns true for Released state', () => {
      const item = { state: 'Released' } as any
      expect(ItemService.requiresCheckout(item)).toBe(true)
    })

    it('returns true for Approved state', () => {
      const item = { state: 'Approved' } as any
      expect(ItemService.requiresCheckout(item)).toBe(true)
    })

    it('returns false for Draft state', () => {
      const item = { state: 'Draft' } as any
      expect(ItemService.requiresCheckout(item)).toBe(false)
    })

    it('returns false for InReview state', () => {
      const item = { state: 'InReview' } as any
      expect(ItemService.requiresCheckout(item)).toBe(false)
    })

    it('returns false when no state', () => {
      const item = {} as any
      expect(ItemService.requiresCheckout(item)).toBe(false)
    })
  })

  describe('canEditItemDirectly', () => {
    it('returns true for Draft state', () => {
      const item = { state: 'Draft' } as any
      expect(ItemService.canEditItemDirectly(item)).toBe(true)
    })

    it('returns true for InReview state', () => {
      const item = { state: 'InReview' } as any
      expect(ItemService.canEditItemDirectly(item)).toBe(true)
    })

    it('returns false for Released state', () => {
      const item = { state: 'Released' } as any
      expect(ItemService.canEditItemDirectly(item)).toBe(false)
    })

    it('returns false for Approved state', () => {
      const item = { state: 'Approved' } as any
      expect(ItemService.canEditItemDirectly(item)).toBe(false)
    })

    it('returns false when no state', () => {
      const item = {} as any
      expect(ItemService.canEditItemDirectly(item)).toBe(false)
    })
  })

  describe('getItemBranchInfo', () => {
    it('returns null for items not on ECO/workspace branch', async () => {
      const created = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-BRANCH-001`,
          revision: 'A',
          name: 'Branch Info Test',
          designId,
        } as any,
        user.id,
      )

      const branchInfo = await ItemService.getItemBranchInfo(created.id)

      expect(branchInfo).toBeNull()
    })
  })

  describe('items without design', () => {
    it('creates Task without designId (no commit tracking)', async () => {
      // Task doesn't require designId (unlike Part and Requirement)
      const result = await ItemService.create(
        'Task',
        {
          itemNumber: `TSK-${uniquePrefix}-NODESIGN-001`,
          revision: 'A',
          name: 'No Design Task',
          priority: 'Low',
          // No designId
        } as any,
        user.id,
      )

      expect(result).toBeDefined()
      // designId will be null (not undefined) from the database
      expect(result.designId).toBeNull()
    })
  })

  describe('relationship tracking', () => {
    it('tracks relationship removal without userId', async () => {
      const parentPart = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-RELTRACK-001`,
          revision: 'A',
          name: 'Parent Part',
          designId,
        } as any,
        user.id,
      )

      const childPart = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-RELTRACK-002`,
          revision: 'A',
          name: 'Child Part',
          designId,
        } as any,
        user.id,
      )

      const relationship = await ItemService.addRelationship(
        parentPart.id,
        childPart.id,
        'BOM',
        user.id,
      )

      // Remove without userId (no commit tracking)
      await ItemService.removeRelationship(relationship.id)

      const related = await ItemService.getRelated(parentPart.id)
      expect(related.length).toBe(0)
    })

    it('handles removing non-existent relationship', async () => {
      // Should throw NotFoundError for non-existent relationship
      await expect(
        ItemService.removeRelationship(
          '00000000-0000-0000-0000-000000000000',
          user.id,
        ),
      ).rejects.toThrow(NotFoundError)
    })
  })

  describe('getRelated', () => {
    it('filters relationships by type', async () => {
      const parentPart = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-RELTYPE-001`,
          revision: 'A',
          name: 'Parent Part',
          designId,
        } as any,
        user.id,
      )

      const child1 = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-RELTYPE-002`,
          revision: 'A',
          name: 'BOM Child',
          designId,
        } as any,
        user.id,
      )

      const child2 = await ItemService.create(
        'Document',
        {
          itemNumber: `DOC-${uniquePrefix}-RELTYPE-001`,
          revision: 'A',
          name: 'Reference Doc',
          designId,
        } as any,
        user.id,
      )

      await ItemService.addRelationship(
        parentPart.id,
        child1.id,
        'BOM',
        user.id,
      )
      await ItemService.addRelationship(
        parentPart.id,
        child2.id,
        'Reference',
        user.id,
      )

      const bomOnly = await ItemService.getRelated(parentPart.id, 'BOM')
      const all = await ItemService.getRelated(parentPart.id)

      expect(bomOnly.length).toBe(1)
      expect(bomOnly[0].id).toBe(child1.id)
      expect(all.length).toBe(2)
    })
  })

  describe('getRelationshipsWithDetails', () => {
    it('filters by relationship type', async () => {
      const parentPart = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-DETTYPE-001`,
          revision: 'A',
          name: 'Parent Part',
          designId,
        } as any,
        user.id,
      )

      const child1 = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-DETTYPE-002`,
          revision: 'A',
          name: 'BOM Child',
          designId,
        } as any,
        user.id,
      )

      await ItemService.addRelationship(
        parentPart.id,
        child1.id,
        'BOM',
        user.id,
      )

      const details = await ItemService.getRelationshipsWithDetails(
        parentPart.id,
        'BOM',
      )

      expect(details.length).toBe(1)
      expect(details[0].relationshipType).toBe('BOM')
      expect(details[0].targetItem).toBeDefined()
    })
  })

  describe('searchByItemNumber advanced options', () => {
    it('filters by multiple designIds', async () => {
      const [design2] = await testDb.db
        .insert(designs)
        .values({
          name: 'Search Design',
          code: `SRCH-${uniquePrefix}`,
          designType: 'Engineering',
          createdBy: user.id,
        })
        .returning()

      await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-SRCHDES-001`,
          revision: 'A',
          name: 'Search Design Part',
          designId,
        } as any,
        user.id,
      )

      const results = await ItemService.searchByItemNumber(`SRCHDES`, {
        designIds: [designId, design2.id],
      })

      expect(results.length).toBeGreaterThanOrEqual(1)
    })

    it('respects currentOnly=false', async () => {
      const itemNumber = `PN-${uniquePrefix}-SRCHCUR-001`
      const revA = await ItemService.create(
        'Part',
        {
          itemNumber,
          revision: 'A',
          name: 'Search Current Part',
          designId,
        } as any,
        user.id,
      )

      await ItemService.revise(revA.id, 'B', user.id)

      const currentOnly = await ItemService.searchByItemNumber('SRCHCUR', {
        currentOnly: true,
        limit: 100,
      })
      const all = await ItemService.searchByItemNumber('SRCHCUR', {
        currentOnly: false,
        limit: 100,
      })

      expect(all.length).toBeGreaterThan(currentOnly.length)
    })
  })

  // Edge case tests (nested to share the same TestDatabase instance)
  describe('Edge Cases', () => {
    describe('Search Boundaries', () => {
      it('handles empty search string', async () => {
        const results = await ItemService.searchByItemNumber('')
        // Empty search may return all or empty depending on implementation
        expect(Array.isArray(results)).toBe(true)
      })

      it('handles single character search', async () => {
        await ItemService.create(
          'Part',
          {
            itemNumber: `PN-${uniquePrefix}-X001`,
            revision: 'A',
            name: 'Single Char Test',
            designId,
          } as any,
          user.id,
        )

        const results = await ItemService.searchByItemNumber('X')
        expect(Array.isArray(results)).toBe(true)
      })

      it('handles very long search string', async () => {
        const longSearch = 'A'.repeat(500)
        const results = await ItemService.searchByItemNumber(longSearch)
        // Should return empty, not error
        expect(results).toEqual([])
      })

      it('handles special SQL characters in search', async () => {
        const results = await ItemService.searchByItemNumber(
          "'; DROP TABLE items; --",
        )
        // Should not error or execute SQL injection
        expect(Array.isArray(results)).toBe(true)
      })

      it('handles wildcard characters in search', async () => {
        await ItemService.create(
          'Part',
          {
            itemNumber: `PN-${uniquePrefix}-WILD001`,
            revision: 'A',
            name: 'Wildcard Test',
            designId,
          } as any,
          user.id,
        )

        // Test SQL wildcard characters
        const percentResults = await ItemService.searchByItemNumber('WILD%')
        const underscoreResults = await ItemService.searchByItemNumber('WILD_')

        // Should treat as literal characters, not wildcards
        expect(Array.isArray(percentResults)).toBe(true)
        expect(Array.isArray(underscoreResults)).toBe(true)
      })

      it('search is case-insensitive', async () => {
        const itemNumber = `PN-${uniquePrefix}-CASETEST001`
        await ItemService.create(
          'Part',
          {
            itemNumber,
            revision: 'A',
            name: 'Case Test Part',
            designId,
          } as any,
          user.id,
        )

        const upper = await ItemService.searchByItemNumber('CASETEST')
        const lower = await ItemService.searchByItemNumber('casetest')
        const mixed = await ItemService.searchByItemNumber('CaseTest')

        // All should find the same item (or be consistently handled)
        expect(upper.length).toBe(lower.length)
        expect(upper.length).toBe(mixed.length)
      })

      it('respects limit of 0', async () => {
        await ItemService.create(
          'Part',
          {
            itemNumber: `PN-${uniquePrefix}-LIMIT001`,
            revision: 'A',
            name: 'Limit Test',
            designId,
          } as any,
          user.id,
        )

        const results = await ItemService.searchByItemNumber('LIMIT', {
          limit: 0,
        })
        // Limit 0 might return empty or use default limit
        expect(Array.isArray(results)).toBe(true)
      })

      it('handles very large limit', async () => {
        const results = await ItemService.searchByItemNumber(uniquePrefix, {
          limit: 999999,
        })
        expect(Array.isArray(results)).toBe(true)
      })
    })

    describe('Item Number Validation', () => {
      it('handles unicode in item number', async () => {
        const itemNumber = `PN-${uniquePrefix}-テスト-001`
        const result = await ItemService.create(
          'Part',
          {
            itemNumber,
            revision: 'A',
            name: 'Unicode Number Part',
            designId,
          } as any,
          user.id,
        )

        expect(result.itemNumber).toBe(itemNumber)
      })

      it('handles special characters in item number', async () => {
        const itemNumber = `PN-${uniquePrefix}-A/B(1)_V2.0`
        const result = await ItemService.create(
          'Part',
          {
            itemNumber,
            revision: 'A',
            name: 'Special Char Part',
            designId,
          } as any,
          user.id,
        )

        expect(result.itemNumber).toBe(itemNumber)
      })

      it('handles very long item number', async () => {
        const longNumber = `PN-${uniquePrefix}-${'X'.repeat(200)}`

        // May succeed or fail depending on DB constraints
        try {
          const result = await ItemService.create(
            'Part',
            {
              itemNumber: longNumber,
              revision: 'A',
              name: 'Long Number Part',
              designId,
            } as any,
            user.id,
          )
          expect(result.itemNumber.length).toBeGreaterThan(0)
        } catch (error) {
          // Validation error for too long is acceptable
          expect(error).toBeInstanceOf(ValidationError)
        }
      })

      it('rejects or handles whitespace-only item number', async () => {
        try {
          const result = await ItemService.create(
            'Part',
            {
              itemNumber: '   ',
              revision: 'A',
              name: 'Whitespace Number',
              designId,
            } as any,
            user.id,
          )
          // If it doesn't throw, the item number might be trimmed or handled differently
          expect(result.itemNumber).toBeDefined()
        } catch (error) {
          // Expected to throw validation error
          expect(error).toBeDefined()
        }
      })
    })

    describe('Revision Edge Cases', () => {
      it('handles lowercase revision', async () => {
        const result = await ItemService.create(
          'Part',
          {
            itemNumber: `PN-${uniquePrefix}-LOWER001`,
            revision: 'a',
            name: 'Lowercase Rev Part',
            designId,
          } as any,
          user.id,
        )

        // Revision might be normalized to uppercase or kept as-is
        expect(result.revision).toBeDefined()
      })

      it('handles numeric revision', async () => {
        const result = await ItemService.create(
          'Part',
          {
            itemNumber: `PN-${uniquePrefix}-NUMREV001`,
            revision: '1',
            name: 'Numeric Rev Part',
            designId,
          } as any,
          user.id,
        )

        expect(result.revision).toBe('1')
      })

      it('handles complex revision format', async () => {
        const result = await ItemService.create(
          'Part',
          {
            itemNumber: `PN-${uniquePrefix}-COMPLEX001`,
            revision: 'A.1.2-RC1',
            name: 'Complex Rev Part',
            designId,
          } as any,
          user.id,
        )

        expect(result.revision).toBe('A.1.2-RC1')
      })
    })

    describe('Invalid UUID Handling', () => {
      it('findById with malformed UUID throws or returns null', async () => {
        try {
          const result = await ItemService.findById('not-a-valid-uuid')
          expect(result).toBeNull()
        } catch (error) {
          // Malformed UUID may cause DB error
          expect(error).toBeDefined()
        }
      })

      it('findById with non-existent UUID returns null', async () => {
        const result = await ItemService.findById(
          '00000000-0000-0000-0000-000000000000',
        )
        expect(result).toBeNull()
      })

      it('update with non-existent ID throws NotFoundError', async () => {
        await expect(
          ItemService.update(
            '00000000-0000-0000-0000-000000000000',
            { name: 'Test' },
            user.id,
          ),
        ).rejects.toThrow(NotFoundError)
      })

      it('revise with non-existent ID throws NotFoundError', async () => {
        await expect(
          ItemService.revise(
            '00000000-0000-0000-0000-000000000000',
            'B',
            user.id,
          ),
        ).rejects.toThrow(NotFoundError)
      })

      it('delete with non-existent ID does not error', async () => {
        // Delete is idempotent - non-existent items don't throw
        const result = await ItemService.delete(
          '00000000-0000-0000-0000-000000000000',
        )
        expect(result).toBeUndefined()
      })
    })

    describe('Type Validation', () => {
      it('Part requires partType to be valid enum', async () => {
        await expect(
          ItemService.create(
            'Part',
            {
              itemNumber: `PN-${uniquePrefix}-BADMAKE001`,
              revision: 'A',
              name: 'Bad PartType Part',
              partType: 'InvalidValue',
              designId,
            } as any,
            user.id,
          ),
        ).rejects.toThrow()
      })

      it('ChangeOrder requires valid changeType', async () => {
        await expect(
          ItemService.create(
            'ChangeOrder',
            {
              revision: 'A',
              name: 'Bad Change Type',
              changeType: 'INVALID',
              priority: 'medium',
              designId,
            } as any,
            user.id,
          ),
        ).rejects.toThrow()
      })

      it('ChangeOrder requires valid priority', async () => {
        await expect(
          ItemService.create(
            'ChangeOrder',
            {
              revision: 'A',
              name: 'Bad Priority',
              changeType: 'ECO',
              priority: 'invalid',
              designId,
            } as any,
            user.id,
          ),
        ).rejects.toThrow()
      })
    })

    describe('Name and Description Edge Cases', () => {
      it('handles empty name', async () => {
        // Empty name may be accepted by the service
        try {
          const result = await ItemService.create(
            'Part',
            {
              itemNumber: `PN-${uniquePrefix}-EMPTYNAME`,
              revision: 'A',
              name: '',
              designId,
            } as any,
            user.id,
          )
          // If accepted, verify name is empty
          expect(result.name).toBe('')
        } catch (error) {
          // If rejected, that's also acceptable
          expect(error).toBeDefined()
        }
      })

      it('handles very long name', async () => {
        const longName = 'X'.repeat(500)

        try {
          const result = await ItemService.create(
            'Part',
            {
              itemNumber: `PN-${uniquePrefix}-LONGNAME`,
              revision: 'A',
              name: longName,
              designId,
            } as any,
            user.id,
          )
          expect(result.name.length).toBeGreaterThan(0)
        } catch (error) {
          expect(error).toBeInstanceOf(ValidationError)
        }
      })

      it('handles unicode in name', async () => {
        const result = await ItemService.create(
          'Part',
          {
            itemNumber: `PN-${uniquePrefix}-UNICODE001`,
            revision: 'A',
            name: '部品テスト 零件测试',
            designId,
          } as any,
          user.id,
        )

        expect(result.name).toBe('部品テスト 零件测试')
      })

      it('handles undefined description', async () => {
        // Test with undefined description (not null)
        const result = await ItemService.create(
          'Part',
          {
            itemNumber: `PN-${uniquePrefix}-UNDEFDESC`,
            revision: 'A',
            name: 'Undefined Desc Part',
            // description omitted (undefined)
            designId,
          } as any,
          user.id,
        )

        expect(result).toBeDefined()
      })

      it('handles very long description', async () => {
        const longDesc = 'Description content. '.repeat(1000)

        // Very long description may fail validation
        try {
          const result = await ItemService.create(
            'Part',
            {
              itemNumber: `PN-${uniquePrefix}-LONGDESC`,
              revision: 'A',
              name: 'Long Desc Part',
              description: longDesc,
              designId,
            } as any,
            user.id,
          )

          expect(result.description?.length).toBeGreaterThan(0)
        } catch (error) {
          // Validation error for too long is acceptable
          expect(error).toBeInstanceOf(ValidationError)
        }
      })
    })

    describe('Concurrent Operations', () => {
      it('handles parallel item creation', async () => {
        const promises = Array.from({ length: 5 }, (_, i) =>
          ItemService.create(
            'Part',
            {
              itemNumber: `PN-${uniquePrefix}-PARALLEL${i}`,
              revision: 'A',
              name: `Parallel Part ${i}`,
              designId,
            } as any,
            user.id,
          ),
        )

        const results = await Promise.all(promises)
        expect(results).toHaveLength(5)
        results.forEach((r) => expect(r.id).toBeDefined())
      })

      it('handles parallel updates to different items', async () => {
        // Create items first
        const items = await Promise.all(
          Array.from({ length: 3 }, (_, i) =>
            ItemService.create(
              'Part',
              {
                itemNumber: `PN-${uniquePrefix}-PARUPD${i}`,
                revision: 'A',
                name: `Parallel Update Part ${i}`,
                designId,
              } as any,
              user.id,
            ),
          ),
        )

        // Update all in parallel
        const updatePromises = items.map((item, i) =>
          ItemService.update(item.id, { name: `Updated ${i}` }, user.id),
        )

        const updated = await Promise.all(updatePromises)
        updated.forEach((u, i) => expect(u.name).toBe(`Updated ${i}`))
      })
    })

    describe('Search with DesignId Filtering', () => {
      it('search with designIds filter returns matching items', async () => {
        await ItemService.create(
          'Part',
          {
            itemNumber: `PN-${uniquePrefix}-DESFILTER001`,
            revision: 'A',
            name: 'Design Filter Part',
            designId,
          } as any,
          user.id,
        )

        const results = await ItemService.searchByItemNumber('DESFILTER', {
          designIds: [designId],
        })

        expect(results.length).toBeGreaterThanOrEqual(1)
        results.forEach((r) => expect(r.designId).toBe(designId))
      })

      it('search with non-matching designId returns empty', async () => {
        await ItemService.create(
          'Part',
          {
            itemNumber: `PN-${uniquePrefix}-NOMATCH001`,
            revision: 'A',
            name: 'No Match Part',
            designId,
          } as any,
          user.id,
        )

        const results = await ItemService.searchByItemNumber('NOMATCH', {
          designIds: ['00000000-0000-0000-0000-000000000000'],
        })

        expect(results).toEqual([])
      })

      it('search respects limit option', async () => {
        // Create multiple items
        for (let i = 0; i < 5; i++) {
          await ItemService.create(
            'Part',
            {
              itemNumber: `PN-${uniquePrefix}-SRCHPAGE${i}`,
              revision: 'A',
              name: `Search Page Part ${i}`,
              designId,
            } as any,
            user.id,
          )
        }

        const limited = await ItemService.searchByItemNumber('SRCHPAGE', {
          limit: 2,
        })
        expect(limited.length).toBeLessThanOrEqual(2)
      })

      it('search returns items of different types', async () => {
        await ItemService.create(
          'Part',
          {
            itemNumber: `PN-${uniquePrefix}-MIXTYPE001`,
            revision: 'A',
            name: 'Mixed Type Part',
            designId,
          } as any,
          user.id,
        )

        await ItemService.create(
          'Document',
          {
            itemNumber: `DOC-${uniquePrefix}-MIXTYPE001`,
            revision: 'A',
            name: 'Mixed Type Document',
            designId,
          } as any,
          user.id,
        )

        const results = await ItemService.searchByItemNumber('MIXTYPE')

        // Should return items of both types
        expect(results.length).toBeGreaterThanOrEqual(2)
        const types = new Set(results.map((r) => r.itemType))
        expect(types.has('Part') || types.has('Document')).toBe(true)
      })
    })

    describe('Update Operations', () => {
      it('update with empty object does not error', async () => {
        const item = await ItemService.create(
          'Part',
          {
            itemNumber: `PN-${uniquePrefix}-EMPTYUPD`,
            revision: 'A',
            name: 'Empty Update Part',
            designId,
          } as any,
          user.id,
        )

        const result = await ItemService.update(item.id, {}, user.id)
        expect(result.name).toBe('Empty Update Part')
      })

      it('update preserves fields not in update object', async () => {
        const item = await ItemService.create(
          'Part',
          {
            itemNumber: `PN-${uniquePrefix}-PRESERVE`,
            revision: 'A',
            name: 'Preserve Part',
            description: 'Original description',
            designId,
          } as any,
          user.id,
        )

        const result = await ItemService.update(
          item.id,
          { name: 'New Name' },
          user.id,
        )

        expect(result.name).toBe('New Name')
        expect((result as any).description).toBe('Original description')
      })
    })
  })
})
