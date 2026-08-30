// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * CHECK constraints — merge status and the revision working-marker (DBI-4)
 *
 * Data-integrity gate. Two columns gate release machinery on their literal
 * values, and neither had a database-level guard:
 *
 *  - change_order_designs.merge_status decides whether a design merges on
 *    release: a typo'd status silently skips or double-merges a design.
 *  - items.revision starting with '-' is a working marker with exactly two
 *    legal shapes ('-' and '-{8 hex}'); a malformed marker makes
 *    isWorkingRevision disagree with the merge, which then mints a revision
 *    from the literal marker text.
 *
 * These tests pin the constraints from both sides: the corrupt shapes throw,
 * and every legal shape — including legacy 'DRAFT' and '' — still inserts.
 *
 * Run: npx vitest run packages/core/src/lib/db/constraint-checks.test.ts
 */

import { randomUUID } from 'node:crypto'
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
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import {
  changeOrderDesigns,
  designs,
  instructionExecutions,
  items,
  programs,
  workOrderInstructions,
  workOrders,
  workflowDefinitions,
  workflowInstanceApprovers,
  workflowInstances,
  workflowStateApprovers,
} from '@/lib/db/schema'
import { asPostgresError, constraintOf } from '@/lib/errors/pg'
import { takeFirst } from '@/lib/db/take-first'
import { notWorkingRevision } from '@/lib/db/filters'
import { RevisionService } from '@/lib/services/RevisionService'

/** Postgres check_violation. */
const CHECK_VIOLATION = '23514'
/** Postgres unique_violation. */
const UNIQUE_VIOLATION = '23505'

