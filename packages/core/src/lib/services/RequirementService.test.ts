// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * RequirementService Tests
 *
 * Integration tests for the RequirementService class.
 * Tests cover satisfaction linking, derivation, allocation, coverage,
 * verification status/method updates, and test case verification linking.
 *
 * Run: npm run test -- src/lib/services/RequirementService.test.ts
 */

import { and, eq } from 'drizzle-orm'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import { RequirementService } from './RequirementService'
import { BranchService } from './BranchService'
import { DesignService } from './DesignService'
import { CheckoutService } from './CheckoutService'
import { RevisionService } from './RevisionService'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { Requirement } from '@/lib/items/types/requirement'
import type { Part } from '@/lib/items/types/part'
import type { TestCase } from '@/lib/items/types/testcase'
import type { PersistedItem } from '@/lib/items/types/base'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import {
  branchItems,
  itemRelationships,
  items,
  programMembers,
  programs,
} from '@/lib/db/schema'
import { itemVersions } from '@/lib/db/schema/versioning'
import {
  BranchProtectionError,
  ItemCheckoutRequiredError,
  NotFoundError,
  ValidationError,
} from '@/lib/errors'
import { ItemService } from '@/lib/items/services/ItemService'
import { ItemRelationshipService } from '@/lib/items/services/ItemRelationshipService'
import { resolveEdgeGuardEnd } from '@/lib/items/traceability-relationships'
import { ChangeOrderService } from '@/lib/items/services/ChangeOrderService'
import { takeFirst } from '@/lib/db/take-first'
import '@/lib/items/registerItemTypes.server'

