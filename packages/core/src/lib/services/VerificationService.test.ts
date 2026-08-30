// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * VerificationService — recording test results, and the rollups over them.
 *
 * Two gates. `recordExecution` writes an execution row and updates the test
 * case in the same breath, and the two disagreeing is invisible until someone
 * asks why the dashboard says Passed and the history says Failed. And
 * `getTestCoverage` / `getVerificationGaps` are rollup arithmetic — the kind
 * of code that reads correct and is off by one requirement.
 *
 * The expected numbers below are computed by hand in the comments beside them,
 * so a change to the maths has to argue with a stated figure rather than a
 * snapshot.
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
import { DesignService } from './DesignService'
import { RequirementService } from './RequirementService'
import {
  VALIDATES_RELATIONSHIP,
  VerificationService,
} from './VerificationService'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { Part } from '@/lib/items/types/part'
import type { Requirement } from '@/lib/items/types/requirement'
import type { TestCase } from '@/lib/items/types/testcase'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { takeFirst } from '@/lib/db/take-first'
import { NotFoundError, ValidationError } from '@/lib/errors'
import { ItemService } from '@/lib/items/services/ItemService'
import {
  itemRelationships,
  programMembers,
  programs,
  testCases,
  testExecutions,
} from '@/lib/db/schema'
import '@/lib/items/registerItemTypes.server'

