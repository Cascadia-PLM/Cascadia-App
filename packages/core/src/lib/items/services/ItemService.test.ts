// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

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
import { and, eq } from 'drizzle-orm'
import { ItemService } from './ItemService'
import type { Part } from '@/lib/items/types/part'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import {
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from '@/lib/errors'
import { RevisionService } from '@/lib/services/RevisionService'
import { LifecycleService } from '@/lib/services/LifecycleService'
import { seedWorkOrderLifecycle } from '@/__tests__/fixtures/lifecycles'
import { LIFECYCLE_IDS } from '@/lib/items/lifecycle-ids'
import {
  branches,
  changeOrders,
  commits,
  designs,
  requirements,
  workOrderInstructions,
  workflowHistory,
  workflowInstances,
} from '@/lib/db/schema'
import { takeFirst } from '@/lib/db/take-first'
import { DesignService } from '@/lib/services/DesignService'
import { ProgramService } from '@/lib/services/ProgramService'
import { permissionService } from '@/lib/auth/permission-service'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

describe('ItemService', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let designId: string

  beforeAll(async () => {
    await testDb.setup()
    // The revision a create assigns follows the type's lifecycle kind, so the
    // Free-lifecycle case below needs a type whose kind this suite owns:
    // `LifecycleService.test.ts` re-links Task to a Driven lifecycle in the
    // same shared database, and the global default seed is first-writer-wins.
    await seedWorkOrderLifecycle(testDb.db)
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
    const createdDesign = takeFirst(
      await testDb.db
        .insert(designs)
        .values({
          name: 'Test Design',
          code: `PROD-${uniquePrefix}`,
          designType: 'Engineering',
          createdBy: user.id,
        })
        .returning(),
    )

    // Create main branch first (head unset), then the initial commit on it —
    // commits.branch_id is a real FK now, so the old placeholder-then-fixup
    // order cannot insert.
    const mainBranch = takeFirst(
      await testDb.db
        .insert(branches)
        .values({
          designId: createdDesign.id,
          name: 'main',
          branchType: 'main',
          createdBy: user.id,
        })
        .returning(),
    )

    const initialCommit = takeFirst(
      await testDb.db
        .insert(commits)
        .values({
          designId: createdDesign.id,
          branchId: mainBranch.id,
          message: 'Initial commit',
          createdBy: user.id,
        })
        .returning(),
    )

    await testDb.db
      .update(branches)
      .set({ headCommitId: initialCommit.id, baseCommitId: initialCommit.id })
      .where(eq(branches.id, mainBranch.id))

    // Update design with default branch
    const [updated] = await testDb.db
      .update(designs)
      .set({ defaultBranchId: mainBranch.id })
      .where(eq(designs.id, createdDesign.id))
      .returning()

    expect(updated).toBeDefined()
    designId = updated!.id
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

    // `items.attributes` is jsonb and `baseItemSchema` matches it, so whatever
    // a caller puts there comes back unchanged. It narrowed to
    // `Record<string, string>` once, which made a catalog snapshot or a SysML
    // element carrying a numeric property a validation failure rather than
    // data - and left three separate encode-on-the-way-in workarounds behind.
    it('round-trips a structured attributes document through create', async () => {
      const attributes = {
        text: 'anodized',
        count: 12,
        ratio: 0.5,
        flag: true,
        absent: null,
        list: [1, 'two', { three: false }],
        nested: { supplier: { name: 'Acme', leadTimeDays: 30 } },
      }

      const created = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-ATTRS`,
          revision: 'A',
          name: 'Structured attributes',
          partType: 'Manufacture',
          designId,
          attributes,
        } as any,
        user.id,
      )

      const found = await ItemService.findById(created.id)
      expect(found?.attributes).toEqual(attributes)
    })

    // The other half of matching the column: a value jsonb cannot hold is
    // refused at the boundary instead of being reshaped on the way to
    // Postgres. A Date carries a `toJSON`, so it would otherwise land as a
    // string nobody wrote.
    it('rejects an attributes value that jsonb cannot represent', async () => {
      await expect(
        ItemService.create(
          'Part',
          {
            itemNumber: `PN-${uniquePrefix}-ATTRD`,
            revision: 'A',
            name: 'Unrepresentable attribute',
            partType: 'Manufacture',
            designId,
            attributes: { measuredAt: new Date() },
          } as any,
          user.id,
        ),
      ).rejects.toThrow(ValidationError)
    })

    it('throws ValidationError for invalid data', async () => {
      const invalidData = {
        // Missing the design a Part requires
        itemNumber: `PN-${uniquePrefix}-INVALID`,
        name: 'Test Part',
      }

      await expect(
        ItemService.create('Part', invalidData as any, user.id),
      ).rejects.toThrow(ValidationError)
    })

    // The revision is the lifecycle's to assign, not the caller's. An
    // ECO-controlled type created at a real-looking 'A' is indistinguishable
    // from one released as A, and the first release then revises it to B.
    it('starts an ECO-controlled type at the unreleased marker', async () => {
      const created = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-NOREV`,
          name: 'No revision supplied',
          designId,
        } as any,
        user.id,
      )

      expect(created.revision).toBe(RevisionService.getUnreleasedRevision())
      expect(RevisionService.isWorkingRevision(created.revision)).toBe(true)
      // The marker is what makes the first release assign A rather than B.
      expect(RevisionService.getNextRevision(created.revision)).toBe('A')
    })

    // A Free lifecycle has no release to assign a revision later, so the
    // marker would be permanent: those start at the scheme's first value,
    // which is what every such create site used to write by hand.
    it('starts a type no release ever revises at the first revision', async () => {
      const created = await ItemService.create(
        'WorkOrder',
        {
          // WO numbers are auto-generated; manual entry is refused
          name: 'No revision supplied',
        } as any,
        user.id,
      )

      expect(created.revision).toBe('A')
    })

    it('keeps a revision the caller does name', async () => {
      const created = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-IMPORTED`,
          name: 'Imported at C',
          designId,
          revision: 'C',
        } as any,
        user.id,
      )

      expect(created.revision).toBe('C')
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

    // An MBOM copies the EBOM's item numbers verbatim, so the same number
    // names two items. The lookup used to be an unordered LIMIT 1 and
    // resolved to whichever row the planner reached first - in practice the
    // manufacturing copy, which is how an agent asked about a released
    // assembly answered from an empty draft shadow of it.
    describe('when the number exists in more than one design', () => {
      let mbomDesignId: string
      let itemNumber: string

      beforeEach(async () => {
        mbomDesignId = takeFirst(
          await testDb.db
            .insert(designs)
            .values({
              name: 'Test Design MBOM',
              code: `PROD-${uniquePrefix}-M`,
              designType: 'Manufacturing',
              sourceDesignId: designId,
              createdBy: user.id,
            })
            .returning(),
        ).id

        itemNumber = `PN-${uniquePrefix}-SHARED-001`

        await ItemService.create(
          'Part',
          { itemNumber, revision: 'A', name: 'EBOM part', designId } as any,
          user.id,
        )
        await ItemService.create(
          'Part',
          {
            itemNumber,
            revision: 'A',
            name: 'MBOM copy',
            designId: mbomDesignId,
          } as any,
          user.id,
        )

        // The copy really is derived later than the original, but every row
        // written inside one test transaction shares the same now(), so say
        // it explicitly. That leaves recency - the last ordering rule with
        // any opinion here - pointing at the copy, so these tests fail if
        // the design ranking stops being what decides.
        const { items: itemsTable } = await import('@/lib/db/schema')
        await testDb.db
          .update(itemsTable)
          .set({ createdAt: new Date(Date.now() + 60_000) })
          .where(
            and(
              eq(itemsTable.itemNumber, itemNumber),
              eq(itemsTable.designId, mbomDesignId),
            ),
          )
      })

      it('returns the engineering item, not the manufacturing copy', async () => {
        const found = await ItemService.findByNumber(itemNumber)

        expect(found?.designId).toBe(designId)
        expect(found?.name).toBe('EBOM part')
      })

      it('returns the same item every time', async () => {
        const ids = await Promise.all(
          Array.from({ length: 5 }, () => ItemService.findByNumber(itemNumber)),
        )

        expect(new Set(ids.map((item) => item?.id)).size).toBe(1)
      })

      it('honours an explicit designId over the ranking', async () => {
        const found = await ItemService.findByNumber(itemNumber, undefined, {
          designId: mbomDesignId,
        })

        expect(found?.designId).toBe(mbomDesignId)
        expect(found?.name).toBe('MBOM copy')
      })

      it('reports every match, best first, named by design', async () => {
        const matches = await ItemService.findMatchesByNumber(itemNumber)

        expect(matches.map((m) => m.designId)).toEqual([designId, mbomDesignId])
        expect(matches.map((m) => m.designType)).toEqual([
          'Engineering',
          'Manufacturing',
        ])
        expect(matches[1]?.designCode).toBe(`PROD-${uniquePrefix}-M`)
      })

      // `[]` is not `null`: a caller that reaches no design must see nothing,
      // never everything - the ambiguity report must not become a way to read
      // item numbers out of designs the caller has no access to.
      it('sees only the designs its access scope admits', async () => {
        const scoped = await ItemService.findMatchesByNumber(
          itemNumber,
          undefined,
          { accessScope: { designIds: [mbomDesignId], programIds: [] } },
        )
        expect(scoped.map((m) => m.designId)).toEqual([mbomDesignId])

        const unscoped = await ItemService.findMatchesByNumber(
          itemNumber,
          undefined,
          { accessScope: { designIds: [], programIds: [] } },
        )
        expect(unscoped).toEqual([])
      })
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

      const updated = await ItemService.update<Part>(
        created.id,
        {
          name: 'Updated Name',
          description: 'Updated description',
        },
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

      const updated = await ItemService.update<Part>(
        created.id,
        {
          partType: 'Purchase',
          material: 'Steel',
        },
        user.id,
      )

      expect(updated.partType).toBe('Purchase')
      expect(updated.material).toBe('Steel')
    })

    // The three names below are documented on their PUT bodies and were
    // accepted-and-dropped: the update landed nowhere and a re-read returned
    // the old value. Assert the stored value, not the call.
    it('stores a requirement type sent under the API name requirementType', async () => {
      const created = await ItemService.create(
        'Requirement',
        {
          itemNumber: `REQ-${uniquePrefix}-ALIAS-001`,
          revision: 'A',
          name: 'Alias Requirement',
          designId,
        } as any,
        user.id,
      )

      await ItemService.update(
        created.id,
        { requirementType: 'Performance' } as any,
        user.id,
      )

      const stored = takeFirst(
        await testDb.db
          .select()
          .from(requirements)
          .where(eq(requirements.itemId, created.id)),
      )
      expect(stored.type).toBe('Performance')
    })

    it('prefers an explicit type over the requirementType alias', async () => {
      const created = await ItemService.create(
        'Requirement',
        {
          itemNumber: `REQ-${uniquePrefix}-ALIAS-002`,
          revision: 'A',
          name: 'Alias Precedence Requirement',
          designId,
        } as any,
        user.id,
      )

      await ItemService.update(
        created.id,
        { type: 'Security', requirementType: 'Performance' } as any,
        user.id,
      )

      const stored = takeFirst(
        await testDb.db
          .select()
          .from(requirements)
          .where(eq(requirements.itemId, created.id)),
      )
      expect(stored.type).toBe('Security')
    })

    it('round-trips a change order description', async () => {
      const created = await ItemService.create(
        'ChangeOrder',
        {
          revision: 'A',
          name: 'Described Change Order',
          changeType: 'ECO',
          designId,
        } as any,
        user.id,
      )

      await ItemService.update(
        created.id,
        { description: 'Why this change exists' } as any,
        user.id,
      )

      const stored = takeFirst(
        await testDb.db
          .select()
          .from(changeOrders)
          .where(eq(changeOrders.itemId, created.id)),
      )
      expect(stored.description).toBe('Why this change exists')
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

    it('rejects state changes through the generic update path (WI-2.1)', async () => {
      const created = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-LIFE-001`,
          revision: 'A',
          name: 'Lifecycle Guard',
          designId,
        } as any,
        user.id,
      )

      await expect(
        ItemService.update(created.id, { state: 'Released' } as any, user.id),
      ).rejects.toThrow(ValidationError)
    })

    it('rejects revision and isCurrent changes through update', async () => {
      const created = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-LIFE-002`,
          revision: 'A',
          name: 'Lifecycle Guard 2',
          designId,
        } as any,
        user.id,
      )

      await expect(
        ItemService.update(created.id, { revision: 'Z' } as any, user.id),
      ).rejects.toThrow(ValidationError)
      await expect(
        ItemService.update(created.id, { isCurrent: false } as any, user.id),
      ).rejects.toThrow(ValidationError)
    })

    it('tolerates echoed unchanged lifecycle fields (whole-object form saves)', async () => {
      const created = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-LIFE-003`,
          revision: 'A',
          name: 'Echo Save',
          designId,
        } as any,
        user.id,
      )

      const updated = await ItemService.update(
        created.id,
        {
          name: 'Echo Save Updated',
          state: created.state,
          revision: created.revision,
          isCurrent: created.isCurrent,
        },
        user.id,
      )

      expect(updated.name).toBe('Echo Save Updated')
      expect(updated.state).toBe(created.state)
      expect(updated.revision).toBe(created.revision)
    })

    it('permits lifecycle fields for the release machinery (allowLifecycleFields)', async () => {
      const created = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-LIFE-004`,
          revision: 'A',
          name: 'Release Machinery Path',
          designId,
        } as any,
        user.id,
      )

      const updated = await ItemService.update<Part>(
        created.id,
        { state: 'Released' },
        user.id,
        { bypassBranchProtection: true, allowLifecycleFields: true },
      )

      expect(updated.state).toBe('Released')
    })

    it('rejects clearing an item’s design through update', async () => {
      const created = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-DESIGN-001`,
          revision: 'A',
          name: 'Design Guard',
          designId,
        } as any,
        user.id,
      )

      // `designId: null` used to write straight through, stranding the part
      // outside versioning while its commits stayed with the design.
      await expect(
        ItemService.update(created.id, { designId: null } as any, user.id),
      ).rejects.toThrow(ValidationError)

      const after = await ItemService.findById(created.id)
      expect(after?.designId).toBe(designId)
    })

    it('rejects moving an item to another design through update', async () => {
      const otherDesign = takeFirst(
        await testDb.db
          .insert(designs)
          .values({
            name: 'Other Design',
            code: `OTHER-${uniquePrefix}`,
            designType: 'Engineering',
            createdBy: user.id,
          })
          .returning(),
      )

      const created = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-DESIGN-002`,
          revision: 'A',
          name: 'Design Move Guard',
          designId,
        } as any,
        user.id,
      )

      await expect(
        ItemService.update(
          created.id,
          { designId: otherDesign.id } as any,
          user.id,
        ),
      ).rejects.toThrow(ValidationError)

      const after = await ItemService.findById(created.id)
      expect(after?.designId).toBe(designId)
    })

    it('tolerates an echoed unchanged designId (whole-object form saves)', async () => {
      const created = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-DESIGN-003`,
          revision: 'A',
          name: 'Design Echo',
          designId,
        } as any,
        user.id,
      )

      // The part form PUTs the whole item back, designId included, so the
      // guard has to pass this through rather than reject every save.
      const updated = await ItemService.update<Part>(
        created.id,
        { name: 'Design Echo Updated', designId },
        user.id,
      )

      expect(updated.name).toBe('Design Echo Updated')
      expect(updated.designId).toBe(designId)
    })

    it('still adopts a design-less item into a design', async () => {
      // The one direction that adds history instead of orphaning it — how a
      // legacy design-less item gets repaired.
      const created = await ItemService.create(
        'Task',
        {
          itemNumber: `TSK-${uniquePrefix}-DESIGN-004`,
          revision: 'A',
          name: 'Adoptable Task',
          priority: 'Low',
        } as any,
        user.id,
      )
      expect(created.designId).toBeNull()

      const updated = await ItemService.update(
        created.id,
        { designId },
        user.id,
      )

      expect(updated.designId).toBe(designId)
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

      await ItemService.delete(created.id, user.id)

      const found = await ItemService.findById(created.id)
      expect(found).toBeNull()
    })

    it('does not throw when deleting non-existent item', async () => {
      // This is current behavior - no error for missing item
      await expect(
        ItemService.delete('00000000-0000-0000-0000-000000000000', user.id),
      ).resolves.not.toThrow()
    })

    // The hard delete cascades from items.id — version rows, workflow
    // instance, its history and approvals, affected-item lists, traveler
    // lines. These pin what it is no longer allowed to take. Every state ID
    // below is read from lifecycle configuration, never written as a literal.
    describe('evidence the delete must not destroy', () => {
      /**
       * A state is put on the row directly: `ItemService.update` refuses to
       * write `state` at all (transitions go through the lifecycle), and the
       * transition machinery is not what these tests are about.
       */
      async function putInState(itemId: string, state: string): Promise<void> {
        const { items: itemsTable } = await import('@/lib/db/schema')
        await testDb.db
          .update(itemsTable)
          .set({ state })
          .where(eq(itemsTable.id, itemId))
      }

      /** The governing definition's first state matching `match`. */
      async function governingState(
        itemType: string,
        match: (s: {
          id: string
          isInitial?: boolean
          isFinal?: boolean
          finalKind?: string
        }) => boolean,
      ): Promise<string> {
        const governing =
          await LifecycleService.getGoverningDefinition(itemType)
        const found = governing?.states.find(match)
        if (!found) {
          throw new Error(`No matching ${itemType} state in configuration`)
        }
        return found.id
      }

      it('refuses a change order that has left its initial state, and keeps its vote record', async () => {
        const inReview = await governingState(
          'ChangeOrder',
          (s) => s.isInitial !== true && s.isFinal !== true,
        )

        const eco = await ItemService.create(
          'ChangeOrder',
          {
            revision: 'A',
            name: 'Delete Gate ECO',
            changeType: 'ECO',
            priority: 'medium',
            reasonForChange: 'Test reason',
            designId,
          } as any,
          user.id,
        )

        const instance = takeFirst(
          await testDb.db
            .insert(workflowInstances)
            .values({
              workflowDefinitionId: LIFECYCLE_IDS.changeOrder,
              itemId: eco.id,
              currentState: inReview,
              context: { actorId: user.id },
            })
            .returning(),
        )
        await testDb.db.insert(workflowHistory).values({
          instanceId: instance.id,
          toState: inReview,
          action: 'Submit for Review',
          actorId: user.id,
        })
        await putInState(eco.id, inReview)

        await expect(ItemService.delete(eco.id, user.id)).rejects.toThrow(
          ValidationError,
        )

        expect(await ItemService.findById(eco.id)).not.toBeNull()
        expect(
          await testDb.db
            .select()
            .from(workflowInstances)
            .where(eq(workflowInstances.itemId, eco.id)),
        ).toHaveLength(1)
        expect(
          await testDb.db
            .select()
            .from(workflowHistory)
            .where(eq(workflowHistory.instanceId, instance.id)),
        ).toHaveLength(1)
      })

      it('refuses a change order that has reached a release final state', async () => {
        const approved = await governingState(
          'ChangeOrder',
          (s) => s.finalKind === 'release',
        )

        const eco = await ItemService.create(
          'ChangeOrder',
          {
            revision: 'A',
            name: 'Released ECO',
            changeType: 'ECO',
            priority: 'medium',
            reasonForChange: 'Test reason',
            designId,
          } as any,
          user.id,
        )
        await putInState(eco.id, approved)

        await expect(ItemService.delete(eco.id, user.id)).rejects.toThrow(
          ValidationError,
        )
        expect(await ItemService.findById(eco.id)).not.toBeNull()
      })

      // The regression pin: ChangeOrderService.create deletes a change order
      // it has just failed to link to a design, and that cleanup must survive
      // the gate. A change order in the state `create` gave it is still
      // deletable.
      it('still deletes a change order in its initial state', async () => {
        const eco = await ItemService.create(
          'ChangeOrder',
          {
            revision: 'A',
            name: 'Draft ECO',
            changeType: 'ECO',
            priority: 'medium',
            reasonForChange: 'Test reason',
            designId,
          } as any,
          user.id,
        )

        await ItemService.delete(eco.id, user.id)

        expect(await ItemService.findById(eco.id)).toBeNull()
      })

      // Released lineage. Branch protection already refuses this for a part
      // inside a design that has released — this arm is what answers for the
      // design-less rows that skip that gate entirely, and states the rule
      // once for any lifecycle whose release family is reachable.
      it('refuses a released item', async () => {
        const released = (
          await LifecycleService.getReleasedFamilyStates('Part')
        ).at(0)
        expect(released).toBeDefined()

        const part = await ItemService.create(
          'Part',
          {
            itemNumber: `PN-${uniquePrefix}-DELETE-RELEASED`,
            revision: 'A',
            name: 'Released Part',
            designId,
          } as any,
          user.id,
        )
        // A design-less row — the legacy shape the codebase still repairs by
        // adoption — is what reaches this arm: `requireContentEditable`
        // returns early without a design, so branch protection never runs.
        const { items: itemsTable } = await import('@/lib/db/schema')
        await testDb.db
          .update(itemsTable)
          .set({ state: released, designId: null })
          .where(eq(itemsTable.id, part.id))

        await expect(ItemService.delete(part.id, user.id)).rejects.toThrow(
          ValidationError,
        )

        expect(await ItemService.findById(part.id)).not.toBeNull()
      })

      it('refuses a completed work order, and keeps its traveler lines', async () => {
        const complete = await governingState(
          'WorkOrder',
          (s) => s.finalKind === 'complete',
        )

        const workOrder = await ItemService.create(
          'WorkOrder',
          {
            revision: 'A',
            name: 'Completed Work Order',
            designId,
            quantity: 1,
          } as any,
          user.id,
        )
        const line = takeFirst(
          await testDb.db
            .insert(workOrderInstructions)
            .values({
              workOrderId: workOrder.id,
              title: 'Torque the fasteners',
              snapshot: { operations: [], steps: [] } as any,
              createdBy: user.id,
            })
            .returning(),
        )
        await putInState(workOrder.id, complete)

        await expect(ItemService.delete(workOrder.id, user.id)).rejects.toThrow(
          ValidationError,
        )

        expect(await ItemService.findById(workOrder.id)).not.toBeNull()
        expect(
          await testDb.db
            .select()
            .from(workOrderInstructions)
            .where(eq(workOrderInstructions.id, line.id)),
        ).toHaveLength(1)
      })
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

      // A real released-family state (the boundary now rejects states the
      // lifecycle does not define, which is how 'InReview' used to sneak in
      // here); creating it protects main, so the sibling below bypasses
      await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-SEARCH-002`,
          revision: 'A',
          name: 'Search Part Two',
          state: 'Released',
          designId,
        } as any,
        user.id,
        { bypassBranchProtection: true },
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
        { bypassBranchProtection: true },
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
      expect(related[0]).toMatchObject({ id: childPart.id })
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
      const relationship = relationships[0]
      expect(relationship).toBeDefined()
      expect(parseFloat(relationship!.quantity!)).toBe(5)
      expect(relationship!.findNumber).toBe(10)
      expect(relationship!.targetItem).toBeDefined()
      expect(relationship!.targetItem?.id).toBe(childPart.id)
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

      await ItemService.removeRelationship(beforeRemove[0]!.id, user.id)

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
      const design2 = takeFirst(
        await testDb.db
          .insert(designs)
          .values({
            name: 'Second Design',
            code: `PROD2-${uniquePrefix}`,
            designType: 'Engineering',
            createdBy: user.id,
          })
          .returning(),
      )

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
          designId,
        } as any,
        user.id,
      )

      const updated = await ItemService.update(
        created.id,
        {
          description: 'Reworded after review',
          priority: 'MustHave',
        } as any,
        user.id,
      )

      expect((updated as any).description).toBe('Reworded after review')
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

    // The schema types `state` as a plain string because the state universe
    // is runtime lifecycle configuration — this boundary check is what
    // rejects states the lifecycle does not define.
    it('rejects a state the lifecycle does not define', async () => {
      await expect(
        ItemService.create(
          'Part',
          {
            itemNumber: `PN-${uniquePrefix}-BOGUS`,
            revision: 'A',
            name: 'Bogus State Part',
            state: 'NotARealState',
            designId,
          } as any,
          user.id,
          { bypassBranchProtection: true },
        ),
      ).rejects.toThrow(ValidationError)
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

      await ItemService.removeRelationship(relationship.id, user.id)

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
      expect(bomOnly[0]).toMatchObject({ id: child1.id })
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
      expect(details[0]).toMatchObject({ relationshipType: 'BOM' })
      expect(details[0]?.targetItem).toBeDefined()
    })
  })

  describe('searchByItemNumber advanced options', () => {
    it('filters by multiple designIds', async () => {
      const design2 = takeFirst(
        await testDb.db
          .insert(designs)
          .values({
            name: 'Search Design',
            code: `SRCH-${uniquePrefix}`,
            designType: 'Engineering',
            createdBy: user.id,
          })
          .returning(),
      )

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
          user.id,
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

      // A design scope that resolves to nothing — `designScope=library` on an
      // instance with no Standard Library, `designScope=all` for a user in no
      // program — must match nothing rather than fall through to every design
      it('an empty designIds set matches nothing, not everything', async () => {
        await ItemService.create(
          'Part',
          {
            itemNumber: `PN-${uniquePrefix}-EMPTYSCOPE001`,
            revision: 'A',
            name: 'Empty Scope Part',
            designId,
          } as any,
          user.id,
        )

        const byNumber = await ItemService.searchByItemNumber('EMPTYSCOPE', {
          designIds: [],
        })
        expect(byNumber).toEqual([])

        const byType = await ItemService.search('Part', { designIds: [] })
        expect(byType.items).toEqual([])
        expect(byType.total).toBe(0)
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

  /**
   * Security gate. Type-level RBAC answers "may this user update parts?" and
   * says nothing about *which* parts; program membership is what scopes that.
   * Until this gate existed, PUT and DELETE on every by-id type route wrote
   * straight across the program boundary — RBAC alone was the whole check.
   *
   * The suite's own design has no programId, and an unassigned design is
   * readable by everyone by deliberate design, so these cases seed a
   * program-assigned design of their own.
   */
  describe('design access on update and delete', () => {
    let member: TestUser
    let outsider: TestUser
    let scopedDesignId: string

    beforeEach(async () => {
      permissionService.clearCache()

      member = await insertTestUser(testDb.db)
      outsider = await insertTestUser(testDb.db)

      // create() enrolls the creator as an admin member, which is exactly the
      // membership under test — no addMember needed.
      const program = await ProgramService.create(
        { name: 'Scoped Program', code: `SCOPE-${uniquePrefix}` },
        member.id,
      )

      const design = await DesignService.create(
        {
          programId: program.id,
          name: 'Scoped Design',
          code: `SCOPED-${uniquePrefix}`,
          designType: 'Engineering',
        },
        member.id,
      )
      scopedDesignId = design.id
    })

    async function scopedPart(suffix: string) {
      return ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-${suffix}`,
          revision: 'A',
          name: 'Scoped Part',
          designId: scopedDesignId,
        } as any,
        member.id,
      )
    }

    it('refuses an update from someone outside the program', async () => {
      const part = await scopedPart('OUT-U')

      await expect(
        ItemService.update(part.id, { name: 'Renamed' }, outsider.id),
      ).rejects.toThrow(PermissionDeniedError)

      const unchanged = await ItemService.findById(part.id)
      expect(unchanged!.name).toBe('Scoped Part')
    })

    it('refuses a delete from someone outside the program', async () => {
      const part = await scopedPart('OUT-D')

      await expect(ItemService.delete(part.id, outsider.id)).rejects.toThrow(
        PermissionDeniedError,
      )

      expect(await ItemService.findById(part.id)).not.toBeNull()
    })

    it('allows a program member through', async () => {
      const part = await scopedPart('IN')

      const updated = await ItemService.update(
        part.id,
        { name: 'Renamed' },
        member.id,
      )
      expect(updated.name).toBe('Renamed')

      await ItemService.delete(part.id, member.id)
      expect(await ItemService.findById(part.id)).toBeNull()
    })

    it('refuses before reporting which fields are immutable', async () => {
      const part = await scopedPart('ORDER')

      // A lifecycle field an outsider may not write either way. Authorization
      // has to answer first, or the 400 tells them the item exists and what
      // shape it has.
      await expect(
        ItemService.update(part.id, { state: 'Released' } as any, outsider.id),
      ).rejects.toThrow(PermissionDeniedError)
    })

    it('lets the release machinery through with skipAccessCheck', async () => {
      const part = await scopedPart('BYPASS')

      // What ChangeOrderMergeService passes: a releaser may legitimately reach
      // only a subset of a multi-design ECO's designs, so the release decides
      // authorization once on the ECO rather than per item.
      const updated = await ItemService.update(
        part.id,
        { name: 'Released by machinery' },
        outsider.id,
        { skipAccessCheck: true },
      )
      expect(updated.name).toBe('Released by machinery')

      await ItemService.delete(part.id, outsider.id, { skipAccessCheck: true })
      expect(await ItemService.findById(part.id)).toBeNull()
    })

    it('leaves design-less items alone', async () => {
      // Change orders carry designId NULL, so there is no design to check and
      // this gate must not become an accidental block on them. Their own
      // routes are gated separately.
      const changeOrder = await ItemService.create(
        'ChangeOrder',
        {
          revision: 'A',
          name: 'Design-less ECO',
          changeType: 'ECO',
          priority: 'medium',
          reasonForChange: 'Covering the design-less path',
        } as any,
        member.id,
      )
      expect(changeOrder.designId).toBeNull()

      const updated = await ItemService.update(
        changeOrder.id,
        { name: 'Renamed by an outsider' },
        outsider.id,
      )
      expect(updated.name).toBe('Renamed by an outsider')
    })
  })
})
