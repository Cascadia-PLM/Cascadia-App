// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * LifecycleService tests
 *
 * The drivers allow-list, state identity by ID, action-target resolution
 * and definition memoization. The Free-lifecycle transition path moved with
 * its engine to lib/lifecycles/LifecycleInstanceService.test.ts (remediation
 * plan CM-22).
 *
 * Run: npx vitest run packages/core/src/lib/services/LifecycleService.test.ts
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
import { ItemService } from '../items/services/ItemService'
import { LifecycleDefinitionService } from '../lifecycles/LifecycleDefinitionService'
import { LifecycleService } from './LifecycleService'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { lifecycleDefinitions } from '@/lib/db/schema/lifecycles'
import { ItemTypeRegistry } from '@/lib/items/registry'
import {
  SYSTEM_USER_ID,
  overrideItemTypeConfig,
  seedStandardPartLifecycle,
} from '@/__tests__/fixtures/lifecycles'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

// Security tests (three-gate rule) for the Driven-side `drivers` allow-list
// (remediation WI-4.4): a Driving lifecycle that is not listed may not act
// on the Driven lifecycle; an empty list stays permissive as documented.
describe('LifecycleService drivers allow-list (WI-4.4)', () => {
  const testDb = new TestDatabase()
  let restoreItemTypeConfig: (() => Promise<void>) | undefined

  // This file claims the 'Tool' item type for its Driven fixture — each
  // itemType may be configured by at most one test file (shared row)
  const ALLOWED_DRIVER_ID = '00000000-0000-4000-8000-000000000313'
  const BLOCKED_DRIVER_ID = '00000000-0000-4000-8000-000000000314'
  const TOOL_LIFECYCLE_ID = '00000000-0000-4000-8000-000000000315'

  const drivingDefinition = (name: string) => ({
    states: [
      { id: 'Draft', name: 'Draft', isInitial: true },
      {
        id: 'Approved',
        name: 'Approved',
        isFinal: true,
        finalKind: 'release',
      },
    ],
    transitions: [
      {
        id: 't1',
        name: 'Approve',
        fromStateId: 'Draft',
        toStateId: 'Approved',
      },
    ],
    lifecycleType: 'Driving',
    description: name,
  })

  const toolLifecycleDefinition = {
    states: [
      { id: 'Draft', name: 'Draft', isInitial: true },
      { id: 'Released', name: 'Released' },
      { id: 'Obsolete', name: 'Obsolete', isFinal: true },
    ],
    transitions: [],
    changeActionMappings: {
      release: {
        fromState: 'Draft',
        toState: 'Released',
        assignsRevision: true,
      },
    },
    lifecycleType: 'Driven',
    applicableItemTypes: ['Tool'],
  }

  beforeAll(async () => {
    await testDb.setup()
    // Part lifecycle (no drivers configured) backs the permissive-default test
    await seedStandardPartLifecycle(testDb.db)

    for (const [id, name] of [
      [ALLOWED_DRIVER_ID, 'Allowed Driver Workflow - Drivers Test'],
      [BLOCKED_DRIVER_ID, 'Blocked Driver Workflow - Drivers Test'],
    ] as const) {
      await testDb.db
        .insert(lifecycleDefinitions)
        .values({
          id,
          name,
          version: 1,
          workflowType: 'strict',
          definition: drivingDefinition(name),
          isActive: true,
          lifecycleType: 'Driving',
        })
        .onConflictDoNothing()
    }

    await testDb.db
      .insert(lifecycleDefinitions)
      .values({
        id: TOOL_LIFECYCLE_ID,
        name: 'Tool Lifecycle - Drivers Test',
        version: 1,
        workflowType: 'strict',
        definition: toolLifecycleDefinition,
        isActive: true,
        lifecycleType: 'Driven',
        drivers: [ALLOWED_DRIVER_ID],
      })
      .onConflictDoUpdate({
        target: lifecycleDefinitions.id,
        set: {
          definition: toolLifecycleDefinition,
          lifecycleType: 'Driven',
          drivers: [ALLOWED_DRIVER_ID],
          isActive: true,
        },
      })

    restoreItemTypeConfig = await overrideItemTypeConfig(
      testDb.db,
      'Tool',
      { lifecycleDefinitionId: TOOL_LIFECYCLE_ID },
      SYSTEM_USER_ID,
    )

    await ItemTypeRegistry.reload()
  })

  afterAll(async () => {
    // Shared row: put back what this suite found before it wrote.
    await restoreItemTypeConfig?.()
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  it('blocks a Driving lifecycle that is not in the drivers list', async () => {
    const result = await LifecycleService.canApplyAction(
      'Tool',
      'Draft',
      'release',
      { drivingLifecycleId: BLOCKED_DRIVER_ID },
    )

    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/authorized driver/)
  })

  it('allows a Driving lifecycle that is in the drivers list', async () => {
    const result = await LifecycleService.canApplyAction(
      'Tool',
      'Draft',
      'release',
      { drivingLifecycleId: ALLOWED_DRIVER_ID },
    )

    expect(result.valid).toBe(true)
  })

  it('stays permissive when no drivers are configured', async () => {
    // Own the fixture state: clear the drivers list inside this test's
    // transaction rather than assuming anything about shared rows (the
    // Part lifecycle's drivers vary between seeded and fresh databases)
    await testDb.db
      .update(lifecycleDefinitions)
      .set({ drivers: [] })
      .where(eq(lifecycleDefinitions.id, TOOL_LIFECYCLE_ID))

    const result = await LifecycleService.canApplyAction(
      'Tool',
      'Draft',
      'release',
      { drivingLifecycleId: BLOCKED_DRIVER_ID },
    )

    expect(result.valid).toBe(true)
  })

  it('does not gate callers with no acting Driving lifecycle', async () => {
    const result = await LifecycleService.canApplyAction(
      'Tool',
      'Draft',
      'release',
    )

    expect(result.valid).toBe(true)
  })
})

// Data-integrity tests (three-gate rule) for state identity (WI-5.1): the
// engine matches and writes state IDs; display names are never load-bearing.
// Every state in this fixture has id !== name, which the WI-1.5 guardrail
// used to forbid — its replacement is mappings-must-reference-IDs.
describe('LifecycleService state identity is IDs (WI-5.1)', () => {
  const testDb = new TestDatabase()
  let restoreItemTypeConfig: (() => Promise<void>) | undefined

  // This file claims the 'Task' item type for its id!==name fixture
  const REQ_LIFECYCLE_ID = '00000000-0000-4000-8000-000000000316'

  const reqLifecycleDefinition = {
    states: [
      {
        id: 'req-draft',
        name: 'Draft',
        isInitial: true,
        phaseId: 'ph-dev',
      },
      { id: 'req-review', name: 'In Review', phaseId: 'ph-dev' },
      { id: 'req-released', name: 'Released', phaseId: 'ph-prod' },
      {
        id: 'req-obsolete',
        name: 'Obsolete',
        isFinal: true,
        phaseId: 'ph-prod',
      },
    ],
    transitions: [],
    phases: [
      { id: 'ph-dev', name: 'Development', order: 0 },
      { id: 'ph-prod', name: 'Production', order: 1 },
    ],
    changeActionMappings: {
      release: {
        fromState: 'req-draft',
        toState: 'req-released',
        assignsRevision: true,
      },
      obsolete: {
        fromState: 'req-released',
        toState: 'req-obsolete',
        assignsRevision: false,
      },
      promote: {
        fromState: 'req-review',
        toState: 'req-released',
        assignsRevision: true,
      },
    },
    lifecycleType: 'Driven',
    applicableItemTypes: ['Task'],
  }

  beforeAll(async () => {
    await testDb.setup()

    await testDb.db
      .insert(lifecycleDefinitions)
      .values({
        id: REQ_LIFECYCLE_ID,
        name: 'Task Lifecycle - State ID Test',
        version: 1,
        workflowType: 'strict',
        definition: reqLifecycleDefinition,
        isActive: true,
        lifecycleType: 'Driven',
      })
      .onConflictDoUpdate({
        target: lifecycleDefinitions.id,
        set: {
          definition: reqLifecycleDefinition,
          lifecycleType: 'Driven',
          isActive: true,
        },
      })

    restoreItemTypeConfig = await overrideItemTypeConfig(
      testDb.db,
      'Task',
      { lifecycleDefinitionId: REQ_LIFECYCLE_ID },
      SYSTEM_USER_ID,
    )

    await ItemTypeRegistry.reload()
  })

  afterAll(async () => {
    // Shared row: put back what this suite found before it wrote.
    await restoreItemTypeConfig?.()
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  it('getInitialStateId returns the initial state ID, not its name', async () => {
    const initial = await LifecycleService.getInitialStateId('Task')
    expect(initial).toBe('req-draft')
  })

  it('canApplyAction matches the current state by ID only', async () => {
    const byId = await LifecycleService.canApplyAction(
      'Task',
      'req-draft',
      'release',
    )
    expect(byId.valid).toBe(true)

    // The display name is not an identity — an item claiming to be in
    // "Draft" (the name) is not in 'req-draft' (the ID)
    const byName = await LifecycleService.canApplyAction(
      'Task',
      'Draft',
      'release',
    )
    expect(byName.valid).toBe(false)
  })

  it('resolves mapping targets and phases by ID', async () => {
    const target = await LifecycleService.getTargetState('Task', 'release')
    expect(target).toBe('req-released')

    const lifecycle = await LifecycleService.getLifecycleForItemType('Task')
    expect(lifecycle).not.toBeNull()

    const phase = LifecycleService.getPhaseForState(lifecycle!, 'req-released')
    expect(phase?.id).toBe('ph-prod')

    // Names no longer resolve phases
    const byName = LifecycleService.getPhaseForState(lifecycle!, 'Released')
    expect(byName).toBeUndefined()
  })

  it('validates promote across phases with ID-keyed mappings', async () => {
    const result = await LifecycleService.canApplyAction(
      'Task',
      'req-review',
      'promote',
    )
    expect(result.valid).toBe(true)
  })

  it('creates items in the initial state ID', async () => {
    const user = await insertTestUser(testDb.db)
    const created = await ItemService.create(
      'Task',
      {
        itemNumber: `REQ-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        revision: 'A',
        name: 'State Identity Task',
      } as any,
      user.id,
    )

    expect(created.state).toBe('req-draft')
  })
})

describe('LifecycleService.resolveActionTarget', () => {
  const testDb = new TestDatabase()
  let restoreItemTypeConfig: (() => Promise<void>) | undefined

  // This file claims the 'TestCase' item type for its numeric-scheme fixture
  const NUMERIC_LIFECYCLE_ID = '00000000-0000-4000-8000-000000000317'

  const numericLifecycleDefinition = {
    states: [
      { id: 'tc-draft', name: 'Draft', isInitial: true, phaseId: 'ph-proto' },
      { id: 'tc-qualified', name: 'Qualified', phaseId: 'ph-prod' },
      { id: 'tc-retired', name: 'Retired', isFinal: true, phaseId: 'ph-prod' },
    ],
    transitions: [],
    phases: [
      { id: 'ph-proto', name: 'Prototype', order: 0 },
      {
        id: 'ph-prod',
        name: 'Production',
        order: 1,
        resetRevisionOnEntry: true,
        revisionScheme: { type: 'alpha' },
      },
    ],
    revisionScheme: { type: 'numeric' },
    changeActionMappings: {
      release: {
        fromState: 'tc-draft',
        toState: 'tc-qualified',
        assignsRevision: true,
      },
      revise: {
        fromState: 'tc-qualified',
        newVersionState: 'tc-qualified',
        oldVersionState: 'tc-retired',
        assignsRevision: true,
      },
      obsolete: {
        fromState: 'tc-qualified',
        toState: 'tc-retired',
        assignsRevision: false,
      },
      promote: {
        fromState: 'tc-draft',
        toState: 'tc-qualified',
        assignsRevision: true,
      },
    },
    lifecycleType: 'Driven',
    applicableItemTypes: ['TestCase'],
  }

  beforeAll(async () => {
    await testDb.setup()

    await testDb.db
      .insert(lifecycleDefinitions)
      .values({
        id: NUMERIC_LIFECYCLE_ID,
        name: 'TestCase Lifecycle - Numeric Scheme',
        version: 1,
        workflowType: 'strict',
        definition: numericLifecycleDefinition,
        isActive: true,
        lifecycleType: 'Driven',
      })
      .onConflictDoUpdate({
        target: lifecycleDefinitions.id,
        set: {
          definition: numericLifecycleDefinition,
          lifecycleType: 'Driven',
          isActive: true,
        },
      })

    restoreItemTypeConfig = await overrideItemTypeConfig(
      testDb.db,
      'TestCase',
      { lifecycleDefinitionId: NUMERIC_LIFECYCLE_ID },
      SYSTEM_USER_ID,
    )

    await ItemTypeRegistry.reload()
  })

  afterAll(async () => {
    // Shared row: put back what this suite found before it wrote.
    await restoreItemTypeConfig?.()
    await testDb.teardown()
  })

  it('follows the lifecycle revision scheme, not the alpha default', async () => {
    // The client-side predictor this replaced knew only single-letter alpha:
    // it answered '3.1' here and '[' for an item at revision Z.
    const revised = await LifecycleService.resolveActionTarget(
      'TestCase',
      'revise',
      '3',
    )

    expect(revised).toEqual({
      toState: 'tc-qualified',
      revision: '4',
      assignsRevision: true,
    })
  })

  it('rolls Z over to AA under an alpha scheme', async () => {
    const revised = await LifecycleService.resolveActionTarget(
      'Part',
      'revise',
      'Z',
    )

    expect(revised?.revision).toBe('AA')
  })

  it('targets the state the revise mapping names for the new version', async () => {
    const revised = await LifecycleService.resolveActionTarget(
      'TestCase',
      'revise',
      '1',
    )

    // newVersionState, never the release action's toState
    expect(revised?.toState).toBe('tc-qualified')
  })

  it('gives a first release the scheme initial, and leaves a real one alone', async () => {
    const fresh = await LifecycleService.resolveActionTarget(
      'TestCase',
      'release',
      '-abc12345',
    )
    expect(fresh?.revision).toBe('1')

    const alreadyNumbered = await LifecycleService.resolveActionTarget(
      'TestCase',
      'release',
      '2',
    )
    expect(alreadyNumbered?.revision).toBe('2')
  })

  it('resets the revision when a promote enters a phase that says so', async () => {
    // The target phase sets resetRevisionOnEntry and overrides the scheme to
    // alpha, so a promote out of Prototype restarts at A rather than counting on
    const promoted = await LifecycleService.resolveActionTarget(
      'TestCase',
      'promote',
      '7',
    )

    expect(promoted).toEqual({
      toState: 'tc-qualified',
      revision: 'A',
      assignsRevision: true,
    })
  })

  it('keeps the current revision for an action that assigns none', async () => {
    const obsoleted = await LifecycleService.resolveActionTarget(
      'TestCase',
      'obsolete',
      '5',
    )

    expect(obsoleted).toEqual({
      toState: 'tc-retired',
      revision: '5',
      assignsRevision: false,
    })
  })

  it('returns null for an action the lifecycle does not configure', async () => {
    // 'Part' has no promote mapping in the shared fixture
    expect(
      await LifecycleService.resolveActionTarget('Part', 'promote', 'A'),
    ).toBeNull()
    // and an item type with no lifecycle at all resolves nothing
    expect(
      await LifecycleService.resolveActionTarget('Nonexistent', 'release', 'A'),
    ).toBeNull()
  })
})

describe('lifecycle definition memoization', () => {
  const testDb = new TestDatabase()
  let restoreItemTypeConfig: (() => Promise<void>) | undefined

  // This file claims the 'Issue' item type elsewhere; use its own here
  const MEMO_LIFECYCLE_ID = '00000000-0000-4000-8000-000000000318'

  function definitionWithReleaseState(toState: string) {
    return {
      states: [
        { id: 'memo-draft', name: 'Draft', isInitial: true },
        { id: 'memo-a', name: 'State A' },
        { id: 'memo-b', name: 'State B' },
      ],
      transitions: [],
      changeActionMappings: {
        release: {
          fromState: 'memo-draft',
          toState,
          assignsRevision: true,
        },
      },
      lifecycleType: 'Driven',
      applicableItemTypes: ['TestPlan'],
    }
  }

  beforeAll(async () => {
    await testDb.setup()

    await testDb.db
      .insert(lifecycleDefinitions)
      .values({
        id: MEMO_LIFECYCLE_ID,
        name: 'TestPlan Lifecycle - Memo Test',
        version: 1,
        workflowType: 'strict',
        definition: definitionWithReleaseState('memo-a'),
        isActive: true,
        lifecycleType: 'Driven',
      })
      .onConflictDoUpdate({
        target: lifecycleDefinitions.id,
        set: {
          definition: definitionWithReleaseState('memo-a'),
          lifecycleType: 'Driven',
          isActive: true,
        },
      })

    restoreItemTypeConfig = await overrideItemTypeConfig(
      testDb.db,
      'TestPlan',
      { lifecycleDefinitionId: MEMO_LIFECYCLE_ID },
      SYSTEM_USER_ID,
    )

    await ItemTypeRegistry.reload()
  })

  afterAll(async () => {
    // Shared row: put back what this suite found before it wrote.
    await restoreItemTypeConfig?.()
    await testDb.teardown()
  })

  /**
   * The registry memoizes lifecycle definitions so a release stops re-reading
   * the same row hundreds of times. The risk that buys is staleness: an edit
   * that does not drop the memo would be invisible until the process restarted.
   * `LifecycleDefinitionService.update` is the production edit path.
   */
  it('sees a lifecycle edit made through LifecycleDefinitionService', async () => {
    expect(await LifecycleService.getTargetState('TestPlan', 'release')).toBe(
      'memo-a',
    )

    const existing = await LifecycleDefinitionService.getById(MEMO_LIFECYCLE_ID)
    await LifecycleDefinitionService.update(MEMO_LIFECYCLE_ID, {
      name: existing!.name,
      states: existing!.states,
      transitions: existing!.transitions ?? [],
      changeActionMappings: {
        release: {
          fromState: 'memo-draft',
          toState: 'memo-b',
          assignsRevision: true,
        },
      },
    })

    expect(await LifecycleService.getTargetState('TestPlan', 'release')).toBe(
      'memo-b',
    )
  })
})