describe('VerificationService', () => {
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

    const program = takeFirst(
      await testDb.db
        .insert(programs)
        .values({
          name: 'Verification Test Program',
          code: `PROG-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
          createdBy: user.id,
        })
        .returning(),
    )
    // A directly-inserted program does not enrol its creator; ItemService
    // refuses writes to a design the caller cannot reach.
    await testDb.db.insert(programMembers).values({
      programId: program.id,
      userId: user.id,
      role: 'admin',
      invitedBy: user.id,
    })

    const design = await DesignService.create(
      {
        programId: program.id,
        name: 'Verification Test Design',
        code: `DESIGN-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
        designType: 'Engineering',
      },
      user.id,
    )
    designId = design.id
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

  const createRequirement = (overrides: Partial<Requirement> = {}) =>
    ItemService.create<Requirement>(
      'Requirement',
      {
        itemNumber: `REQ-${uid()}`,
        revision: 'A',
        designId,
        name: 'Test Requirement',
        ...overrides,
      } as Requirement,
      user.id,
    )

  const createPart = (overrides: Partial<Part> = {}) =>
    ItemService.create<Part>(
      'Part',
      {
        itemNumber: `PRT-${uid()}`,
        revision: 'A',
        designId,
        name: 'Test Part',
        ...overrides,
      } as Part,
      user.id,
    )

  const createTestCase = (overrides: Partial<TestCase> = {}) =>
    ItemService.create<TestCase>(
      'TestCase',
      {
        itemNumber: `TC-${uid()}`,
        revision: 'A',
        designId,
        name: 'Test Case',
        ...overrides,
      } as TestCase,
      user.id,
    )

  describe('recordExecution', () => {
    it('writes the execution and moves the test case to match it', async () => {
      const testCase = await createTestCase()

      const result = await VerificationService.recordExecution(
        testCase.id!,
        {
          status: 'Passed',
          duration: 42,
          environment: 'bench',
          actualResults: 'within tolerance',
          notes: 'first run',
        },
        user.id,
      )

      expect(result.status).toBe('Passed')
      expect(result.testCaseId).toBe(testCase.id)
      expect(result.executorId).toBe(user.id)

      // The history row and the test case must agree — the whole point of
      // writing both.
      const history = await testDb.db
        .select()
        .from(testExecutions)
        .where(eq(testExecutions.testCaseId, testCase.id!))
      expect(history).toHaveLength(1)
      expect(history[0]?.status).toBe('Passed')
      expect(history[0]?.duration).toBe(42)
      expect(history[0]?.environment).toBe('bench')

      const [stored] = await testDb.db
        .select()
        .from(testCases)
        .where(eq(testCases.itemId, testCase.id!))
      expect(stored?.executionStatus).toBe('Passed')
      expect(stored?.lastExecutedBy).toBe(user.id)
      expect(stored?.lastExecutedAt).toBeTruthy()
    })

    it('keeps every run in history while the test case shows the latest', async () => {
      const testCase = await createTestCase()

      await VerificationService.recordExecution(
        testCase.id!,
        { status: 'Failed' },
        user.id,
      )
      await VerificationService.recordExecution(
        testCase.id!,
        { status: 'Passed' },
        user.id,
      )

      const history = await VerificationService.getExecutionHistory(
        testCase.id!,
      )
      expect(history).toHaveLength(2)
      const [stored] = await testDb.db
        .select()
        .from(testCases)
        .where(eq(testCases.itemId, testCase.id!))
      expect(stored?.executionStatus).toBe('Passed')
    })

    it('refuses an id that is not a test case', async () => {
      const part = await createPart()

      await expect(
        VerificationService.recordExecution(
          part.id!,
          { status: 'Passed' },
          user.id,
        ),
      ).rejects.toThrow(NotFoundError)
    })
  })

  describe('getTestCoverage', () => {
    it('is all zeros for a design with no requirements', async () => {
      const coverage = await VerificationService.getTestCoverage(designId)

      expect(coverage.totalRequirements).toBe(0)
      expect(coverage.coveragePercent).toBe(0)
      expect(coverage.totalTests).toBe(0)
    })

    it('computes coverage and the pass/fail split by hand-checkable numbers', async () => {
      // Three requirements, two of them verified by a test case:
      //   coveragePercent = 2/3 = 66.666… → rounded to one decimal = 66.7
      const [reqA, reqB] = await Promise.all([
        createRequirement(),
        createRequirement(),
        createRequirement(),
      ])

      // Four test cases: one Passed, one Failed, one Blocked, one never run.
      //   passedPercent = 1/4 = 25, failedPercent = 1/4 = 25
      const passed = await createTestCase()
      const failed = await createTestCase()
      const blocked = await createTestCase()
      await createTestCase()

      await RequirementService.linkVerification(reqA.id!, [passed.id!], user.id)
      await RequirementService.linkVerification(reqB.id!, [failed.id!], user.id)

      await VerificationService.recordExecution(
        passed.id!,
        { status: 'Passed' },
        user.id,
      )
      await VerificationService.recordExecution(
        failed.id!,
        { status: 'Failed' },
        user.id,
      )
      await VerificationService.recordExecution(
        blocked.id!,
        { status: 'Blocked' },
        user.id,
      )

      const coverage = await VerificationService.getTestCoverage(designId)

      expect(coverage.totalRequirements).toBe(3)
      expect(coverage.requirementsWithTests).toBe(2)
      expect(coverage.coveragePercent).toBe(66.7)
      expect(coverage.totalTests).toBe(4)
      expect(coverage.passed).toBe(1)
      expect(coverage.failed).toBe(1)
      expect(coverage.blocked).toBe(1)
      expect(coverage.notRun).toBe(1)
      expect(coverage.passedPercent).toBe(25)
      expect(coverage.failedPercent).toBe(25)
    })

    it('counts a requirement once however many tests verify it', async () => {
      const req = await createRequirement()
      const first = await createTestCase()
      const second = await createTestCase()

      await RequirementService.linkVerification(
        req.id!,
        [first.id!, second.id!],
        user.id,
      )

      const coverage = await VerificationService.getTestCoverage(designId)

      // 1 of 1 requirement covered — not 2 of 1.
      expect(coverage.totalRequirements).toBe(1)
      expect(coverage.requirementsWithTests).toBe(1)
      expect(coverage.coveragePercent).toBe(100)
      expect(coverage.totalTests).toBe(2)
    })

    it('reports a missing design as not found', async () => {
      await expect(
        VerificationService.getTestCoverage(
          '00000000-0000-0000-0000-000000000000',
        ),
      ).rejects.toThrow(NotFoundError)
    })
  })

  describe('getVerificationGaps', () => {
    it('lists exactly the requirements nothing verifies', async () => {
      const covered = await createRequirement({ name: 'Covered' })
      const gap = await createRequirement({ name: 'Uncovered' })
      const testCase = await createTestCase()

      await RequirementService.linkVerification(
        covered.id!,
        [testCase.id!],
        user.id,
      )

      const gaps = await VerificationService.getVerificationGaps(designId)

      expect(gaps.map((g) => g.id)).toEqual([gap.id])
      expect(gaps[0]?.name).toBe('Uncovered')
    })

    it('is empty when every requirement is verified', async () => {
      const req = await createRequirement()
      const testCase = await createTestCase()
      await RequirementService.linkVerification(
        req.id!,
        [testCase.id!],
        user.id,
      )

      expect(await VerificationService.getVerificationGaps(designId)).toEqual(
        [],
      )
    })
  })

  describe('linkValidation / unlinkValidation', () => {
    it('creates one VALIDATES edge per part and reads back both ways', async () => {
      const testCase = await createTestCase()
      const partA = await createPart({ name: 'Part A' })
      const partB = await createPart({ name: 'Part B' })

      await VerificationService.linkValidation(
        testCase.id!,
        [partA.id!, partB.id!],
        user.id,
      )

      const edges = await testDb.db
        .select()
        .from(itemRelationships)
        .where(
          and(
            eq(itemRelationships.sourceId, testCase.id!),
            eq(itemRelationships.relationshipType, VALIDATES_RELATIONSHIP),
          ),
        )
      expect(edges).toHaveLength(2)

      const validated = await VerificationService.getPartsValidatedBy(
        testCase.id!,
      )
      expect(validated.map((p) => p.id).sort()).toEqual(
        [partA.id, partB.id].sort(),
      )

      const validating = await VerificationService.getValidatingTests(partA.id!)
      expect(validating.map((t) => t.id)).toEqual([testCase.id])
    })

    it('linking the same part twice leaves one edge', async () => {
      const testCase = await createTestCase()
      const part = await createPart()

      await VerificationService.linkValidation(
        testCase.id!,
        [part.id!],
        user.id,
      )
      await VerificationService.linkValidation(
        testCase.id!,
        [part.id!],
        user.id,
      )

      const edges = await testDb.db
        .select()
        .from(itemRelationships)
        .where(
          and(
            eq(itemRelationships.sourceId, testCase.id!),
            eq(itemRelationships.relationshipType, VALIDATES_RELATIONSHIP),
          ),
        )
      expect(edges).toHaveLength(1)
    })

    it('unlinking removes the edge and is safe to repeat', async () => {
      const testCase = await createTestCase()
      const part = await createPart()
      await VerificationService.linkValidation(
        testCase.id!,
        [part.id!],
        user.id,
      )

      await VerificationService.unlinkValidation(
        testCase.id!,
        part.id!,
        user.id,
      )
      expect(
        await VerificationService.getPartsValidatedBy(testCase.id!),
      ).toEqual([])

      // A second unlink finds nothing and says nothing — an idempotent delete.
      await expect(
        VerificationService.unlinkValidation(testCase.id!, part.id!, user.id),
      ).resolves.toBeUndefined()
    })

    it('refuses to validate something that is not a Part', async () => {
      const testCase = await createTestCase()
      const other = await createRequirement()

      await expect(
        VerificationService.linkValidation(testCase.id!, [other.id!], user.id),
      ).rejects.toThrow(ValidationError)
    })

    it('refuses a missing part and a source that is not a test case', async () => {
      const testCase = await createTestCase()
      const part = await createPart()

      await expect(
        VerificationService.linkValidation(
          testCase.id!,
          ['00000000-0000-0000-0000-000000000000'],
          user.id,
        ),
      ).rejects.toThrow(NotFoundError)

      await expect(
        VerificationService.linkValidation(part.id!, [part.id!], user.id),
      ).rejects.toThrow(NotFoundError)
    })
  })
})
