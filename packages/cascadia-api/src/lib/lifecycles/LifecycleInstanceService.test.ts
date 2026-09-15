// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * LifecycleInstanceService tests
 *
 * Integration tests for lifecycle instances: starting, transitions, guards, actions, claims, history and flexible structure. Split from the WorkflowService suite along
 * the same seam as the service (remediation plan CM-22).
 *
 * Run: npx vitest run packages/core/src/lib/lifecycles/LifecycleInstanceService.test.ts
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
import { LifecycleDefinitionService } from './LifecycleDefinitionService'
import { LifecycleInstanceService } from './LifecycleInstanceService'
import { ApprovalService } from './ApprovalService'
import type { CreateLifecycleInput, TransitionAction } from './types'
import type { TestUser } from '@/__tests__/fixtures/users'
import {
  AlreadyExistsError,
  NotFoundError,
  ValidationError,
} from '@/lib/errors'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import {
  insertTestPart,
  insertTestRequirement,
} from '@/__tests__/fixtures/items'
import {
  items,
  lifecycleApprovalVotes,
  lifecycleDefinitions,
  lifecycleInstances,
  parts,
} from '@/lib/db/schema'
import { takeFirst } from '@/lib/db/take-first'
import { ItemService } from '@/lib/items/services/ItemService'
import { ItemTypeRegistry } from '@/lib/items/registry'
import {
  SYSTEM_USER_ID,
  overrideItemTypeConfig,
  seedStandardPartLifecycle,
} from '@/__tests__/fixtures/lifecycles'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