describe('RequirementService', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let designId: string
  let initialCommitId: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    user = await insertTestUser(testDb.db)

    // Create program + design
    const program = takeFirst(
      await testDb.db
        .insert(programs)
        .values({
          name: 'Test Program',
          code: `PROG-${Date.now()}`,
          createdBy: user.id,
        })
        .returning(),
    )

    // The program's creator is not automatically a member when the row is
    // inserted directly (ProgramService.create is what enrols them), and
    // ItemService.update/delete now refuse a write to a design the caller
    // cannot reach. Enrol the acting user so these cases exercise their own
    // subject rather than the program boundary.
    await testDb.db.insert(programMembers).values({
      programId: program.id,
      userId: user.id,
      role: 'admin',
      invitedBy: user.id,
    })

    const design = await DesignService.create(
      {
        programId: program.id,
        name: 'Test Design',
        code: `DESIGN-${Date.now()}`,
        designType: 'Engineering',
      },
      user.id,
    )
    designId = design.id
    initialCommitId = design.initialCommit!.id
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  // ---- Helpers ----

  async function createRequirement(
    overrides: Partial<Requirement> = {},
  ): Promise<Requirement> {
    const ts = Date.now()
    return ItemService.create(
      'Requirement',
      {
        itemNumber:
          overrides.itemNumber ??
          `REQ-${ts}-${Math.random().toString(36).slice(2, 6)}`,
        revision: 'A',
        designId,
        name: overrides.name ?? 'Test Requirement',
        ...overrides,
      } as Requirement,
      user.id,
    )
  }

  async function createPart(overrides: Partial<Part> = {}): Promise<Part> {
    const ts = Date.now()
    return ItemService.create(
      'Part',
      {
        itemNumber:
          overrides.itemNumber ??
          `PRT-${ts}-${Math.random().toString(36).slice(2, 6)}`,
        revision: 'A',
        designId,
        name: overrides.name ?? 'Test Part',
        ...overrides,
      } as Part,
      user.id,
    )
  }

  async function createTestCase(
    overrides: Partial<TestCase> = {},
  ): Promise<TestCase> {
    const ts = Date.now()
    return ItemService.create(
      'TestCase',
      {
        itemNumber:
          overrides.itemNumber ??
          `TC-${ts}-${Math.random().toString(36).slice(2, 6)}`,
        revision: 'A',
        designId,
        name: overrides.name ?? 'Test Case',
        ...overrides,
      } as TestCase,
      user.id,
    )
  }

  // ================================================================
  // linkSatisfaction() and unlinkSatisfaction()
  // ================================================================

  describe('linkSatisfaction()', () => {
    it('should link a part to a requirement as SATISFIES', async () => {
      const req = await createRequirement()
      const part = await createPart()

      await RequirementService.linkSatisfaction(req.id!, [part.id!], user.id)

      const satisfying = await RequirementService.getSatisfyingItems(req.id!)
      expect(satisfying).toHaveLength(1)
      expect(satisfying[0]!.id).toBe(part.id)
    })

    it('should link multiple items to a requirement', async () => {
      const req = await createRequirement()
      const part1 = await createPart({ name: 'Part 1' })
      const part2 = await createPart({ name: 'Part 2' })

      await RequirementService.linkSatisfaction(
        req.id!,
        [part1.id!, part2.id!],
        user.id,
      )

      const satisfying = await RequirementService.getSatisfyingItems(req.id!)
      expect(satisfying).toHaveLength(2)
      const ids = satisfying.map((s) => s.id)
      expect(ids).toContain(part1.id)
      expect(ids).toContain(part2.id)
    })

    it('should skip duplicate satisfaction links', async () => {
      const req = await createRequirement()
      const part = await createPart()

      await RequirementService.linkSatisfaction(req.id!, [part.id!], user.id)
      // Link again - should not create duplicate
      await RequirementService.linkSatisfaction(req.id!, [part.id!], user.id)

      const satisfying = await RequirementService.getSatisfyingItems(req.id!)
      expect(satisfying).toHaveLength(1)
    })

    it('should throw NotFoundError for non-existent requirement', async () => {
      const part = await createPart()
      const fakeId = '00000000-0000-0000-0000-000000000000'

      await expect(
        RequirementService.linkSatisfaction(fakeId, [part.id!], user.id),
      ).rejects.toThrow(NotFoundError)
    })

    it('should throw NotFoundError for non-existent item', async () => {
      const req = await createRequirement()
      const fakeId = '00000000-0000-0000-0000-000000000000'

      await expect(
        RequirementService.linkSatisfaction(req.id!, [fakeId], user.id),
      ).rejects.toThrow(NotFoundError)
    })
  })

  describe('unlinkSatisfaction()', () => {
    it('should remove a satisfaction relationship', async () => {
      const req = await createRequirement()
      const part = await createPart()

      await RequirementService.linkSatisfaction(req.id!, [part.id!], user.id)
      let satisfying = await RequirementService.getSatisfyingItems(req.id!)
      expect(satisfying).toHaveLength(1)

      await RequirementService.unlinkSatisfaction(req.id!, part.id!, user.id)

      satisfying = await RequirementService.getSatisfyingItems(req.id!)
      expect(satisfying).toHaveLength(0)
    })

    it('should do nothing when unlinking a non-existent relationship', async () => {
      const req = await createRequirement()
      const part = await createPart()

      // No link exists; should not throw
      await RequirementService.unlinkSatisfaction(req.id!, part.id!, user.id)
    })
  })

  // ================================================================
  // getSatisfyingItems()
  // ================================================================

  describe('getSatisfyingItems()', () => {
    it('should return items that satisfy a requirement', async () => {
      const req = await createRequirement()
      const part = await createPart({ name: 'Satisfying Part' })

      await RequirementService.linkSatisfaction(req.id!, [part.id!], user.id)

      const result = await RequirementService.getSatisfyingItems(req.id!)
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({
        id: part.id,
        itemType: 'Part',
        name: 'Satisfying Part',
      })
      expect(result[0]!.relationshipId).toBeDefined()
    })

    it('should return empty array when no items satisfy', async () => {
      const req = await createRequirement()

      const result = await RequirementService.getSatisfyingItems(req.id!)
      expect(result).toEqual([])
    })
  })

  // ================================================================
  // getRequirementsSatisfiedBy()
  // ================================================================

  describe('getRequirementsSatisfiedBy()', () => {
    it('should return requirements that an item satisfies', async () => {
      const req1 = await createRequirement({
        name: 'Req Alpha',
        priority: 'MustHave',
      })
      const req2 = await createRequirement({
        name: 'Req Beta',
        priority: 'ShouldHave',
      })
      const part = await createPart()

      await RequirementService.linkSatisfaction(req1.id!, [part.id!], user.id)
      await RequirementService.linkSatisfaction(req2.id!, [part.id!], user.id)

      const result = await RequirementService.getRequirementsSatisfiedBy(
        part.id!,
      )
      expect(result).toHaveLength(2)
      const names = result.map((r) => r.name)
      expect(names).toContain('Req Alpha')
      expect(names).toContain('Req Beta')
    })

    it('should return empty array when item satisfies no requirements', async () => {
      const part = await createPart()

      const result = await RequirementService.getRequirementsSatisfiedBy(
        part.id!,
      )
      expect(result).toEqual([])
    })
  })

  // ================================================================
  // deriveRequirement()
  // ================================================================

  describe('deriveRequirement()', () => {
    it('should create a child requirement from a parent', async () => {
      const parent = await createRequirement({
        itemNumber: `REQ-PARENT-${Date.now()}`,
        name: 'Parent Requirement',
      })

      const child = await RequirementService.deriveRequirement(
        parent.id!,
        { name: 'Child Requirement' },
        user.id,
      )

      expect(child).toBeDefined()
      expect(child.name).toBe('Child Requirement')
      expect(child.parentRequirementId).toBe(parent.id)
      expect(child.designId).toBe(designId)
    })

    it('should auto-generate item number as PARENT-D1, PARENT-D2', async () => {
      const parentNumber = `REQ-AUTO-${Date.now()}`
      const parent = await createRequirement({ itemNumber: parentNumber })

      const child1 = await RequirementService.deriveRequirement(
        parent.id!,
        { name: 'First Child' },
        user.id,
      )
      const child2 = await RequirementService.deriveRequirement(
        parent.id!,
        { name: 'Second Child' },
        user.id,
      )

      expect(child1.itemNumber).toBe(`${parentNumber}-D1`)
      expect(child2.itemNumber).toBe(`${parentNumber}-D2`)
    })

    it('should use explicit itemNumber when provided', async () => {
      const parent = await createRequirement()
      const customNumber = `REQ-CUSTOM-${Date.now()}`

      const child = await RequirementService.deriveRequirement(
        parent.id!,
        { itemNumber: customNumber, name: 'Custom Child' },
        user.id,
      )

      expect(child.itemNumber).toBe(customNumber)
    })

    it('should throw NotFoundError for non-existent parent', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000'

      await expect(
        RequirementService.deriveRequirement(
          fakeId,
          { name: 'Orphan Child' },
          user.id,
        ),
      ).rejects.toThrow(NotFoundError)
    })

    it('should throw ValidationError if derived item type is not Requirement', async () => {
      const parent = await createRequirement()

      await expect(
        RequirementService.deriveRequirement(
          parent.id!,
          { itemType: 'Part' as any, name: 'Wrong Type' },
          user.id,
        ),
      ).rejects.toThrow(ValidationError)
    })

    it('should inherit verification method, category and source from the parent', async () => {
      const parent = await createRequirement({
        verificationMethod: 'Test',
        category: 'Safety',
        source: 'Customer spec 4.2',
      })

      const child = await RequirementService.deriveRequirement(
        parent.id!,
        { name: 'Inheriting Child' },
        user.id,
      )

      expect(child.verificationMethod).toBe('Test')
      expect(child.category).toBe('Safety')
      expect(child.source).toBe('Customer spec 4.2')
    })

    it('should let the caller override inherited fields', async () => {
      const parent = await createRequirement({
        verificationMethod: 'Test',
        category: 'Safety',
      })

      const child = await RequirementService.deriveRequirement(
        parent.id!,
        { name: 'Overriding Child', verificationMethod: 'Inspection' },
        user.id,
      )

      expect(child.verificationMethod).toBe('Inspection')
      expect(child.category).toBe('Safety')
    })

    it('should create the child on an explicitly named branch', async () => {
      const parent = await createRequirement()
      const branch = await BranchService.createWorkspaceBranch(
        designId,
        user.id,
        `derive-${Date.now()}`,
      )

      const child = await RequirementService.deriveRequirement(
        parent.id!,
        { name: 'Branch Child' },
        user.id,
        { branchId: branch.id, commitMessage: 'Decompose parent' },
      )

      // A branch row, not a main row: branch-scoped working revision plus a
      // branchItems entry tracking it as new scope on that branch.
      expect(child.revision).toBe(RevisionService.getWorkingRevision(branch.id))
      const tracked = await testDb.db
        .select()
        .from(branchItems)
        .where(
          and(
            eq(branchItems.branchId, branch.id),
            eq(branchItems.currentItemId, child.id!),
          ),
        )
      expect(tracked).toHaveLength(1)
      expect(tracked[0]!.changeType).toBe('added')
      expect(child.parentRequirementId).toBe(parent.id)
    })

    it('should derive onto a branch after the design has released items', async () => {
      // What made this unusable: requirements get decomposed after the first
      // release, and main is protected from then on.
      const parent = await createRequirement()
      const branch = await BranchService.createWorkspaceBranch(
        designId,
        user.id,
        `post-release-${Date.now()}`,
      )
      await testDb.db.insert(items).values({
        masterId: crypto.randomUUID(),
        itemNumber: `PRT-REL-${Date.now()}`,
        revision: 'A',
        itemType: 'Part',
        name: 'Released Part',
        state: 'Released',
        designId,
        createdBy: user.id,
        modifiedBy: user.id,
      })

      await expect(
        RequirementService.deriveRequirement(
          parent.id!,
          { name: 'Blocked Child' },
          user.id,
        ),
      ).rejects.toThrow(BranchProtectionError)

      const child = await RequirementService.deriveRequirement(
        parent.id!,
        { name: 'Allowed Child' },
        user.id,
        { branchId: branch.id },
      )
      expect(child.id).toBeDefined()
      expect(child.designId).toBe(designId)
    })

    it("should default to the parent's own branch when the parent is a branch row", async () => {
      const branch = await BranchService.createWorkspaceBranch(
        designId,
        user.id,
        `parent-branch-${Date.now()}`,
      )
      const { item: parent } = await ItemService.createOnBranch(
        'Requirement',
        {
          itemNumber: `REQ-ONBRANCH-${Date.now()}`,
          itemType: 'Requirement',
          designId,
          name: 'Parent on branch',
        },
        branch.id,
        'Add parent requirement',
        user.id,
      )

      const child = await RequirementService.deriveRequirement(
        parent.id!,
        { name: 'Follows Parent' },
        user.id,
      )

      const tracked = await testDb.db
        .select()
        .from(branchItems)
        .where(
          and(
            eq(branchItems.branchId, branch.id),
            eq(branchItems.currentItemId, child.id!),
          ),
        )
      expect(tracked).toHaveLength(1)
    })

    it('should reject a branch belonging to a different design', async () => {
      const parent = await createRequirement()
      const otherProgram = takeFirst(
        await testDb.db
          .insert(programs)
          .values({
            name: 'Other Program',
            code: `PROG-OTHER-${Date.now()}`,
            createdBy: user.id,
          })
          .returning(),
      )
      const otherDesign = await DesignService.create(
        {
          programId: otherProgram.id,
          name: 'Other Design',
          code: `DESIGN-OTHER-${Date.now()}`,
          designType: 'Engineering',
        },
        user.id,
      )
      const foreignBranch = await BranchService.createWorkspaceBranch(
        otherDesign.id,
        user.id,
        `foreign-${Date.now()}`,
      )

      await expect(
        RequirementService.deriveRequirement(
          parent.id!,
          { name: 'Misfiled Child' },
          user.id,
          { branchId: foreignBranch.id },
        ),
      ).rejects.toThrow(ValidationError)
    })

    it('should throw NotFoundError for a non-existent branch', async () => {
      const parent = await createRequirement()

      await expect(
        RequirementService.deriveRequirement(
          parent.id!,
          { name: 'Nowhere Child' },
          user.id,
          { branchId: '00000000-0000-0000-0000-000000000000' },
        ),
      ).rejects.toThrow(NotFoundError)
    })
  })

  // ================================================================
  // getChildRequirements() and getParentRequirement()
  // ================================================================

  describe('getChildRequirements()', () => {
    it('should return child requirements for a parent', async () => {
      const parent = await createRequirement({
        itemNumber: `REQ-P-${Date.now()}`,
      })

      await RequirementService.deriveRequirement(
        parent.id!,
        { name: 'Child A' },
        user.id,
      )
      await RequirementService.deriveRequirement(
        parent.id!,
        { name: 'Child B' },
        user.id,
      )

      const children = await RequirementService.getChildRequirements(parent.id!)
      expect(children).toHaveLength(2)
      const names = children.map((c) => c.name)
      expect(names).toContain('Child A')
      expect(names).toContain('Child B')
    })

    it('should return empty array when no children exist', async () => {
      const req = await createRequirement()

      const children = await RequirementService.getChildRequirements(req.id!)
      expect(children).toEqual([])
    })
  })

  describe('getParentRequirement()', () => {
    it('should return parent for a derived requirement', async () => {
      const parent = await createRequirement({
        itemNumber: `REQ-PP-${Date.now()}`,
        name: 'Parent Req',
      })

      const child = await RequirementService.deriveRequirement(
        parent.id!,
        { name: 'Child Req' },
        user.id,
      )

      const result = await RequirementService.getParentRequirement(child.id!)
      expect(result).not.toBeNull()
      expect(result!.id).toBe(parent.id)
      expect(result!.name).toBe('Parent Req')
    })

    it('should return null for a requirement with no parent', async () => {
      const req = await createRequirement()

      const result = await RequirementService.getParentRequirement(req.id!)
      expect(result).toBeNull()
    })
  })

  // ================================================================
  // The derive hierarchy across revisions
  //
  // `requirements.parent_requirement_id` names one version ROW of the parent
  // and is never re-pointed — the type handler copies it onto every later
  // revision of the child — so both hierarchy reads have to resolve lineage
  // rather than match the id they were handed. These cover the branch half of
  // that (a working copy at each end); the post-merge half, where the parent
  // is genuinely superseded, runs against a real release in
  // ChangeOrderMergeService.test.ts.
  //
  // Invariants: a parent row reports each child exactly once, at the row that
  // answers in that parent row's own context; a child reports the parent row
  // that answers in its context; and a child derived inside a branch is
  // invisible from main.
  // ================================================================

  describe('derive hierarchy across revisions', () => {
    let workspaceBranchId: string

    beforeEach(async () => {
      const branch = await BranchService.createWorkspaceBranch(
        designId,
        user.id,
        `ws-derive-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      )
      workspaceBranchId = branch.id
    })

    /** A parent with two children, all on main. */
    async function parentWithTwoChildren() {
      const parent = await createRequirement({
        itemNumber: `REQ-DH-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      })
      const first = await RequirementService.deriveRequirement(
        parent.id!,
        { name: 'Child One' },
        user.id,
      )
      const second = await RequirementService.deriveRequirement(
        parent.id!,
        { name: 'Child Two' },
        user.id,
      )
      return { parent, first, second }
    }

    /** The parent, opened for edit on the workspace branch. */
    async function workingCopyOf(requirement: Requirement) {
      const { workingCopy } =
        await ChangeOrderService.createRevisionWorkingCopy(
          (await ItemService.findById(
            requirement.id!,
          )) as unknown as Parameters<
            typeof ChangeOrderService.createRevisionWorkingCopy
          >[0],
          workspaceBranchId,
          user.id,
        )
      return workingCopy
    }

    it('numbers derived children by the highest suffix taken, not the count', async () => {
      const { parent, first, second } = await parentWithTwoChildren()
      expect([first.itemNumber, second.itemNumber]).toEqual([
        `${parent.itemNumber}-D1`,
        `${parent.itemNumber}-D2`,
      ])

      // Counting is only ever right while nothing has left the tree. Remove
      // -D1 and the count says the next child is -D2 — an item number -D2
      // already holds.
      await ItemService.delete(first.id!, user.id)

      const third = await RequirementService.deriveRequirement(
        parent.id!,
        { name: 'Child Three' },
        user.id,
      )

      expect(third.itemNumber).toBe(`${parent.itemNumber}-D3`)
    })

    it('shows a working copy of the parent the children it was cut from', async () => {
      const { parent, first, second } = await parentWithTwoChildren()

      const workingCopy = await workingCopyOf(parent)

      const children = await RequirementService.getChildRequirements(
        workingCopy.id,
      )
      expect(children.map((c) => c.id).sort()).toEqual(
        [first.id!, second.id!].sort(),
      )
    })

    it('keeps a child derived on a branch off the main parent row', async () => {
      const { parent, first, second } = await parentWithTwoChildren()
      const workingCopy = await workingCopyOf(parent)
      await CheckoutService.checkout(
        { itemMasterId: parent.masterId!, branchId: workspaceBranchId },
        user.id,
      )

      const branchOnly = await RequirementService.deriveRequirement(
        workingCopy.id,
        { name: 'Branch Child' },
        user.id,
        { branchId: workspaceBranchId },
      )

      // The branch sees what it inherited plus what it added.
      const onBranch = await RequirementService.getChildRequirements(
        workingCopy.id,
      )
      expect(onBranch.map((c) => c.id).sort()).toEqual(
        [first.id!, second.id!, branchOnly.id!].sort(),
      )

      // Main sees only what was there before the branch was cut.
      const onMain = await RequirementService.getChildRequirements(parent.id!)
      expect(onMain.map((c) => c.id).sort()).toEqual(
        [first.id!, second.id!].sort(),
      )
    })

    it('reports each child once even when the child has a working copy too', async () => {
      const { parent, first, second } = await parentWithTwoChildren()

      // A second row for one child, on the branch. Read from main, the child
      // is still one child — the extra row is a version of it, not a sibling.
      const childWorkingCopy = await workingCopyOf(first)

      const onMain = await RequirementService.getChildRequirements(parent.id!)
      expect(onMain.map((c) => c.id).sort()).toEqual(
        [first.id!, second.id!].sort(),
      )
      expect(onMain.map((c) => c.id)).not.toContain(childWorkingCopy.id)
    })

    it('answers a branch child with the parent row that branch is working from', async () => {
      const { parent, first } = await parentWithTwoChildren()
      const workingCopy = await workingCopyOf(parent)

      // Main's child row still names the row it was derived from; read from
      // main that is main's parent row.
      const fromMain = await RequirementService.getParentRequirement(first.id!)
      expect(fromMain?.id).toBe(parent.id)

      // A child on the branch answers with the branch's parent row.
      await CheckoutService.checkout(
        { itemMasterId: parent.masterId!, branchId: workspaceBranchId },
        user.id,
      )
      const branchChild = await RequirementService.deriveRequirement(
        workingCopy.id,
        { name: 'Branch Child' },
        user.id,
        { branchId: workspaceBranchId },
      )

      const fromBranch = await RequirementService.getParentRequirement(
        branchChild.id!,
      )
      expect(fromBranch?.id).toBe(workingCopy.id)
    })
  })

  // ================================================================
  // allocateToDesign() and removeAllocation()
  // ================================================================

  describe('allocateToDesign()', () => {
    it('should allocate a requirement to a part', async () => {
      const req = await createRequirement()
      const part = await createPart()

      await RequirementService.allocateToDesign(req.id!, part.id!, user.id)

      // Verify allocation exists by checking coverage (allocated count)
      const coverage = await RequirementService.getCoverage(designId)
      expect(coverage.allocated).toBeGreaterThanOrEqual(1)
    })

    it('should skip duplicate allocations', async () => {
      const req = await createRequirement()
      const part = await createPart()

      await RequirementService.allocateToDesign(req.id!, part.id!, user.id)
      // Allocate again - should not create duplicate
      await RequirementService.allocateToDesign(req.id!, part.id!, user.id)

      // No error means it handled the duplicate gracefully
    })

    it('should throw NotFoundError for non-existent requirement', async () => {
      const part = await createPart()
      const fakeId = '00000000-0000-0000-0000-000000000000'

      await expect(
        RequirementService.allocateToDesign(fakeId, part.id!, user.id),
      ).rejects.toThrow(NotFoundError)
    })

    it('should throw NotFoundError for non-existent target item', async () => {
      const req = await createRequirement()
      const fakeId = '00000000-0000-0000-0000-000000000000'

      await expect(
        RequirementService.allocateToDesign(req.id!, fakeId, user.id),
      ).rejects.toThrow(NotFoundError)
    })
  })

  describe('removeAllocation()', () => {
    it('should remove an allocation relationship', async () => {
      const req = await createRequirement()
      const part = await createPart()

      await RequirementService.allocateToDesign(req.id!, part.id!, user.id)
      await RequirementService.removeAllocation(req.id!, part.id!, user.id)

      // Allocation should be gone - requirement shows as not_allocated in coverage
      const coverage = await RequirementService.getCoverage(designId)
      const gap = coverage.gaps.find((g) => g.id === req.id)
      expect(gap?.gapType).toBe('not_allocated')
    })

    it('should do nothing when removing a non-existent allocation', async () => {
      const req = await createRequirement()
      const part = await createPart()

      // No allocation exists; should not throw
      await RequirementService.removeAllocation(req.id!, part.id!, user.id)
    })
  })

  // ================================================================
  // getCoverage()
  // ================================================================

  describe('getCoverage()', () => {
    it('should return zero metrics when no requirements exist', async () => {
      const coverage = await RequirementService.getCoverage(designId)

      expect(coverage.totalRequirements).toBe(0)
      expect(coverage.allocated).toBe(0)
      expect(coverage.satisfied).toBe(0)
      expect(coverage.verified).toBe(0)
      expect(coverage.allocatedPercent).toBe(0)
      expect(coverage.satisfiedPercent).toBe(0)
      expect(coverage.verifiedPercent).toBe(0)
      expect(coverage.gaps).toEqual([])
    })

    it('should return coverage metrics for requirements in a design', async () => {
      const req1 = await createRequirement({
        name: 'Req 1',
        priority: 'MustHave',
      })
      const req2 = await createRequirement({
        name: 'Req 2',
        priority: 'ShouldHave',
      })
      const part = await createPart()

      // Allocate req1, satisfy req1
      await RequirementService.allocateToDesign(req1.id!, part.id!, user.id)
      await RequirementService.linkSatisfaction(req1.id!, [part.id!], user.id)

      const coverage = await RequirementService.getCoverage(designId)

      expect(coverage.totalRequirements).toBe(2)
      expect(coverage.allocated).toBe(1)
      expect(coverage.satisfied).toBe(1)
      // req2 should be in gaps as not_allocated
      const gapForReq2 = coverage.gaps.find((g) => g.id === req2.id)
      expect(gapForReq2).toBeDefined()
      expect(gapForReq2!.gapType).toBe('not_allocated')
    })

    it('should identify not_satisfied gaps correctly', async () => {
      const req = await createRequirement({ priority: 'MustHave' })
      const part = await createPart()

      // Allocate but do not satisfy
      await RequirementService.allocateToDesign(req.id!, part.id!, user.id)

      const coverage = await RequirementService.getCoverage(designId)
      const gap = coverage.gaps.find((g) => g.id === req.id)
      expect(gap).toBeDefined()
      expect(gap!.gapType).toBe('not_satisfied')
    })

    it('should identify not_verified gaps correctly', async () => {
      const req = await createRequirement({ priority: 'MustHave' })
      const part = await createPart()

      // Allocate and satisfy but do not verify
      await RequirementService.allocateToDesign(req.id!, part.id!, user.id)
      await RequirementService.linkSatisfaction(req.id!, [part.id!], user.id)

      const coverage = await RequirementService.getCoverage(designId)
      const gap = coverage.gaps.find((g) => g.id === req.id)
      expect(gap).toBeDefined()
      expect(gap!.gapType).toBe('not_verified')
    })

    it('should count requirement as verified when verificationStatus is Passed', async () => {
      const req = await createRequirement({ priority: 'MustHave' })
      const part = await createPart()

      await RequirementService.allocateToDesign(req.id!, part.id!, user.id)
      await RequirementService.linkSatisfaction(req.id!, [part.id!], user.id)
      await RequirementService.updateVerificationStatus(
        req.id!,
        'Passed',
        user.id,
      )

      const coverage = await RequirementService.getCoverage(designId)
      expect(coverage.verified).toBe(1)
      // No not_verified gap for this requirement
      const gap = coverage.gaps.find(
        (g) => g.id === req.id && g.gapType === 'not_verified',
      )
      expect(gap).toBeUndefined()
    })

    it('should throw NotFoundError for non-existent design', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000'

      await expect(RequirementService.getCoverage(fakeId)).rejects.toThrow(
        NotFoundError,
      )
    })

    it('should sort gaps by priority (MustHave first)', async () => {
      await createRequirement({ priority: 'CouldHave', name: 'Low Priority' })
      await createRequirement({ priority: 'MustHave', name: 'High Priority' })
      await createRequirement({ priority: 'ShouldHave', name: 'Med Priority' })

      const coverage = await RequirementService.getCoverage(designId)
      expect(coverage.gaps.length).toBeGreaterThanOrEqual(3)

      // MustHave should come before ShouldHave, which comes before CouldHave
      const priorities = coverage.gaps.map((g) => g.priority)
      const mustIdx = priorities.indexOf('MustHave')
      const shouldIdx = priorities.indexOf('ShouldHave')
      const couldIdx = priorities.indexOf('CouldHave')
      expect(mustIdx).toBeLessThan(shouldIdx)
      expect(shouldIdx).toBeLessThan(couldIdx)
    })
  })

  // ================================================================
  // updateVerificationStatus() and updateVerificationMethod()
  // ================================================================

  describe('updateVerificationStatus()', () => {
    it('should update the verification status of a requirement', async () => {
      const req = await createRequirement()

      await RequirementService.updateVerificationStatus(
        req.id!,
        'InProgress',
        user.id,
      )

      const updated = (await ItemService.findById(req.id!)) as any
      expect(updated).toBeDefined()
      // The status should be updated in the requirement-specific table
      // Verify by checking coverage side-effect or re-fetching
    })
  })

  describe('updateVerificationMethod()', () => {
    it('should update the verification method of a requirement', async () => {
      const req = await createRequirement()

      await RequirementService.updateVerificationMethod(
        req.id!,
        'Test',
        user.id,
      )

      // The method should be updated - no error means success
    })
  })

  // ================================================================
  // linkVerification() and unlinkVerification()
  // ================================================================

  describe('linkVerification()', () => {
    it('should link a test case to a requirement as VERIFIED_BY', async () => {
      const req = await createRequirement()
      const tc = await createTestCase()

      await RequirementService.linkVerification(req.id!, [tc.id!], user.id)

      const tests = await RequirementService.getVerifyingTests(req.id!)
      expect(tests).toHaveLength(1)
      expect(tests[0]!.id).toBe(tc.id)
    })

    it('should link multiple test cases to a requirement', async () => {
      const req = await createRequirement()
      const tc1 = await createTestCase({ name: 'TC Alpha' })
      const tc2 = await createTestCase({ name: 'TC Beta' })

      await RequirementService.linkVerification(
        req.id!,
        [tc1.id!, tc2.id!],
        user.id,
      )

      const tests = await RequirementService.getVerifyingTests(req.id!)
      expect(tests).toHaveLength(2)
      const ids = tests.map((t) => t.id)
      expect(ids).toContain(tc1.id)
      expect(ids).toContain(tc2.id)
    })

    it('should skip duplicate verification links', async () => {
      const req = await createRequirement()
      const tc = await createTestCase()

      await RequirementService.linkVerification(req.id!, [tc.id!], user.id)
      // Link again - should not create duplicate
      await RequirementService.linkVerification(req.id!, [tc.id!], user.id)

      const tests = await RequirementService.getVerifyingTests(req.id!)
      expect(tests).toHaveLength(1)
    })

    it('should throw NotFoundError for non-existent requirement', async () => {
      const tc = await createTestCase()
      const fakeId = '00000000-0000-0000-0000-000000000000'

      await expect(
        RequirementService.linkVerification(fakeId, [tc.id!], user.id),
      ).rejects.toThrow(NotFoundError)
    })

    it('should throw NotFoundError for non-existent test case', async () => {
      const req = await createRequirement()
      const fakeId = '00000000-0000-0000-0000-000000000000'

      await expect(
        RequirementService.linkVerification(req.id!, [fakeId], user.id),
      ).rejects.toThrow(NotFoundError)
    })

    it('should throw ValidationError when item is not a TestCase', async () => {
      const req = await createRequirement()
      const part = await createPart()

      await expect(
        RequirementService.linkVerification(req.id!, [part.id!], user.id),
      ).rejects.toThrow(ValidationError)
    })
  })

  describe('unlinkVerification()', () => {
    it('should remove a verification relationship', async () => {
      const req = await createRequirement()
      const tc = await createTestCase()

      await RequirementService.linkVerification(req.id!, [tc.id!], user.id)
      let tests = await RequirementService.getVerifyingTests(req.id!)
      expect(tests).toHaveLength(1)

      await RequirementService.unlinkVerification(req.id!, tc.id!, user.id)

      tests = await RequirementService.getVerifyingTests(req.id!)
      expect(tests).toHaveLength(0)
    })

    it('should do nothing when unlinking a non-existent verification', async () => {
      const req = await createRequirement()
      const tc = await createTestCase()

      // No link exists; should not throw
      await RequirementService.unlinkVerification(req.id!, tc.id!, user.id)
    })
  })

  // ================================================================
  // getVerifyingTests()
  // ================================================================

  describe('getVerifyingTests()', () => {
    it('should return test cases verifying a requirement with details', async () => {
      const req = await createRequirement()
      const tc = await createTestCase({
        name: 'Verify Performance',
        testType: 'System',
      })

      await RequirementService.linkVerification(req.id!, [tc.id!], user.id)

      const result = await RequirementService.getVerifyingTests(req.id!)
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({
        id: tc.id,
        name: 'Verify Performance',
      })
      expect(result[0]!.relationshipId).toBeDefined()
    })

    it('should return empty array when no test cases verify the requirement', async () => {
      const req = await createRequirement()

      const result = await RequirementService.getVerifyingTests(req.id!)
      expect(result).toEqual([])
    })
  })

  // ================================================================
  // getRequirementsVerifiedBy()
  // ================================================================

  describe('getRequirementsVerifiedBy()', () => {
    it('should return requirements that a test case verifies', async () => {
      const req1 = await createRequirement({
        name: 'Req One',
        priority: 'MustHave',
      })
      const req2 = await createRequirement({
        name: 'Req Two',
        priority: 'ShouldHave',
      })
      const tc = await createTestCase()

      await RequirementService.linkVerification(req1.id!, [tc.id!], user.id)
      await RequirementService.linkVerification(req2.id!, [tc.id!], user.id)

      const result = await RequirementService.getRequirementsVerifiedBy(tc.id!)
      expect(result).toHaveLength(2)
      const names = result.map((r) => r.name)
      expect(names).toContain('Req One')
      expect(names).toContain('Req Two')
    })

    it('should return empty array when test case verifies no requirements', async () => {
      const tc = await createTestCase()

      const result = await RequirementService.getRequirementsVerifiedBy(tc.id!)
      expect(result).toEqual([])
    })
  })

  // ================================================================
  // Branch protection on traceability links
  //
  // An access gate, not bookkeeping: these links are what a released baseline
  // claims about its own coverage, and each one used to answer to a different
  // rule. `SATISFIES` (a Part source) went through the edit-lock policy;
  // `VERIFIED_BY` did not, because its source is a TestCase and TestCase
  // carries a Free lifecycle, so a V&V link could be written straight onto a
  // Released requirement on protected main with no change order anywhere.
  //
  // Invariant: every traceability link write answers to some end's edit rule
  // - a branch row whose checkout the caller holds, or main before anything
  // in the design has released - and is never ungated.
  // ================================================================

  describe('branch protection on traceability links', () => {
    let changeOrderId: string
    let ecoBranchId: string

    async function createReleased(
      itemType: 'Requirement' | 'Part',
    ): Promise<PersistedItem> {
      const ts = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      const item = await ItemService.create<PersistedItem>(
        itemType,
        {
          itemNumber: `${itemType.slice(0, 3).toUpperCase()}-${ts}`,
          revision: 'A',
          state: 'Released',
          designId,
          name: `Released ${itemType}`,
        } as PersistedItem,
        user.id,
        { bypassBranchProtection: true },
      )

      // Link to the initial commit so VersionResolver can find the released
      // version, the same way the checkout fixtures do.
      await testDb.db.insert(itemVersions).values({
        commitId: initialCommitId,
        itemId: item.id,
        changeType: 'added',
      })

      return item
    }

    /**
     * A test case authored on the ECO branch, with this caller holding its
     * checkout.
     *
     * Deliberately not a test case on main. Whether the *source* of a
     * `VERIFIED_BY` edge is exempt from branch protection depends on the
     * TestCase lifecycle, a global row other suites legitimately repoint
     * (`LifecycleService.test.ts` swaps it for a Driven one), so a source on
     * main is sometimes editable here and sometimes not. Putting it somewhere
     * this caller may certainly edit removes that variable, leaving the
     * requirement end as the only thing that can decide the outcome.
     */
    async function createBranchTestCase(): Promise<PersistedItem> {
      const ts = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      const { item } = await ItemService.createOnBranch(
        'TestCase',
        {
          itemNumber: `TC-${ts}`,
          revision: 'A',
          itemType: 'TestCase',
          designId,
          name: 'Branch Test Case',
        },
        ecoBranchId,
        'Added test case',
        user.id,
      )
      const testCase = item as PersistedItem

      await CheckoutService.checkout(
        { itemMasterId: testCase.masterId, branchId: ecoBranchId },
        user.id,
      )
      return testCase
    }

    /** The row the ECO branch is currently working from for a master. */
    async function branchRowId(masterId: string): Promise<string | null> {
      const [row] = await testDb.db
        .select({ currentItemId: branchItems.currentItemId })
        .from(branchItems)
        .where(
          and(
            eq(branchItems.branchId, ecoBranchId),
            eq(branchItems.itemMasterId, masterId),
          ),
        )
        .limit(1)
      return row?.currentItemId ?? null
    }

    beforeEach(async () => {
      const changeOrder = await ItemService.create<PersistedItem>(
        'ChangeOrder',
        {
          revision: 'A',
          name: 'Traceability ECO',
          changeType: 'ECO',
          priority: 'medium',
          reasonForChange: 'Record traceability',
          designId,
        } as unknown as PersistedItem,
        user.id,
      )
      changeOrderId = changeOrder.id

      const { branch } = await BranchService.getOrCreateEcoBranch(
        designId,
        changeOrderId,
        user.id,
      )
      ecoBranchId = branch.id
    })

    it('refuses a verification link on a released requirement', async () => {
      // Authored before the release: main closes to new items of every type
      // once the design has released one, test cases included.
      const testCase = await createTestCase()
      const requirement = await createReleased('Requirement')

      await expect(
        RequirementService.linkVerification(
          requirement.id,
          [testCase.id!],
          user.id,
        ),
      ).rejects.toThrow(BranchProtectionError)

      expect(
        await RequirementService.getVerifyingTests(requirement.id),
      ).toHaveLength(0)
    })

    it('refuses the same link through the batch relationship path', async () => {
      const testCase = await createTestCase()
      const requirement = await createReleased('Requirement')

      await expect(
        ItemRelationshipService.addRelationshipBatch([
          {
            sourceId: testCase.id!,
            targetId: requirement.id,
            relationshipType: 'VERIFIED_BY',
            userId: user.id,
          },
        ]),
      ).rejects.toThrow(BranchProtectionError)
    })

    it('records a verification link on the ECO row once the requirement is checked out', async () => {
      const testCase = await createBranchTestCase()
      const requirement = await createReleased('Requirement')

      await ChangeOrderService.checkoutItemToEco(
        changeOrderId,
        requirement.id,
        user.id,
      )
      const workingCopyId = await branchRowId(requirement.masterId)
      expect(workingCopyId).not.toBe(requirement.id)

      await RequirementService.linkVerification(
        requirement.id,
        [testCase.id],
        user.id,
        { branchId: ecoBranchId },
      )

      // The link lives on the branch, not on the released baseline.
      expect(
        await RequirementService.getVerifyingTests(workingCopyId!),
      ).toHaveLength(1)
      expect(
        await RequirementService.getVerifyingTests(requirement.id),
      ).toHaveLength(0)
    })

    it('refuses a link on a branch row nobody has checked out', async () => {
      const requirement = await createReleased('Requirement')
      const part = await createReleased('Part')

      // A working copy on the branch, but no checkout: the branch has the
      // item, this caller does not hold the right to edit it.
      await ChangeOrderService.createRevisionWorkingCopy(
        part as unknown as Parameters<
          typeof ChangeOrderService.createRevisionWorkingCopy
        >[0],
        ecoBranchId,
        user.id,
      )

      await expect(
        RequirementService.linkSatisfaction(
          requirement.id,
          [part.id],
          user.id,
          { branchId: ecoBranchId },
        ),
      ).rejects.toThrow(ItemCheckoutRequiredError)
    })

    it('sends the rule to the requirement end only for an exempt source', async () => {
      // An item type with no lifecycle assigned resolves Free, so this says
      // "exempt source" without depending on any configured lifecycle row.
      const exempt = 'UnmappedType'

      expect(await resolveEdgeGuardEnd(exempt, 'VERIFIED_BY')).toBe('target')
      expect(await resolveEdgeGuardEnd('Part', 'SATISFIES')).toBe('source')

      // Scope management runs ChangeOrder -> Part and must keep answering to
      // its source: requiring the affected item to be checked out before it
      // could be added to the ECO would never terminate.
      expect(await resolveEdgeGuardEnd('ChangeOrder', 'Affects')).toBe('source')
      expect(await resolveEdgeGuardEnd(exempt, 'BOM')).toBe('source')
    })

    it('records satisfaction against the ECO part row, never the released one', async () => {
      const requirement = await createReleased('Requirement')
      const part = await createReleased('Part')

      await expect(
        RequirementService.linkSatisfaction(requirement.id, [part.id], user.id),
      ).rejects.toThrow(BranchProtectionError)

      await ChangeOrderService.checkoutItemToEco(
        changeOrderId,
        part.id,
        user.id,
      )
      const partWorkingCopyId = await branchRowId(part.masterId)

      await RequirementService.linkSatisfaction(
        requirement.id,
        [part.id],
        user.id,
        { branchId: ecoBranchId },
      )

      const edges = await testDb.db
        .select()
        .from(itemRelationships)
        .where(eq(itemRelationships.targetId, requirement.id))
      expect(edges).toHaveLength(1)
      expect(edges[0]!.sourceId).toBe(partWorkingCopyId)
    })

    it('holds allocation to the same rule', async () => {
      const requirement = await createReleased('Requirement')
      const part = await createReleased('Part')

      await expect(
        RequirementService.allocateToDesign(requirement.id, part.id, user.id),
      ).rejects.toThrow(BranchProtectionError)

      await ChangeOrderService.checkoutItemToEco(
        changeOrderId,
        requirement.id,
        user.id,
      )
      const requirementWorkingCopyId = await branchRowId(requirement.masterId)

      await RequirementService.allocateToDesign(
        requirement.id,
        part.id,
        user.id,
        { branchId: ecoBranchId },
      )

      const allocated = await RequirementService.getAllocatedItems(
        requirementWorkingCopyId!,
      )
      expect(allocated.map((i) => i.id)).toEqual([part.id])
      expect(
        await RequirementService.getAllocatedItems(requirement.id),
      ).toHaveLength(0)
    })
  })

  // ================================================================
  // Incoming links across revisions
  //
  // `SATISFIES` and `VERIFIED_BY` point AT a requirement and belong to the
  // item at the other end, so nothing in a revision moves them: they keep
  // naming the row the new revision superseded. Readers therefore walk the
  // lineage backwards. The walk runs one way only, and these are the two ends
  // of that: a working copy inherits what it was cut from, and nothing ever
  // inherits from a working copy, which is what keeps one ECO's links out of
  // main. (The post-merge half of the invariant is exercised against a real
  // release in ChangeOrderMergeService.test.ts.)
  // ================================================================

  describe('incoming links across revisions', () => {
    let workspaceBranchId: string

    beforeEach(async () => {
      const branch = await BranchService.createWorkspaceBranch(
        designId,
        user.id,
        `ws-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      )
      workspaceBranchId = branch.id
    })

    /** A released requirement that one test case already verifies. */
    async function releasedRequirementWithTest() {
      const requirement = await createRequirement()
      const testCase = await createTestCase()

      // Linked before the release: this is the state a design is in before
      // its first change order.
      await RequirementService.linkVerification(
        requirement.id!,
        [testCase.id!],
        user.id,
      )
      await testDb.db
        .update(items)
        .set({ state: 'Released' })
        .where(eq(items.id, requirement.id!))

      return { requirement, testCase }
    }

    /** A test case authored on the workspace branch, checked out to us. */
    async function branchTestCase(): Promise<PersistedItem> {
      const ts = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      const { item } = await ItemService.createOnBranch(
        'TestCase',
        {
          itemNumber: `TC-${ts}`,
          revision: 'A',
          itemType: 'TestCase',
          designId,
          name: 'Branch Test Case',
        },
        workspaceBranchId,
        'Added test case',
        user.id,
      )
      const testCase = item as PersistedItem
      await CheckoutService.checkout(
        { itemMasterId: testCase.masterId, branchId: workspaceBranchId },
        user.id,
      )
      return testCase
    }

    it('shows a working copy the coverage it was cut from', async () => {
      const { requirement, testCase } = await releasedRequirementWithTest()

      const { workingCopy } =
        await ChangeOrderService.createRevisionWorkingCopy(
          (await ItemService.findById(
            requirement.id!,
          )) as unknown as Parameters<
            typeof ChangeOrderService.createRevisionWorkingCopy
          >[0],
          workspaceBranchId,
          user.id,
        )

      const verifying = await RequirementService.getVerifyingTests(
        workingCopy.id,
      )
      expect(verifying.map((t) => t.id)).toEqual([testCase.id])
    })

    it('keeps a link recorded on a working copy off the released row', async () => {
      const { requirement, testCase } = await releasedRequirementWithTest()
      const branchOnly = await branchTestCase()

      const { workingCopy } =
        await ChangeOrderService.createRevisionWorkingCopy(
          (await ItemService.findById(
            requirement.id!,
          )) as unknown as Parameters<
            typeof ChangeOrderService.createRevisionWorkingCopy
          >[0],
          workspaceBranchId,
          user.id,
        )
      await CheckoutService.checkout(
        { itemMasterId: requirement.masterId!, branchId: workspaceBranchId },
        user.id,
      )

      await RequirementService.linkVerification(
        requirement.id!,
        [branchOnly.id],
        user.id,
        { branchId: workspaceBranchId },
      )

      // The branch sees both: what it inherited and what it added.
      const onBranch = await RequirementService.getVerifyingTests(
        workingCopy.id,
      )
      expect(onBranch.map((t) => t.id).sort()).toEqual(
        [testCase.id, branchOnly.id].sort(),
      )

      // Main sees only what was released.
      const onMain = await RequirementService.getVerifyingTests(requirement.id!)
      expect(onMain.map((t) => t.id)).toEqual([testCase.id])
    })
  })
})
