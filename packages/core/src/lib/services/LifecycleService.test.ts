// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * LifecycleService Free-lifecycle transition tests
 *
 * Data-integrity and security tests (three-gate rule) for the Free-lifecycle
 * transition path (remediation WI-2.2): the only sanctioned write path for
 * Free-lifecycle item state. Covers lazy instance creation, history,
 * display-name targets, undefined-transition rejection, Driven-type refusal,
 * reopen semantics (terminality is Driving-only), and legacy state adoption.
 *
 * Run: npx vitest run src/lib/services/LifecycleService.test.ts
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
import { WorkflowService } from '../workflows/WorkflowService'
import { LifecycleService } from './LifecycleService'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import {
  insertTestPart,
  insertTestRequirement,
} from '@/__tests__/fixtures/items'
import { workflowDefinitions } from '@/lib/db/schema/workflows'
import { items } from '@/lib/db/schema'
import { ItemTypeRegistry } from '@/lib/items/registry'
import {
  SYSTEM_USER_ID,
  overrideItemTypeConfig,
  seedStandardPartLifecycle,
} from '@/__tests__/fixtures/lifecycles'
import { ValidationError } from '@/lib/errors'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

// Unique ID for this file's Free lifecycle — avoids races with other test
// files that configure their own lifecycles against the shared DB
const FREE_LIFECYCLE_ID = '00000000-0000-4000-8000-000000000312'

const freeLifecycleDefinition = {
  states: [
    { id: 'Open', name: 'Open', isInitial: true },
    { id: 'InProgress', name: 'In Progress' },
    { id: 'Closed', name: 'Closed', isFinal: true },
  ],
  transitions: [
    {
      id: 't1',
      name: 'Start Work',
      fromStateId: 'Open',
      toStateId: 'InProgress',
    },
    { id: 't2', name: 'Close', fromStateId: 'InProgress', toStateId: 'Closed' },
    { id: 't3', name: 'Reopen', fromStateId: 'Closed', toStateId: 'Open' },
  ],
  // Deliberately NO legacy definitionType: this suite doubles as proof that
  // registry resolution and the Free-transition path work from lifecycleType
  // alone (remediation WI-3.3)
  lifecycleType: 'Free',
  applicableItemTypes: ['Issue'],
}