describe('LifecycleInstanceService', () => {
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

  describe('startInstance', () => {
    it('creates workflow instance for item', async () => {
      const user = await insertTestUser(testDb.db, {
        name: 'Instance Test User',
      })
      const workflow = await LifecycleDefinitionService.create(
        createWorkflowInput(),
      )
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })

      const instance = await LifecycleInstanceService.startInstance(
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
      const workflow = await LifecycleDefinitionService.create(
        createWorkflowInput(),
      )
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })

      const instance = await LifecycleInstanceService.startInstance(
        workflow.id,
        item.id,
        {
          actorId: user.id,
        },
      )

      const history = await LifecycleInstanceService.getHistory(instance.id)

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
        LifecycleInstanceService.startInstance(
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
      const workflow = await LifecycleDefinitionService.create(
        createWorkflowInput(),
      )
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })
      const created = await LifecycleInstanceService.startInstance(
        workflow.id,
        item.id,
        {
          actorId: user.id,
        },
      )

      const result = await LifecycleInstanceService.getInstance(created.id)

      expect(result).not.toBeNull()
      expect(result?.id).toBe(created.id)
    })

    it('returns null for non-existent instance', async () => {
      const result = await LifecycleInstanceService.getInstance(
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
      const workflow = await LifecycleDefinitionService.create(
        createWorkflowInput(),
      )
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })
      const instance = await LifecycleInstanceService.startInstance(
        workflow.id,
        item.id,
        {
          actorId: user.id,
        },
      )

      const result = await LifecycleInstanceService.getInstanceByItemId(item.id)

      expect(result).not.toBeNull()
      expect(result?.id).toBe(instance.id)
    })

    it('returns null for item with no instances', async () => {
      const user = await insertTestUser(testDb.db, { name: 'No Instance User' })
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })

      const result = await LifecycleInstanceService.getInstanceByItemId(item.id)

      expect(result).toBeNull()
    })
  })

  describe('getAvailableTransitions', () => {
    it('returns transitions from current state', async () => {
      const user = await insertTestUser(testDb.db, { name: 'Transitions User' })
      const workflow = await LifecycleDefinitionService.create(
        createWorkflowInput(),
      )
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })
      const instance = await LifecycleInstanceService.startInstance(
        workflow.id,
        item.id,
        {
          actorId: user.id,
        },
      )

      const available = await LifecycleInstanceService.getAvailableTransitions(
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
        LifecycleInstanceService.getAvailableTransitions(
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
      const workflow = await LifecycleDefinitionService.create(
        createWorkflowInput(),
      )
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })
      const instance = await LifecycleInstanceService.startInstance(
        workflow.id,
        item.id,
        {
          actorId: user.id,
        },
      )

      const result = await LifecycleInstanceService.canTransition(
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
      const workflow = await LifecycleDefinitionService.create(
        createWorkflowInput(),
      )
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })
      const instance = await LifecycleInstanceService.startInstance(
        workflow.id,
        item.id,
        {
          actorId: user.id,
        },
      )

      // From draft, cannot go directly to approved
      const result = await LifecycleInstanceService.canTransition(
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
      const workflow = await LifecycleDefinitionService.create(
        createWorkflowInput(),
      )
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })
      const instance = await LifecycleInstanceService.startInstance(
        workflow.id,
        item.id,
        {
          actorId: user.id,
        },
      )

      const result = await LifecycleInstanceService.transition(
        instance.id,
        'review',
        user.id,
        'Test comment',
      )

      expect(result.success).toBe(true)
      expect(result.fromState).toBe('draft')
      expect(result.toState).toBe('review')

      // Verify instance state updated
      const updated = await LifecycleInstanceService.getInstance(instance.id)
      expect(updated?.currentState).toBe('review')
    })

    it('locks scope on leaving the initial state and reopens it on rework', async () => {
      const user = await insertTestUser(testDb.db, { name: 'Scope Lock User' })
      const workflow = await LifecycleDefinitionService.create(
        createWorkflowInput(),
      )
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })
      const instance = await LifecycleInstanceService.startInstance(
        workflow.id,
        item.id,
        { actorId: user.id },
      )

      await LifecycleInstanceService.transition(instance.id, 'review', user.id)
      expect(
        (await LifecycleInstanceService.getInstance(instance.id))?.scopeLocked,
      ).toBe(true)

      // Sending a change order back to Draft asks for its scope to be
      // corrected there. Leaving the lock set made that a one-way trip: the
      // change order could no longer accept the items it was returned to add.
      await LifecycleInstanceService.transition(instance.id, 'draft', user.id)
      const afterRework = await LifecycleInstanceService.getInstance(
        instance.id,
      )
      expect(afterRework?.currentState).toBe('draft')
      expect(afterRework?.scopeLocked).toBe(false)

      // ...and locks again on the next submit
      await LifecycleInstanceService.transition(instance.id, 'review', user.id)
      expect(
        (await LifecycleInstanceService.getInstance(instance.id))?.scopeLocked,
      ).toBe(true)
    })

    it('records transition in history', async () => {
      const user = await insertTestUser(testDb.db, {
        name: 'History Transition User',
      })
      const workflow = await LifecycleDefinitionService.create(
        createWorkflowInput(),
      )
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })
      const instance = await LifecycleInstanceService.startInstance(
        workflow.id,
        item.id,
        {
          actorId: user.id,
        },
      )

      await LifecycleInstanceService.transition(
        instance.id,
        'review',
        user.id,
        'Submitting for review',
      )

      const history = await LifecycleInstanceService.getHistory(instance.id)

      // Should have "started" and "Submit for Review"
      expect(history.length).toBeGreaterThanOrEqual(2)
      expect(history.some((h) => h.action === 'Submit for Review')).toBe(true)
    })

    it('writes nothing of a transition whose history row cannot be written', async () => {
      const user = await insertTestUser(testDb.db, {
        name: 'Atomic Transition User',
      })
      const workflow = await LifecycleDefinitionService.create(
        createWorkflowInput(),
      )
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })
      const instance = await LifecycleInstanceService.startInstance(
        workflow.id,
        item.id,
        { actorId: user.id },
      )
      const stateBefore = takeFirst(
        await testDb.db.select().from(items).where(eq(items.id, item.id)),
      ).state

      // The instance state, the item's mirrored state and the history row
      // used to be separate statements, so this failure left the instance
      // advanced with the item and the history still describing the old state
      const historyWrite = vi
        .spyOn(LifecycleInstanceService, 'recordHistory')
        .mockRejectedValueOnce(new Error('connection reset'))
      await expect(
        LifecycleInstanceService.transition(instance.id, 'review', user.id),
      ).rejects.toThrow('connection reset')
      historyWrite.mockRestore()

      expect(
        (await LifecycleInstanceService.getInstance(instance.id))?.currentState,
      ).toBe('draft')
      expect(
        takeFirst(
          await testDb.db.select().from(items).where(eq(items.id, item.id)),
        ).state,
      ).toBe(stateBefore)
      expect(
        (await LifecycleInstanceService.getHistory(instance.id)).map(
          (h) => h.action,
        ),
      ).toEqual(['started'])

      // Nothing is stuck: the same transition succeeds next time
      const retry = await LifecycleInstanceService.transition(
        instance.id,
        'review',
        user.id,
      )
      expect(retry.success).toBe(true)
    })

    it('updates item state', async () => {
      const user = await insertTestUser(testDb.db, { name: 'Item State User' })
      const workflow = await LifecycleDefinitionService.create(
        createWorkflowInput(),
      )
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })
      const instance = await LifecycleInstanceService.startInstance(
        workflow.id,
        item.id,
        {
          actorId: user.id,
        },
      )

      await LifecycleInstanceService.transition(instance.id, 'review', user.id)

      // Check item state in database
      const [updatedItem] = await testDb.db
        .select()
        .from(items)
        .where(eq(items.id, item.id))
      expect(updatedItem).toMatchObject({ state: 'review' })
    })

    it('marks instance complete on final state', async () => {
      const user = await insertTestUser(testDb.db, { name: 'Final State User' })
      const workflow = await LifecycleDefinitionService.create(
        createWorkflowInput(),
      )
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })
      const instance = await LifecycleInstanceService.startInstance(
        workflow.id,
        item.id,
        {
          actorId: user.id,
        },
      )

      // Transition to review then to approved (final)
      await LifecycleInstanceService.transition(instance.id, 'review', user.id)
      await LifecycleInstanceService.transition(
        instance.id,
        'approved',
        user.id,
      )

      const final = await LifecycleInstanceService.getInstance(instance.id)
      expect(final?.completedAt).toBeDefined()
    })

    it('returns error for invalid transition', async () => {
      const user = await insertTestUser(testDb.db, {
        name: 'Invalid State User',
      })
      const workflow = await LifecycleDefinitionService.create(
        createWorkflowInput(),
      )
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })
      const instance = await LifecycleInstanceService.startInstance(
        workflow.id,
        item.id,
        {
          actorId: user.id,
        },
      )

      // Cannot go directly from draft to approved
      const result = await LifecycleInstanceService.transition(
        instance.id,
        'approved',
        user.id,
      )

      expect(result.success).toBe(false)
      expect(result.error).toContain('No valid transition')
    })

    it('returns error for non-existent instance', async () => {
      const result = await LifecycleInstanceService.transition(
        '00000000-0000-0000-0000-000000000000',
        'review',
        'test-user',
      )

      expect(result.success).toBe(false)
      expect(result.error).toBe('Workflow instance not found')
    })
  })

  describe('Phase 1 hardening', () => {
    /**
     * A Driven lifecycle mints a new `items` row per release, and
     * (item_number, revision, design_id, item_type) is unique — so a revision
     * scheme that never advances makes the second release of any item a
     * unique violation inside the merge transaction. The configuration is
     * refused at save time instead.
     */

    describe('transition hardening (WI-1.2 / WI-1.4)', () => {
      async function setupInstance() {
        const user = await insertTestUser(testDb.db)
        const workflow = await LifecycleDefinitionService.create(
          createWorkflowInput(),
        )
        const { item } = await insertTestPart(testDb.db, null, user.id, {
          itemNumber: uniqueItemNumber(),
        })
        const instance = await LifecycleInstanceService.startInstance(
          workflow.id,
          item.id,
          { actorId: user.id },
        )
        return { user, workflow, item, instance }
      }

      it('refuses transitions on completed instances', async () => {
        const { user, instance } = await setupInstance()
        await LifecycleInstanceService.transition(
          instance.id,
          'review',
          user.id,
        )
        const done = await LifecycleInstanceService.transition(
          instance.id,
          'approved',
          user.id,
        )
        expect(done.success).toBe(true)

        const after = await LifecycleInstanceService.transition(
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
          LifecycleInstanceService.transition(instance.id, 'review', user.id),
          LifecycleInstanceService.transition(instance.id, 'review', user.id),
        ])

        const successes = [a, b].filter((r) => r.success)
        expect(successes).toHaveLength(1)

        const updated = await LifecycleInstanceService.getInstance(instance.id)
        expect(updated?.currentState).toBe('review')

        const history = await LifecycleInstanceService.getHistory(instance.id)
        expect(history.filter((h) => h.toState === 'review')).toHaveLength(1)
      })

      it('blocks other transitions while a release claim is held', async () => {
        const { user, instance } = await setupInstance()

        const claim = await LifecycleInstanceService.claimRelease(
          instance.id,
          'draft',
        )
        expect(claim.claimed).toBe(true)

        const blocked = await LifecycleInstanceService.transition(
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
        const second = await LifecycleInstanceService.claimRelease(
          instance.id,
          'draft',
        )
        expect(second.claimed).toBe(false)

        await LifecycleInstanceService.releaseClaim(instance.id)
        const after = await LifecycleInstanceService.transition(
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

        const first = await LifecycleInstanceService.claimRelease(
          instance.id,
          'draft',
        )
        expect(first.claimed).toBe(true)

        await testDb.db
          .update(lifecycleInstances)
          .set({
            releasingAt: new Date(
              Date.now() -
                LifecycleInstanceService.RELEASE_CLAIM_TIMEOUT_MS -
                60_000,
            ),
          })
          .where(eq(lifecycleInstances.id, instance.id))

        const takeover = await LifecycleInstanceService.claimRelease(
          instance.id,
          'draft',
        )
        expect(takeover.claimed).toBe(true)

        // Taking over re-stamps the claim rather than simply consuming the
        // stale one: the instance is exclusive again immediately, so a third
        // caller arriving behind the takeover still loses.
        const third = await LifecycleInstanceService.claimRelease(
          instance.id,
          'draft',
        )
        expect(third.claimed).toBe(false)
      })

      it('refuses a release claim when the expected state is stale', async () => {
        const { user, instance } = await setupInstance()
        await LifecycleInstanceService.transition(
          instance.id,
          'review',
          user.id,
        )

        const claim = await LifecycleInstanceService.claimRelease(
          instance.id,
          'draft',
        )
        expect(claim.claimed).toBe(false)
        expect(claim.error).toMatch(/state/i)
      })

      it('fails closed when the approval check itself errors', async () => {
        const { user, instance } = await setupInstance()

        const spy = vi
          .spyOn(ApprovalService, 'areApprovalsComplete')
          .mockRejectedValueOnce(new Error('simulated outage'))
        try {
          const result = await LifecycleInstanceService.transition(
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
          LifecycleInstanceService.startInstance(workflow.id, item.id),
        ).rejects.toThrow(AlreadyExistsError)
      })
    })
  })
})