describe('database CHECK constraints (DBI-4)', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let unique: string
  let designId: string
  let ecoItemId: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    user = await insertTestUser(testDb.db)
    unique = `${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`

    const program = takeFirst(
      await testDb.db
        .insert(programs)
        .values({ name: 'P', code: `PRG-${unique}`, createdBy: user.id })
        .returning(),
    )
    const design = takeFirst(
      await testDb.db
        .insert(designs)
        .values({
          programId: program.id,
          name: 'D',
          code: `DES-${unique}`,
          createdBy: user.id,
        })
        .returning(),
    )
    designId = design.id

    const eco = takeFirst(
      await testDb.db
        .insert(items)
        .values({
          itemNumber: `ECO-${unique}`,
          itemType: 'ChangeOrder',
          revision: '-',
          name: 'Check fixture ECO',
          state: 'Draft',
          masterId: randomUUID(),
          isCurrent: true,
          createdBy: user.id,
          modifiedBy: user.id,
        })
        .returning(),
    )
    ecoItemId = eco.id
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  function itemRow(revision: string) {
    return {
      itemNumber: `PN-${unique}-${Math.random().toString(36).slice(2, 6)}`,
      itemType: 'Part',
      revision,
      name: `Revision shape ${JSON.stringify(revision)}`,
      state: 'Draft',
      masterId: randomUUID(),
      designId,
      isCurrent: true,
      createdBy: user.id,
      modifiedBy: user.id,
    }
  }

  async function insertExpectingCheck(run: () => Promise<unknown>) {
    let caught: unknown
    try {
      await run()
    } catch (error) {
      caught = error
    }
    expect(caught).toBeDefined()
    const pgError = asPostgresError(caught)
    expect(pgError?.code).toBe(CHECK_VIOLATION)
    return pgError!
  }

  describe('items revision working-marker shape', () => {
    it.each(['-DRAFT', '-xyz', '-ABCDEF12', '-ab12cd3', '-ab12cd345'])(
      'rejects the malformed marker %j',
      async (revision) => {
        const pgError = await insertExpectingCheck(() =>
          testDb.db.insert(items).values(itemRow(revision)),
        )
        expect(constraintOf(pgError)).toBe('ck_items_revision_working_marker')
      },
    )

    it.each(['-', '-abcdef12', '-00000000', 'A', 'X12', '', 'DRAFT', '3'])(
      'accepts the legal shape %j',
      async (revision) => {
        await testDb.db.insert(items).values(itemRow(revision))
      },
    )

    /**
     * The `none` scheme's released marker has to satisfy two rules that live
     * in different places and break independently: this CHECK constraint, and
     * the released-item predicate `notWorkingRevision()`.
     *
     * It used to satisfy only the first. `getInitialRevision({type:'none'})`
     * returned '', which the check happily stores and the predicate then
     * filters out — so an item released under `none` was released in name and
     * invisible to every released-item query. Both halves are asserted here,
     * because the marker is only correct when both hold.
     */
    it('stores the none-scheme marker and reads it back as released', async () => {
      const inserted = takeFirst(
        await testDb.db
          .insert(items)
          .values(itemRow(RevisionService.NO_REVISION))
          .returning(),
      )

      const released = await testDb.db
        .select({ id: items.id })
        .from(items)
        .where(and(eq(items.id, inserted.id), notWorkingRevision()))

      expect(released.map((r) => r.id)).toEqual([inserted.id])
    })

    it('filters out the empty revision the marker replaced', async () => {
      // Pins why the marker cannot be '': same predicate, opposite verdict.
      const inserted = takeFirst(
        await testDb.db.insert(items).values(itemRow('')).returning(),
      )

      const released = await testDb.db
        .select({ id: items.id })
        .from(items)
        .where(and(eq(items.id, inserted.id), notWorkingRevision()))

      expect(released).toHaveLength(0)
    })
  })

  describe('change_order_designs merge status', () => {
    function codRow(mergeStatus: string | null) {
      return {
        changeOrderId: ecoItemId,
        designId,
        mergeStatus,
      }
    }

    it('rejects a status outside the closed set', async () => {
      const pgError = await insertExpectingCheck(() =>
        testDb.db.insert(changeOrderDesigns).values(codRow('done')),
      )
      expect(constraintOf(pgError)).toBe('ck_cod_merge_status')
    })

    it.each(['pending', 'merged', 'conflict', 'skipped'])(
      'accepts %j',
      async (status) => {
        await testDb.db.insert(changeOrderDesigns).values(codRow(status))
        // One (changeOrder, design) pair per test — remove for the next case.
        await testDb.db.delete(changeOrderDesigns)
      },
    )
  })

  /**
   * instruction_executions: one open run per (line, technician, unit), and a
   * closed status set.
   *
   * The countable tally behind the work-order completion gate counts
   * `status IN ('Complete','Approved')` rows and compares the total to the
   * line's `requiredCount`, so both constraints protect the same number: a
   * duplicate open run inflates it, and an out-of-set status silently does not
   * count toward it.
   */
  describe('instruction_executions open-run uniqueness and status set', () => {
    let lineId: string

    beforeEach(async () => {
      // A work order, a traveler line on it, and nothing else — these tests
      // write execution rows directly, because the point is what the database
      // refuses, not what the service does.
      const woItem = takeFirst(
        await testDb.db
          .insert(items)
          .values({
            itemNumber: `WO-${unique}`,
            itemType: 'WorkOrder',
            revision: '-',
            name: 'Constraint fixture WO',
            state: 'Not Started',
            masterId: randomUUID(),
            isCurrent: true,
            createdBy: user.id,
            modifiedBy: user.id,
          })
          .returning(),
      )
      await testDb.db.insert(workOrders).values({
        itemId: woItem.id,
        quantity: 1,
      })
      const line = takeFirst(
        await testDb.db
          .insert(workOrderInstructions)
          .values({
            workOrderId: woItem.id,
            workInstructionId: null,
            orderIndex: 0,
            title: 'Constraint fixture line',
            snapshot: {
              name: 'Constraint fixture line',
              description: null,
              estimatedTime: null,
              difficulty: null,
              safetyNotes: null,
              requiredTools: null,
              operations: [],
              steps: [],
            },
            createdBy: user.id,
          })
          .returning(),
      )
      lineId = line.id
    })

    function execRow(overrides: Record<string, unknown> = {}) {
      return {
        workOrderInstructionId: lineId,
        executedBy: user.id,
        status: 'In Progress',
        ...overrides,
      }
    }

    it('rejects a second open run for the same technician and unit', async () => {
      await testDb.db
        .insert(instructionExecutions)
        .values(execRow({ unitLabel: 'SN-1' }))

      let caught: unknown
      try {
        await testDb.db
          .insert(instructionExecutions)
          .values(execRow({ unitLabel: 'SN-1' }))
      } catch (error) {
        caught = error
      }
      const pgError = asPostgresError(caught)
      expect(pgError?.code).toBe(UNIQUE_VIOLATION)
      expect(constraintOf(pgError!)).toBe('uq_instr_exec_open_run')
    })

    it('treats two null unit labels as the same unit', async () => {
      // COALESCE, not raw SQL NULL semantics: without it two unlabelled runs
      // would be "distinct" and the index would gate nothing for the default
      // case.
      await testDb.db.insert(instructionExecutions).values(execRow())

      let caught: unknown
      try {
        await testDb.db.insert(instructionExecutions).values(execRow())
      } catch (error) {
        caught = error
      }
      expect(constraintOf(asPostgresError(caught)!)).toBe(
        'uq_instr_exec_open_run',
      )
    })

    it('allows a second run once the first is no longer open', async () => {
      await testDb.db
        .insert(instructionExecutions)
        .values(execRow({ status: 'Complete' }))

      await testDb.db.insert(instructionExecutions).values(execRow())
    })

    it('allows distinct unit labels to run at once', async () => {
      await testDb.db
        .insert(instructionExecutions)
        .values(execRow({ unitLabel: 'SN-1' }))
      await testDb.db
        .insert(instructionExecutions)
        .values(execRow({ unitLabel: 'SN-2' }))
    })

    it('rejects a status outside the six legal literals', async () => {
      const pgError = await insertExpectingCheck(() =>
        testDb.db
          .insert(instructionExecutions)
          .values(execRow({ status: 'Done' })),
      )
      expect(constraintOf(pgError)).toBe('ck_instr_exec_status')
    })

    it.each([
      'In Progress',
      'Complete',
      'Incomplete',
      'Pending Approval',
      'Approved',
      'Rejected',
    ])('accepts %j', async (status) => {
      await testDb.db
        .insert(instructionExecutions)
        .values(execRow({ status, unitLabel: `SN-${status}` }))
    })
  })

  /**
   * Approver uniqueness on both workflow approver tables (DBI2-4).
   *
   * These are the rows approval gating reads. Neither table carried a key, and
   * `addStateApprover` was a SELECT followed by an INSERT — so two
   * administrators configuring one state at once both wrote, and removing the
   * approver afterwards deleted one row and left the twin approving.
   *
   * The key is the whole identity of an assignment and nothing else:
   * (owner, state, type, approver). `is_required` deliberately sits outside
   * it — the same person cannot be listed twice at one state under two
   * different flags, because gating would collapse that to one approver
   * anyway.
   *
   * Written directly rather than through the service, because the point is
   * what the database refuses; the race the constraint closes is in
   * `WorkflowApprovalService.race.test.ts`.
   */
  describe('workflow approver uniqueness', () => {
    let definitionId: string
    let instanceId: string

    beforeEach(async () => {
      const definition = takeFirst(
        await testDb.db
          .insert(workflowDefinitions)
          .values({
            name: `Approver constraints ${unique}`,
            version: 1,
            workflowType: 'strict',
            definition: { states: [], transitions: [] },
          })
          .returning(),
      )
      definitionId = definition.id
      const instance = takeFirst(
        await testDb.db
          .insert(workflowInstances)
          .values({ workflowDefinitionId: definition.id })
          .returning(),
      )
      instanceId = instance.id
    })

    function stateRow(overrides: Record<string, unknown> = {}) {
      return {
        workflowDefinitionId: definitionId,
        stateId: 'Review',
        approverType: 'user',
        approverId: user.id,
        createdBy: user.id,
        ...overrides,
      }
    }

    function instanceRow(overrides: Record<string, unknown> = {}) {
      return {
        workflowInstanceId: instanceId,
        stateId: 'Review',
        approverType: 'user',
        approverId: user.id,
        createdBy: user.id,
        ...overrides,
      }
    }

    async function insertExpectingUnique(run: () => Promise<unknown>) {
      let caught: unknown
      try {
        await run()
      } catch (error) {
        caught = error
      }
      expect(caught).toBeDefined()
      const pgError = asPostgresError(caught)
      expect(pgError?.code).toBe(UNIQUE_VIOLATION)
      return pgError!
    }

    it('admits every assignment that differs in one key column', async () => {
      // All four columns, one at a time, against the same base row — the
      // constraint has to be wide enough to allow each of these and narrow
      // enough to reject the repeat below.
      const other = await insertTestUser(testDb.db)
      const second = takeFirst(
        await testDb.db
          .insert(workflowDefinitions)
          .values({
            name: `Approver constraints II ${unique}`,
            version: 1,
            workflowType: 'strict',
            definition: { states: [], transitions: [] },
          })
          .returning(),
      )

      await testDb.db.insert(workflowStateApprovers).values([
        stateRow(),
        stateRow({ stateId: 'Approved' }),
        // Same uuid, recorded as a role rather than as a person.
        stateRow({ approverType: 'role' }),
        stateRow({ approverId: other.id }),
        stateRow({ workflowDefinitionId: second.id }),
      ])

      const rows = await testDb.db
        .select({ id: workflowStateApprovers.id })
        .from(workflowStateApprovers)
      expect(rows).toHaveLength(5)
    })

    it('rejects a second definition-level row for the same approver', async () => {
      await testDb.db.insert(workflowStateApprovers).values(stateRow())

      const pgError = await insertExpectingUnique(() =>
        testDb.db.insert(workflowStateApprovers).values(stateRow()),
      )
      expect(constraintOf(pgError)).toBe('uq_wf_state_approvers')
    })

    it('rejects the same approver listed required and optional at one state', async () => {
      // is_required is outside the key on purpose: two rows differing only in
      // that flag are one approver to `mergeApproverLists`, which ORs them.
      await testDb.db
        .insert(workflowStateApprovers)
        .values(stateRow({ isRequired: true }))

      const pgError = await insertExpectingUnique(() =>
        testDb.db
          .insert(workflowStateApprovers)
          .values(stateRow({ isRequired: false })),
      )
      expect(constraintOf(pgError)).toBe('uq_wf_state_approvers')
    })

    it('admits distinct instance-level assignments', async () => {
      const other = await insertTestUser(testDb.db)
      const secondInstance = takeFirst(
        await testDb.db
          .insert(workflowInstances)
          .values({ workflowDefinitionId: definitionId })
          .returning(),
      )

      await testDb.db
        .insert(workflowInstanceApprovers)
        .values([
          instanceRow(),
          instanceRow({ stateId: 'Approved' }),
          instanceRow({ approverType: 'role' }),
          instanceRow({ approverId: other.id }),
          instanceRow({ workflowInstanceId: secondInstance.id }),
        ])

      const rows = await testDb.db
        .select({ id: workflowInstanceApprovers.id })
        .from(workflowInstanceApprovers)
      expect(rows).toHaveLength(5)
    })

    it('rejects a second instance-level row for the same approver', async () => {
      await testDb.db.insert(workflowInstanceApprovers).values(instanceRow())

      const pgError = await insertExpectingUnique(() =>
        testDb.db.insert(workflowInstanceApprovers).values(instanceRow()),
      )
      expect(constraintOf(pgError)).toBe('uq_wf_instance_approvers')
    })
  })
})
