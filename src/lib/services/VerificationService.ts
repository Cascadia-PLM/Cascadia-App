import { and, desc, eq, inArray } from 'drizzle-orm'
import { db } from '../db'
import { designs } from '../db/schema/designs'
import {
  itemRelationships,
  items,
  requirements,
  testCases,
  testExecutions,
} from '../db/schema/items'
import { users } from '../db/schema/users'
import { NotFoundError, ValidationError } from '../errors'
import { ItemService } from '../items/services/ItemService'
import { VERIFIED_BY_RELATIONSHIP } from './RequirementService'
import type { ExecutionStatus } from '../items/types/testcase'

/**
 * Relationship type constant for test-to-part validation
 */
export const VALIDATES_RELATIONSHIP = 'VALIDATES' // TestCase → Part

/**
 * Test execution result
 */
export interface TestExecutionResult {
  id: string
  testCaseId: string
  executorId: string
  executorName: string
  executedAt: Date
  status: string
  duration: number | null
  environment: string | null
  actualResults: string | null
  notes: string | null
}

/**
 * Test coverage metrics for a design
 */
export interface TestCoverage {
  totalRequirements: number
  requirementsWithTests: number
  coveragePercent: number
  totalTests: number
  passed: number
  failed: number
  notRun: number
  blocked: number
  passedPercent: number
  failedPercent: number
}

/**
 * Verification gap - requirements without test cases
 */
export interface VerificationGap {
  id: string
  itemNumber: string
  name: string | null
  priority: string | null
  verificationMethod: string | null
}

/**
 * Validating test for a part
 */
export interface ValidatingTest {
  id: string
  itemNumber: string
  name: string | null
  testType: string | null
  executionStatus: string | null
  lastExecutedAt: Date | null
  relationshipId: string
}

/**
 * Validated part by a test
 */
export interface ValidatedPart {
  id: string
  itemNumber: string
  name: string | null
  state: string
  relationshipId: string
}

/**
 * Service for test verification and validation tracking
 */
export class VerificationService {
  /**
   * Record a test execution result.
   * Updates the test case execution status and creates an execution history record.
   */
  static async recordExecution(
    testCaseId: string,
    result: {
      status: ExecutionStatus
      duration?: number
      environment?: string
      actualResults?: string
      notes?: string
    },
    userId: string,
  ): Promise<TestExecutionResult> {
    // Verify test case exists
    const testCase = await ItemService.findById(testCaseId)
    if (!testCase || testCase.itemType !== 'TestCase') {
      throw new NotFoundError('TestCase', testCaseId, {
        operation: 'recordExecution',
      })
    }

    // Create execution record
    const [execution] = await db
      .insert(testExecutions)
      .values({
        testCaseId,
        executorId: userId,
        status: result.status,
        duration: result.duration ?? null,
        environment: result.environment ?? null,
        actualResults: result.actualResults ?? null,
        notes: result.notes ?? null,
      })
      .returning()

    // Update test case with latest execution status
    await db
      .update(testCases)
      .set({
        executionStatus: result.status,
        lastExecutedAt: new Date(),
        lastExecutedBy: userId,
        environment: result.environment ?? null,
      })
      .where(eq(testCases.itemId, testCaseId))

    // Also update the item's modifiedAt/modifiedBy
    await ItemService.update(testCaseId, {}, userId)

    // Get executor name for response
    const [executor] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)