describe('LifecycleService Free-lifecycle transitions', () => {
  const testDb = new TestDatabase()
  let restoreItemTypeConfig: (() => Promise<void>) | undefined
  let user: TestUser
  let uniquePrefix: string

  beforeAll(async () => {
    await testDb.setup()
    await seedStandardPartLifecycle(testDb.db)

    await testDb.db
      .insert(workflowDefinitions)
      .values({
        id: FREE_LIFECYCLE_ID,
        name: 'Issue Lifecycle - LifecycleService Test',
        version: 1,
        workflowType: 'strict',
        definition: freeLifecycleDefinition,
        isActive: true,
        lifecycleType: 'Free',
      })
      .onConflictDoUpdate({
        target: workflowDefinitions.id,
        set: {
          definition: freeLifecycleDefinition,
          lifecycleType: 'Free',
          isActive: true,
        },
      })

    restoreItemTypeConfig = await overrideItemTypeConfig(
      testDb.db,
      'Issue',
      { lifecycleDefinitionId: FREE_LIFECYCLE_ID },
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
    uniquePrefix = `LC-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    user = await insertTestUser(testDb.db)
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  async function createIssue() {
    return ItemService.create(
      'Issue',
      {
        itemNumber: `ISS-${uniquePrefix}-${Math.random().toString(36).slice(2, 6)}`,
        revision: 'A',
        name: 'Test Issue',
        state: 'Open',
      } as any,
      user.id,
    )
  }

  it('transitions a Free item, creating the instance lazily and recording history', async () => {
    const issue = await createIssue()

    const result = await LifecycleService.transitionFreeItem(
      issue.id,
      'InProgress',
      user.id,
    )

    expect(result.toStateId).toBe('InProgress')

    const updated = await ItemService.findById(issue.id)
    expect(updated?.state).toBe('InProgress')

    const instance = await WorkflowService.getInstanceByItemId(issue.id)
    expect(instance?.currentState).toBe('InProgress')

    const history = await WorkflowService.getHistory(instance!.id)
    expect(history.some((h) => h.toState === 'InProgress')).toBe(true)
  })

  it('accepts the target state by display name', async () => {
    const issue = await createIssue()

    const result = await LifecycleService.transitionFreeItem(
      issue.id,
      'In Progress',
      user.id,
    )

    expect(result.toStateId).toBe('InProgress')
  })

  it('rejects transitions the lifecycle does not define', async () => {
    const issue = await createIssue()

    // Open -> Closed has no edge; only Open -> InProgress -> Closed
    await expect(
      LifecycleService.transitionFreeItem(issue.id, 'Closed', user.id),
    ).rejects.toThrow(ValidationError)

    const untouched = await ItemService.findById(issue.id)
    expect(untouched?.state).toBe('Open')
  })

  it('refuses to move a Driven item into released lineage by hand', async () => {
    const { item: part } = await insertTestPart(testDb.db, null, user.id, {
      itemNumber: `PN-${uniquePrefix}`,
    })

    // 'Released' is in the Part lifecycle's released family: entered only by
    // a change-order release, never by a manual transition
    await expect(
      LifecycleService.transitionFreeItem(part.id, 'Released', user.id),
    ).rejects.toThrow(ValidationError)
  })

  // A Driven lifecycle may declare manual edges among its pre-release states
  // (review progress); the released family stays change-order-only in both
  // directions. The default Requirement lifecycle is the shipped example.
  describe('Driven lifecycles with declared pre-release transitions', () => {
    // Inserted directly (the fixture bypasses the create schema, which wants a
    // design); state is set straight on the row for the released case
    async function createRequirement(state?: string) {
      const { item } = await insertTestRequirement(testDb.db, null, user.id, {
        itemNumber: `REQ-${uniquePrefix}-${Math.random().toString(36).slice(2, 7)}`,
      })
      if (state) {
        await testDb.db
          .update(items)
          .set({ state })
          .where(eq(items.id, item.id))
      }
      return { ...item, state: state ?? item.state }
    }

    it('walks the declared review edges and offers only those', async () => {
      const req = await createRequirement()
      expect(req.state).toBe('Draft')

      const offered = await LifecycleService.getAvailableFreeTransitions(req.id)
      expect(offered.lifecycleType).toBe('Driven')
      expect(offered.transitions.map((t) => t.toStateId)).toEqual(['Proposed'])

      await LifecycleService.transitionFreeItem(req.id, 'Proposed', user.id)
      await LifecycleService.transitionFreeItem(req.id, 'Approved', user.id)
      expect((await ItemService.findById(req.id))?.state).toBe('Approved')

      // From Approved the only manual edge is Rework; Released is a release
      // target and is never offered
      const fromApproved = await LifecycleService.getAvailableFreeTransitions(
        req.id,
      )
      expect(fromApproved.transitions.map((t) => t.toStateId)).toEqual([
        'Draft',
      ])
      await expect(
        LifecycleService.transitionFreeItem(req.id, 'Released', user.id),
      ).rejects.toThrow(ValidationError)
    })

    it('cannot transition released lineage by hand', async () => {
      const released = await createRequirement('Released')

      const offered = await LifecycleService.getAvailableFreeTransitions(
        released.id,
      )
      expect(offered.transitions).toEqual([])
      await expect(
        LifecycleService.transitionFreeItem(released.id, 'Draft', user.id),
      ).rejects.toThrow(ValidationError)
    })
  })

  it('reopens a completed Free workflow (terminality is Driving-only)', async () => {
    const issue = await createIssue()
    await LifecycleService.transitionFreeItem(issue.id, 'InProgress', user.id)
    await LifecycleService.transitionFreeItem(issue.id, 'Closed', user.id)

    let instance = await WorkflowService.getInstanceByItemId(issue.id)
    expect(instance?.completedAt).toBeDefined()

    await LifecycleService.transitionFreeItem(issue.id, 'Open', user.id)

    instance = await WorkflowService.getInstanceByItemId(issue.id)
    expect(instance?.currentState).toBe('Open')
    expect(instance?.completedAt).toBeUndefined()

    const reopened = await ItemService.findById(issue.id)
    expect(reopened?.state).toBe('Open')
  })

  it('adopts an item state written before the endpoint existed', async () => {
    const issue = await createIssue()

    // Simulate a legacy direct write: state advanced with no instance
    await testDb.db
      .update(items)
      .set({ state: 'InProgress' })
      .where(eq(items.id, issue.id))

    await LifecycleService.transitionFreeItem(issue.id, 'Closed', user.id)

    const instance = await WorkflowService.getInstanceByItemId(issue.id)
    expect(instance?.currentState).toBe('Closed')

    const history = await WorkflowService.getHistory(instance!.id)
    expect(history.some((h) => h.action === 'state_adopted')).toBe(true)
  })

  it('lists available transitions for the current state only', async () => {
    const issue = await createIssue()

    const available = await LifecycleService.getAvailableFreeTransitions(
      issue.id,
    )

    expect(available.lifecycleType).toBe('Free')
    expect(available.currentStateId).toBe('Open')
    expect(available.transitions.map((t) => t.toStateId)).toEqual([
      'InProgress',
    ])
  })

  it('returns no transitions for Driven item types', async () => {
    const { item: part } = await insertTestPart(testDb.db, null, user.id, {
      itemNumber: `PN-${uniquePrefix}-D`,
    })

    const available = await LifecycleService.getAvailableFreeTransitions(
      part.id,
    )

    expect(available.lifecycleType).toBe('Driven')
    expect(available.transitions).toEqual([])
  })
})

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
        .insert(workflowDefinitions)
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
      .insert(workflowDefinitions)
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
        target: workflowDefinitions.id,
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
      .update(workflowDefinitions)
      .set({ drivers: [] })
      .where(eq(workflowDefinitions.id, TOOL_LIFECYCLE_ID))

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
      .insert(workflowDefinitions)
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
        target: workflowDefinitions.id,
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
      .insert(workflowDefinitions)
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
        target: workflowDefinitions.id,
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
      .insert(workflowDefinitions)
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
        target: workflowDefinitions.id,
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
   * `WorkflowService.update` is the production edit path.
   */
  it('sees a lifecycle edit made through WorkflowService', async () => {
    expect(await LifecycleService.getTargetState('TestPlan', 'release')).toBe(
      'memo-a',
    )

    const existing = await WorkflowService.getById(MEMO_LIFECYCLE_ID)
    await WorkflowService.update(MEMO_LIFECYCLE_ID, {
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