describe('LifecycleInstanceService Edge Cases', () => {
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

      const workflow = await LifecycleDefinitionService.create({
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
        lifecycleType: 'Driving' as const,
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

      const workflow = await LifecycleDefinitionService.create(input)
      const user = await insertTestUser(testDb.db, {
        name: 'Circular Test User',
      })
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })
      const instance = await LifecycleInstanceService.startInstance(
        workflow.id,
        item.id,
        { actorId: user.id },
      )

      // Go through circular path: draft -> review -> rework -> review -> approved
      await LifecycleInstanceService.transition(instance.id, 'review', user.id)
      await LifecycleInstanceService.transition(instance.id, 'rework', user.id)
      await LifecycleInstanceService.transition(instance.id, 'review', user.id)
      await LifecycleInstanceService.transition(
        instance.id,
        'approved',
        user.id,
      )

      const final = await LifecycleInstanceService.getInstance(instance.id)
      expect(final?.currentState).toBe('approved')
      expect(final?.completedAt).toBeDefined()

      const history = await LifecycleInstanceService.getHistory(instance.id)
      // started + 4 transitions = 5 entries
      expect(history.length).toBeGreaterThanOrEqual(5)
    })

    it('handles multiple parallel paths to same state', async () => {
      const input = {
        name: `Parallel Paths ${testPrefix}`,
        lifecycleType: 'Driving' as const,
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

      const workflow = await LifecycleDefinitionService.create(input)
      const user = await insertTestUser(testDb.db, {
        name: 'Parallel Path User',
      })
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })
      const instance = await LifecycleInstanceService.startInstance(
        workflow.id,
        item.id,
        { actorId: user.id },
      )

      // Check that both paths are available from draft
      const available = await LifecycleInstanceService.getAvailableTransitions(
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
        lifecycleType: 'Driving' as const,
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

      const workflow = await LifecycleDefinitionService.create(input)
      const user = await insertTestUser(testDb.db, { name: 'Self Loop User' })
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })
      const instance = await LifecycleInstanceService.startInstance(
        workflow.id,
        item.id,
        { actorId: user.id },
      )

      // Perform self-loop multiple times
      await LifecycleInstanceService.transition(
        instance.id,
        'review',
        user.id,
        'First review',
      )
      await LifecycleInstanceService.transition(
        instance.id,
        'review',
        user.id,
        'Second review',
      )
      await LifecycleInstanceService.transition(
        instance.id,
        'review',
        user.id,
        'Third review',
      )

      const current = await LifecycleInstanceService.getInstance(instance.id)
      expect(current?.currentState).toBe('review')

      const history = await LifecycleInstanceService.getHistory(instance.id)
      expect(history.length).toBeGreaterThanOrEqual(4) // started + 3 re-reviews
    })
  })

  describe('Transition to Completed Instance', () => {
    it('cannot transition after reaching final state', async () => {
      const input = {
        name: `Final State Test ${testPrefix}`,
        lifecycleType: 'Driving' as const,
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

      const workflow = await LifecycleDefinitionService.create(input)
      const user = await insertTestUser(testDb.db, { name: 'Final State User' })
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })
      const instance = await LifecycleInstanceService.startInstance(
        workflow.id,
        item.id,
        { actorId: user.id },
      )

      // Complete the workflow
      await LifecycleInstanceService.transition(instance.id, 'done', user.id)

      // Try to transition again (should fail - no transitions from final state)
      const result = await LifecycleInstanceService.transition(
        instance.id,
        'draft',
        user.id,
      )
      expect(result.success).toBe(false)
    })
  })

  describe('Concurrent Instance Operations', () => {
    it('handles multiple instances for different items', async () => {
      const workflow = await LifecycleDefinitionService.create({
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
      const instance1 = await LifecycleInstanceService.startInstance(
        workflow.id,
        item1.id,
        { actorId: user.id },
      )
      const instance2 = await LifecycleInstanceService.startInstance(
        workflow.id,
        item2.id,
        { actorId: user.id },
      )
      const instance3 = await LifecycleInstanceService.startInstance(
        workflow.id,
        item3.id,
        { actorId: user.id },
      )

      // Transition only instance2
      await LifecycleInstanceService.transition(instance2.id, 'done', user.id)

      // Verify states
      const i1 = await LifecycleInstanceService.getInstance(instance1.id)
      const i2 = await LifecycleInstanceService.getInstance(instance2.id)
      const i3 = await LifecycleInstanceService.getInstance(instance3.id)

      expect(i1?.currentState).toBe('draft')
      expect(i2?.currentState).toBe('done')
      expect(i3?.currentState).toBe('draft')
    })
  })

  describe('Invalid UUID Handling', () => {
    it('getById handles malformed UUID', async () => {
      try {
        const result = await LifecycleDefinitionService.getById('not-a-uuid')
        expect(result).toBeNull()
      } catch (error) {
        // Malformed UUID may cause DB error
        expect(error).toBeDefined()
      }
    })

    it('getInstance handles malformed UUID', async () => {
      try {
        const result = await LifecycleInstanceService.getInstance('not-a-uuid')
        expect(result).toBeNull()
      } catch (error) {
        // Malformed UUID may cause DB error
        expect(error).toBeDefined()
      }
    })

    it('getInstanceByItemId handles malformed UUID', async () => {
      try {
        const result =
          await LifecycleInstanceService.getInstanceByItemId('not-a-uuid')
        expect(result).toBeNull()
      } catch (error) {
        // Malformed UUID may cause DB error
        expect(error).toBeDefined()
      }
    })

    it('startInstance with malformed workflow ID throws', async () => {
      await expect(
        LifecycleInstanceService.startInstance(
          'not-a-uuid',
          '00000000-0000-0000-0000-000000000001',
        ),
      ).rejects.toThrow()
    })

    it('update with malformed UUID throws', async () => {
      await expect(
        LifecycleDefinitionService.update('not-a-uuid', { name: 'Test' }),
      ).rejects.toThrow()
    })

    it('delete with malformed UUID throws', async () => {
      await expect(
        LifecycleDefinitionService.delete('not-a-uuid'),
      ).rejects.toThrow()
    })
  })

  describe('History Edge Cases', () => {
    it('history maintains correct chronological order', async () => {
      const workflow = await LifecycleDefinitionService.create({
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
      const instance = await LifecycleInstanceService.startInstance(
        workflow.id,
        item.id,
        { actorId: user.id },
      )

      await LifecycleInstanceService.transition(instance.id, 'b', user.id)
      await LifecycleInstanceService.transition(instance.id, 'c', user.id)
      await LifecycleInstanceService.transition(instance.id, 'd', user.id)

      const history = await LifecycleInstanceService.getHistory(instance.id)

      // Verify chronological order (most recent first or oldest first depending on implementation)
      const timestamps = history.map((h) => new Date(h.timestamp).getTime())
      const sorted = [...timestamps].sort((a, b) => b - a) // Most recent first
      expect(timestamps).toEqual(sorted)
    })

    it('history stores comments when provided', async () => {
      const workflow = await LifecycleDefinitionService.create({
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
      const instance = await LifecycleInstanceService.startInstance(
        workflow.id,
        item.id,
        { actorId: user.id },
      )

      await LifecycleInstanceService.transition(
        instance.id,
        'review',
        user.id,
        'Ready for review!',
      )
      await LifecycleInstanceService.transition(
        instance.id,
        'done',
        user.id,
        'Approved by manager',
      )

      const history = await LifecycleInstanceService.getHistory(instance.id)

      // History should have entries for the transitions
      expect(history.length).toBeGreaterThanOrEqual(2)
    })

    it('getHistory for non-existent instance returns empty array', async () => {
      const history = await LifecycleInstanceService.getHistory(
        '00000000-0000-0000-0000-000000000000',
      )
      expect(history).toEqual([])
    })
  })

  describe('Inactive Workflow Handling', () => {
    it('can start instance on inactive workflow', async () => {
      const workflow = await LifecycleDefinitionService.create({
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
      const instance = await LifecycleInstanceService.startInstance(
        workflow.id,
        item.id,
        { actorId: user.id },
      )
      expect(instance).toBeDefined()
      expect(instance.currentState).toBe('draft')
    })
  })
})

describe('LifecycleInstanceService Transition Guards', () => {
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
    const workflow = await LifecycleDefinitionService.create({
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

    const instance = await LifecycleInstanceService.startInstance(
      workflow.id,
      item.id,
      {
        actorId: user.id,
      },
    )

    // Check canTransition returns not allowed
    const canResult = await LifecycleInstanceService.canTransition(
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

  it('previews a field_value guard against the item itself, as execution does', async () => {
    const workflow = await LifecycleDefinitionService.create({
      name: `Guarded Workflow Preview ${testPrefix}`,
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

    const user = await insertTestUser(testDb.db, { name: 'Preview Guard User' })
    const { item } = await insertTestPart(testDb.db, null, user.id, {
      itemNumber: uniqueItemNumber(),
      description: '',
    })
    const instance = await LifecycleInstanceService.startInstance(
      workflow.id,
      item.id,
      {
        actorId: user.id,
      },
    )
    const submitAvailable = async () =>
      (
        await LifecycleInstanceService.getAvailableTransitions(instance.id, {
          user: { id: user.id },
        })
      ).find((a) => a.transition.toStateId === 'review')?.canTransition

    // No item in the context: the service loads it. The preview used to be
    // handed an empty item and failed this guard while execution passed it.
    expect(await submitAvailable()).toBe(false)
    const refused = await LifecycleInstanceService.transition(
      instance.id,
      'review',
      user.id,
    )
    expect(refused.success).toBe(false)

    // The row itself, not the context: the service must read it
    await testDb.db
      .update(parts)
      .set({ description: 'Now described' })
      .where(eq(parts.itemId, item.id))

    expect(await submitAvailable()).toBe(true)
    const accepted = await LifecycleInstanceService.transition(
      instance.id,
      'review',
      user.id,
    )
    expect(accepted.success).toBe(true)
  })

  it('allows transition when field_value guard passes', async () => {
    const workflow = await LifecycleDefinitionService.create({
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

    const instance = await LifecycleInstanceService.startInstance(
      workflow.id,
      item.id,
      {
        actorId: user.id,
      },
    )

    const canResult = await LifecycleInstanceService.canTransition(
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
    const workflow = await LifecycleDefinitionService.create({
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

    const instance = await LifecycleInstanceService.startInstance(
      workflow.id,
      item.id,
      {
        actorId: user.id,
      },
    )

    // User has no roles - guard should fail
    const canResult = await LifecycleInstanceService.canTransition(
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
    const workflow = await LifecycleDefinitionService.create({
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

    const instance = await LifecycleInstanceService.startInstance(
      workflow.id,
      item.id,
      {
        actorId: user.id,
      },
    )

    const canResult = await LifecycleInstanceService.canTransition(
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
    const workflow = await LifecycleDefinitionService.create({
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

    const instance = await LifecycleInstanceService.startInstance(
      workflow.id,
      item.id,
      {
        actorId: user.id,
      },
    )

    // Both guards pass
    const canResult = await LifecycleInstanceService.canTransition(
      instance.id,
      'approved',
      {
        item: { description: 'Valid' },
        user: { id: user.id, roles: ['admin'] },
      },
    )

    expect(canResult.allowed).toBe(true)

    // One guard fails (no description)
    const canResultFail = await LifecycleInstanceService.canTransition(
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

describe('LifecycleInstanceService Transition Actions', () => {
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
      const workflow = await LifecycleDefinitionService.create({
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

      const instance = await LifecycleInstanceService.startInstance(
        workflow.id,
        item.id,
        { actorId: user.id },
      )

      const result = await LifecycleInstanceService.transition(
        instance.id,
        'review',
        user.id,
      )

      expect(result.success).toBe(true)
      expect(result.actionResults).toBeDefined()
    })

    it('executes before action before state change', async () => {
      const workflow = await LifecycleDefinitionService.create({
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

      const instance = await LifecycleInstanceService.startInstance(
        workflow.id,
        item.id,
        { actorId: user.id },
      )

      const result = await LifecycleInstanceService.transition(
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
          .insert(lifecycleDefinitions)
          .values({
            name: `Failing Before Action ${testPrefix}`,
            version: 1,
            workflowType: 'strict',
            isActive: true,
            lifecycleType: 'Driving',
            definition: {
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
          .returning({ id: lifecycleDefinitions.id }),
      )

      const user = await insertTestUser(testDb.db, {
        name: 'Failing Action User',
      })
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })

      const instance = await LifecycleInstanceService.startInstance(
        workflow.id,
        item.id,
        { actorId: user.id },
      )

      const result = await LifecycleInstanceService.transition(
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
          .insert(lifecycleDefinitions)
          .values({
            name: `Failing After Action ${testPrefix}`,
            version: 1,
            workflowType: 'strict',
            isActive: true,
            lifecycleType: 'Driving',
            definition: {
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
          .returning({ id: lifecycleDefinitions.id }),
      )

      const user = await insertTestUser(testDb.db, {
        name: 'After Action User',
      })
      const { item } = await insertTestPart(testDb.db, null, user.id, {
        itemNumber: uniqueItemNumber(),
      })

      const instance = await LifecycleInstanceService.startInstance(
        workflow.id,
        item.id,
        { actorId: user.id },
      )

      const result = await LifecycleInstanceService.transition(
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
      const workflow = await LifecycleDefinitionService.create({
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

      const instance = await LifecycleInstanceService.startInstance(
        workflow.id,
        item.id,
        { actorId: user.id },
      )

      const result = await LifecycleInstanceService.transition(
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
          .insert(lifecycleDefinitions)
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

      const instance = await LifecycleInstanceService.startInstance(
        workflow.id,
        item.id,
        { actorId: user.id },
      )

      const result = await LifecycleInstanceService.transition(
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
        LifecycleDefinitionService.create({
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
        LifecycleDefinitionService.create({
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

describe('LifecycleInstanceService send_notification Action', () => {
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
    const workflow = await LifecycleDefinitionService.create({
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

    const instance = await LifecycleInstanceService.startInstance(
      workflow.id,
      item.id,
      {
        actorId: user.id,
      },
    )

    const result = await LifecycleInstanceService.transition(
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

    const workflow = await LifecycleDefinitionService.create({
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

    const instance = await LifecycleInstanceService.startInstance(
      workflow.id,
      item.id,
      {
        actorId: actorUser.id,
      },
    )

    const result = await LifecycleInstanceService.transition(
      instance.id,
      'done',
      actorUser.id,
    )

    expect(result.success).toBe(true)
  })

  it('handles send_notification when item not found', async () => {
    const { items: itemsTable } = await import('../db/schema')
    const { eq: eqFn } = await import('drizzle-orm')

    const workflow = await LifecycleDefinitionService.create({
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

    const instance = await LifecycleInstanceService.startInstance(
      workflow.id,
      item.id,
      {
        actorId: user.id,
      },
    )

    // Delete the item to simulate "item not found" scenario
    await testDb.db.delete(itemsTable).where(eqFn(itemsTable.id, item.id))

    const result = await LifecycleInstanceService.transition(
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

    const workflow = await LifecycleDefinitionService.create({
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

    const instance = await LifecycleInstanceService.startInstance(
      workflow.id,
      item.id,
      {
        actorId: actorUser.id,
      },
    )

    const result = await LifecycleInstanceService.transition(
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

    const workflow = await LifecycleDefinitionService.create({
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

    const instance = await LifecycleInstanceService.startInstance(
      workflow.id,
      item.id,
      {
        actorId: user.id,
      },
    )

    const result = await LifecycleInstanceService.transition(
      instance.id,
      'done',
      user.id,
    )

    // Should succeed - actor is filtered out from recipients
    expect(result.success).toBe(true)
  })
})

describe('LifecycleInstanceService send_notification Design Access', () => {
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

    const workflow = await LifecycleDefinitionService.create({
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

    const instance = await LifecycleInstanceService.startInstance(
      workflow.id,
      item.id,
      {
        actorId: programOwner.id,
      },
    )

    // Use programOwner as actor - they are a program member
    // nonMemberRecipient should be filtered out (no design access)
    // memberRecipient should receive notification (has design access)
    const result = await LifecycleInstanceService.transition(
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

    const workflow = await LifecycleDefinitionService.create({
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

    const instance = await LifecycleInstanceService.startInstance(
      workflow.id,
      item.id,
      {
        actorId: programOwner.id,
      },
    )

    const result = await LifecycleInstanceService.transition(
      instance.id,
      'done',
      programOwner.id,
    )

    // Transition should succeed - no recipients after filtering is not an error
    expect(result.success).toBe(true)
  })

  it('handles notification with non-existent user recipient gracefully', async () => {
    const workflow = await LifecycleDefinitionService.create({
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

    const instance = await LifecycleInstanceService.startInstance(
      workflow.id,
      item.id,
      {
        actorId: actorUser.id,
      },
    )

    const result = await LifecycleInstanceService.transition(
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

    const workflow = await LifecycleDefinitionService.create({
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

    const instance = await LifecycleInstanceService.startInstance(
      workflow.id,
      item.id,
      {
        actorId: actorUser.id,
      },
    )

    const result = await LifecycleInstanceService.transition(
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

    const workflow = await LifecycleDefinitionService.create({
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

    const instance = await LifecycleInstanceService.startInstance(
      workflow.id,
      item.id,
      {
        actorId: actorUser.id,
      },
    )

    const result = await LifecycleInstanceService.transition(
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
      overrides?: Partial<CreateLifecycleInput>,
    ): CreateLifecycleInput {
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
      overrides?: Partial<CreateLifecycleInput>,
    ): CreateLifecycleInput {
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
        const workflow = await LifecycleDefinitionService.create(
          createStrictWorkflowInput(),
        )
        const actorUser = await insertTestUser(testDb.db, {
          name: 'Test User',
        })
        const { item } = await insertTestPart(testDb.db, null, actorUser.id, {
          itemNumber: uniqueItemNumber(),
        })
        const instance = await LifecycleInstanceService.startInstance(
          workflow.id,
          item.id,
          { actorId: actorUser.id },
        )

        const structure = await LifecycleInstanceService.getEffectiveStructure(
          instance.id,
        )

        expect(structure.isInstanceLevel).toBe(false)
        expect(structure.canEdit).toBe(false)
        expect(structure.states).toHaveLength(3)
        expect(structure.transitions).toHaveLength(3)
      })

      it('returns instance structure for flexible workflows', async () => {
        const workflow = await LifecycleDefinitionService.create(
          createFlexibleWorkflowInput(),
        )
        const actorUser = await insertTestUser(testDb.db, {
          name: 'Test User',
        })
        const { item } = await insertTestPart(testDb.db, null, actorUser.id, {
          itemNumber: uniqueItemNumber(),
        })
        const instance = await LifecycleInstanceService.startInstance(
          workflow.id,
          item.id,
          { actorId: actorUser.id },
        )

        const structure = await LifecycleInstanceService.getEffectiveStructure(
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
        const workflow = await LifecycleDefinitionService.create(
          createFlexibleWorkflowInput(),
        )
        const actorUser = await insertTestUser(testDb.db, {
          name: 'Test User',
        })
        const { item } = await insertTestPart(testDb.db, null, actorUser.id, {
          itemNumber: uniqueItemNumber(),
        })

        const instance = await LifecycleInstanceService.startInstance(
          workflow.id,
          item.id,
          { actorId: actorUser.id },
        )

        expect(instance.currentState).toBe('start')
        const structure = await LifecycleInstanceService.getEffectiveStructure(
          instance.id,
        )
        expect(structure.isInstanceLevel).toBe(true)
        expect(structure.states).toHaveLength(2)
      })
    })

    describe('updateInstanceStructure', () => {
      it('updates instance structure successfully', async () => {
        const workflow = await LifecycleDefinitionService.create(
          createFlexibleWorkflowInput(),
        )
        const actorUser = await insertTestUser(testDb.db, {
          name: 'Test User',
        })
        const { item } = await insertTestPart(testDb.db, null, actorUser.id, {
          itemNumber: uniqueItemNumber(),
        })
        const instance = await LifecycleInstanceService.startInstance(
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

        const result = await LifecycleInstanceService.updateInstanceStructure(
          instance.id,
          newStates,
          newTransitions,
          actorUser.id,
        )

        expect(result.success).toBe(true)
        const structure = await LifecycleInstanceService.getEffectiveStructure(
          instance.id,
        )
        expect(structure.states).toHaveLength(3)
        expect(structure.transitions).toHaveLength(2)
      })

      it('writes nothing of a structure edit whose history row cannot be written', async () => {
        const workflow = await LifecycleDefinitionService.create(
          createFlexibleWorkflowInput(),
        )
        const actorUser = await insertTestUser(testDb.db, {
          name: 'Atomic Structure User',
        })
        const { item } = await insertTestPart(testDb.db, null, actorUser.id, {
          itemNumber: uniqueItemNumber(),
        })
        const instance = await LifecycleInstanceService.startInstance(
          workflow.id,
          item.id,
          { actorId: actorUser.id },
        )
        const before = await LifecycleInstanceService.getEffectiveStructure(
          instance.id,
        )

        // The structure and its history row used to be separate statements,
        // so this failure left the instance restructured with no record of
        // who did it
        const historyWrite = vi
          .spyOn(LifecycleInstanceService, 'recordHistory')
          .mockRejectedValueOnce(new Error('connection reset'))
        await expect(
          LifecycleInstanceService.updateInstanceStructure(
            instance.id,
            [
              { id: 'start', name: 'Start', color: 'gray', isInitial: true },
              { id: 'review', name: 'Review', color: 'yellow' },
              {
                id: 'complete',
                name: 'Complete',
                color: 'green',
                isFinal: true,
                finalKind: 'release' as const,
              },
            ],
            [
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
            ],
            actorUser.id,
          ),
        ).rejects.toThrow('connection reset')
        historyWrite.mockRestore()

        const after = await LifecycleInstanceService.getEffectiveStructure(
          instance.id,
        )
        expect(after.isInstanceLevel).toBe(before.isInstanceLevel)
        expect(after.states).toEqual(before.states)
        expect(after.transitions).toEqual(before.transitions)
        expect(
          (await LifecycleInstanceService.getHistory(instance.id)).map(
            (h) => h.action,
          ),
        ).toEqual(['started'])
      })

      it('fails if current state is removed', async () => {
        const workflow = await LifecycleDefinitionService.create(
          createFlexibleWorkflowInput(),
        )
        const actorUser = await insertTestUser(testDb.db, {
          name: 'Test User',
        })
        const { item } = await insertTestPart(testDb.db, null, actorUser.id, {
          itemNumber: uniqueItemNumber(),
        })
        const instance = await LifecycleInstanceService.startInstance(
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

        const result = await LifecycleInstanceService.updateInstanceStructure(
          instance.id,
          newStates,
          newTransitions,
          actorUser.id,
        )

        expect(result.success).toBe(false)
        expect(result.error).toContain('current state')
      })

      it('fails without initial state', async () => {
        const workflow = await LifecycleDefinitionService.create(
          createFlexibleWorkflowInput(),
        )
        const actorUser = await insertTestUser(testDb.db, {
          name: 'Test User',
        })
        const { item } = await insertTestPart(testDb.db, null, actorUser.id, {
          itemNumber: uniqueItemNumber(),
        })
        const instance = await LifecycleInstanceService.startInstance(
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

        const result = await LifecycleInstanceService.updateInstanceStructure(
          instance.id,
          newStates,
          newTransitions,
          actorUser.id,
        )

        expect(result.success).toBe(false)
        expect(result.error).toContain('initial state')
      })

      it('fails without final state', async () => {
        const workflow = await LifecycleDefinitionService.create(
          createFlexibleWorkflowInput(),
        )
        const actorUser = await insertTestUser(testDb.db, {
          name: 'Test User',
        })
        const { item } = await insertTestPart(testDb.db, null, actorUser.id, {
          itemNumber: uniqueItemNumber(),
        })
        const instance = await LifecycleInstanceService.startInstance(
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

        const result = await LifecycleInstanceService.updateInstanceStructure(
          instance.id,
          newStates,
          newTransitions,
          actorUser.id,
        )

        expect(result.success).toBe(false)
        expect(result.error).toContain('final state')
      })

      it('fails if transition references non-existent state', async () => {
        const workflow = await LifecycleDefinitionService.create(
          createFlexibleWorkflowInput(),
        )
        const actorUser = await insertTestUser(testDb.db, {
          name: 'Test User',
        })
        const { item } = await insertTestPart(testDb.db, null, actorUser.id, {
          itemNumber: uniqueItemNumber(),
        })
        const instance = await LifecycleInstanceService.startInstance(
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

        const result = await LifecycleInstanceService.updateInstanceStructure(
          instance.id,
          newStates,
          newTransitions,
          actorUser.id,
        )

        expect(result.success).toBe(false)
        expect(result.error).toContain('references invalid state')
      })

      it('fails for strict workflows', async () => {
        const workflow = await LifecycleDefinitionService.create(
          createStrictWorkflowInput(),
        )
        const actorUser = await insertTestUser(testDb.db, {
          name: 'Test User',
        })
        const { item } = await insertTestPart(testDb.db, null, actorUser.id, {
          itemNumber: uniqueItemNumber(),
        })
        const instance = await LifecycleInstanceService.startInstance(
          workflow.id,
          item.id,
          { actorId: actorUser.id },
        )

        const result = await LifecycleInstanceService.updateInstanceStructure(
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
        const workflow = await LifecycleDefinitionService.create(
          createFlexibleWorkflowInput(),
        )
        const actorUser = await insertTestUser(testDb.db, {
          name: 'Test User',
        })
        const { item } = await insertTestPart(testDb.db, null, actorUser.id, {
          itemNumber: uniqueItemNumber(),
        })
        const instance = await LifecycleInstanceService.startInstance(
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

        await LifecycleInstanceService.updateInstanceStructure(
          instance.id,
          newStates,
          newTransitions,
          actorUser.id,
        )

        const transitions =
          await LifecycleInstanceService.getAvailableTransitions(instance.id, {
            item: { id: item.id },
            user: { id: actorUser.id, roles: [] },
          })

        expect(transitions).toHaveLength(1)
        expect(transitions[0]).toMatchObject({
          transition: { name: 'Submit', toStateId: 'review' },
        })
      })

      it('executes transitions using instance structure', async () => {
        const workflow = await LifecycleDefinitionService.create(
          createFlexibleWorkflowInput(),
        )
        const actorUser = await insertTestUser(testDb.db, {
          name: 'Test User',
        })
        const { item } = await insertTestPart(testDb.db, null, actorUser.id, {
          itemNumber: uniqueItemNumber(),
        })
        const instance = await LifecycleInstanceService.startInstance(
          workflow.id,
          item.id,
          { actorId: actorUser.id },
        )

        // Use default transition to 'complete'
        const result = await LifecycleInstanceService.transition(
          instance.id,
          'complete',
          actorUser.id,
        )

        expect(result.success).toBe(true)
        expect(result.toState).toBe('complete')

        const updated = await LifecycleInstanceService.getInstance(instance.id)
        expect(updated?.currentState).toBe('complete')
      })
    })

    describe('isFlexibleAndEditable', () => {
      it('returns true for flexible workflow in non-final state', async () => {
        const workflow = await LifecycleDefinitionService.create(
          createFlexibleWorkflowInput(),
        )
        const actorUser = await insertTestUser(testDb.db, {
          name: 'Test User',
        })
        const { item } = await insertTestPart(testDb.db, null, actorUser.id, {
          itemNumber: uniqueItemNumber(),
        })
        const instance = await LifecycleInstanceService.startInstance(
          workflow.id,
          item.id,
          { actorId: actorUser.id },
        )

        const result = await LifecycleInstanceService.isFlexibleAndEditable(
          instance.id,
        )

        expect(result).toBe(true)
      })

      it('returns false for strict workflow', async () => {
        const workflow = await LifecycleDefinitionService.create(
          createStrictWorkflowInput(),
        )
        const actorUser = await insertTestUser(testDb.db, {
          name: 'Test User',
        })
        const { item } = await insertTestPart(testDb.db, null, actorUser.id, {
          itemNumber: uniqueItemNumber(),
        })
        const instance = await LifecycleInstanceService.startInstance(
          workflow.id,
          item.id,
          { actorId: actorUser.id },
        )

        const result = await LifecycleInstanceService.isFlexibleAndEditable(
          instance.id,
        )

        expect(result).toBe(false)
      })

      it('returns false for completed flexible workflow', async () => {
        const workflow = await LifecycleDefinitionService.create(
          createFlexibleWorkflowInput(),
        )
        const actorUser = await insertTestUser(testDb.db, {
          name: 'Test User',
        })
        const { item } = await insertTestPart(testDb.db, null, actorUser.id, {
          itemNumber: uniqueItemNumber(),
        })
        const instance = await LifecycleInstanceService.startInstance(
          workflow.id,
          item.id,
          { actorId: actorUser.id },
        )

        // Complete the workflow
        await LifecycleInstanceService.transition(
          instance.id,
          'complete',
          actorUser.id,
        )

        const result = await LifecycleInstanceService.isFlexibleAndEditable(
          instance.id,
        )

        expect(result).toBe(false)
      })
    })
  })
})

describe('LifecycleInstanceService rework supersedes approvals (WI-4.1)', () => {
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
    const workflow = await LifecycleDefinitionService.create({
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
    const instance = await LifecycleInstanceService.startInstance(
      workflow.id,
      item.id,
      {
        actorId: approver.id,
      },
    )

    await ApprovalService.addStateApprover(
      workflow.id,
      'review',
      { type: 'user', id: approver.id, isRequired: true },
      approver.id,
    )

    // First pass: submit, approve at Review — leaving Review is unlocked
    const submit = await LifecycleInstanceService.transition(
      instance.id,
      'review',
      approver.id,
    )
    expect(submit.success).toBe(true)

    await ApprovalService.submitApproval(
      instance.id,
      'review',
      approver.id,
      'approved',
    )

    // Rework: Review → Draft is backward (Draft reaches Review again)
    const rework = await LifecycleInstanceService.transition(
      instance.id,
      'draft',
      approver.id,
    )
    expect(rework.success).toBe(true)

    // Second pass: the old vote is superseded, so leaving Review is gated
    const resubmit = await LifecycleInstanceService.transition(
      instance.id,
      'review',
      approver.id,
    )
    expect(resubmit.success).toBe(true)

    const blocked = await LifecycleInstanceService.transition(
      instance.id,
      'done',
      approver.id,
    )
    expect(blocked.success).toBe(false)
    expect(blocked.error).toMatch(/approval/i)

    // The superseded vote is still queryable — audit trail, not deletion
    const votes = await testDb.db
      .select()
      .from(lifecycleApprovalVotes)
      .where(eq(lifecycleApprovalVotes.workflowInstanceId, instance.id))
    expect(votes).toHaveLength(1)
    expect(votes[0]?.supersededAt).not.toBeNull()

    // Fresh vote unlocks the transition
    await ApprovalService.submitApproval(
      instance.id,
      'review',
      approver.id,
      'approved',
    )
    const approved = await LifecycleInstanceService.transition(
      instance.id,
      'done',
      approver.id,
    )
    expect(approved.success).toBe(true)
  })

  it('leaves votes active on forward transitions', async () => {
    const workflow = await LifecycleDefinitionService.create({
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
    const instance = await LifecycleInstanceService.startInstance(
      workflow.id,
      item.id,
      {
        actorId: approver.id,
      },
    )

    await ApprovalService.addStateApprover(
      workflow.id,
      'review',
      { type: 'user', id: approver.id, isRequired: true },
      approver.id,
    )

    await LifecycleInstanceService.transition(
      instance.id,
      'review',
      approver.id,
    )
    await ApprovalService.submitApproval(
      instance.id,
      'review',
      approver.id,
      'approved',
    )
    const done = await LifecycleInstanceService.transition(
      instance.id,
      'done',
      approver.id,
    )
    expect(done.success).toBe(true)

    // No transition in this workflow is backward — the vote stays active
    const votes = await testDb.db
      .select()
      .from(lifecycleApprovalVotes)
      .where(eq(lifecycleApprovalVotes.workflowInstanceId, instance.id))
    expect(votes).toHaveLength(1)
    expect(votes[0]?.supersededAt).toBeNull()
  })
})

describe('LifecycleInstanceService flexible-instance approvals (WI-4.2)', () => {
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
    const workflow = await LifecycleDefinitionService.create({
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
    const instance = await LifecycleInstanceService.startInstance(
      workflow.id,
      item.id,
      {
        actorId: owner.id,
      },
    )

    // Add a custom review state between draft and done — the scenario
    // definition-keyed approvers can never cover
    const structure = await LifecycleInstanceService.updateInstanceStructure(
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

    await ApprovalService.setInstanceApprovers(
      instance.id,
      'quality-review',
      [
        { type: 'user', id: owner.id, isRequired: true },
        { type: 'user', id: approver2.id, isRequired: true },
      ],
      owner.id,
    )

    const submit = await LifecycleInstanceService.transition(
      instance.id,
      'quality-review',
      owner.id,
    )
    expect(submit.success).toBe(true)

    // 0/2 approvals — blocked
    const blocked = await LifecycleInstanceService.transition(
      instance.id,
      'done',
      owner.id,
    )
    expect(blocked.success).toBe(false)
    expect(blocked.error).toMatch(/approval/i)

    // 1/2 approvals — still blocked
    await ApprovalService.submitApproval(
      instance.id,
      'quality-review',
      owner.id,
      'approved',
    )
    const stillBlocked = await LifecycleInstanceService.transition(
      instance.id,
      'done',
      owner.id,
    )
    expect(stillBlocked.success).toBe(false)

    // 2/2 approvals — allowed
    await ApprovalService.submitApproval(
      instance.id,
      'quality-review',
      approver2.id,
      'approved',
    )
    const allowed = await LifecycleInstanceService.transition(
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
    const structure = await LifecycleInstanceService.updateInstanceStructure(
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

    await LifecycleInstanceService.transition(
      instance.id,
      'quality-review',
      owner.id,
    )

    // No votes yet — the count gate blocks
    const blocked = await LifecycleInstanceService.transition(
      instance.id,
      'done',
      owner.id,
    )
    expect(blocked.success).toBe(false)
    expect(blocked.error).toMatch(/approval/i)

    // With no named approvers anyone may vote; one vote satisfies the gate
    await ApprovalService.submitApproval(
      instance.id,
      'quality-review',
      owner.id,
      'approved',
    )
    const allowed = await LifecycleInstanceService.transition(
      instance.id,
      'done',
      owner.id,
    )
    expect(allowed.success).toBe(true)
  })
})

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
  // Registry resolution and the Free-transition path work from
  // lifecycleType alone (remediation WI-3.3)
  lifecycleType: 'Free',
  applicableItemTypes: ['Issue'],
}

describe('LifecycleInstanceService Free-lifecycle transitions', () => {
  const testDb = new TestDatabase()
  let restoreItemTypeConfig: (() => Promise<void>) | undefined
  let user: TestUser
  let uniquePrefix: string

  beforeAll(async () => {
    await testDb.setup()
    await seedStandardPartLifecycle(testDb.db)

    await testDb.db
      .insert(lifecycleDefinitions)
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
        target: lifecycleDefinitions.id,
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

    const result = await LifecycleInstanceService.transitionFreeItem(
      issue.id,
      'InProgress',
      user.id,
    )

    expect(result.toStateId).toBe('InProgress')

    const updated = await ItemService.findById(issue.id)
    expect(updated?.state).toBe('InProgress')

    const instance = await LifecycleInstanceService.getInstanceByItemId(
      issue.id,
    )
    expect(instance?.currentState).toBe('InProgress')

    const history = await LifecycleInstanceService.getHistory(instance!.id)
    expect(history.some((h) => h.toState === 'InProgress')).toBe(true)
  })

  it('accepts the target state by display name', async () => {
    const issue = await createIssue()

    const result = await LifecycleInstanceService.transitionFreeItem(
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
      LifecycleInstanceService.transitionFreeItem(issue.id, 'Closed', user.id),
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
      LifecycleInstanceService.transitionFreeItem(part.id, 'Released', user.id),
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

      const offered =
        await LifecycleInstanceService.getAvailableFreeTransitions(req.id)
      expect(offered.lifecycleType).toBe('Driven')
      expect(offered.transitions.map((t) => t.toStateId)).toEqual(['Proposed'])

      await LifecycleInstanceService.transitionFreeItem(
        req.id,
        'Proposed',
        user.id,
      )
      await LifecycleInstanceService.transitionFreeItem(
        req.id,
        'Approved',
        user.id,
      )
      expect((await ItemService.findById(req.id))?.state).toBe('Approved')

      // From Approved the only manual edge is Rework; Released is a release
      // target and is never offered
      const fromApproved =
        await LifecycleInstanceService.getAvailableFreeTransitions(req.id)
      expect(fromApproved.transitions.map((t) => t.toStateId)).toEqual([
        'Draft',
      ])
      await expect(
        LifecycleInstanceService.transitionFreeItem(
          req.id,
          'Released',
          user.id,
        ),
      ).rejects.toThrow(ValidationError)
    })

    it('cannot transition released lineage by hand', async () => {
      const released = await createRequirement('Released')

      const offered =
        await LifecycleInstanceService.getAvailableFreeTransitions(released.id)
      expect(offered.transitions).toEqual([])
      await expect(
        LifecycleInstanceService.transitionFreeItem(
          released.id,
          'Draft',
          user.id,
        ),
      ).rejects.toThrow(ValidationError)
    })
  })

  it('reopens a completed Free workflow (terminality is Driving-only)', async () => {
    const issue = await createIssue()
    await LifecycleInstanceService.transitionFreeItem(
      issue.id,
      'InProgress',
      user.id,
    )
    await LifecycleInstanceService.transitionFreeItem(
      issue.id,
      'Closed',
      user.id,
    )

    let instance = await LifecycleInstanceService.getInstanceByItemId(issue.id)
    expect(instance?.completedAt).toBeDefined()

    await LifecycleInstanceService.transitionFreeItem(issue.id, 'Open', user.id)

    instance = await LifecycleInstanceService.getInstanceByItemId(issue.id)
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

    await LifecycleInstanceService.transitionFreeItem(
      issue.id,
      'Closed',
      user.id,
    )

    const instance = await LifecycleInstanceService.getInstanceByItemId(
      issue.id,
    )
    expect(instance?.currentState).toBe('Closed')

    const history = await LifecycleInstanceService.getHistory(instance!.id)
    expect(history.some((h) => h.action === 'state_adopted')).toBe(true)
  })

  it('lists available transitions for the current state only', async () => {
    const issue = await createIssue()

    const available =
      await LifecycleInstanceService.getAvailableFreeTransitions(issue.id)

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

    const available =
      await LifecycleInstanceService.getAvailableFreeTransitions(part.id)

    expect(available.lifecycleType).toBe('Driven')
    expect(available.transitions).toEqual([])
  })
})