    return {
      id: execution.id,
      testCaseId: execution.testCaseId,
      executorId: execution.executorId,
      executorName: executor?.name ?? 'Unknown',
      executedAt: execution.executedAt,
      status: execution.status,
      duration: execution.duration,
      environment: execution.environment,
      actualResults: execution.actualResults,
      notes: execution.notes,
    }
  }

  /**
   * Get execution history for a test case.
   */
  static async getExecutionHistory(
    testCaseId: string,
    limit: number = 20,
  ): Promise<Array<TestExecutionResult>> {
    const executions = await db
      .select({
        id: testExecutions.id,
        testCaseId: testExecutions.testCaseId,
        executorId: testExecutions.executorId,
        executorName: users.name,
        executedAt: testExecutions.executedAt,
        status: testExecutions.status,
        duration: testExecutions.duration,
        environment: testExecutions.environment,
        actualResults: testExecutions.actualResults,
        notes: testExecutions.notes,
      })
      .from(testExecutions)
      .leftJoin(users, eq(testExecutions.executorId, users.id))
      .where(eq(testExecutions.testCaseId, testCaseId))
      .orderBy(desc(testExecutions.executedAt))
      .limit(limit)

    return executions.map((e) => ({
      ...e,
      executorName: e.executorName ?? 'Unknown',
    }))
  }

  /**
   * Get test coverage metrics for a design.
   */
  static async getTestCoverage(designId: string): Promise<TestCoverage> {
    // Verify design exists
    const [design] = await db
      .select()
      .from(designs)
      .where(eq(designs.id, designId))
      .limit(1)

    if (!design) {
      throw new NotFoundError('Design', designId, {
        operation: 'getTestCoverage',
      })
    }

    // Get all requirements for this design
    const allRequirements = await db
      .select({ id: items.id })
      .from(items)
      .where(
        and(
          eq(items.designId, designId),
          eq(items.itemType, 'Requirement'),
          eq(items.isCurrent, true),
        ),
      )

    const totalRequirements = allRequirements.length
    if (totalRequirements === 0) {
      return {
        totalRequirements: 0,
        requirementsWithTests: 0,
        coveragePercent: 0,
        totalTests: 0,
        passed: 0,
        failed: 0,
        notRun: 0,
        blocked: 0,
        passedPercent: 0,
        failedPercent: 0,
      }
    }

    const requirementIds = allRequirements.map((r) => r.id)

    // Count requirements with VERIFIED_BY relationships
    const verifiedReqs = await db
      .select({ reqId: itemRelationships.targetId })
      .from(itemRelationships)
      .where(
        and(
          inArray(itemRelationships.targetId, requirementIds),
          eq(itemRelationships.relationshipType, VERIFIED_BY_RELATIONSHIP),
        ),
      )
    const requirementsWithTests = new Set(verifiedReqs.map((r) => r.reqId)).size

    // Get all test cases for this design
    const allTestCases = await db
      .select({
        id: items.id,
        executionStatus: testCases.executionStatus,
      })
      .from(items)
      .innerJoin(testCases, eq(items.id, testCases.itemId))
      .where(
        and(
          eq(items.designId, designId),
          eq(items.itemType, 'TestCase'),
          eq(items.isCurrent, true),
        ),
      )

    // Count execution statuses
    let passed = 0
    let failed = 0
    let notRun = 0
    let blocked = 0

    for (const tc of allTestCases) {
      switch (tc.executionStatus) {
        case 'Passed':
          passed++
          break
        case 'Failed':
          failed++
          break
        case 'Blocked':
          blocked++
          break
        default:
          notRun++
          break
      }
    }

    const totalTests = allTestCases.length
    const passedPercent =
      totalTests > 0 ? Math.round((passed / totalTests) * 1000) / 10 : 0
    const failedPercent =
      totalTests > 0 ? Math.round((failed / totalTests) * 1000) / 10 : 0

    return {
      totalRequirements,
      requirementsWithTests,
      coveragePercent:
        Math.round((requirementsWithTests / totalRequirements) * 1000) / 10,
      totalTests,
      passed,
      failed,
      notRun,
      blocked,
      passedPercent,
      failedPercent,
    }
  }

  /**
   * Get requirements without test cases (verification gaps).
   */
  static async getVerificationGaps(
    designId: string,
  ): Promise<Array<VerificationGap>> {
    // Get all requirements for this design
    const allRequirements = await db
      .select({
        id: items.id,
        itemNumber: items.itemNumber,
        name: items.name,
        priority: requirements.priority,
        verificationMethod: requirements.verificationMethod,
      })
      .from(items)
      .innerJoin(requirements, eq(items.id, requirements.itemId))
      .where(
        and(
          eq(items.designId, designId),
          eq(items.itemType, 'Requirement'),
          eq(items.isCurrent, true),
        ),
      )

    if (allRequirements.length === 0) {
      return []
    }

    const requirementIds = allRequirements.map((r) => r.id)

    // Find requirements with VERIFIED_BY relationships
    const verifiedReqs = await db
      .select({ reqId: itemRelationships.targetId })
      .from(itemRelationships)
      .where(
        and(
          inArray(itemRelationships.targetId, requirementIds),
          eq(itemRelationships.relationshipType, VERIFIED_BY_RELATIONSHIP),
        ),
      )
    const verifiedIds = new Set(verifiedReqs.map((r) => r.reqId))

    // Return requirements without tests
    const gaps = allRequirements
      .filter((r) => !verifiedIds.has(r.id))
      .map((r) => ({
        id: r.id,
        itemNumber: r.itemNumber,
        name: r.name,
        priority: r.priority,
        verificationMethod: r.verificationMethod,
      }))

    // Sort by priority (MustHave first)
    const priorityOrder = ['MustHave', 'ShouldHave', 'CouldHave', 'WontHave']
    gaps.sort((a, b) => {
      const aOrder = a.priority
        ? priorityOrder.indexOf(a.priority)
        : priorityOrder.length
      const bOrder = b.priority
        ? priorityOrder.indexOf(b.priority)
        : priorityOrder.length
      return aOrder - bOrder
    })

    return gaps
  }

  /**
   * Update the execution status of a test case.
   */
  static async updateTestStatus(
    testCaseId: string,
    status: ExecutionStatus,
    userId: string,
  ): Promise<void> {
    // Verify test case exists
    const testCase = await ItemService.findById(testCaseId)
    if (!testCase || testCase.itemType !== 'TestCase') {
      throw new NotFoundError('TestCase', testCaseId, {
        operation: 'updateTestStatus',
      })
    }

    await db
      .update(testCases)
      .set({
        executionStatus: status,
        lastExecutedAt: new Date(),
        lastExecutedBy: userId,
      })
      .where(eq(testCases.itemId, testCaseId))

    // Also update the item's modifiedAt/modifiedBy
    await ItemService.update(testCaseId, {}, userId)
  }

  /**
   * Create VALIDATES relationships between a test case and parts.
   * Direction: TestCase → Part (source → target)
   * A test case "validates" a part/design element.
   */
  static async linkValidation(
    testCaseId: string,
    partIds: Array<string>,
    userId: string,
  ): Promise<void> {
    // Verify test case exists
    const testCase = await ItemService.findById(testCaseId)
    if (!testCase || testCase.itemType !== 'TestCase') {
      throw new NotFoundError('TestCase', testCaseId, {
        operation: 'linkValidation',
      })
    }

    // Create relationships for each part
    for (const partId of partIds) {
      const part = await ItemService.findById(partId)
      if (!part) {
        throw new NotFoundError('Part', partId, {
          operation: 'linkValidation',
        })
      }

      if (part.itemType !== 'Part') {
        throw new ValidationError(`Item ${partId} is not a Part`, undefined, {
          operation: 'linkValidation',
        })
      }

      // Check if relationship already exists
      const existing = await db
        .select()
        .from(itemRelationships)
        .where(
          and(
            eq(itemRelationships.sourceId, testCaseId),
            eq(itemRelationships.targetId, partId),
            eq(itemRelationships.relationshipType, VALIDATES_RELATIONSHIP),
          ),
        )
        .limit(1)

      if (existing.length === 0) {
        await ItemService.addRelationship(
          testCaseId,
          partId,
          VALIDATES_RELATIONSHIP,
          userId,
        )
      }
    }
  }

  /**
   * Remove a VALIDATES relationship between a test case and a part.
   */
  static async unlinkValidation(
    testCaseId: string,
    partId: string,
    userId: string,
  ): Promise<void> {
    // Find the relationship
    const [relationship] = await db
      .select()
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.sourceId, testCaseId),
          eq(itemRelationships.targetId, partId),
          eq(itemRelationships.relationshipType, VALIDATES_RELATIONSHIP),
        ),
      )
      .limit(1)

    if (relationship) {
      await ItemService.removeRelationship(relationship.id, userId)
    }
  }

  /**
   * Get test cases that validate a part (VALIDATES relationships).
   */
  static async getValidatingTests(
    partId: string,
  ): Promise<Array<ValidatingTest>> {
    // Find all VALIDATES relationships where this part is the target
    const relationships = await db
      .select({
        relationshipId: itemRelationships.id,
        sourceId: itemRelationships.sourceId,
      })
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.targetId, partId),
          eq(itemRelationships.relationshipType, VALIDATES_RELATIONSHIP),
        ),
      )

    if (relationships.length === 0) {
      return []
    }

    // Get details for each test case
    const sourceIds = relationships.map((r) => r.sourceId)
    const testCaseItems = await db
      .select({
        id: items.id,
        itemNumber: items.itemNumber,
        name: items.name,
      })
      .from(items)
      .where(and(inArray(items.id, sourceIds), eq(items.itemType, 'TestCase')))

    // Get test case specific data
    const testCaseData = await db
      .select({
        itemId: testCases.itemId,
        testType: testCases.testType,
        executionStatus: testCases.executionStatus,
        lastExecutedAt: testCases.lastExecutedAt,
      })
      .from(testCases)
      .where(inArray(testCases.itemId, sourceIds))

    // Combine data
    return testCaseItems.map((tc) => {
      const rel = relationships.find((r) => r.sourceId === tc.id)
      const tcData = testCaseData.find((t) => t.itemId === tc.id)
      return {
        id: tc.id,
        itemNumber: tc.itemNumber,
        name: tc.name,
        testType: tcData?.testType ?? null,
        executionStatus: tcData?.executionStatus ?? null,
        lastExecutedAt: tcData?.lastExecutedAt ?? null,
        relationshipId: rel!.relationshipId,
      }
    })
  }

  /**
   * Get parts that a test case validates (VALIDATES relationships).
   */
  static async getPartsValidatedBy(
    testCaseId: string,
  ): Promise<Array<ValidatedPart>> {
    // Find all VALIDATES relationships where this test case is the source
    const relationships = await db
      .select({
        relationshipId: itemRelationships.id,
        targetId: itemRelationships.targetId,
      })
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.sourceId, testCaseId),
          eq(itemRelationships.relationshipType, VALIDATES_RELATIONSHIP),
        ),
      )

    if (relationships.length === 0) {
      return []
    }

    // Get details for each part
    const targetIds = relationships.map((r) => r.targetId)
    const partItems = await db
      .select({
        id: items.id,
        itemNumber: items.itemNumber,
        name: items.name,
        state: items.state,
      })
      .from(items)
      .where(and(inArray(items.id, targetIds), eq(items.itemType, 'Part')))

    // Combine data
    return partItems.map((part) => {
      const rel = relationships.find((r) => r.targetId === part.id)
      return {
        id: part.id,
        itemNumber: part.itemNumber,
        name: part.name,
        state: part.state,
        relationshipId: rel!.relationshipId,
      }
    })
  }
}
