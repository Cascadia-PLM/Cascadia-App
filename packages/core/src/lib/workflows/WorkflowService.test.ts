// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * WorkflowService Tests
 *
 * Integration tests for the WorkflowService class.
 * Tests cover workflow CRUD, validation, instances, transitions, and lifecycle effects.
 *
 * Run: npm run test -- src/lib/workflows/WorkflowService.test.ts
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { eq } from 'drizzle-orm'
import { WorkflowService } from './WorkflowService'
import { WorkflowApprovalService } from './WorkflowApprovalService'
import { resolveLifecycleType } from './normalize'
import type { CreateWorkflowInput, TransitionAction } from './types'
import {
  AlreadyExistsError,
  NotFoundError,
  ValidationError,
} from '@/lib/errors'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { insertTestPart } from '@/__tests__/fixtures/items'
import {
  items,
  workflowApprovalVotes,
  workflowDefinitions,
  workflowInstances,
} from '@/lib/db/schema'
import { takeFirst } from '@/lib/db/take-first'

describe('WorkflowService', () => {
  const testDb = new TestDatabase()

  // Unique prefix per test run to avoid item number collisions
  let testPrefix: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    testPrefix = `WF-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  /**
   * Generate a unique item number for this test
   */
  function uniqueItemNumber(): string {
    return `${testPrefix}-${Math.random().toString(36).slice(2, 6)}`
  }

  // Helper to create basic workflow input
  function createWorkflowInput(
    overrides?: Partial<CreateWorkflowInput>,
  ): CreateWorkflowInput {
    return {
      name: `Test Workflow ${testPrefix}-${Math.random().toString(36).slice(2, 8)}`,
      lifecycleType: 'Driving',
      workflowType: 'strict',
      states: [
        { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
        { id: 'review', name: 'In Review', color: 'yellow' },
        {
          id: 'approved',
          name: 'Approved',
          color: 'green',
          isFinal: true,
          finalKind: 'release' as const,
        },
      ],
      transitions: [
        {
          id: 't1',
          name: 'Submit for Review',
          fromStateId: 'draft',
          toStateId: 'review',
        },
        {
          id: 't2',
          name: 'Approve',
          fromStateId: 'review',
          toStateId: 'approved',
        },
        { id: 't3', name: 'Reject', fromStateId: 'review', toStateId: 'draft' },
      ],
      ...overrides,
    }
  }

  describe('create', () => {
    it('creates workflow definition with valid input', async () => {
      const input = createWorkflowInput()

      const result = await WorkflowService.create(input)

      expect(result.id).toBeDefined()
      expect(result.name).toBe(input.name)
      expect(result.lifecycleType).toBe('Driving')
      expect(result.states).toHaveLength(3)
      expect(result.transitions).toHaveLength(3)
      expect(result.isActive).toBe(true)
    })

    it('creates lifecycle definition', async () => {
      const input = createWorkflowInput({
        name: `Test Lifecycle ${Date.now()}`,
        lifecycleType: 'Driven',
      })

      const result = await WorkflowService.create(input)

      expect(result.lifecycleType).toBe('Driven')
    })

    it('throws error for missing name', async () => {
      const input = createWorkflowInput({ name: '' })

      await expect(WorkflowService.create(input)).rejects.toThrow(
        'Workflow name is required',
      )
    })

    it('throws error for no states', async () => {
      const input = createWorkflowInput({ states: [] })

      await expect(WorkflowService.create(input)).rejects.toThrow(
        'Workflow must have at least one state',
      )
    })

    it('throws error for no initial state', async () => {
      const input = createWorkflowInput({
        states: [
          { id: 'draft', name: 'Draft', color: 'gray' },
          {
            id: 'done',
            name: 'Done',
            color: 'green',
            isFinal: true,
            finalKind: 'release' as const,
          },
        ],
      })

      await expect(WorkflowService.create(input)).rejects.toThrow(
        'Workflow must have an initial state',
      )
    })

    it('throws error for multiple initial states', async () => {
      const input = createWorkflowInput({
        states: [
          { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
          { id: 'new', name: 'New', color: 'blue', isInitial: true },
        ],
      })

      await expect(WorkflowService.create(input)).rejects.toThrow(
        'Workflow can only have one initial state',
      )
    })

    it('throws error for duplicate state IDs', async () => {
      const input = createWorkflowInput({
        states: [
          { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
          { id: 'draft', name: 'Draft Copy', color: 'blue' },
        ],
      })

      await expect(WorkflowService.create(input)).rejects.toThrow(
        'Duplicate state IDs',
      )
    })

    it('throws error for invalid transition from state', async () => {
      const input = createWorkflowInput({
        transitions: [
          {
            id: 't1',
            name: 'Bad',
            fromStateId: 'nonexistent',
            toStateId: 'review',
          },
        ],
      })

      await expect(WorkflowService.create(input)).rejects.toThrow(
        'references non-existent from state',
      )
    })

    it('throws error for invalid transition to state', async () => {
      const input = createWorkflowInput({
        transitions: [
          {
            id: 't1',
            name: 'Bad',
            fromStateId: 'draft',
            toStateId: 'nonexistent',
          },
        ],
      })

      await expect(WorkflowService.create(input)).rejects.toThrow(
        'references non-existent to state',
      )
    })
  })

  describe('getById', () => {
    it('returns workflow by ID', async () => {
      const input = createWorkflowInput()
      const created = await WorkflowService.create(input)

      const result = await WorkflowService.getById(created.id)

      expect(result).not.toBeNull()
      expect(result?.id).toBe(created.id)
      expect(result?.name).toBe(input.name)
    })

    it('returns null for non-existent ID', async () => {
      const result = await WorkflowService.getById(
        '00000000-0000-0000-0000-000000000000',
      )

      expect(result).toBeNull()
    })
  })

  describe('getByName', () => {
    it('returns workflow by name', async () => {
      const input = createWorkflowInput()
      const created = await WorkflowService.create(input)

      const result = await WorkflowService.getByName(input.name)

      expect(result).not.toBeNull()
      expect(result?.id).toBe(created.id)
    })

    it('returns null for non-existent name', async () => {
      const result = await WorkflowService.getByName('NonExistent Workflow')

      expect(result).toBeNull()
    })
  })

  describe('list', () => {
    it('returns all workflows', async () => {
      await WorkflowService.create(createWorkflowInput())
      await WorkflowService.create(createWorkflowInput())

      const result = await WorkflowService.list()

      expect(result.length).toBeGreaterThanOrEqual(2)
    })

    it('filters by isActive', async () => {
      await WorkflowService.create(createWorkflowInput({ isActive: true }))
      await WorkflowService.create(createWorkflowInput({ isActive: false }))

      const activeOnly = await WorkflowService.list({ isActive: true })
      const inactiveOnly = await WorkflowService.list({ isActive: false })

      expect(activeOnly.every((w) => w.isActive)).toBe(true)
      expect(inactiveOnly.every((w) => !w.isActive)).toBe(true)
    })

    it('filters by kind via resolved lifecycleType', async () => {
      await WorkflowService.create(
        createWorkflowInput({
          name: `Workflow Test ${Date.now()}`,
          lifecycleType: 'Driving',
        }),
      )
      await WorkflowService.create(
        createWorkflowInput({
          name: `Lifecycle Test ${Date.now() + 1}`,
          lifecycleType: 'Driven',
        }),
      )

      const workflowsOnly = await WorkflowService.list({ kind: 'workflow' })
      const lifecyclesOnly = await WorkflowService.list({ kind: 'lifecycle' })

      expect(
        workflowsOnly.every((w) => resolveLifecycleType(w) === 'Driving'),
      ).toBe(true)
      expect(
        lifecyclesOnly.every((w) => resolveLifecycleType(w) !== 'Driving'),
      ).toBe(true)
    })

    it('resolves kind for definitions with only lifecycleType (no legacy definitionType)', async () => {
      const created = await WorkflowService.create({
        name: `Pure LifecycleType ${Date.now()}`,
        workflowType: 'strict',
        lifecycleType: 'Driven',
        states: [{ id: 'Draft', name: 'Draft', isInitial: true }],
        transitions: [],
      })

      expect(created.lifecycleType).toBe('Driven')
      const lifecyclesOnly = await WorkflowService.list({ kind: 'lifecycle' })
      expect(lifecyclesOnly.some((w) => w.id === created.id)).toBe(true)
    })
  })

  describe('update', () => {
    it('updates workflow name', async () => {
      const created = await WorkflowService.create(createWorkflowInput())
      const newName = `Updated Name ${Date.now()}`

      const updated = await WorkflowService.update(created.id, {
        name: newName,
      })

      expect(updated.name).toBe(newName)
    })

    it('updates workflow states', async () => {
      const created = await WorkflowService.create(createWorkflowInput())
      const newStates = [
        { id: 'new', name: 'New', color: 'blue', isInitial: true },
        {
          id: 'done',
          name: 'Done',
          color: 'green',
          isFinal: true,
          finalKind: 'release' as const,
        },
      ]

      const updated = await WorkflowService.update(created.id, {
        states: newStates,
        transitions: [
          { id: 't1', name: 'Complete', fromStateId: 'new', toStateId: 'done' },
        ],
      })

      expect(updated.states).toHaveLength(2)
    })

    it('throws error for non-existent workflow', async () => {
      await expect(
        WorkflowService.update('00000000-0000-0000-0000-000000000000', {
          name: 'Test',
        }),
      ).rejects.toThrow(NotFoundError)
    })

    it('throws error for invalid update', async () => {
      const created = await WorkflowService.create(createWorkflowInput())

      await expect(
        WorkflowService.update(created.id, {
          states: [], // Invalid - no states
        }),
      ).rejects.toThrow(ValidationError)
    })
  })

  describe('delete', () => {
    it('deletes workflow definition', async () => {
      const created = await WorkflowService.create(createWorkflowInput())

      await WorkflowService.delete(created.id)

      const result = await WorkflowService.getById(created.id)
      expect(result).toBeNull()
    })

    it('throws error for non-existent workflow', async () => {
      await expect(
        WorkflowService.delete('00000000-0000-0000-0000-000000000000'),
      ).rejects.toThrow(NotFoundError)
    })

    it('throws error when active instances exist', async () => {
      const user = await insertTestUser(testDb.db, { name: 'Delete Test User' })
      const workflow = await WorkflowService.create(createWorkflowInput())
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })

      // Start an instance
      await WorkflowService.startInstance(workflow.id, item.id, {
        actorId: user.id,
      })

      await expect(WorkflowService.delete(workflow.id)).rejects.toThrow(
        'Cannot delete workflow with active instances',
      )
    })
  })

  describe('validateDefinition', () => {
    it('returns valid for correct definition', () => {
      const input = createWorkflowInput()

      const result = WorkflowService.validateDefinition(input)

      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    it('warns about no final state', () => {
      const input = createWorkflowInput({
        states: [
          { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
          { id: 'review', name: 'Review', color: 'yellow' },
        ],
        transitions: [
          {
            id: 't1',
            name: 'Submit',
            fromStateId: 'draft',
            toStateId: 'review',
          },
        ],
      })

      const result = WorkflowService.validateDefinition(input)

      expect(result.valid).toBe(true)
      expect(result.warnings.some((w) => w.code === 'NO_FINAL_STATE')).toBe(
        true,
      )
    })

    it('warns about unreachable state', () => {
      const input = createWorkflowInput({
        states: [
          { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
          { id: 'orphan', name: 'Orphan', color: 'red' },
          {
            id: 'done',
            name: 'Done',
            color: 'green',
            isFinal: true,
            finalKind: 'release' as const,
          },
        ],
        transitions: [
          {
            id: 't1',
            name: 'Complete',
            fromStateId: 'draft',
            toStateId: 'done',
          },
        ],
      })

      const result = WorkflowService.validateDefinition(input)

      expect(result.warnings.some((w) => w.code === 'UNREACHABLE_STATE')).toBe(
        true,
      )
    })

    it('warns about dead-end state', () => {
      const input = createWorkflowInput({
        states: [
          { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
          { id: 'deadend', name: 'Dead End', color: 'red' },
          {
            id: 'done',
            name: 'Done',
            color: 'green',
            isFinal: true,
            finalKind: 'release' as const,
          },
        ],
        transitions: [
          {
            id: 't1',
            name: 'To Dead End',
            fromStateId: 'draft',
            toStateId: 'deadend',
          },
          {
            id: 't2',
            name: 'To Done',
            fromStateId: 'draft',
            toStateId: 'done',
          },
        ],
      })

      const result = WorkflowService.validateDefinition(input)

      expect(result.warnings.some((w) => w.code === 'DEAD_END_STATE')).toBe(
        true,
      )
    })

    // The degenerate Free lifecycle: one state carrying both isInitial and
    // isFinal, zero transitions. This is the shipped default for item types
    // with no meaningful flow ("Current"), so the validator must accept it —
    // the flags are deliberately NOT mutually exclusive, and the reachability
    // rules (non-initial needs incoming, non-final needs outgoing) are
    // satisfiable by a zero-transition machine only in this configuration.
    it('accepts a single-state Free lifecycle whose state is initial and final', () => {
      const input = createWorkflowInput({
        lifecycleType: 'Free',
        states: [
          {
            id: 'current',
            name: 'Current',
            color: 'green',
            isInitial: true,
            isFinal: true,
          },
        ],
        transitions: [],
      })

      const result = WorkflowService.validateDefinition(input)

      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
      // No reachability warnings either: the single state is both entry and
      // terminus, so nothing is unreachable and nothing is a dead end.
      expect(
        result.warnings.filter(
          (w) => w.code === 'UNREACHABLE_STATE' || w.code === 'DEAD_END_STATE',
        ),
      ).toHaveLength(0)
    })
  })

  describe('startInstance', () => {
    it('creates workflow instance for item', async () => {
      const user = await insertTestUser(testDb.db, {
        name: 'Instance Test User',
      })
      const workflow = await WorkflowService.create(createWorkflowInput())
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })

      const instance = await WorkflowService.startInstance(
        workflow.id,
        item.id,
        {
          actorId: user.id,
        },
      )

      expect(instance.id).toBeDefined()
      expect(instance.workflowDefinitionId).toBe(workflow.id)
      expect(instance.itemId).toBe(item.id)
      expect(instance.currentState).toBe('draft')
    })

    it('records initial history entry', async () => {
      const user = await insertTestUser(testDb.db, {
        name: 'History Test User',
      })
      const workflow = await WorkflowService.create(createWorkflowInput())
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })

      const instance = await WorkflowService.startInstance(
        workflow.id,
        item.id,
        {
          actorId: user.id,
        },
      )

      const history = await WorkflowService.getHistory(instance.id)

      expect(history).toHaveLength(1)
      expect(history[0]).toMatchObject({ action: 'started', toState: 'draft' })
    })

    it('throws error for non-existent workflow', async () => {
      const user = await insertTestUser(testDb.db, {
        name: 'Bad Workflow User',
      })
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })

      await expect(
        WorkflowService.startInstance(
          '00000000-0000-0000-0000-000000000000',
          item.id,
        ),
      ).rejects.toThrow(NotFoundError)
    })
  })

  describe('getInstance', () => {
    it('returns instance by ID', async () => {
      const user = await insertTestUser(testDb.db, {
        name: 'Get Instance User',
      })
      const workflow = await WorkflowService.create(createWorkflowInput())
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })
      const created = await WorkflowService.startInstance(
        workflow.id,
        item.id,
        {
          actorId: user.id,
        },
      )

      const result = await WorkflowService.getInstance(created.id)

      expect(result).not.toBeNull()
      expect(result?.id).toBe(created.id)
    })

    it('returns null for non-existent instance', async () => {
      const result = await WorkflowService.getInstance(
        '00000000-0000-0000-0000-000000000000',
      )

      expect(result).toBeNull()
    })
  })

  describe('getInstanceByItemId', () => {
    it('returns most recent instance for item', async () => {
      const user = await insertTestUser(testDb.db, {
        name: 'Item Instance User',
      })
      const workflow = await WorkflowService.create(createWorkflowInput())
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })
      const instance = await WorkflowService.startInstance(
        workflow.id,
        item.id,
        {
          actorId: user.id,
        },
      )

      const result = await WorkflowService.getInstanceByItemId(item.id)

      expect(result).not.toBeNull()
      expect(result?.id).toBe(instance.id)
    })

    it('returns null for item with no instances', async () => {
      const user = await insertTestUser(testDb.db, { name: 'No Instance User' })
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })

      const result = await WorkflowService.getInstanceByItemId(item.id)

      expect(result).toBeNull()
    })
  })

  describe('getAvailableTransitions', () => {
    it('returns transitions from current state', async () => {
      const user = await insertTestUser(testDb.db, { name: 'Transitions User' })
      const workflow = await WorkflowService.create(createWorkflowInput())
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })
      const instance = await WorkflowService.startInstance(
        workflow.id,
        item.id,
        {
          actorId: user.id,
        },
      )

      const available = await WorkflowService.getAvailableTransitions(
        instance.id,
        {
          item: { id: item.id },
          user: { id: user.id, roles: [] },
        },
      )

      // From draft, should have "Submit for Review"
      expect(available.length).toBeGreaterThanOrEqual(1)
      expect(
        available.some((t) => t.transition.name === 'Submit for Review'),
      ).toBe(true)
    })

    it('throws error for non-existent instance', async () => {
      await expect(
        WorkflowService.getAvailableTransitions(
          '00000000-0000-0000-0000-000000000000',
          {
            item: {},
            user: { id: 'test', roles: [] },
          },
        ),
      ).rejects.toThrow(NotFoundError)
    })
  })

  describe('canTransition', () => {
    it('returns allowed for valid transition', async () => {
      const user = await insertTestUser(testDb.db, {
        name: 'Can Transition User',
      })
      const workflow = await WorkflowService.create(createWorkflowInput())
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })
      const instance = await WorkflowService.startInstance(
        workflow.id,
        item.id,
        {
          actorId: user.id,
        },
      )

      const result = await WorkflowService.canTransition(
        instance.id,
        'review',
        {
          item: { id: item.id },
          user: { id: user.id, roles: [] },
        },
      )

      expect(result.allowed).toBe(true)
      expect(result.reasons).toHaveLength(0)
    })

    it('returns not allowed for invalid transition', async () => {
      const user = await insertTestUser(testDb.db, {
        name: 'Invalid Transition User',
      })
      const workflow = await WorkflowService.create(createWorkflowInput())
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })
      const instance = await WorkflowService.startInstance(
        workflow.id,
        item.id,
        {
          actorId: user.id,
        },
      )

      // From draft, cannot go directly to approved
      const result = await WorkflowService.canTransition(
        instance.id,
        'approved',
        {
          item: { id: item.id },
          user: { id: user.id, roles: [] },
        },
      )

      expect(result.allowed).toBe(false)
      expect(result.reasons.length).toBeGreaterThan(0)
    })
  })

  describe('transition', () => {
    it('executes valid transition', async () => {
      const user = await insertTestUser(testDb.db, {
        name: 'Execute Transition User',
      })
      const workflow = await WorkflowService.create(createWorkflowInput())
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })
      const instance = await WorkflowService.startInstance(
        workflow.id,
        item.id,
        {
          actorId: user.id,
        },
      )

      const result = await WorkflowService.transition(
        instance.id,
        'review',
        user.id,
        'Test comment',
      )

      expect(result.success).toBe(true)
      expect(result.fromState).toBe('draft')
      expect(result.toState).toBe('review')

      // Verify instance state updated
      const updated = await WorkflowService.getInstance(instance.id)
      expect(updated?.currentState).toBe('review')
    })

    it('locks scope on leaving the initial state and reopens it on rework', async () => {
      const user = await insertTestUser(testDb.db, { name: 'Scope Lock User' })
      const workflow = await WorkflowService.create(createWorkflowInput())
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })
      const instance = await WorkflowService.startInstance(
        workflow.id,
        item.id,
        { actorId: user.id },
      )

      await WorkflowService.transition(instance.id, 'review', user.id)
      expect(
        (await WorkflowService.getInstance(instance.id))?.scopeLocked,
      ).toBe(true)

      // Sending a change order back to Draft asks for its scope to be
      // corrected there. Leaving the lock set made that a one-way trip: the
      // change order could no longer accept the items it was returned to add.
      await WorkflowService.transition(instance.id, 'draft', user.id)
      const afterRework = await WorkflowService.getInstance(instance.id)
      expect(afterRework?.currentState).toBe('draft')
      expect(afterRework?.scopeLocked).toBe(false)

      // ...and locks again on the next submit
      await WorkflowService.transition(instance.id, 'review', user.id)
      expect(
        (await WorkflowService.getInstance(instance.id))?.scopeLocked,
      ).toBe(true)
    })

    it('records transition in history', async () => {
      const user = await insertTestUser(testDb.db, {
        name: 'History Transition User',
      })
      const workflow = await WorkflowService.create(createWorkflowInput())
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })
      const instance = await WorkflowService.startInstance(
        workflow.id,
        item.id,
        {
          actorId: user.id,
        },
      )

      await WorkflowService.transition(
        instance.id,
        'review',
        user.id,
        'Submitting for review',
      )

      const history = await WorkflowService.getHistory(instance.id)

      // Should have "started" and "Submit for Review"
      expect(history.length).toBeGreaterThanOrEqual(2)
      expect(history.some((h) => h.action === 'Submit for Review')).toBe(true)
    })

    it('updates item state', async () => {
      const user = await insertTestUser(testDb.db, { name: 'Item State User' })
      const workflow = await WorkflowService.create(createWorkflowInput())
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })
      const instance = await WorkflowService.startInstance(
        workflow.id,
        item.id,
        {
          actorId: user.id,
        },
      )

      await WorkflowService.transition(instance.id, 'review', user.id)

      // Check item state in database
      const [updatedItem] = await testDb.db
        .select()
        .from(items)
        .where(eq(items.id, item.id))
      expect(updatedItem).toMatchObject({ state: 'review' })
    })

    it('marks instance complete on final state', async () => {
      const user = await insertTestUser(testDb.db, { name: 'Final State User' })
      const workflow = await WorkflowService.create(createWorkflowInput())
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })
      const instance = await WorkflowService.startInstance(
        workflow.id,
        item.id,
        {
          actorId: user.id,
        },
      )

      // Transition to review then to approved (final)
      await WorkflowService.transition(instance.id, 'review', user.id)
      await WorkflowService.transition(instance.id, 'approved', user.id)

      const final = await WorkflowService.getInstance(instance.id)
      expect(final?.completedAt).toBeDefined()
    })

    it('returns error for invalid transition', async () => {
      const user = await insertTestUser(testDb.db, {
        name: 'Invalid State User',
      })
      const workflow = await WorkflowService.create(createWorkflowInput())
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })
      const instance = await WorkflowService.startInstance(
        workflow.id,
        item.id,
        {
          actorId: user.id,
        },
      )

      // Cannot go directly from draft to approved
      const result = await WorkflowService.transition(
        instance.id,
        'approved',
        user.id,
      )

      expect(result.success).toBe(false)
      expect(result.error).toContain('No valid transition')
    })

    it('returns error for non-existent instance', async () => {
      const result = await WorkflowService.transition(
        '00000000-0000-0000-0000-000000000000',
        'review',
        'test-user',
      )

      expect(result.success).toBe(false)
      expect(result.error).toBe('Workflow instance not found')
    })
  })

  describe('Phase 1 hardening', () => {
    describe('finalKind validation (WI-1.1)', () => {
      it('rejects Driving definitions whose final states lack finalKind', () => {
        const result = WorkflowService.validateDefinition({
          name: 'FK Missing',
          definitionType: 'workflow',
          states: [
            { id: 'draft', name: 'Draft', isInitial: true },
            { id: 'done', name: 'Done', isFinal: true },
          ],
          transitions: [
            {
              id: 't1',
              name: 'Finish',
              fromStateId: 'draft',
              toStateId: 'done',
            },
          ],
        } as any)

        expect(result.valid).toBe(false)
        expect(result.errors.map((e) => e.code)).toContain('MISSING_FINAL_KIND')
      })

      it('accepts Driving definitions when final states declare finalKind', () => {
        const result = WorkflowService.validateDefinition({
          name: 'FK Present',
          definitionType: 'workflow',
          states: [
            { id: 'draft', name: 'Draft', isInitial: true },
            { id: 'done', name: 'Done', isFinal: true, finalKind: 'release' },
          ],
          transitions: [
            {
              id: 't1',
              name: 'Finish',
              fromStateId: 'draft',
              toStateId: 'done',
            },
          ],
        } as any)

        expect(result.errors.map((e) => e.code)).not.toContain(
          'MISSING_FINAL_KIND',
        )
      })

      it('does not require finalKind on Driven lifecycles', () => {
        const result = WorkflowService.validateDefinition({
          name: 'Driven FK Exempt',
          definitionType: 'lifecycle',
          lifecycleType: 'Driven',
          states: [
            { id: 'Draft', name: 'Draft', isInitial: true },
            { id: 'Obsolete', name: 'Obsolete', isFinal: true },
          ],
          transitions: [],
        } as any)

        expect(result.errors.map((e) => e.code)).not.toContain(
          'MISSING_FINAL_KIND',
        )
      })
    })

    describe('changeActionMappings reference state IDs (WI-5.1)', () => {
      it('rejects mappings that reference a display name instead of a state ID', () => {
        const result = WorkflowService.validateDefinition({
          name: 'Mapping By Name',
          lifecycleType: 'Driven',
          states: [
            { id: 'Draft', name: 'Draft', isInitial: true },
            { id: 'Rel', name: 'Released' },
          ],
          transitions: [],
          changeActionMappings: {
            // 'Released' is the display name; the ID is 'Rel'
            release: { fromState: 'Draft', toState: 'Released' },
          },
        } as any)

        expect(result.valid).toBe(false)
        expect(result.errors.map((e) => e.code)).toContain(
          'MAPPING_UNKNOWN_STATE',
        )
      })

      it('accepts id !== name freely when mappings are keyed by IDs', () => {
        const result = WorkflowService.validateDefinition({
          name: 'IDs Everywhere',
          lifecycleType: 'Driven',
          states: [
            { id: 'draft', name: 'Draft', isInitial: true },
            { id: 'in-review', name: 'In Review' },
            { id: 'released', name: 'Released' },
          ],
          transitions: [],
          changeActionMappings: {
            release: { fromState: 'draft', toState: 'released' },
          },
        } as any)

        expect(result.errors.map((e) => e.code)).not.toContain(
          'MAPPING_UNKNOWN_STATE',
        )
        expect(result.valid).toBe(true)
      })
    })

    /**
     * A Driven lifecycle mints a new `items` row per release, and
     * (item_number, revision, design_id, item_type) is unique — so a revision
     * scheme that never advances makes the second release of any item a
     * unique violation inside the merge transaction. The configuration is
     * refused at save time instead.
     */
    describe("revision scheme 'none' on a Driven lifecycle", () => {
      const noneScheme = { type: 'none' } as const
      const states = [
        { id: 'draft', name: 'Draft', isInitial: true },
        { id: 'released', name: 'Released' },
      ]

      it('is rejected at the lifecycle level', () => {
        const result = WorkflowService.validateDefinition({
          name: 'Driven None',
          lifecycleType: 'Driven',
          states,
          transitions: [],
          revisionScheme: noneScheme,
        } as any)

        expect(result.valid).toBe(false)
        expect(result.errors.map((e) => e.code)).toContain(
          'NONE_SCHEME_ON_DRIVEN',
        )
      })

      it('is accepted on a Free lifecycle, which updates items in place', () => {
        const result = WorkflowService.validateDefinition({
          name: 'Free None',
          lifecycleType: 'Free',
          states,
          transitions: [],
          revisionScheme: noneScheme,
        } as any)

        expect(result.errors.map((e) => e.code)).not.toContain(
          'NONE_SCHEME_ON_DRIVEN',
        )
      })

      it('is accepted as a phase-level override on a Driven lifecycle', () => {
        // Phase overrides are read only by the promote path, which updates the
        // item in place and mints no row.
        const result = WorkflowService.validateDefinition({
          name: 'Driven Phase None',
          lifecycleType: 'Driven',
          states: states.map((s) => ({ ...s, phaseId: 'p1' })),
          transitions: [],
          phases: [
            { id: 'p1', name: 'Service', order: 0, revisionScheme: noneScheme },
          ],
        } as any)

        expect(result.errors.map((e) => e.code)).not.toContain(
          'NONE_SCHEME_ON_DRIVEN',
        )
      })
    })

    describe('transition hardening (WI-1.2 / WI-1.4)', () => {
      async function setupInstance() {
        const user = await insertTestUser(testDb.db)
        const workflow = await WorkflowService.create(createWorkflowInput())
        const { item } = await insertTestPart(testDb.db, null, user.id, {
          itemNumber: uniqueItemNumber(),
        })
        const instance = await WorkflowService.startInstance(
          workflow.id,
          item.id,
          { actorId: user.id },
        )
        return { user, workflow, item, instance }
      }

      it('refuses transitions on completed instances', async () => {
        const { user, instance } = await setupInstance()
        await WorkflowService.transition(instance.id, 'review', user.id)
        const done = await WorkflowService.transition(
          instance.id,
          'approved',
          user.id,
        )
        expect(done.success).toBe(true)

        const after = await WorkflowService.transition(
          instance.id,
          'review',
          user.id,
        )
        expect(after.success).toBe(false)
        expect(after.error).toMatch(/already completed/i)
      })

      it('allows exactly one of two concurrent identical transitions', async () => {
        const { user, instance } = await setupInstance()

        const [a, b] = await Promise.all([
          WorkflowService.transition(instance.id, 'review', user.id),
          WorkflowService.transition(instance.id, 'review', user.id),
        ])

        const successes = [a, b].filter((r) => r.success)
        expect(successes).toHaveLength(1)

        const updated = await WorkflowService.getInstance(instance.id)
        expect(updated?.currentState).toBe('review')

        const history = await WorkflowService.getHistory(instance.id)
        expect(history.filter((h) => h.toState === 'review')).toHaveLength(1)
      })

      it('blocks other transitions while a release claim is held', async () => {
        const { user, instance } = await setupInstance()

        const claim = await WorkflowService.claimRelease(instance.id, 'draft')
        expect(claim.claimed).toBe(true)

        const blocked = await WorkflowService.transition(
          instance.id,
          'review',
          user.id,
        )
        expect(blocked.success).toBe(false)
        expect(blocked.error).toMatch(/release .* already in progress/i)

        // The claim was taken a moment ago, so it is live and the CAS refuses
        // to hand it to anyone else. The next test is the other half of this
        // pair: the identical call *succeeds* once the same claim has aged
        // past RELEASE_CLAIM_TIMEOUT_MS. Age is the only thing separating
        // them, which is what makes the timeout the whole of the takeover
        // policy — read them together.
        const second = await WorkflowService.claimRelease(instance.id, 'draft')
        expect(second.claimed).toBe(false)

        await WorkflowService.releaseClaim(instance.id)
        const after = await WorkflowService.transition(
          instance.id,
          'review',
          user.id,
        )
        expect(after.success).toBe(true)
      })

      it('takes over a release claim that has gone stale', async () => {
        // The other half of the pair above. `releaseClaim` is only ever called
        // by the process that took the claim, so a process that dies between
        // claiming and closing clears nothing — without the staleness arm of
        // the CAS its instance would be wedged permanently, unable to
        // transition and unable to be released. Backdating `releasingAt` past
        // the timeout is what that crash looks like from the database's side.
        const { instance } = await setupInstance()

        const first = await WorkflowService.claimRelease(instance.id, 'draft')
        expect(first.claimed).toBe(true)

        await testDb.db
          .update(workflowInstances)
          .set({
            releasingAt: new Date(
              Date.now() - WorkflowService.RELEASE_CLAIM_TIMEOUT_MS - 60_000,
            ),
          })
          .where(eq(workflowInstances.id, instance.id))

        const takeover = await WorkflowService.claimRelease(
          instance.id,
          'draft',
        )
        expect(takeover.claimed).toBe(true)

        // Taking over re-stamps the claim rather than simply consuming the
        // stale one: the instance is exclusive again immediately, so a third
        // caller arriving behind the takeover still loses.
        const third = await WorkflowService.claimRelease(instance.id, 'draft')
        expect(third.claimed).toBe(false)
      })

      it('refuses a release claim when the expected state is stale', async () => {
        const { user, instance } = await setupInstance()
        await WorkflowService.transition(instance.id, 'review', user.id)

        const claim = await WorkflowService.claimRelease(instance.id, 'draft')
        expect(claim.claimed).toBe(false)
        expect(claim.error).toMatch(/state/i)
      })

      it('fails closed when the approval check itself errors', async () => {
        const { user, instance } = await setupInstance()

        const spy = vi
          .spyOn(WorkflowApprovalService, 'areApprovalsComplete')
          .mockRejectedValueOnce(new Error('simulated outage'))
        try {
          const result = await WorkflowService.transition(
            instance.id,
            'review',
            user.id,
          )
          expect(result.success).toBe(false)
          expect(result.error).toMatch(/could not verify approvals/i)
        } finally {
          spy.mockRestore()
        }
      })

      it('rejects a second active workflow instance for the same item (WI-1.3)', async () => {
        const { workflow, item } = await setupInstance()

        await expect(
          WorkflowService.startInstance(workflow.id, item.id),
        ).rejects.toThrow(AlreadyExistsError)
      })
    })
  })

  describe('update_field allowlist (WI-2.3)', () => {
    it('rejects definitions whose update_field targets a non-allowlisted column', () => {
      const result = WorkflowService.validateDefinition({
        name: 'UF Disallowed',
        definitionType: 'workflow',
        states: [
          { id: 'draft', name: 'Draft', isInitial: true },
          { id: 'done', name: 'Done', isFinal: true, finalKind: 'release' },
        ],
        transitions: [
          {
            id: 't1',
            name: 'Finish',
            fromStateId: 'draft',
            toStateId: 'done',
            actions: [
              {
                id: 'a1',
                name: 'Sneaky state write',
                type: 'update_field',
                executeOn: 'after',
                config: { fieldName: 'state', value: 'Released' },
              },
            ],
          },
        ],
      } as any)

      expect(result.valid).toBe(false)
      expect(result.errors.map((e) => e.code)).toContain(
        'UPDATE_FIELD_NOT_ALLOWED',
      )
    })

    it('accepts update_field on allowlisted columns', () => {
      const result = WorkflowService.validateDefinition({
        name: 'UF Allowed',
        definitionType: 'workflow',
        states: [
          { id: 'draft', name: 'Draft', isInitial: true },
          { id: 'done', name: 'Done', isFinal: true, finalKind: 'release' },
        ],
        transitions: [
          {
            id: 't1',
            name: 'Finish',
            fromStateId: 'draft',
            toStateId: 'done',
            actions: [
              {
                id: 'a1',
                name: 'Rename on completion',
                type: 'update_field',
                executeOn: 'after',
                config: { fieldName: 'name', value: 'Done!' },
              },
            ],
          },
        ],
      } as any)

      expect(result.errors.map((e) => e.code)).not.toContain(
        'UPDATE_FIELD_NOT_ALLOWED',
      )
    })
  })
})

// Edge case tests
describe('WorkflowService Edge Cases', () => {
  const testDb = new TestDatabase()
  let testPrefix: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    testPrefix = `WFEC-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  function uniqueItemNumber(): string {
    return `${testPrefix}-${Math.random().toString(36).slice(2, 6)}`
  }

  describe('Complex State Machines', () => {
    it('handles workflow with many states (10+)', async () => {
      const states = [
        { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
        { id: 'review1', name: 'Review Level 1', color: 'yellow' },
        { id: 'review2', name: 'Review Level 2', color: 'yellow' },
        { id: 'review3', name: 'Review Level 3', color: 'yellow' },
        { id: 'pending-approval', name: 'Pending Approval', color: 'orange' },
        { id: 'approved', name: 'Approved', color: 'green' },
        { id: 'implementation', name: 'In Implementation', color: 'blue' },
        { id: 'testing', name: 'Testing', color: 'purple' },
        {
          id: 'release',
          name: 'Released',
          color: 'green',
          isFinal: true,
          finalKind: 'release' as const,
        },
        {
          id: 'cancelled',
          name: 'Cancelled',
          color: 'red',
          isFinal: true,
          finalKind: 'cancel' as const,
        },
      ]

      const transitions = [
        {
          id: 't1',
          name: 'Submit L1',
          fromStateId: 'draft',
          toStateId: 'review1',
        },
        {
          id: 't2',
          name: 'Submit L2',
          fromStateId: 'review1',
          toStateId: 'review2',
        },
        {
          id: 't3',
          name: 'Submit L3',
          fromStateId: 'review2',
          toStateId: 'review3',
        },
        {
          id: 't4',
          name: 'Request Approval',
          fromStateId: 'review3',
          toStateId: 'pending-approval',
        },
        {
          id: 't5',
          name: 'Approve',
          fromStateId: 'pending-approval',
          toStateId: 'approved',
        },
        {
          id: 't6',
          name: 'Implement',
          fromStateId: 'approved',
          toStateId: 'implementation',
        },
        {
          id: 't7',
          name: 'Test',
          fromStateId: 'implementation',
          toStateId: 'testing',
        },
        {
          id: 't8',
          name: 'Release',
          fromStateId: 'testing',
          toStateId: 'release',
        },
        {
          id: 't9',
          name: 'Cancel',
          fromStateId: 'draft',
          toStateId: 'cancelled',
        },
        {
          id: 't10',
          name: 'Reject L1',
          fromStateId: 'review1',
          toStateId: 'draft',
        },
      ]

      const workflow = await WorkflowService.create({
        name: `Complex Workflow ${testPrefix}`,
        lifecycleType: 'Driving',
        workflowType: 'strict',
        states,
        transitions,
      })

      expect(workflow.states).toHaveLength(10)
      expect(workflow.transitions).toHaveLength(10)
    })

    it('handles workflow with circular transitions (loops back)', async () => {
      const input = {
        name: `Circular Workflow ${testPrefix}`,
        definitionType: 'workflow' as const,
        workflowType: 'strict' as const,
        states: [
          { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
          { id: 'review', name: 'Review', color: 'yellow' },
          { id: 'rework', name: 'Rework', color: 'orange' },
          {
            id: 'approved',
            name: 'Approved',
            color: 'green',
            isFinal: true,
            finalKind: 'release' as const,
          },
        ],
        transitions: [
          {
            id: 't1',
            name: 'Submit',
            fromStateId: 'draft',
            toStateId: 'review',
          },
          {
            id: 't2',
            name: 'Request Rework',
            fromStateId: 'review',
            toStateId: 'rework',
          },
          {
            id: 't3',
            name: 'Resubmit',
            fromStateId: 'rework',
            toStateId: 'review',
          },
          {
            id: 't4',
            name: 'Approve',
            fromStateId: 'review',
            toStateId: 'approved',
          },
        ],
      }

      const workflow = await WorkflowService.create(input)
      const user = await insertTestUser(testDb.db, {
        name: 'Circular Test User',
      })
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })
      const instance = await WorkflowService.startInstance(
        workflow.id,
        item.id,
        { actorId: user.id },
      )

      // Go through circular path: draft -> review -> rework -> review -> approved
      await WorkflowService.transition(instance.id, 'review', user.id)
      await WorkflowService.transition(instance.id, 'rework', user.id)
      await WorkflowService.transition(instance.id, 'review', user.id)
      await WorkflowService.transition(instance.id, 'approved', user.id)

      const final = await WorkflowService.getInstance(instance.id)
      expect(final?.currentState).toBe('approved')
      expect(final?.completedAt).toBeDefined()

      const history = await WorkflowService.getHistory(instance.id)
      // started + 4 transitions = 5 entries
      expect(history.length).toBeGreaterThanOrEqual(5)
    })

    it('handles multiple parallel paths to same state', async () => {
      const input = {
        name: `Parallel Paths ${testPrefix}`,
        definitionType: 'workflow' as const,
        workflowType: 'strict' as const,
        states: [
          { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
          { id: 'fast-track', name: 'Fast Track', color: 'yellow' },
          { id: 'normal-review', name: 'Normal Review', color: 'blue' },
          {
            id: 'approved',
            name: 'Approved',
            color: 'green',
            isFinal: true,
            finalKind: 'release' as const,
          },
        ],
        transitions: [
          {
            id: 't1',
            name: 'Fast Track',
            fromStateId: 'draft',
            toStateId: 'fast-track',
          },
          {
            id: 't2',
            name: 'Normal Path',
            fromStateId: 'draft',
            toStateId: 'normal-review',
          },
          {
            id: 't3',
            name: 'Fast Approve',
            fromStateId: 'fast-track',
            toStateId: 'approved',
          },
          {
            id: 't4',
            name: 'Normal Approve',
            fromStateId: 'normal-review',
            toStateId: 'approved',
          },
        ],
      }

      const workflow = await WorkflowService.create(input)
      const user = await insertTestUser(testDb.db, {
        name: 'Parallel Path User',
      })
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })
      const instance = await WorkflowService.startInstance(
        workflow.id,
        item.id,
        { actorId: user.id },
      )

      // Check that both paths are available from draft
      const available = await WorkflowService.getAvailableTransitions(
        instance.id,
        {
          item: { id: item.id },
          user: { id: user.id, roles: [] },
        },
      )

      expect(available.length).toBe(2)
      expect(available.some((t) => t.transition.name === 'Fast Track')).toBe(
        true,
      )
      expect(available.some((t) => t.transition.name === 'Normal Path')).toBe(
        true,
      )
    })

    it('handles self-loop transitions', async () => {
      const input = {
        name: `Self Loop ${testPrefix}`,
        definitionType: 'workflow' as const,
        workflowType: 'strict' as const,
        states: [
          { id: 'review', name: 'Review', color: 'yellow', isInitial: true },
          {
            id: 'done',
            name: 'Done',
            color: 'green',
            isFinal: true,
            finalKind: 'release' as const,
          },
        ],
        transitions: [
          {
            id: 't1',
            name: 'Re-review',
            fromStateId: 'review',
            toStateId: 'review',
          },
          {
            id: 't2',
            name: 'Complete',
            fromStateId: 'review',
            toStateId: 'done',
          },
        ],
      }

      const workflow = await WorkflowService.create(input)
      const user = await insertTestUser(testDb.db, { name: 'Self Loop User' })
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })
      const instance = await WorkflowService.startInstance(
        workflow.id,
        item.id,
        { actorId: user.id },
      )

      // Perform self-loop multiple times
      await WorkflowService.transition(
        instance.id,
        'review',
        user.id,
        'First review',
      )
      await WorkflowService.transition(
        instance.id,
        'review',
        user.id,
        'Second review',
      )
      await WorkflowService.transition(
        instance.id,
        'review',
        user.id,
        'Third review',
      )

      const current = await WorkflowService.getInstance(instance.id)
      expect(current?.currentState).toBe('review')

      const history = await WorkflowService.getHistory(instance.id)
      expect(history.length).toBeGreaterThanOrEqual(4) // started + 3 re-reviews
    })
  })

  describe('State Name Edge Cases', () => {
    it('handles state names with special characters', async () => {
      const input = {
        name: `Special State Names ${testPrefix}`,
        definitionType: 'workflow' as const,
        workflowType: 'strict' as const,
        states: [
          {
            id: 'draft',
            name: 'Draft (Initial)',
            color: 'gray',
            isInitial: true,
          },
          { id: 'review', name: 'In-Review / Pending', color: 'yellow' },
          {
            id: 'done',
            name: 'Done & Complete!',
            color: 'green',
            isFinal: true,
            finalKind: 'release' as const,
          },
        ],
        transitions: [
          {
            id: 't1',
            name: 'Submit → Review',
            fromStateId: 'draft',
            toStateId: 'review',
          },
          {
            id: 't2',
            name: 'Approve ✓',
            fromStateId: 'review',
            toStateId: 'done',
          },
        ],
      }

      const workflow = await WorkflowService.create(input)
      expect(workflow.states[0]).toMatchObject({ name: 'Draft (Initial)' })
      expect(workflow.states[1]).toMatchObject({ name: 'In-Review / Pending' })
    })

    it('handles unicode in state and transition names', async () => {
      const input = {
        name: `Unicode Workflow ${testPrefix}`,
        definitionType: 'workflow' as const,
        workflowType: 'strict' as const,
        states: [
          { id: 'draft', name: '草稿', color: 'gray', isInitial: true },
          { id: 'review', name: 'レビュー中', color: 'yellow' },
          {
            id: 'done',
            name: '完了',
            color: 'green',
            isFinal: true,
            finalKind: 'release' as const,
          },
        ],
        transitions: [
          { id: 't1', name: '提出', fromStateId: 'draft', toStateId: 'review' },
          { id: 't2', name: '承認', fromStateId: 'review', toStateId: 'done' },
        ],
      }

      const workflow = await WorkflowService.create(input)
      expect(workflow.states.find((s) => s.id === 'draft')?.name).toBe('草稿')
      expect(workflow.transitions?.find((t) => t.id === 't1')?.name).toBe(
        '提出',
      )
    })

    it('handles very long state names', async () => {
      const longName = 'A'.repeat(200)
      const input = {
        name: `Long Names ${testPrefix}`,
        definitionType: 'workflow' as const,
        workflowType: 'strict' as const,
        states: [
          { id: 'draft', name: longName, color: 'gray', isInitial: true },
          {
            id: 'done',
            name: 'Done',
            color: 'green',
            isFinal: true,
            finalKind: 'release' as const,
          },
        ],
        transitions: [
          { id: 't1', name: longName, fromStateId: 'draft', toStateId: 'done' },
        ],
      }

      const workflow = await WorkflowService.create(input)
      // Name may be truncated or accepted depending on DB constraints
      expect(workflow.states[0]?.name.length).toBeGreaterThan(0)
    })

    it('handles empty state name', async () => {
      const input = {
        name: `Empty State Name ${testPrefix}`,
        definitionType: 'workflow' as const,
        workflowType: 'strict' as const,
        states: [
          { id: 'draft', name: '', color: 'gray', isInitial: true },
          {
            id: 'done',
            name: 'Done',
            color: 'green',
            isFinal: true,
            finalKind: 'release' as const,
          },
        ],
        transitions: [
          {
            id: 't1',
            name: 'Complete',
            fromStateId: 'draft',
            toStateId: 'done',
          },
        ],
      }

      try {
        const result = await WorkflowService.create(input)
        // If accepted, empty name is stored
        expect(result.states.find((s) => s.id === 'draft')?.name).toBe('')
      } catch (error) {
        // Expected to reject empty name
        expect(error).toBeDefined()
      }
    })

    it('handles whitespace-only state name', async () => {
      const input = {
        name: `Whitespace State Name ${testPrefix}`,
        definitionType: 'workflow' as const,
        workflowType: 'strict' as const,
        states: [
          { id: 'draft', name: '   ', color: 'gray', isInitial: true },
          {
            id: 'done',
            name: 'Done',
            color: 'green',
            isFinal: true,
            finalKind: 'release' as const,
          },
        ],
        transitions: [
          {
            id: 't1',
            name: 'Complete',
            fromStateId: 'draft',
            toStateId: 'done',
          },
        ],
      }

      try {
        const result = await WorkflowService.create(input)
        // If accepted, whitespace name may be trimmed or kept
        expect(result).toBeDefined()
      } catch (error) {
        // Expected to reject whitespace name
        expect(error).toBeDefined()
      }
    })
  })

  describe('Transition to Completed Instance', () => {
    it('cannot transition after reaching final state', async () => {
      const input = {
        name: `Final State Test ${testPrefix}`,
        definitionType: 'workflow' as const,
        workflowType: 'strict' as const,
        states: [
          { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
          {
            id: 'done',
            name: 'Done',
            color: 'green',
            isFinal: true,
            finalKind: 'release' as const,
          },
        ],
        transitions: [
          {
            id: 't1',
            name: 'Complete',
            fromStateId: 'draft',
            toStateId: 'done',
          },
        ],
      }

      const workflow = await WorkflowService.create(input)
      const user = await insertTestUser(testDb.db, { name: 'Final State User' })
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })
      const instance = await WorkflowService.startInstance(
        workflow.id,
        item.id,
        { actorId: user.id },
      )

      // Complete the workflow
      await WorkflowService.transition(instance.id, 'done', user.id)

      // Try to transition again (should fail - no transitions from final state)
      const result = await WorkflowService.transition(
        instance.id,
        'draft',
        user.id,
      )
      expect(result.success).toBe(false)
    })
  })

  describe('Concurrent Instance Operations', () => {
    it('handles multiple instances for different items', async () => {
      const workflow = await WorkflowService.create({
        name: `Multi Instance ${testPrefix}`,
        lifecycleType: 'Driving',
        workflowType: 'strict',
        states: [
          { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
          {
            id: 'done',
            name: 'Done',
            color: 'green',
            isFinal: true,
            finalKind: 'release' as const,
          },
        ],
        transitions: [
          {
            id: 't1',
            name: 'Complete',
            fromStateId: 'draft',
            toStateId: 'done',
          },
        ],
      })

      const user = await insertTestUser(testDb.db, {
        name: 'Multi Instance User',
      })
      const { item: item1 } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })
      const { item: item2 } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })
      const { item: item3 } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })

      // Start instances for all items
      const instance1 = await WorkflowService.startInstance(
        workflow.id,
        item1.id,
        { actorId: user.id },
      )
      const instance2 = await WorkflowService.startInstance(
        workflow.id,
        item2.id,
        { actorId: user.id },
      )
      const instance3 = await WorkflowService.startInstance(
        workflow.id,
        item3.id,
        { actorId: user.id },
      )

      // Transition only instance2
      await WorkflowService.transition(instance2.id, 'done', user.id)

      // Verify states
      const i1 = await WorkflowService.getInstance(instance1.id)
      const i2 = await WorkflowService.getInstance(instance2.id)
      const i3 = await WorkflowService.getInstance(instance3.id)

      expect(i1?.currentState).toBe('draft')
      expect(i2?.currentState).toBe('done')
      expect(i3?.currentState).toBe('draft')
    })
  })

  describe('Invalid UUID Handling', () => {
    it('getById handles malformed UUID', async () => {
      try {
        const result = await WorkflowService.getById('not-a-uuid')
        expect(result).toBeNull()
      } catch (error) {
        // Malformed UUID may cause DB error
        expect(error).toBeDefined()
      }
    })

    it('getInstance handles malformed UUID', async () => {
      try {
        const result = await WorkflowService.getInstance('not-a-uuid')
        expect(result).toBeNull()
      } catch (error) {
        // Malformed UUID may cause DB error
        expect(error).toBeDefined()
      }
    })

    it('getInstanceByItemId handles malformed UUID', async () => {
      try {
        const result = await WorkflowService.getInstanceByItemId('not-a-uuid')
        expect(result).toBeNull()
      } catch (error) {
        // Malformed UUID may cause DB error
        expect(error).toBeDefined()
      }
    })

    it('startInstance with malformed workflow ID throws', async () => {
      await expect(
        WorkflowService.startInstance(
          'not-a-uuid',
          '00000000-0000-0000-0000-000000000001',
        ),
      ).rejects.toThrow()
    })

    it('update with malformed UUID throws', async () => {
      await expect(
        WorkflowService.update('not-a-uuid', { name: 'Test' }),
      ).rejects.toThrow()
    })

    it('delete with malformed UUID throws', async () => {
      await expect(WorkflowService.delete('not-a-uuid')).rejects.toThrow()
    })
  })

  describe('History Edge Cases', () => {
    it('history maintains correct chronological order', async () => {
      const workflow = await WorkflowService.create({
        name: `History Order ${testPrefix}`,
        lifecycleType: 'Driving',
        workflowType: 'strict',
        states: [
          { id: 'a', name: 'A', color: 'gray', isInitial: true },
          { id: 'b', name: 'B', color: 'yellow' },
          { id: 'c', name: 'C', color: 'blue' },
          {
            id: 'd',
            name: 'D',
            color: 'green',
            isFinal: true,
            finalKind: 'release' as const,
          },
        ],
        transitions: [
          { id: 't1', name: 'A to B', fromStateId: 'a', toStateId: 'b' },
          { id: 't2', name: 'B to C', fromStateId: 'b', toStateId: 'c' },
          { id: 't3', name: 'C to D', fromStateId: 'c', toStateId: 'd' },
        ],
      })

      const user = await insertTestUser(testDb.db, {
        name: 'History Order User',
      })
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })
      const instance = await WorkflowService.startInstance(
        workflow.id,
        item.id,
        { actorId: user.id },
      )

      await WorkflowService.transition(instance.id, 'b', user.id)
      await WorkflowService.transition(instance.id, 'c', user.id)
      await WorkflowService.transition(instance.id, 'd', user.id)

      const history = await WorkflowService.getHistory(instance.id)

      // Verify chronological order (most recent first or oldest first depending on implementation)
      const timestamps = history.map((h) => new Date(h.timestamp).getTime())
      const sorted = [...timestamps].sort((a, b) => b - a) // Most recent first
      expect(timestamps).toEqual(sorted)
    })

    it('history stores comments when provided', async () => {
      const workflow = await WorkflowService.create({
        name: `History Comments ${testPrefix}`,
        lifecycleType: 'Driving',
        workflowType: 'strict',
        states: [
          { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
          { id: 'review', name: 'Review', color: 'yellow' },
          {
            id: 'done',
            name: 'Done',
            color: 'green',
            isFinal: true,
            finalKind: 'release' as const,
          },
        ],
        transitions: [
          {
            id: 't1',
            name: 'Submit',
            fromStateId: 'draft',
            toStateId: 'review',
          },
          {
            id: 't2',
            name: 'Approve',
            fromStateId: 'review',
            toStateId: 'done',
          },
        ],
      })

      const user = await insertTestUser(testDb.db, {
        name: 'History Comments User',
      })
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })
      const instance = await WorkflowService.startInstance(
        workflow.id,
        item.id,
        { actorId: user.id },
      )

      await WorkflowService.transition(
        instance.id,
        'review',
        user.id,
        'Ready for review!',
      )
      await WorkflowService.transition(
        instance.id,
        'done',
        user.id,
        'Approved by manager',
      )

      const history = await WorkflowService.getHistory(instance.id)

      // History should have entries for the transitions
      expect(history.length).toBeGreaterThanOrEqual(2)
    })

    it('getHistory for non-existent instance returns empty array', async () => {
      const history = await WorkflowService.getHistory(
        '00000000-0000-0000-0000-000000000000',
      )
      expect(history).toEqual([])
    })
  })

  describe('Validation Edge Cases', () => {
    it('validates workflow with only initial state (no final)', () => {
      const input = {
        name: `No Final ${testPrefix}`,
        definitionType: 'workflow' as const,
        workflowType: 'strict' as const,
        states: [
          { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
        ],
        transitions: [],
      }

      const result = WorkflowService.validateDefinition(input)

      expect(result.valid).toBe(true)
      expect(result.warnings.some((w) => w.code === 'NO_FINAL_STATE')).toBe(
        true,
      )
    })

    it('validates workflow with multiple final states', () => {
      const input = {
        name: `Multiple Finals ${testPrefix}`,
        definitionType: 'workflow' as const,
        workflowType: 'strict' as const,
        states: [
          { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
          {
            id: 'approved',
            name: 'Approved',
            color: 'green',
            isFinal: true,
            finalKind: 'release' as const,
          },
          {
            id: 'rejected',
            name: 'Rejected',
            color: 'red',
            isFinal: true,
            finalKind: 'cancel' as const,
          },
        ],
        transitions: [
          {
            id: 't1',
            name: 'Approve',
            fromStateId: 'draft',
            toStateId: 'approved',
          },
          {
            id: 't2',
            name: 'Reject',
            fromStateId: 'draft',
            toStateId: 'rejected',
          },
        ],
      }

      const result = WorkflowService.validateDefinition(input)

      expect(result.valid).toBe(true)
      // Multiple finals should be acceptable
      expect(result.errors).toHaveLength(0)
    })

    it('handles duplicate transition IDs', async () => {
      const input = {
        name: `Duplicate Trans ${testPrefix}`,
        definitionType: 'workflow' as const,
        workflowType: 'strict' as const,
        states: [
          { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
          { id: 'review', name: 'Review', color: 'yellow' },
          {
            id: 'done',
            name: 'Done',
            color: 'green',
            isFinal: true,
            finalKind: 'release' as const,
          },
        ],
        transitions: [
          {
            id: 't1',
            name: 'Submit',
            fromStateId: 'draft',
            toStateId: 'review',
          },
          {
            id: 't1',
            name: 'Approve',
            fromStateId: 'review',
            toStateId: 'done',
          }, // Duplicate ID
        ],
      }

      try {
        const result = await WorkflowService.create(input)
        // If accepted, transitions might be deduplicated or overwritten
        expect(result.transitions?.length ?? 0).toBeLessThanOrEqual(2)
      } catch (error) {
        // Expected to reject duplicate IDs
        expect(error).toBeDefined()
      }
    })
  })

  describe('List Filtering Edge Cases', () => {
    it('list with both filters returns intersection', async () => {
      await WorkflowService.create({
        name: `Filter Test A ${testPrefix}`,
        lifecycleType: 'Driving',
        workflowType: 'strict',
        isActive: true,
        states: [
          { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
        ],
        transitions: [],
      })

      await WorkflowService.create({
        name: `Filter Test B ${testPrefix}`,
        lifecycleType: 'Driven',
        workflowType: 'strict',
        isActive: true,
        states: [
          { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
        ],
        transitions: [],
      })

      await WorkflowService.create({
        name: `Filter Test C ${testPrefix}`,
        lifecycleType: 'Driving',
        workflowType: 'strict',
        isActive: false,
        states: [
          { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
        ],
        transitions: [],
      })

      const results = await WorkflowService.list({
        kind: 'workflow',
        isActive: true,
      })

      // Should only return active workflows (not lifecycles, not inactive)
      expect(
        results.every(
          (w) => resolveLifecycleType(w) === 'Driving' && w.isActive,
        ),
      ).toBe(true)
    })

    it('list returns empty array when no matches', async () => {
      // Create only workflow type
      await WorkflowService.create({
        name: `Only Workflow ${testPrefix}`,
        lifecycleType: 'Driving',
        workflowType: 'strict',
        isActive: true,
        states: [
          { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
        ],
        transitions: [],
      })

      // Filter for lifecycles that are inactive - should be empty if none exist
      const results = await WorkflowService.list({
        kind: 'lifecycle',
        isActive: false,
      })

      // May or may not be empty depending on existing data, but should not error
      expect(Array.isArray(results)).toBe(true)
    })
  })

  describe('Inactive Workflow Handling', () => {
    it('can start instance on inactive workflow', async () => {
      const workflow = await WorkflowService.create({
        name: `Inactive Workflow ${testPrefix}`,
        lifecycleType: 'Driving',
        workflowType: 'strict',
        isActive: false,
        states: [
          { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
          {
            id: 'done',
            name: 'Done',
            color: 'green',
            isFinal: true,
            finalKind: 'release' as const,
          },
        ],
        transitions: [
          {
            id: 't1',
            name: 'Complete',
            fromStateId: 'draft',
            toStateId: 'done',
          },
        ],
      })

      const user = await insertTestUser(testDb.db, { name: 'Inactive WF User' })
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })

      // Should still be able to start instance (isActive is for discoverability, not enforcement)
      const instance = await WorkflowService.startInstance(
        workflow.id,
        item.id,
        { actorId: user.id },
      )
      expect(instance).toBeDefined()
      expect(instance.currentState).toBe('draft')
    })
  })
})

// validateStateRemoval Tests
describe('WorkflowService validateStateRemoval', () => {
  const testDb = new TestDatabase()
  let testPrefix: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    testPrefix = `VSR-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  it('returns valid when no states are being removed', async () => {
    const currentStates = [
      { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
      {
        id: 'done',
        name: 'Done',
        color: 'green',
        isFinal: true,
        finalKind: 'release' as const,
      },
    ]
    const newStates = [
      { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
      {
        id: 'done',
        name: 'Done',
        color: 'green',
        isFinal: true,
        finalKind: 'release' as const,
      },
    ]

    const result = await WorkflowService.validateStateRemoval(
      'any-id',
      currentStates,
      newStates,
    )

    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('returns valid when states are added (not removed)', async () => {
    const currentStates = [
      { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
    ]
    const newStates = [
      { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
      { id: 'review', name: 'Review', color: 'yellow' },
      {
        id: 'done',
        name: 'Done',
        color: 'green',
        isFinal: true,
        finalKind: 'release' as const,
      },
    ]

    const result = await WorkflowService.validateStateRemoval(
      'any-id',
      currentStates,
      newStates,
    )

    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('returns valid when removing states from unused lifecycle', async () => {
    // Create a lifecycle that is not used by any item type
    const lifecycle = await WorkflowService.create({
      name: `Unused Lifecycle ${testPrefix}`,
      lifecycleType: 'Driven',
      workflowType: 'strict',
      states: [
        { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
        { id: 'review', name: 'Review', color: 'yellow' },
        {
          id: 'done',
          name: 'Done',
          color: 'green',
          isFinal: true,
          finalKind: 'release' as const,
        },
      ],
      transitions: [],
    })

    const currentStates = lifecycle.states
    const newStates = [
      { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
      {
        id: 'done',
        name: 'Done',
        color: 'green',
        isFinal: true,
        finalKind: 'release' as const,
      },
    ]

    // Should be valid because no item types use this lifecycle
    const result = await WorkflowService.validateStateRemoval(
      lifecycle.id,
      currentStates,
      newStates,
    )

    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })
})

// Transition with Guards Tests
describe('WorkflowService Transition Guards', () => {
  const testDb = new TestDatabase()
  let testPrefix: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    testPrefix = `TG-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  function uniqueItemNumber(): string {
    return `${testPrefix}-${Math.random().toString(36).slice(2, 6)}`
  }

  it('blocks transition when field_value guard fails', async () => {
    const workflow = await WorkflowService.create({
      name: `Guarded Workflow ${testPrefix}`,
      lifecycleType: 'Driving',
      workflowType: 'strict',
      states: [
        { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
        { id: 'review', name: 'Review', color: 'yellow' },
        {
          id: 'done',
          name: 'Done',
          color: 'green',
          isFinal: true,
          finalKind: 'release' as const,
        },
      ],
      transitions: [
        {
          id: 't1',
          name: 'Submit',
          fromStateId: 'draft',
          toStateId: 'review',
          guards: [
            {
              id: 'g1',
              name: 'Description Required',
              type: 'field_value',
              config: {
                fieldName: 'description',
                operator: 'is_not_empty',
              },
              errorMessage: 'Description is required to submit',
            },
          ],
        },
        { id: 't2', name: 'Approve', fromStateId: 'review', toStateId: 'done' },
      ],
    })

    const user = await insertTestUser(testDb.db, { name: 'Guard Test User' })
    const { item } = await insertTestPart(testDb.db, null, user.id, {
      itemNumber: uniqueItemNumber(),
      description: '', // Empty description - guard should fail
    })

    const instance = await WorkflowService.startInstance(workflow.id, item.id, {
      actorId: user.id,
    })

    // Check canTransition returns not allowed
    const canResult = await WorkflowService.canTransition(
      instance.id,
      'review',
      {
        item: { description: '' },
        user: { id: user.id, roles: [] },
      },
    )

    expect(canResult.allowed).toBe(false)
    expect(canResult.reasons.some((r) => r.includes('Description'))).toBe(true)
  })

  it('allows transition when field_value guard passes', async () => {
    const workflow = await WorkflowService.create({
      name: `Guarded Workflow Pass ${testPrefix}`,
      lifecycleType: 'Driving',
      workflowType: 'strict',
      states: [
        { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
        { id: 'review', name: 'Review', color: 'yellow' },
        {
          id: 'done',
          name: 'Done',
          color: 'green',
          isFinal: true,
          finalKind: 'release' as const,
        },
      ],
      transitions: [
        {
          id: 't1',
          name: 'Submit',
          fromStateId: 'draft',
          toStateId: 'review',
          guards: [
            {
              id: 'g1',
              name: 'Description Required',
              type: 'field_value',
              config: {
                fieldName: 'description',
                operator: 'is_not_empty',
              },
              errorMessage: 'Description is required',
            },
          ],
        },
        { id: 't2', name: 'Approve', fromStateId: 'review', toStateId: 'done' },
      ],
    })

    const user = await insertTestUser(testDb.db, { name: 'Guard Pass User' })
    const { item } = await insertTestPart(testDb.db, null, user.id, {
      itemNumber: uniqueItemNumber(),
      description: 'Valid description here',
    })

    const instance = await WorkflowService.startInstance(workflow.id, item.id, {
      actorId: user.id,
    })

    const canResult = await WorkflowService.canTransition(
      instance.id,
      'review',
      {
        item: { description: 'Valid description here' },
        user: { id: user.id, roles: [] },
      },
    )

    expect(canResult.allowed).toBe(true)
  })

  it('blocks transition when user_role guard fails', async () => {
    const workflow = await WorkflowService.create({
      name: `Role Guard Workflow ${testPrefix}`,
      lifecycleType: 'Driving',
      workflowType: 'strict',
      states: [
        { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
        {
          id: 'approved',
          name: 'Approved',
          color: 'green',
          isFinal: true,
          finalKind: 'release' as const,
        },
      ],
      transitions: [
        {
          id: 't1',
          name: 'Approve',
          fromStateId: 'draft',
          toStateId: 'approved',
          guards: [
            {
              id: 'g1',
              name: 'Requires Admin',
              type: 'user_role',
              config: {
                requiredRoles: ['admin'],
                requireAll: false,
              },
              errorMessage: 'Only admins can approve',
            },
          ],
        },
      ],
    })

    const user = await insertTestUser(testDb.db, { name: 'Non-Admin User' })
    const { item } = await insertTestPart(testDb.db, null, user.id, {
      itemNumber: uniqueItemNumber(),
    })

    const instance = await WorkflowService.startInstance(workflow.id, item.id, {
      actorId: user.id,
    })

    // User has no roles - guard should fail
    const canResult = await WorkflowService.canTransition(
      instance.id,
      'approved',
      {
        item: {},
        user: { id: user.id, roles: [] },
      },
    )

    expect(canResult.allowed).toBe(false)
    expect(canResult.reasons.some((r) => r.includes('admin'))).toBe(true)
  })

  it('allows transition when user has required role', async () => {
    const workflow = await WorkflowService.create({
      name: `Role Guard Pass ${testPrefix}`,
      lifecycleType: 'Driving',
      workflowType: 'strict',
      states: [
        { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
        {
          id: 'approved',
          name: 'Approved',
          color: 'green',
          isFinal: true,
          finalKind: 'release' as const,
        },
      ],
      transitions: [
        {
          id: 't1',
          name: 'Approve',
          fromStateId: 'draft',
          toStateId: 'approved',
          guards: [
            {
              id: 'g1',
              name: 'Requires Reviewer',
              type: 'user_role',
              config: {
                requiredRoles: ['reviewer', 'admin'],
                requireAll: false,
              },
              errorMessage: 'Requires reviewer or admin role',
            },
          ],
        },
      ],
    })

    const user = await insertTestUser(testDb.db, { name: 'Admin User' })
    const { item } = await insertTestPart(testDb.db, null, user.id, {
      itemNumber: uniqueItemNumber(),
    })

    const instance = await WorkflowService.startInstance(workflow.id, item.id, {
      actorId: user.id,
    })

    const canResult = await WorkflowService.canTransition(
      instance.id,
      'approved',
      {
        item: {},
        user: { id: user.id, roles: ['admin'] },
      },
    )

    expect(canResult.allowed).toBe(true)
  })

  it('evaluates multiple guards - all must pass', async () => {
    const workflow = await WorkflowService.create({
      name: `Multi Guard Workflow ${testPrefix}`,
      lifecycleType: 'Driving',
      workflowType: 'strict',
      states: [
        { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
        {
          id: 'approved',
          name: 'Approved',
          color: 'green',
          isFinal: true,
          finalKind: 'release' as const,
        },
      ],
      transitions: [
        {
          id: 't1',
          name: 'Approve',
          fromStateId: 'draft',
          toStateId: 'approved',
          guards: [
            {
              id: 'g1',
              name: 'Description Required',
              type: 'field_value',
              config: { fieldName: 'description', operator: 'is_not_empty' },
              errorMessage: 'Description required',
            },
            {
              id: 'g2',
              name: 'Requires Admin',
              type: 'user_role',
              config: { requiredRoles: ['admin'], requireAll: false },
              errorMessage: 'Admin only',
            },
          ],
        },
      ],
    })

    const user = await insertTestUser(testDb.db, { name: 'Multi Guard User' })
    const { item } = await insertTestPart(testDb.db, null, user.id, {
      itemNumber: uniqueItemNumber(),
    })

    const instance = await WorkflowService.startInstance(workflow.id, item.id, {
      actorId: user.id,
    })

    // Both guards pass
    const canResult = await WorkflowService.canTransition(
      instance.id,
      'approved',
      {
        item: { description: 'Valid' },
        user: { id: user.id, roles: ['admin'] },
      },
    )

    expect(canResult.allowed).toBe(true)

    // One guard fails (no description)
    const canResultFail = await WorkflowService.canTransition(
      instance.id,
      'approved',
      {
        item: { description: '' },
        user: { id: user.id, roles: ['admin'] },
      },
    )

    expect(canResultFail.allowed).toBe(false)
  })
})

// Transition Actions Tests - tests for executeUpdateField and executeSendNotification
describe('WorkflowService Transition Actions', () => {
  const testDb = new TestDatabase()
  let testPrefix: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    testPrefix = `TA-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  function uniqueItemNumber(): string {
    return `${testPrefix}-${Math.random().toString(36).slice(2, 6)}`
  }

  describe('update_field action', () => {
    it('executes update_field action on transition', async () => {
      const workflow = await WorkflowService.create({
        name: `Update Field Workflow ${testPrefix}`,
        lifecycleType: 'Driving',
        workflowType: 'strict',
        states: [
          { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
          { id: 'review', name: 'Review', color: 'blue' },
        ],
        transitions: [
          {
            id: 't1',
            name: 'Submit for Review',
            fromStateId: 'draft',
            toStateId: 'review',
            actions: [
              {
                id: 'a1',
                name: 'Update Name',
                type: 'update_field',
                executeOn: 'after',
                config: {
                  fieldName: 'name',
                  value: 'Reviewed Item',
                },
              },
            ],
          },
        ],
      })

      const user = await insertTestUser(testDb.db, { name: 'Action User' })
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
        name: 'Original Name',
      })

      const instance = await WorkflowService.startInstance(
        workflow.id,
        item.id,
        { actorId: user.id },
      )

      const result = await WorkflowService.transition(
        instance.id,
        'review',
        user.id,
      )

      expect(result.success).toBe(true)
      expect(result.actionResults).toBeDefined()
    })

    it('executes before action before state change', async () => {
      const workflow = await WorkflowService.create({
        name: `Before Action Workflow ${testPrefix}`,
        lifecycleType: 'Driving',
        workflowType: 'strict',
        states: [
          { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
          {
            id: 'done',
            name: 'Done',
            color: 'green',
            isFinal: true,
            finalKind: 'release' as const,
          },
        ],
        transitions: [
          {
            id: 't1',
            name: 'Complete',
            fromStateId: 'draft',
            toStateId: 'done',
            actions: [
              {
                id: 'a1',
                name: 'Pre-process',
                type: 'update_field',
                executeOn: 'before',
                config: {
                  fieldName: 'name',
                  value: 'Processed before transition',
                },
              },
            ],
          },
        ],
      })

      const user = await insertTestUser(testDb.db, {
        name: 'Before Action User',
      })
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })

      const instance = await WorkflowService.startInstance(
        workflow.id,
        item.id,
        { actorId: user.id },
      )

      const result = await WorkflowService.transition(
        instance.id,
        'done',
        user.id,
      )

      expect(result.success).toBe(true)
      expect(result.actionResults?.length).toBeGreaterThanOrEqual(1)
      expect(
        result.actionResults?.some((a) => a.actionName === 'Pre-process'),
      ).toBe(true)
    })

    it('fails transition when before action fails', async () => {
      // Raw insert: create() rejects non-allowlisted update_field columns at
      // save time (UPDATE_FIELD_NOT_ALLOWED), so bypass it to prove the
      // RUNTIME allowlist also blocks and fails the before-action
      const workflow = takeFirst(
        await testDb.db
          .insert(workflowDefinitions)
          .values({
            name: `Failing Before Action ${testPrefix}`,
            version: 1,
            workflowType: 'strict',
            isActive: true,
            definition: {
              definitionType: 'workflow',
              states: [
                { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
                {
                  id: 'done',
                  name: 'Done',
                  color: 'green',
                  isFinal: true,
                  finalKind: 'release',
                },
              ],
              transitions: [
                {
                  id: 't1',
                  name: 'Complete',
                  fromStateId: 'draft',
                  toStateId: 'done',
                  actions: [
                    {
                      id: 'a1',
                      name: 'Bad Action',
                      type: 'update_field',
                      executeOn: 'before',
                      config: {
                        fieldName: 'nonexistent_column_xyz_123', // Not allowlisted
                        value: 'test',
                      },
                    },
                  ],
                },
              ],
            },
          })
          .returning({ id: workflowDefinitions.id }),
      )

      const user = await insertTestUser(testDb.db, {
        name: 'Failing Action User',
      })
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })

      const instance = await WorkflowService.startInstance(
        workflow.id,
        item.id,
        { actorId: user.id },
      )

      const result = await WorkflowService.transition(
        instance.id,
        'done',
        user.id,
      )

      // Before action failure should fail the entire transition
      expect(result.success).toBe(false)
      expect(result.error).toContain('Before action')
    })

    it('continues transition when after action fails (non-blocking)', async () => {
      // Raw insert to bypass save-time validation — see the before-action
      // test above; the runtime allowlist fails the after-action instead
      const workflow = takeFirst(
        await testDb.db
          .insert(workflowDefinitions)
          .values({
            name: `Failing After Action ${testPrefix}`,
            version: 1,
            workflowType: 'strict',
            isActive: true,
            definition: {
              definitionType: 'workflow',
              states: [
                { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
                {
                  id: 'done',
                  name: 'Done',
                  color: 'green',
                  isFinal: true,
                  finalKind: 'release',
                },
              ],
              transitions: [
                {
                  id: 't1',
                  name: 'Complete',
                  fromStateId: 'draft',
                  toStateId: 'done',
                  actions: [
                    {
                      id: 'a1',
                      name: 'Bad After Action',
                      type: 'update_field',
                      executeOn: 'after',
                      config: {
                        fieldName: 'nonexistent_column_xyz_123',
                        value: 'test',
                      },
                    },
                  ],
                },
              ],
            },
          })
          .returning({ id: workflowDefinitions.id }),
      )

      const user = await insertTestUser(testDb.db, {
        name: 'After Action User',
      })
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })

      const instance = await WorkflowService.startInstance(
        workflow.id,
        item.id,
        { actorId: user.id },
      )

      const result = await WorkflowService.transition(
        instance.id,
        'done',
        user.id,
      )

      // After action failures should not fail the transition
      expect(result.success).toBe(true)
      // But action result should show failure
      const failedAction = result.actionResults?.find(
        (a) => a.actionName === 'Bad After Action',
      )
      expect(failedAction?.success).toBe(false)
    })

    it('executes multiple actions in order', async () => {
      const workflow = await WorkflowService.create({
        name: `Multi Action Workflow ${testPrefix}`,
        lifecycleType: 'Driving',
        workflowType: 'strict',
        states: [
          { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
          {
            id: 'done',
            name: 'Done',
            color: 'green',
            isFinal: true,
            finalKind: 'release' as const,
          },
        ],
        transitions: [
          {
            id: 't1',
            name: 'Complete',
            fromStateId: 'draft',
            toStateId: 'done',
            actions: [
              {
                id: 'a1',
                name: 'Before Action 1',
                type: 'update_field',
                executeOn: 'before',
                config: { fieldName: 'name', value: 'First' },
              },
              {
                id: 'a2',
                name: 'Before Action 2',
                type: 'update_field',
                executeOn: 'before',
                config: { fieldName: 'name', value: 'Second' },
              },
              {
                id: 'a3',
                name: 'After Action 1',
                type: 'update_field',
                executeOn: 'after',
                config: { fieldName: 'name', value: 'Third' },
              },
            ],
          },
        ],
      })

      const user = await insertTestUser(testDb.db, {
        name: 'Multi Action User',
      })
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })

      const instance = await WorkflowService.startInstance(
        workflow.id,
        item.id,
        { actorId: user.id },
      )

      const result = await WorkflowService.transition(
        instance.id,
        'done',
        user.id,
      )

      expect(result.success).toBe(true)
      expect(result.actionResults?.length).toBe(3)
    })
  })

  describe('unknown action type', () => {
    it('handles unknown action type gracefully at runtime', async () => {
      // Raw insert: create() rejects unknown action types at save time
      // (UNKNOWN_ACTION_TYPE), so bypass it to prove raw JSONB with a
      // retired/unknown type fails the action, not the transition
      const workflow = takeFirst(
        await testDb.db
          .insert(workflowDefinitions)
          .values({
            name: `Unknown Action Workflow ${testPrefix}`,
            version: 1,
            workflowType: 'strict',
            isActive: true,
            lifecycleType: 'Driving',
            definition: {
              lifecycleType: 'Driving',
              states: [
                { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
                {
                  id: 'done',
                  name: 'Done',
                  color: 'green',
                  isFinal: true,
                  finalKind: 'release',
                },
              ],
              transitions: [
                {
                  id: 't1',
                  name: 'Complete',
                  fromStateId: 'draft',
                  toStateId: 'done',
                  actions: [
                    {
                      id: 'a1',
                      name: 'Unknown Action',
                      type: 'unknown_type_xyz',
                      executeOn: 'after',
                      config: {},
                    },
                  ],
                },
              ],
            },
          })
          .returning(),
      )

      const user = await insertTestUser(testDb.db, {
        name: 'Unknown Action User',
      })
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })

      const instance = await WorkflowService.startInstance(
        workflow.id,
        item.id,
        { actorId: user.id },
      )

      const result = await WorkflowService.transition(
        instance.id,
        'done',
        user.id,
      )

      // Unknown action types should not crash; the after-action records
      // its failure and the transition itself succeeds
      expect(result.success).toBe(true)
      const actionResult = result.actionResults?.find(
        (r) => r.actionId === 'a1',
      )
      expect(actionResult?.success).toBe(false)
    })
  })

  describe('retired knobs are rejected at save', () => {
    it('rejects create_task actions and approval_count guards', async () => {
      const base = {
        workflowType: 'strict' as const,
        lifecycleType: 'Driving' as const,
        states: [
          { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
          {
            id: 'done',
            name: 'Done',
            color: 'green',
            isFinal: true,
            finalKind: 'release' as const,
          },
        ],
      }

      await expect(
        WorkflowService.create({
          ...base,
          name: `Create Task Workflow ${testPrefix}`,
          transitions: [
            {
              id: 't1',
              name: 'Complete',
              fromStateId: 'draft',
              toStateId: 'done',
              actions: [
                {
                  id: 'a1',
                  name: 'Create Review Task',
                  type: 'create_task' as unknown as 'update_field',
                  executeOn: 'after',
                  config: {} as TransitionAction['config'],
                },
              ],
            },
          ],
        }),
      ).rejects.toThrow(/unsupported type "create_task"/)

      await expect(
        WorkflowService.create({
          ...base,
          name: `Approval Count Workflow ${testPrefix}`,
          transitions: [
            {
              id: 't1',
              name: 'Complete',
              fromStateId: 'draft',
              toStateId: 'done',
              guards: [
                {
                  id: 'g1',
                  name: 'Two Approvals',
                  type: 'approval_count' as unknown as 'user_role',
                  config: { requiredRoles: [] },
                },
              ],
            },
          ],
        }),
      ).rejects.toThrow(/unsupported type "approval_count"/)
    })
  })
})

// send_notification Action Tests
describe('WorkflowService send_notification Action', () => {
  const testDb = new TestDatabase()
  let testPrefix: string

  beforeAll(async () => {
    await testDb.setup()
    // Register job type definitions for notification handling
    await import('../jobs/definitions/register')
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    testPrefix = `SN-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  function uniqueItemNumber(): string {
    return `${testPrefix}-${Math.random().toString(36).slice(2, 6)}`
  }

  function uniqueEmail(base = 'test') {
    return `${base}-${testPrefix}@test.com`
  }

  it('handles send_notification with no recipients configured', async () => {
    const workflow = await WorkflowService.create({
      name: `Empty Notify Workflow ${testPrefix}`,
      lifecycleType: 'Driving',
      workflowType: 'strict',
      states: [
        { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
        {
          id: 'done',
          name: 'Done',
          color: 'green',
          isFinal: true,
          finalKind: 'release' as const,
        },
      ],
      transitions: [
        {
          id: 't1',
          name: 'Complete',
          fromStateId: 'draft',
          toStateId: 'done',
          actions: [
            {
              id: 'a1',
              name: 'Empty Notify',
              type: 'send_notification',
              executeOn: 'after',
              config: {
                recipients: [],
                templateId: 'workflow_transition',
              },
            },
          ],
        },
      ],
    })

    const user = await insertTestUser(testDb.db, { name: 'Empty Notify User' })
    const { item } = await insertTestPart(testDb.db, null, user.id, {
      itemNumber: uniqueItemNumber(),
    })

    const instance = await WorkflowService.startInstance(workflow.id, item.id, {
      actorId: user.id,
    })

    const result = await WorkflowService.transition(
      instance.id,
      'done',
      user.id,
    )

    // Should succeed - empty recipients means no notifications
    expect(result.success).toBe(true)
  })

  it('handles send_notification with user recipients', async () => {
    const recipientUser = await insertTestUser(testDb.db, {
      name: 'Recipient User',
      email: uniqueEmail('recipient'),
    })

    const workflow = await WorkflowService.create({
      name: `User Notify Workflow ${testPrefix}`,
      lifecycleType: 'Driving',
      workflowType: 'strict',
      states: [
        { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
        {
          id: 'done',
          name: 'Done',
          color: 'green',
          isFinal: true,
          finalKind: 'release' as const,
        },
      ],
      transitions: [
        {
          id: 't1',
          name: 'Complete',
          fromStateId: 'draft',
          toStateId: 'done',
          actions: [
            {
              id: 'a1',
              name: 'Notify User',
              type: 'send_notification',
              executeOn: 'after',
              config: {
                recipients: [{ type: 'user', id: recipientUser.id }],
                templateId: 'workflow_transition',
              },
            },
          ],
        },
      ],
    })

    const actorUser = await insertTestUser(testDb.db, { name: 'Actor User' })
    const { item } = await insertTestPart(testDb.db, null, actorUser.id, {
      itemNumber: uniqueItemNumber(),
    })

    const instance = await WorkflowService.startInstance(workflow.id, item.id, {
      actorId: actorUser.id,
    })

    const result = await WorkflowService.transition(
      instance.id,
      'done',
      actorUser.id,
    )

    expect(result.success).toBe(true)
  })

  it('handles send_notification when item not found', async () => {
    const { items: itemsTable } = await import('../db/schema')
    const { eq: eqFn } = await import('drizzle-orm')

    const workflow = await WorkflowService.create({
      name: `Missing Item Notify ${testPrefix}`,
      lifecycleType: 'Driving',
      workflowType: 'strict',
      states: [
        { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
        {
          id: 'done',
          name: 'Done',
          color: 'green',
          isFinal: true,
          finalKind: 'release' as const,
        },
      ],
      transitions: [
        {
          id: 't1',
          name: 'Complete',
          fromStateId: 'draft',
          toStateId: 'done',
          actions: [
            {
              id: 'a1',
              name: 'Notify',
              type: 'send_notification',
              executeOn: 'after',
              config: {
                recipients: [
                  { type: 'user', id: '00000000-0000-0000-0000-000000000001' },
                ],
                templateId: 'workflow_transition',
              },
            },
          ],
        },
      ],
    })

    const user = await insertTestUser(testDb.db, { name: 'Missing Item User' })
    const { item } = await insertTestPart(testDb.db, null, user.id, {
      itemNumber: uniqueItemNumber(),
    })

    const instance = await WorkflowService.startInstance(workflow.id, item.id, {
      actorId: user.id,
    })

    // Delete the item to simulate "item not found" scenario
    await testDb.db.delete(itemsTable).where(eqFn(itemsTable.id, item.id))

    const result = await WorkflowService.transition(
      instance.id,
      'done',
      user.id,
    )

    // Transition handles missing item gracefully (after action is non-blocking)
    expect(result).toBeDefined()
  })

  it('handles send_notification with role recipients', async () => {
    // Create a role and user with that role
    const { roles, userRoles } = await import('../db/schema')
    const testRole = takeFirst(
      await testDb.db
        .insert(roles)
        .values({
          name: `notif-role-${testPrefix}`,
          description: 'Test notification role',
        })
        .returning(),
    )

    const roleUser = await insertTestUser(testDb.db, {
      name: 'Role User',
      email: uniqueEmail('roleuser'),
    })
    await testDb.db.insert(userRoles).values({
      userId: roleUser.id,
      roleId: testRole.id,
    })

    const workflow = await WorkflowService.create({
      name: `Role Notify Workflow ${testPrefix}`,
      lifecycleType: 'Driving',
      workflowType: 'strict',
      states: [
        { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
        {
          id: 'done',
          name: 'Done',
          color: 'green',
          isFinal: true,
          finalKind: 'release' as const,
        },
      ],
      transitions: [
        {
          id: 't1',
          name: 'Complete',
          fromStateId: 'draft',
          toStateId: 'done',
          actions: [
            {
              id: 'a1',
              name: 'Notify Role',
              type: 'send_notification',
              executeOn: 'after',
              config: {
                recipients: [{ type: 'role', id: testRole.id }],
                templateId: 'workflow_transition',
              },
            },
          ],
        },
      ],
    })

    const actorUser = await insertTestUser(testDb.db, { name: 'Role Actor' })
    const { item } = await insertTestPart(testDb.db, null, actorUser.id, {
      itemNumber: uniqueItemNumber(),
    })

    const instance = await WorkflowService.startInstance(workflow.id, item.id, {
      actorId: actorUser.id,
    })

    const result = await WorkflowService.transition(
      instance.id,
      'done',
      actorUser.id,
    )

    expect(result.success).toBe(true)
  })

  it('skips notification when actor is the only recipient', async () => {
    const user = await insertTestUser(testDb.db, {
      name: 'Solo User',
      email: uniqueEmail('solo-actor'),
    })

    const workflow = await WorkflowService.create({
      name: `Self Notify Workflow ${testPrefix}`,
      lifecycleType: 'Driving',
      workflowType: 'strict',
      states: [
        { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
        {
          id: 'done',
          name: 'Done',
          color: 'green',
          isFinal: true,
          finalKind: 'release' as const,
        },
      ],
      transitions: [
        {
          id: 't1',
          name: 'Complete',
          fromStateId: 'draft',
          toStateId: 'done',
          actions: [
            {
              id: 'a1',
              name: 'Self Notify',
              type: 'send_notification',
              executeOn: 'after',
              config: {
                recipients: [{ type: 'user', id: user.id }],
                templateId: 'workflow_transition',
              },
            },
          ],
        },
      ],
    })

    const { item } = await insertTestPart(testDb.db, null, user.id, {
      itemNumber: uniqueItemNumber(),
    })

    const instance = await WorkflowService.startInstance(workflow.id, item.id, {
      actorId: user.id,
    })

    const result = await WorkflowService.transition(
      instance.id,
      'done',
      user.id,
    )

    // Should succeed - actor is filtered out from recipients
    expect(result.success).toBe(true)
  })
})

// Lifecycle Effects Tests

// send_notification Design Access Filtering Tests
describe('WorkflowService send_notification Design Access', () => {
  const testDb = new TestDatabase()
  let testPrefix: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    testPrefix = `SND-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  function uniqueItemNumber(): string {
    return `${testPrefix}-${Math.random().toString(36).slice(2, 6)}`
  }

  // Helper to create a program
  async function createTestProgram(userId: string, name = 'Test Program') {
    const { ProgramService } = await import('../services/ProgramService')
    const code =
      `PROG-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`.toUpperCase()
    return ProgramService.create({ name, code }, userId)
  }

  // Helper to create a design with default branch
  async function createTestDesign(userId: string, programId: string | null) {
    const { DesignService } = await import('../services/DesignService')
    const code =
      `DES-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`.toUpperCase()
    const design = await DesignService.create(
      {
        name: 'Test Design',
        code,
        designType: 'Engineering',
        programId,
      },
      userId,
    )
    expect(design).toBeDefined()
    return design
  }

  // Helper to generate unique email
  function uniqueEmail(base = 'test') {
    return `${base}-${testPrefix}@test.com`
  }

  it('filters out recipients without access to item design', async () => {
    // Create a program owner who will be the actor
    const programOwner = await insertTestUser(testDb.db, {
      name: 'Program Owner',
      email: uniqueEmail('owner'),
    })

    // Create a program and design
    const program = await createTestProgram(programOwner.id)
    const design = await createTestDesign(programOwner.id, program.id)

    // Create a recipient who is NOT a member of the program
    const nonMemberRecipient = await insertTestUser(testDb.db, {
      name: 'Non-Member',
      email: uniqueEmail('nonmember'),
    })

    // Create a recipient who IS a member
    const memberRecipient = await insertTestUser(testDb.db, {
      name: 'Member',
      email: uniqueEmail('member'),
    })
    // Add member to program
    const { programMembers } = await import('../db/schema')
    await testDb.db.insert(programMembers).values({
      programId: program.id,
      userId: memberRecipient.id,
      role: 'viewer',
    })

    const workflow = await WorkflowService.create({
      name: `Design Access Notify ${testPrefix}`,
      lifecycleType: 'Driving',
      workflowType: 'strict',
      states: [
        { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
        {
          id: 'done',
          name: 'Done',
          color: 'green',
          isFinal: true,
          finalKind: 'release' as const,
        },
      ],
      transitions: [
        {
          id: 't1',
          name: 'Complete',
          fromStateId: 'draft',
          toStateId: 'done',
          actions: [
            {
              id: 'a1',
              name: 'Notify Both',
              type: 'send_notification',
              executeOn: 'after',
              config: {
                recipients: [
                  { type: 'user', id: nonMemberRecipient.id },
                  { type: 'user', id: memberRecipient.id },
                ],
                templateId: 'workflow_transition',
              },
            },
          ],
        },
      ],
    })

    // Create an item associated with the design
    const { item } = await insertTestPart(
      testDb.db,
      design.id,
      programOwner.id,
      {
        itemNumber: uniqueItemNumber(),
      },
    )

    const instance = await WorkflowService.startInstance(workflow.id, item.id, {
      actorId: programOwner.id,
    })

    // Use programOwner as actor - they are a program member
    // nonMemberRecipient should be filtered out (no design access)
    // memberRecipient should receive notification (has design access)
    const result = await WorkflowService.transition(
      instance.id,
      'done',
      programOwner.id,
    )

    // Transition should succeed regardless of notification outcome
    expect(result.success).toBe(true)
    // Action should be attempted (after actions don't block transition)
    const notifyAction = result.actionResults?.find(
      (a) => a.actionName === 'Notify Both',
    )
    expect(notifyAction).toBeDefined()
  })

  it('skips all recipients when none have design access', async () => {
    // Create a program owner
    const programOwner = await insertTestUser(testDb.db, {
      name: 'Solo Owner',
      email: uniqueEmail('solo'),
    })

    // Create a program and design
    const program = await createTestProgram(programOwner.id)
    const design = await createTestDesign(programOwner.id, program.id)

    // Create recipients who are NOT members of the program
    const nonMember1 = await insertTestUser(testDb.db, {
      name: 'Non-Member 1',
      email: uniqueEmail('nonmember1'),
    })
    const nonMember2 = await insertTestUser(testDb.db, {
      name: 'Non-Member 2',
      email: uniqueEmail('nonmember2'),
    })

    const workflow = await WorkflowService.create({
      name: `No Access Notify ${testPrefix}`,
      lifecycleType: 'Driving',
      workflowType: 'strict',
      states: [
        { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
        {
          id: 'done',
          name: 'Done',
          color: 'green',
          isFinal: true,
          finalKind: 'release' as const,
        },
      ],
      transitions: [
        {
          id: 't1',
          name: 'Complete',
          fromStateId: 'draft',
          toStateId: 'done',
          actions: [
            {
              id: 'a1',
              name: 'Notify Non-Members',
              type: 'send_notification',
              executeOn: 'after',
              config: {
                recipients: [
                  { type: 'user', id: nonMember1.id },
                  { type: 'user', id: nonMember2.id },
                ],
                templateId: 'workflow_transition',
              },
            },
          ],
        },
      ],
    })

    // Create an item associated with the design
    const { item } = await insertTestPart(
      testDb.db,
      design.id,
      programOwner.id,
      {
        itemNumber: uniqueItemNumber(),
      },
    )

    const instance = await WorkflowService.startInstance(workflow.id, item.id, {
      actorId: programOwner.id,
    })

    const result = await WorkflowService.transition(
      instance.id,
      'done',
      programOwner.id,
    )

    // Transition should succeed - no recipients after filtering is not an error
    expect(result.success).toBe(true)
  })

  it('handles notification with non-existent user recipient gracefully', async () => {
    const workflow = await WorkflowService.create({
      name: `Missing Recipient ${testPrefix}`,
      lifecycleType: 'Driving',
      workflowType: 'strict',
      states: [
        { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
        {
          id: 'done',
          name: 'Done',
          color: 'green',
          isFinal: true,
          finalKind: 'release' as const,
        },
      ],
      transitions: [
        {
          id: 't1',
          name: 'Complete',
          fromStateId: 'draft',
          toStateId: 'done',
          actions: [
            {
              id: 'a1',
              name: 'Notify Missing',
              type: 'send_notification',
              executeOn: 'after',
              config: {
                recipients: [
                  { type: 'user', id: '00000000-0000-0000-0000-000000000099' },
                ],
                templateId: 'workflow_transition',
              },
            },
          ],
        },
      ],
    })

    const actorUser = await insertTestUser(testDb.db, { name: 'Actor User' })
    const { item } = await insertTestPart(testDb.db, null, actorUser.id, {
      itemNumber: uniqueItemNumber(),
    })

    const instance = await WorkflowService.startInstance(workflow.id, item.id, {
      actorId: actorUser.id,
    })

    const result = await WorkflowService.transition(
      instance.id,
      'done',
      actorUser.id,
    )

    // Transition should succeed (after action failures don't block transition)
    expect(result.success).toBe(true)
    // Action should complete (non-existent recipient is filtered out)
    const notifyAction = result.actionResults?.find(
      (a) => a.actionName === 'Notify Missing',
    )
    expect(notifyAction).toBeDefined()
  })

  it('handles notification with multiple valid recipients', async () => {
    const recipient1 = await insertTestUser(testDb.db, {
      name: 'Recipient 1',
      email: uniqueEmail('r1'),
    })
    const recipient2 = await insertTestUser(testDb.db, {
      name: 'Recipient 2',
      email: uniqueEmail('r2'),
    })

    const workflow = await WorkflowService.create({
      name: `Multi Recipient ${testPrefix}`,
      lifecycleType: 'Driving',
      workflowType: 'strict',
      states: [
        { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
        {
          id: 'done',
          name: 'Done',
          color: 'green',
          isFinal: true,
          finalKind: 'release' as const,
        },
      ],
      transitions: [
        {
          id: 't1',
          name: 'Complete',
          fromStateId: 'draft',
          toStateId: 'done',
          actions: [
            {
              id: 'a1',
              name: 'Notify Multiple',
              type: 'send_notification',
              executeOn: 'after',
              config: {
                recipients: [
                  { type: 'user', id: recipient1.id },
                  { type: 'user', id: recipient2.id },
                ],
                templateId: 'workflow_transition',
              },
            },
          ],
        },
      ],
    })

    const actorUser = await insertTestUser(testDb.db, { name: 'Actor' })
    const { item } = await insertTestPart(testDb.db, null, actorUser.id, {
      itemNumber: uniqueItemNumber(),
    })

    const instance = await WorkflowService.startInstance(workflow.id, item.id, {
      actorId: actorUser.id,
    })

    const result = await WorkflowService.transition(
      instance.id,
      'done',
      actorUser.id,
    )

    // Transition should succeed
    expect(result.success).toBe(true)
    // Notification action should be attempted (may fail if RabbitMQ not available)
    const notifyAction = result.actionResults?.find(
      (a) => a.actionName === 'Notify Multiple',
    )
    expect(notifyAction).toBeDefined()
  })

  it('filters out inactive users when notifying by role', async () => {
    const { roles, userRoles } = await import('../db/schema')

    // Create a role
    const testRole = takeFirst(
      await testDb.db
        .insert(roles)
        .values({
          name: `inactive-role-${testPrefix}`,
          description: 'Test role for inactive users',
        })
        .returning(),
    )

    // Create an active user with the role
    const activeUser = await insertTestUser(testDb.db, {
      name: 'Active Role User',
      email: uniqueEmail('active'),
    })
    await testDb.db.insert(userRoles).values({
      userId: activeUser.id,
      roleId: testRole.id,
    })

    // Create an inactive user with the role
    const inactiveUser = await insertTestUser(testDb.db, {
      name: 'Inactive Role User',
      email: uniqueEmail('inactive'),
    })
    const { users } = await import('../db/schema')
    await testDb.db
      .update(users)
      .set({ active: false })
      .where(eq(users.id, inactiveUser.id))
    await testDb.db.insert(userRoles).values({
      userId: inactiveUser.id,
      roleId: testRole.id,
    })

    const workflow = await WorkflowService.create({
      name: `Inactive Role Notify ${testPrefix}`,
      lifecycleType: 'Driving',
      workflowType: 'strict',
      states: [
        { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
        {
          id: 'done',
          name: 'Done',
          color: 'green',
          isFinal: true,
          finalKind: 'release' as const,
        },
      ],
      transitions: [
        {
          id: 't1',
          name: 'Complete',
          fromStateId: 'draft',
          toStateId: 'done',
          actions: [
            {
              id: 'a1',
              name: 'Notify Role',
              type: 'send_notification',
              executeOn: 'after',
              config: {
                recipients: [{ type: 'role', id: testRole.id }],
                templateId: 'workflow_transition',
              },
            },
          ],
        },
      ],
    })

    const actorUser = await insertTestUser(testDb.db, { name: 'Actor User' })
    const { item } = await insertTestPart(testDb.db, null, actorUser.id, {
      itemNumber: uniqueItemNumber(),
    })

    const instance = await WorkflowService.startInstance(workflow.id, item.id, {
      actorId: actorUser.id,
    })

    const result = await WorkflowService.transition(
      instance.id,
      'done',
      actorUser.id,
    )

    // Transition should succeed - inactive users filtered out
    expect(result.success).toBe(true)
  })

  // ==========================================================================
  // Flexible Workflows Tests
  // ==========================================================================

  describe('Flexible Workflows', () => {
    // Helper to create flexible workflow input
    function createFlexibleWorkflowInput(
      overrides?: Partial<CreateWorkflowInput>,
    ): CreateWorkflowInput {
      return {
        name: `Flexible Workflow ${testPrefix}-${Math.random().toString(36).slice(2, 8)}`,
        lifecycleType: 'Driving',
        workflowType: 'flexible',
        states: [
          {
            id: 'start',
            name: 'Start',
            color: 'gray',
            isInitial: true,
            position: { x: 100, y: 200 },
          },
          {
            id: 'complete',
            name: 'Complete',
            color: 'green',
            isFinal: true,
            finalKind: 'release' as const,
            position: { x: 400, y: 200 },
          },
        ],
        transitions: [
          {
            id: 't1',
            name: 'Complete',
            fromStateId: 'start',
            toStateId: 'complete',
          },
        ],
        ...overrides,
      }
    }

    // Helper to create strict workflow input for comparison tests
    function createStrictWorkflowInput(
      overrides?: Partial<CreateWorkflowInput>,
    ): CreateWorkflowInput {
      return {
        name: `Strict Workflow ${testPrefix}-${Math.random().toString(36).slice(2, 8)}`,
        lifecycleType: 'Driving',
        workflowType: 'strict',
        states: [
          { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
          { id: 'review', name: 'In Review', color: 'yellow' },
          {
            id: 'approved',
            name: 'Approved',
            color: 'green',
            isFinal: true,
            finalKind: 'release' as const,
          },
        ],
        transitions: [
          {
            id: 't1',
            name: 'Submit for Review',
            fromStateId: 'draft',
            toStateId: 'review',
          },
          {
            id: 't2',
            name: 'Approve',
            fromStateId: 'review',
            toStateId: 'approved',
          },
          {
            id: 't3',
            name: 'Reject',
            fromStateId: 'review',
            toStateId: 'draft',
          },
        ],
        ...overrides,
      }
    }

    describe('getEffectiveStructure', () => {
      it('returns definition structure for strict workflows', async () => {
        const workflow = await WorkflowService.create(
          createStrictWorkflowInput(),
        )
        const actorUser = await insertTestUser(testDb.db, {
          name: 'Test User',
        })
        const { item } = await insertTestPart(testDb.db, null, actorUser.id, {
          itemNumber: uniqueItemNumber(),
        })
        const instance = await WorkflowService.startInstance(
          workflow.id,
          item.id,
          { actorId: actorUser.id },
        )

        const structure = await WorkflowService.getEffectiveStructure(
          instance.id,
        )

        expect(structure.isInstanceLevel).toBe(false)
        expect(structure.canEdit).toBe(false)
        expect(structure.states).toHaveLength(3)
        expect(structure.transitions).toHaveLength(3)
      })

      it('returns instance structure for flexible workflows', async () => {
        const workflow = await WorkflowService.create(
          createFlexibleWorkflowInput(),
        )
        const actorUser = await insertTestUser(testDb.db, {
          name: 'Test User',
        })
        const { item } = await insertTestPart(testDb.db, null, actorUser.id, {
          itemNumber: uniqueItemNumber(),
        })
        const instance = await WorkflowService.startInstance(
          workflow.id,
          item.id,
          { actorId: actorUser.id },
        )

        const structure = await WorkflowService.getEffectiveStructure(
          instance.id,
        )

        expect(structure.isInstanceLevel).toBe(true)
        expect(structure.canEdit).toBe(true)
        expect(structure.states).toHaveLength(2)
        expect(structure.transitions).toHaveLength(1)
      })
    })

    describe('startInstance for flexible workflows', () => {
      it('copies definition structure to instance', async () => {
        const workflow = await WorkflowService.create(
          createFlexibleWorkflowInput(),
        )
        const actorUser = await insertTestUser(testDb.db, {
          name: 'Test User',
        })
        const { item } = await insertTestPart(testDb.db, null, actorUser.id, {
          itemNumber: uniqueItemNumber(),
        })

        const instance = await WorkflowService.startInstance(
          workflow.id,
          item.id,
          { actorId: actorUser.id },
        )

        expect(instance.currentState).toBe('start')
        const structure = await WorkflowService.getEffectiveStructure(
          instance.id,
        )
        expect(structure.isInstanceLevel).toBe(true)
        expect(structure.states).toHaveLength(2)
      })
    })

    describe('updateInstanceStructure', () => {
      it('updates instance structure successfully', async () => {
        const workflow = await WorkflowService.create(
          createFlexibleWorkflowInput(),
        )
        const actorUser = await insertTestUser(testDb.db, {
          name: 'Test User',
        })
        const { item } = await insertTestPart(testDb.db, null, actorUser.id, {
          itemNumber: uniqueItemNumber(),
        })
        const instance = await WorkflowService.startInstance(
          workflow.id,
          item.id,
          { actorId: actorUser.id },
        )

        const newStates = [
          {
            id: 'start',
            name: 'Start',
            color: 'gray',
            isInitial: true,
            position: { x: 100, y: 200 },
          },
          {
            id: 'review',
            name: 'Engineering Review',
            color: 'yellow',
            position: { x: 250, y: 200 },
          },
          {
            id: 'complete',
            name: 'Complete',
            color: 'green',
            isFinal: true,
            finalKind: 'release' as const,
            position: { x: 400, y: 200 },
          },
        ]
        const newTransitions = [
          {
            id: 't1',
            name: 'Submit for Review',
            fromStateId: 'start',
            toStateId: 'review',
          },
          {
            id: 't2',
            name: 'Approve',
            fromStateId: 'review',
            toStateId: 'complete',
          },
        ]

        const result = await WorkflowService.updateInstanceStructure(
          instance.id,
          newStates,
          newTransitions,
          actorUser.id,
        )

        expect(result.success).toBe(true)
        const structure = await WorkflowService.getEffectiveStructure(
          instance.id,
        )
        expect(structure.states).toHaveLength(3)
        expect(structure.transitions).toHaveLength(2)
      })

      it('fails if current state is removed', async () => {
        const workflow = await WorkflowService.create(
          createFlexibleWorkflowInput(),
        )
        const actorUser = await insertTestUser(testDb.db, {
          name: 'Test User',
        })
        const { item } = await insertTestPart(testDb.db, null, actorUser.id, {
          itemNumber: uniqueItemNumber(),
        })
        const instance = await WorkflowService.startInstance(
          workflow.id,
          item.id,
          { actorId: actorUser.id },
        )

        // Try to remove the current state 'start'
        const newStates = [
          {
            id: 'other',
            name: 'Other',
            color: 'blue',
            isInitial: true,
          },
          {
            id: 'complete',
            name: 'Complete',
            color: 'green',
            isFinal: true,
            finalKind: 'release' as const,
          },
        ]
        const newTransitions = [
          {
            id: 't1',
            name: 'Complete',
            fromStateId: 'other',
            toStateId: 'complete',
          },
        ]

        const result = await WorkflowService.updateInstanceStructure(
          instance.id,
          newStates,
          newTransitions,
          actorUser.id,
        )

        expect(result.success).toBe(false)
        expect(result.error).toContain('current state')
      })

      it('fails without initial state', async () => {
        const workflow = await WorkflowService.create(
          createFlexibleWorkflowInput(),
        )
        const actorUser = await insertTestUser(testDb.db, {
          name: 'Test User',
        })
        const { item } = await insertTestPart(testDb.db, null, actorUser.id, {
          itemNumber: uniqueItemNumber(),
        })
        const instance = await WorkflowService.startInstance(
          workflow.id,
          item.id,
          { actorId: actorUser.id },
        )

        const newStates = [
          {
            id: 'start',
            name: 'Start',
            color: 'gray',
            // Missing isInitial: true
          },
          {
            id: 'complete',
            name: 'Complete',
            color: 'green',
            isFinal: true,
            finalKind: 'release' as const,
          },
        ]
        const newTransitions = [
          {
            id: 't1',
            name: 'Complete',
            fromStateId: 'start',
            toStateId: 'complete',
          },
        ]

        const result = await WorkflowService.updateInstanceStructure(
          instance.id,
          newStates,
          newTransitions,
          actorUser.id,
        )

        expect(result.success).toBe(false)
        expect(result.error).toContain('initial state')
      })

      it('fails without final state', async () => {
        const workflow = await WorkflowService.create(
          createFlexibleWorkflowInput(),
        )
        const actorUser = await insertTestUser(testDb.db, {
          name: 'Test User',
        })
        const { item } = await insertTestPart(testDb.db, null, actorUser.id, {
          itemNumber: uniqueItemNumber(),
        })
        const instance = await WorkflowService.startInstance(
          workflow.id,
          item.id,
          { actorId: actorUser.id },
        )

        const newStates = [
          {
            id: 'start',
            name: 'Start',
            color: 'gray',
            isInitial: true,
          },
          {
            id: 'review',
            name: 'Review',
            color: 'yellow',
            // Missing isFinal: true
          },
        ]
        const newTransitions = [
          {
            id: 't1',
            name: 'Review',
            fromStateId: 'start',
            toStateId: 'review',
          },
        ]

        const result = await WorkflowService.updateInstanceStructure(
          instance.id,
          newStates,
          newTransitions,
          actorUser.id,
        )

        expect(result.success).toBe(false)
        expect(result.error).toContain('final state')
      })

      it('fails if transition references non-existent state', async () => {
        const workflow = await WorkflowService.create(
          createFlexibleWorkflowInput(),
        )
        const actorUser = await insertTestUser(testDb.db, {
          name: 'Test User',
        })
        const { item } = await insertTestPart(testDb.db, null, actorUser.id, {
          itemNumber: uniqueItemNumber(),
        })
        const instance = await WorkflowService.startInstance(
          workflow.id,
          item.id,
          { actorId: actorUser.id },
        )

        const newStates = [
          {
            id: 'start',
            name: 'Start',
            color: 'gray',
            isInitial: true,
          },
          {
            id: 'complete',
            name: 'Complete',
            color: 'green',
            isFinal: true,
            finalKind: 'release' as const,
          },
        ]
        const newTransitions = [
          {
            id: 't1',
            name: 'Complete',
            fromStateId: 'start',
            toStateId: 'nonexistent', // Invalid state reference
          },
        ]

        const result = await WorkflowService.updateInstanceStructure(
          instance.id,
          newStates,
          newTransitions,
          actorUser.id,
        )

        expect(result.success).toBe(false)
        expect(result.error).toContain('references invalid state')
      })

      it('fails for strict workflows', async () => {
        const workflow = await WorkflowService.create(
          createStrictWorkflowInput(),
        )
        const actorUser = await insertTestUser(testDb.db, {
          name: 'Test User',
        })
        const { item } = await insertTestPart(testDb.db, null, actorUser.id, {
          itemNumber: uniqueItemNumber(),
        })
        const instance = await WorkflowService.startInstance(
          workflow.id,
          item.id,
          { actorId: actorUser.id },
        )

        const result = await WorkflowService.updateInstanceStructure(
          instance.id,
          [],
          [],
          actorUser.id,
        )

        expect(result.success).toBe(false)
        expect(result.error).toContain('not flexible')
      })
    })

    describe('transitions with flexible workflows', () => {
      it('uses instance structure for available transitions', async () => {
        const workflow = await WorkflowService.create(
          createFlexibleWorkflowInput(),
        )
        const actorUser = await insertTestUser(testDb.db, {
          name: 'Test User',
        })
        const { item } = await insertTestPart(testDb.db, null, actorUser.id, {
          itemNumber: uniqueItemNumber(),
        })
        const instance = await WorkflowService.startInstance(
          workflow.id,
          item.id,
          { actorId: actorUser.id },
        )

        // Add a new state and transition
        const newStates = [
          {
            id: 'start',
            name: 'Start',
            color: 'gray',
            isInitial: true,
          },
          {
            id: 'review',
            name: 'Review',
            color: 'yellow',
          },
          {
            id: 'complete',
            name: 'Complete',
            color: 'green',
            isFinal: true,
            finalKind: 'release' as const,
          },
        ]
        const newTransitions = [
          {
            id: 't1',
            name: 'Submit',
            fromStateId: 'start',
            toStateId: 'review',
          },
          {
            id: 't2',
            name: 'Approve',
            fromStateId: 'review',
            toStateId: 'complete',
          },
        ]

        await WorkflowService.updateInstanceStructure(
          instance.id,
          newStates,
          newTransitions,
          actorUser.id,
        )

        const transitions = await WorkflowService.getAvailableTransitions(
          instance.id,
          { item: { id: item.id }, user: { id: actorUser.id, roles: [] } },
        )

        expect(transitions).toHaveLength(1)
        expect(transitions[0]).toMatchObject({
          transition: { name: 'Submit', toStateId: 'review' },
        })
      })

      it('executes transitions using instance structure', async () => {
        const workflow = await WorkflowService.create(
          createFlexibleWorkflowInput(),
        )
        const actorUser = await insertTestUser(testDb.db, {
          name: 'Test User',
        })
        const { item } = await insertTestPart(testDb.db, null, actorUser.id, {
          itemNumber: uniqueItemNumber(),
        })
        const instance = await WorkflowService.startInstance(
          workflow.id,
          item.id,
          { actorId: actorUser.id },
        )

        // Use default transition to 'complete'
        const result = await WorkflowService.transition(
          instance.id,
          'complete',
          actorUser.id,
        )

        expect(result.success).toBe(true)
        expect(result.toState).toBe('complete')

        const updated = await WorkflowService.getInstance(instance.id)
        expect(updated?.currentState).toBe('complete')
      })
    })

    describe('isFlexibleAndEditable', () => {
      it('returns true for flexible workflow in non-final state', async () => {
        const workflow = await WorkflowService.create(
          createFlexibleWorkflowInput(),
        )
        const actorUser = await insertTestUser(testDb.db, {
          name: 'Test User',
        })
        const { item } = await insertTestPart(testDb.db, null, actorUser.id, {
          itemNumber: uniqueItemNumber(),
        })
        const instance = await WorkflowService.startInstance(
          workflow.id,
          item.id,
          { actorId: actorUser.id },
        )

        const result = await WorkflowService.isFlexibleAndEditable(instance.id)

        expect(result).toBe(true)
      })

      it('returns false for strict workflow', async () => {
        const workflow = await WorkflowService.create(
          createStrictWorkflowInput(),
        )
        const actorUser = await insertTestUser(testDb.db, {
          name: 'Test User',
        })
        const { item } = await insertTestPart(testDb.db, null, actorUser.id, {
          itemNumber: uniqueItemNumber(),
        })
        const instance = await WorkflowService.startInstance(
          workflow.id,
          item.id,
          { actorId: actorUser.id },
        )

        const result = await WorkflowService.isFlexibleAndEditable(instance.id)

        expect(result).toBe(false)
      })

      it('returns false for completed flexible workflow', async () => {
        const workflow = await WorkflowService.create(
          createFlexibleWorkflowInput(),
        )
        const actorUser = await insertTestUser(testDb.db, {
          name: 'Test User',
        })
        const { item } = await insertTestPart(testDb.db, null, actorUser.id, {
          itemNumber: uniqueItemNumber(),
        })
        const instance = await WorkflowService.startInstance(
          workflow.id,
          item.id,
          { actorId: actorUser.id },
        )

        // Complete the workflow
        await WorkflowService.transition(instance.id, 'complete', actorUser.id)

        const result = await WorkflowService.isFlexibleAndEditable(instance.id)

        expect(result).toBe(false)
      })
    })
  })
})

// Security tests (three-gate rule) for save-side driver validation
// (remediation WI-4.4): a Driven lifecycle's drivers allow-list may only
// reference existing Driving definitions.
describe('WorkflowService driver validation (WI-4.4)', () => {
  const testDb = new TestDatabase()
  let testPrefix: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    testPrefix = `DRV-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  const drivenInput = (
    name: string,
    drivers: Array<string>,
  ): CreateWorkflowInput => ({
    name,
    workflowType: 'strict',
    lifecycleType: 'Driven',
    states: [
      { id: 'Draft', name: 'Draft', isInitial: true },
      { id: 'Released', name: 'Released', isFinal: true },
    ],
    transitions: [],
    drivers,
  })

  it('rejects drivers that do not reference an existing definition', async () => {
    await expect(
      WorkflowService.create(
        drivenInput(`Driven Bad Ref ${testPrefix}`, [
          '00000000-0000-4000-8000-00000000dead',
        ]),
      ),
    ).rejects.toThrow(/does not reference an existing workflow definition/)
  })

  it('rejects drivers that are not Driving lifecycles', async () => {
    const free = await WorkflowService.create({
      name: `Free Not A Driver ${testPrefix}`,
      workflowType: 'strict',
      lifecycleType: 'Free',
      states: [
        { id: 'Open', name: 'Open', isInitial: true },
        { id: 'Closed', name: 'Closed', isFinal: true },
      ],
      transitions: [
        { id: 't1', name: 'Close', fromStateId: 'Open', toStateId: 'Closed' },
      ],
    })

    await expect(
      WorkflowService.create(
        drivenInput(`Driven Free Driver ${testPrefix}`, [free.id]),
      ),
    ).rejects.toThrow(/only Driving lifecycles can act/)
  })

  it('accepts and persists a valid Driving driver, on create and update', async () => {
    const driving = await WorkflowService.create({
      name: `Driving Driver ${testPrefix}`,
      workflowType: 'strict',
      lifecycleType: 'Driving',
      states: [
        { id: 'draft', name: 'Draft', isInitial: true },
        {
          id: 'done',
          name: 'Done',
          isFinal: true,
          finalKind: 'release' as const,
        },
      ],
      transitions: [
        { id: 't1', name: 'Complete', fromStateId: 'draft', toStateId: 'done' },
      ],
    })

    const driven = await WorkflowService.create(
      drivenInput(`Driven With Driver ${testPrefix}`, [driving.id]),
    )
    expect(driven.drivers).toEqual([driving.id])

    // Update replaces the list wholesale and validates the new one
    await expect(
      WorkflowService.update(driven.id, {
        drivers: ['00000000-0000-4000-8000-00000000dead'],
      }),
    ).rejects.toThrow(/does not reference an existing workflow definition/)

    const cleared = await WorkflowService.update(driven.id, { drivers: [] })
    expect(cleared.drivers).toEqual([])
  })
})

// Data-integrity tests (three-gate rule) for rework approval invalidation
// (remediation WI-4.1): a backward transition supersedes votes on the
// re-traversable segment, so the second pass requires fresh approvals.
describe('WorkflowService rework supersedes approvals (WI-4.1)', () => {
  const testDb = new TestDatabase()
  let testPrefix: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    testPrefix = `RW-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  it('requires fresh votes after Draft → Review → Draft → Review; superseded votes remain queryable', async () => {
    const workflow = await WorkflowService.create({
      name: `Rework Workflow ${testPrefix}`,
      workflowType: 'strict',
      lifecycleType: 'Driving',
      states: [
        { id: 'draft', name: 'Draft', isInitial: true },
        { id: 'review', name: 'Review' },
        {
          id: 'done',
          name: 'Done',
          isFinal: true,
          finalKind: 'release' as const,
        },
      ],
      transitions: [
        { id: 't1', name: 'Submit', fromStateId: 'draft', toStateId: 'review' },
        { id: 't2', name: 'Approve', fromStateId: 'review', toStateId: 'done' },
        { id: 't3', name: 'Rework', fromStateId: 'review', toStateId: 'draft' },
      ],
    })

    const approver = await insertTestUser(testDb.db, {
      name: 'Rework Approver',
    })
    const { item } = await insertTestPart(testDb.db, null, approver.id, {
      itemNumber: `PN-${testPrefix}-RW`,
    })
    const instance = await WorkflowService.startInstance(workflow.id, item.id, {
      actorId: approver.id,
    })

    await WorkflowApprovalService.addStateApprover(
      workflow.id,
      'review',
      { type: 'user', id: approver.id, isRequired: true },
      approver.id,
    )

    // First pass: submit, approve at Review — leaving Review is unlocked
    const submit = await WorkflowService.transition(
      instance.id,
      'review',
      approver.id,
    )
    expect(submit.success).toBe(true)

    await WorkflowApprovalService.submitApproval(
      instance.id,
      'review',
      approver.id,
      'approved',
    )

    // Rework: Review → Draft is backward (Draft reaches Review again)
    const rework = await WorkflowService.transition(
      instance.id,
      'draft',
      approver.id,
    )
    expect(rework.success).toBe(true)

    // Second pass: the old vote is superseded, so leaving Review is gated
    const resubmit = await WorkflowService.transition(
      instance.id,
      'review',
      approver.id,
    )
    expect(resubmit.success).toBe(true)

    const blocked = await WorkflowService.transition(
      instance.id,
      'done',
      approver.id,
    )
    expect(blocked.success).toBe(false)
    expect(blocked.error).toMatch(/approval/i)

    // The superseded vote is still queryable — audit trail, not deletion
    const votes = await testDb.db
      .select()
      .from(workflowApprovalVotes)
      .where(eq(workflowApprovalVotes.workflowInstanceId, instance.id))
    expect(votes).toHaveLength(1)
    expect(votes[0]?.supersededAt).not.toBeNull()

    // Fresh vote unlocks the transition
    await WorkflowApprovalService.submitApproval(
      instance.id,
      'review',
      approver.id,
      'approved',
    )
    const approved = await WorkflowService.transition(
      instance.id,
      'done',
      approver.id,
    )
    expect(approved.success).toBe(true)
  })

  it('leaves votes active on forward transitions', async () => {
    const workflow = await WorkflowService.create({
      name: `Forward Workflow ${testPrefix}`,
      workflowType: 'strict',
      lifecycleType: 'Driving',
      states: [
        { id: 'draft', name: 'Draft', isInitial: true },
        { id: 'review', name: 'Review' },
        {
          id: 'done',
          name: 'Done',
          isFinal: true,
          finalKind: 'release' as const,
        },
      ],
      transitions: [
        { id: 't1', name: 'Submit', fromStateId: 'draft', toStateId: 'review' },
        { id: 't2', name: 'Approve', fromStateId: 'review', toStateId: 'done' },
      ],
    })

    const approver = await insertTestUser(testDb.db, {
      name: 'Forward Approver',
    })
    const { item } = await insertTestPart(testDb.db, null, approver.id, {
      itemNumber: `PN-${testPrefix}-FW`,
    })
    const instance = await WorkflowService.startInstance(workflow.id, item.id, {
      actorId: approver.id,
    })

    await WorkflowApprovalService.addStateApprover(
      workflow.id,
      'review',
      { type: 'user', id: approver.id, isRequired: true },
      approver.id,
    )

    await WorkflowService.transition(instance.id, 'review', approver.id)
    await WorkflowApprovalService.submitApproval(
      instance.id,
      'review',
      approver.id,
      'approved',
    )
    const done = await WorkflowService.transition(
      instance.id,
      'done',
      approver.id,
    )
    expect(done.success).toBe(true)

    // No transition in this workflow is backward — the vote stays active
    const votes = await testDb.db
      .select()
      .from(workflowApprovalVotes)
      .where(eq(workflowApprovalVotes.workflowInstanceId, instance.id))
    expect(votes).toHaveLength(1)
    expect(votes[0]?.supersededAt).toBeNull()
  })
})

// Security tests (three-gate rule) for flexible-instance approvals
// (remediation WI-4.2): custom states added at runtime carry real,
// enforced approvers; the instance-transition requiredCount is a real gate.
describe('WorkflowService flexible-instance approvals (WI-4.2)', () => {
  const testDb = new TestDatabase()
  let testPrefix: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    testPrefix = `FA-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  async function createFlexibleInstanceWithCustomReview(suffix: string) {
    const owner = await insertTestUser(testDb.db, { name: 'Flex Owner' })
    const workflow = await WorkflowService.create({
      name: `Flexible Approvals ${suffix} ${testPrefix}`,
      workflowType: 'flexible',
      lifecycleType: 'Driving',
      states: [
        { id: 'draft', name: 'Draft', isInitial: true },
        {
          id: 'done',
          name: 'Done',
          isFinal: true,
          finalKind: 'release' as const,
        },
      ],
      transitions: [
        { id: 't1', name: 'Complete', fromStateId: 'draft', toStateId: 'done' },
      ],
    })
    const { item } = await insertTestPart(testDb.db, null, owner.id, {
      itemNumber: `PN-${testPrefix}-${suffix}`,
    })
    const instance = await WorkflowService.startInstance(workflow.id, item.id, {
      actorId: owner.id,
    })

    // Add a custom review state between draft and done — the scenario
    // definition-keyed approvers can never cover
    const structure = await WorkflowService.updateInstanceStructure(
      instance.id,
      [
        { id: 'draft', name: 'Draft', isInitial: true },
        { id: 'quality-review', name: 'Quality Review' },
        {
          id: 'done',
          name: 'Done',
          isFinal: true,
          finalKind: 'release' as const,
        },
      ],
      [
        {
          id: 't1',
          name: 'Submit',
          fromStateId: 'draft',
          toStateId: 'quality-review',
        },
        {
          id: 't2',
          name: 'Approve',
          fromStateId: 'quality-review',
          toStateId: 'done',
        },
      ],
      owner.id,
    )
    expect(structure.success).toBe(true)

    return { owner, workflow, item, instance }
  }

  it('blocks leaving a custom review state until both required approvers vote', async () => {
    const { owner, instance } =
      await createFlexibleInstanceWithCustomReview('two')
    const approver2 = await insertTestUser(testDb.db, { name: 'Approver Two' })

    await WorkflowApprovalService.setInstanceApprovers(
      instance.id,
      'quality-review',
      [
        { type: 'user', id: owner.id, isRequired: true },
        { type: 'user', id: approver2.id, isRequired: true },
      ],
      owner.id,
    )

    const submit = await WorkflowService.transition(
      instance.id,
      'quality-review',
      owner.id,
    )
    expect(submit.success).toBe(true)

    // 0/2 approvals — blocked
    const blocked = await WorkflowService.transition(
      instance.id,
      'done',
      owner.id,
    )
    expect(blocked.success).toBe(false)
    expect(blocked.error).toMatch(/approval/i)

    // 1/2 approvals — still blocked
    await WorkflowApprovalService.submitApproval(
      instance.id,
      'quality-review',
      owner.id,
      'approved',
    )
    const stillBlocked = await WorkflowService.transition(
      instance.id,
      'done',
      owner.id,
    )
    expect(stillBlocked.success).toBe(false)

    // 2/2 approvals — allowed
    await WorkflowApprovalService.submitApproval(
      instance.id,
      'quality-review',
      approver2.id,
      'approved',
    )
    const allowed = await WorkflowService.transition(
      instance.id,
      'done',
      owner.id,
    )
    expect(allowed.success).toBe(true)
  })

  it('enforces the instance-transition requiredCount without named approvers', async () => {
    const { owner, instance } =
      await createFlexibleInstanceWithCustomReview('cnt')

    // Rewrite the approve transition to demand one approval, from anyone
    const structure = await WorkflowService.updateInstanceStructure(
      instance.id,
      [
        { id: 'draft', name: 'Draft', isInitial: true },
        { id: 'quality-review', name: 'Quality Review' },
        {
          id: 'done',
          name: 'Done',
          isFinal: true,
          finalKind: 'release' as const,
        },
      ],
      [
        {
          id: 't1',
          name: 'Submit',
          fromStateId: 'draft',
          toStateId: 'quality-review',
        },
        {
          id: 't2',
          name: 'Approve',
          fromStateId: 'quality-review',
          toStateId: 'done',
          approvalRequirement: { requiredCount: 1 },
        },
      ],
      owner.id,
    )
    expect(structure.success).toBe(true)

    await WorkflowService.transition(instance.id, 'quality-review', owner.id)

    // No votes yet — the count gate blocks
    const blocked = await WorkflowService.transition(
      instance.id,
      'done',
      owner.id,
    )
    expect(blocked.success).toBe(false)
    expect(blocked.error).toMatch(/approval/i)

    // With no named approvers anyone may vote; one vote satisfies the gate
    await WorkflowApprovalService.submitApproval(
      instance.id,
      'quality-review',
      owner.id,
      'approved',
    )
    const allowed = await WorkflowService.transition(
      instance.id,
      'done',
      owner.id,
    )
    expect(allowed.success).toBe(true)
  })
})
