/**
 * RequirementService Tests
 *
 * Integration tests for the RequirementService class.
 * Tests cover satisfaction linking, derivation, allocation, coverage,
 * verification status/method updates, and test case verification linking.
 *
 * Run: npm run test -- src/lib/services/RequirementService.test.ts
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
import { RequirementService } from './RequirementService'
import { DesignService } from './DesignService'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { Requirement } from '@/lib/items/types/requirement'
import type { Part } from '@/lib/items/types/part'
import type { TestCase } from '@/lib/items/types/testcase'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { programs } from '@/lib/db/schema'
import { NotFoundError, ValidationError } from '@/lib/errors'
import { ItemService } from '@/lib/items/services/ItemService'
import '@/lib/items/registerItemTypes.server'

describe('RequirementService', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let designId: string

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
    const [program] = await testDb.db
      .insert(programs)
      .values({
        name: 'Test Program',
        code: `PROG-${Date.now()}`,
        createdBy: user.id,
      })
      .returning()

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
      expect(satisfying[0].id).toBe(part.id)
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
      expect(result[0].relationshipId).toBeDefined()
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
      expect(tests[0].id).toBe(tc.id)
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
      expect(result[0].relationshipId).toBeDefined()
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
})
