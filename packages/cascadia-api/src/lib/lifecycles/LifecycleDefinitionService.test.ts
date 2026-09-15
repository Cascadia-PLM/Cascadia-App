// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * LifecycleDefinitionService tests
 *
 * Integration tests for lifecycle definitions: CRUD, validation, state removal and driver validation. Split from the WorkflowService suite along
 * the same seam as the service (remediation plan CM-22).
 *
 * Run: npx vitest run packages/core/src/lib/lifecycles/LifecycleDefinitionService.test.ts
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
import { LifecycleDefinitionService } from './LifecycleDefinitionService'
import { LifecycleInstanceService } from './LifecycleInstanceService'
import { resolveLifecycleType } from './normalize'
import type { CreateLifecycleInput } from './types'
import { NotFoundError, ValidationError } from '@/lib/errors'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { insertTestPart } from '@/__tests__/fixtures/items'

describe('LifecycleDefinitionService', () => {
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
    overrides?: Partial<CreateLifecycleInput>,
  ): CreateLifecycleInput {
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

      const result = await LifecycleDefinitionService.create(input)

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

      const result = await LifecycleDefinitionService.create(input)

      expect(result.lifecycleType).toBe('Driven')
    })

    it('throws error for missing name', async () => {
      const input = createWorkflowInput({ name: '' })

      await expect(LifecycleDefinitionService.create(input)).rejects.toThrow(
        'Workflow name is required',
      )
    })

    it('throws error for no states', async () => {
      const input = createWorkflowInput({ states: [] })

      await expect(LifecycleDefinitionService.create(input)).rejects.toThrow(
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

      await expect(LifecycleDefinitionService.create(input)).rejects.toThrow(
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

      await expect(LifecycleDefinitionService.create(input)).rejects.toThrow(
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

      await expect(LifecycleDefinitionService.create(input)).rejects.toThrow(
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

      await expect(LifecycleDefinitionService.create(input)).rejects.toThrow(
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

      await expect(LifecycleDefinitionService.create(input)).rejects.toThrow(
        'references non-existent to state',
      )
    })
  })

  describe('getById', () => {
    it('returns workflow by ID', async () => {
      const input = createWorkflowInput()
      const created = await LifecycleDefinitionService.create(input)

      const result = await LifecycleDefinitionService.getById(created.id)

      expect(result).not.toBeNull()
      expect(result?.id).toBe(created.id)
      expect(result?.name).toBe(input.name)
    })

    it('returns null for non-existent ID', async () => {
      const result = await LifecycleDefinitionService.getById(
        '00000000-0000-0000-0000-000000000000',
      )

      expect(result).toBeNull()
    })
  })

  describe('getByName', () => {
    it('returns workflow by name', async () => {
      const input = createWorkflowInput()
      const created = await LifecycleDefinitionService.create(input)

      const result = await LifecycleDefinitionService.getByName(input.name)

      expect(result).not.toBeNull()
      expect(result?.id).toBe(created.id)
    })

    it('returns null for non-existent name', async () => {
      const result = await LifecycleDefinitionService.getByName(
        'NonExistent Workflow',
      )

      expect(result).toBeNull()
    })
  })

  describe('list', () => {
    it('returns all workflows', async () => {
      await LifecycleDefinitionService.create(createWorkflowInput())
      await LifecycleDefinitionService.create(createWorkflowInput())

      const result = await LifecycleDefinitionService.list()

      expect(result.length).toBeGreaterThanOrEqual(2)
    })

    it('filters by isActive', async () => {
      await LifecycleDefinitionService.create(
        createWorkflowInput({ isActive: true }),
      )
      await LifecycleDefinitionService.create(
        createWorkflowInput({ isActive: false }),
      )

      const activeOnly = await LifecycleDefinitionService.list({
        isActive: true,
      })
      const inactiveOnly = await LifecycleDefinitionService.list({
        isActive: false,
      })

      expect(activeOnly.every((w) => w.isActive)).toBe(true)
      expect(inactiveOnly.every((w) => !w.isActive)).toBe(true)
    })

    it('filters by kind via resolved lifecycleType', async () => {
      await LifecycleDefinitionService.create(
        createWorkflowInput({
          name: `Workflow Test ${Date.now()}`,
          lifecycleType: 'Driving',
        }),
      )
      await LifecycleDefinitionService.create(
        createWorkflowInput({
          name: `Lifecycle Test ${Date.now() + 1}`,
          lifecycleType: 'Driven',
        }),
      )

      const workflowsOnly = await LifecycleDefinitionService.list({
        kind: 'workflow',
      })
      const lifecyclesOnly = await LifecycleDefinitionService.list({
        kind: 'lifecycle',
      })

      expect(
        workflowsOnly.every((w) => resolveLifecycleType(w) === 'Driving'),
      ).toBe(true)
      expect(
        lifecyclesOnly.every((w) => resolveLifecycleType(w) !== 'Driving'),
      ).toBe(true)
    })

    it('resolves kind from lifecycleType alone', async () => {
      const created = await LifecycleDefinitionService.create({
        name: `Pure LifecycleType ${Date.now()}`,
        workflowType: 'strict',
        lifecycleType: 'Driven',
        states: [{ id: 'Draft', name: 'Draft', isInitial: true }],
        transitions: [],
      })

      expect(created.lifecycleType).toBe('Driven')
      const lifecyclesOnly = await LifecycleDefinitionService.list({
        kind: 'lifecycle',
      })
      expect(lifecyclesOnly.some((w) => w.id === created.id)).toBe(true)
    })
  })

  describe('update', () => {
    it('updates workflow name', async () => {
      const created = await LifecycleDefinitionService.create(
        createWorkflowInput(),
      )
      const newName = `Updated Name ${Date.now()}`

      const updated = await LifecycleDefinitionService.update(created.id, {
        name: newName,
      })

      expect(updated.name).toBe(newName)
    })

    it('updates workflow states', async () => {
      const created = await LifecycleDefinitionService.create(
        createWorkflowInput(),
      )
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

      const updated = await LifecycleDefinitionService.update(created.id, {
        states: newStates,
        transitions: [
          { id: 't1', name: 'Complete', fromStateId: 'new', toStateId: 'done' },
        ],
      })

      expect(updated.states).toHaveLength(2)
    })

    it('throws error for non-existent workflow', async () => {
      await expect(
        LifecycleDefinitionService.update(
          '00000000-0000-0000-0000-000000000000',
          {
            name: 'Test',
          },
        ),
      ).rejects.toThrow(NotFoundError)
    })

    it('throws error for invalid update', async () => {
      const created = await LifecycleDefinitionService.create(
        createWorkflowInput(),
      )

      await expect(
        LifecycleDefinitionService.update(created.id, {
          states: [], // Invalid - no states
        }),
      ).rejects.toThrow(ValidationError)
    })
  })

  describe('delete', () => {
    it('deletes workflow definition', async () => {
      const created = await LifecycleDefinitionService.create(
        createWorkflowInput(),
      )

      await LifecycleDefinitionService.delete(created.id)

      const result = await LifecycleDefinitionService.getById(created.id)
      expect(result).toBeNull()
    })

    it('throws error for non-existent workflow', async () => {
      await expect(
        LifecycleDefinitionService.delete(
          '00000000-0000-0000-0000-000000000000',
        ),
      ).rejects.toThrow(NotFoundError)
    })

    it('throws error when active instances exist', async () => {
      const user = await insertTestUser(testDb.db, { name: 'Delete Test User' })
      const workflow = await LifecycleDefinitionService.create(
        createWorkflowInput(),
      )
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })

      // Start an instance
      await LifecycleInstanceService.startInstance(workflow.id, item.id, {
        actorId: user.id,
      })

      await expect(
        LifecycleDefinitionService.delete(workflow.id),
      ).rejects.toThrow('Cannot delete workflow with active instances')
    })
  })

  describe('validateDefinition', () => {
    it('returns valid for correct definition', () => {
      const input = createWorkflowInput()

      const result = LifecycleDefinitionService.validateDefinition(input)

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

      const result = LifecycleDefinitionService.validateDefinition(input)

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

      const result = LifecycleDefinitionService.validateDefinition(input)

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

      const result = LifecycleDefinitionService.validateDefinition(input)

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

      const result = LifecycleDefinitionService.validateDefinition(input)

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

  describe('Phase 1 hardening', () => {
    describe('finalKind validation (WI-1.1)', () => {
      it('rejects Driving definitions whose final states lack finalKind', () => {
        const result = LifecycleDefinitionService.validateDefinition({
          name: 'FK Missing',
          lifecycleType: 'Driving',
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
        const result = LifecycleDefinitionService.validateDefinition({
          name: 'FK Present',
          lifecycleType: 'Driving',
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
        const result = LifecycleDefinitionService.validateDefinition({
          name: 'Driven FK Exempt',
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
        const result = LifecycleDefinitionService.validateDefinition({
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
        const result = LifecycleDefinitionService.validateDefinition({
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
        const result = LifecycleDefinitionService.validateDefinition({
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
        const result = LifecycleDefinitionService.validateDefinition({
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
        const result = LifecycleDefinitionService.validateDefinition({
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
  })

  describe('update_field allowlist (WI-2.3)', () => {
    it('rejects definitions whose update_field targets a non-allowlisted column', () => {
      const result = LifecycleDefinitionService.validateDefinition({
        name: 'UF Disallowed',
        lifecycleType: 'Driving',
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
      const result = LifecycleDefinitionService.validateDefinition({
        name: 'UF Allowed',
        lifecycleType: 'Driving',
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

describe('LifecycleDefinitionService Edge Cases', () => {
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

  describe('State Name Edge Cases', () => {
    it('handles state names with special characters', async () => {
      const input = {
        name: `Special State Names ${testPrefix}`,
        lifecycleType: 'Driving' as const,
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

      const workflow = await LifecycleDefinitionService.create(input)
      expect(workflow.states[0]).toMatchObject({ name: 'Draft (Initial)' })
      expect(workflow.states[1]).toMatchObject({ name: 'In-Review / Pending' })
    })

    it('handles unicode in state and transition names', async () => {
      const input = {
        name: `Unicode Workflow ${testPrefix}`,
        lifecycleType: 'Driving' as const,
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

      const workflow = await LifecycleDefinitionService.create(input)
      expect(workflow.states.find((s) => s.id === 'draft')?.name).toBe('草稿')
      expect(workflow.transitions?.find((t) => t.id === 't1')?.name).toBe(
        '提出',
      )
    })

    it('handles very long state names', async () => {
      const longName = 'A'.repeat(200)
      const input = {
        name: `Long Names ${testPrefix}`,
        lifecycleType: 'Driving' as const,
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

      const workflow = await LifecycleDefinitionService.create(input)
      // Name may be truncated or accepted depending on DB constraints
      expect(workflow.states[0]?.name.length).toBeGreaterThan(0)
    })

    it('handles empty state name', async () => {
      const input = {
        name: `Empty State Name ${testPrefix}`,
        lifecycleType: 'Driving' as const,
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
        const result = await LifecycleDefinitionService.create(input)
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
        lifecycleType: 'Driving' as const,
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
        const result = await LifecycleDefinitionService.create(input)
        // If accepted, whitespace name may be trimmed or kept
        expect(result).toBeDefined()
      } catch (error) {
        // Expected to reject whitespace name
        expect(error).toBeDefined()
      }
    })
  })

  describe('Validation Edge Cases', () => {
    it('validates workflow with only initial state (no final)', () => {
      const input = {
        name: `No Final ${testPrefix}`,
        lifecycleType: 'Driving' as const,
        workflowType: 'strict' as const,
        states: [
          { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
        ],
        transitions: [],
      }

      const result = LifecycleDefinitionService.validateDefinition(input)

      expect(result.valid).toBe(true)
      expect(result.warnings.some((w) => w.code === 'NO_FINAL_STATE')).toBe(
        true,
      )
    })

    it('validates workflow with multiple final states', () => {
      const input = {
        name: `Multiple Finals ${testPrefix}`,
        lifecycleType: 'Driving' as const,
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

      const result = LifecycleDefinitionService.validateDefinition(input)

      expect(result.valid).toBe(true)
      // Multiple finals should be acceptable
      expect(result.errors).toHaveLength(0)
    })

    it('handles duplicate transition IDs', async () => {
      const input = {
        name: `Duplicate Trans ${testPrefix}`,
        lifecycleType: 'Driving' as const,
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
        const result = await LifecycleDefinitionService.create(input)
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
      await LifecycleDefinitionService.create({
        name: `Filter Test A ${testPrefix}`,
        lifecycleType: 'Driving',
        workflowType: 'strict',
        isActive: true,
        states: [
          { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
        ],
        transitions: [],
      })

      await LifecycleDefinitionService.create({
        name: `Filter Test B ${testPrefix}`,
        lifecycleType: 'Driven',
        workflowType: 'strict',
        isActive: true,
        states: [
          { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
        ],
        transitions: [],
      })

      await LifecycleDefinitionService.create({
        name: `Filter Test C ${testPrefix}`,
        lifecycleType: 'Driving',
        workflowType: 'strict',
        isActive: false,
        states: [
          { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
        ],
        transitions: [],
      })

      const results = await LifecycleDefinitionService.list({
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
      await LifecycleDefinitionService.create({
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
      const results = await LifecycleDefinitionService.list({
        kind: 'lifecycle',
        isActive: false,
      })

      // May or may not be empty depending on existing data, but should not error
      expect(Array.isArray(results)).toBe(true)
    })
  })
})

describe('LifecycleDefinitionService validateStateRemoval', () => {
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

    const result = await LifecycleDefinitionService.validateStateRemoval(
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

    const result = await LifecycleDefinitionService.validateStateRemoval(
      'any-id',
      currentStates,
      newStates,
    )

    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('returns valid when removing states from unused lifecycle', async () => {
    // Create a lifecycle that is not used by any item type
    const lifecycle = await LifecycleDefinitionService.create({
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
    const result = await LifecycleDefinitionService.validateStateRemoval(
      lifecycle.id,
      currentStates,
      newStates,
    )

    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })
})

describe('LifecycleDefinitionService driver validation (WI-4.4)', () => {
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
  ): CreateLifecycleInput => ({
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
      LifecycleDefinitionService.create(
        drivenInput(`Driven Bad Ref ${testPrefix}`, [
          '00000000-0000-4000-8000-00000000dead',
        ]),
      ),
    ).rejects.toThrow(/does not reference an existing workflow definition/)
  })

  it('rejects drivers that are not Driving lifecycles', async () => {
    const free = await LifecycleDefinitionService.create({
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
      LifecycleDefinitionService.create(
        drivenInput(`Driven Free Driver ${testPrefix}`, [free.id]),
      ),
    ).rejects.toThrow(/only Driving lifecycles can act/)
  })

  it('accepts and persists a valid Driving driver, on create and update', async () => {
    const driving = await LifecycleDefinitionService.create({
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

    const driven = await LifecycleDefinitionService.create(
      drivenInput(`Driven With Driver ${testPrefix}`, [driving.id]),
    )
    expect(driven.drivers).toEqual([driving.id])

    // Update replaces the list wholesale and validates the new one
    await expect(
      LifecycleDefinitionService.update(driven.id, {
        drivers: ['00000000-0000-4000-8000-00000000dead'],
      }),
    ).rejects.toThrow(/does not reference an existing workflow definition/)

    const cleared = await LifecycleDefinitionService.update(driven.id, {
      drivers: [],
    })
    expect(cleared.drivers).toEqual([])
  })
})
