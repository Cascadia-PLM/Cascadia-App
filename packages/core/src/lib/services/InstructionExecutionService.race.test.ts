// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Opening a traveler run under real concurrency
 *
 * Data-integrity gate. `InstructionExecutionService.start` did a resume
 * SELECT and then a bare INSERT — no transaction, no lock, no ON CONFLICT.
 * Two requests that both read "no open run" both inserted, and the traveler's
 * countable tally (`WorkOrderInstructionService.deriveStatus`,
 * `completedCount >= line.requiredCount`) then counted one physical run twice
 * toward the gate that decides whether a work order may be completed. The
 * manufacturing record said a procedure had been performed twice when it had
 * been performed once.
 *
 * `uq_instr_exec_open_run` — partial on `status = 'In Progress'`, keyed on
 * (line, technician, COALESCE(unit_label,'')) — makes the loser of that race
 * fail, and `start` re-reads and hands back the winner, so a race is
 * indistinguishable from a resume.
 *
 * The same gate covers the auto-start on the other side of that insert.
 * `start()` walks a Not Started order along its lifecycle before opening the
 * run, and that walk was get-then-create: simultaneous FIRST runs left one
 * winner and every other caller holding an "already exists" / "concurrent
 * transition" failure with no execution row at all. These cases therefore
 * race the first run deliberately — there is no warm-up.
 *
 * This cannot be tested under `TestDatabase`: one connection inside one
 * transaction serializes every call, so the race cannot occur. These commit
 * for real through `ConcurrentTestDatabase`, which cleans up after itself.
 *
 * Run: npx vitest run packages/core/src/lib/services/InstructionExecutionService.race.test.ts
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { and, eq, isNull } from 'drizzle-orm'
import type { TestUser } from '@/__tests__/fixtures/users'
import { ConcurrentTestDatabase } from '@/__tests__/helpers/concurrent-db'
import { ItemService } from '@/lib/items/services/ItemService'
import { WorkOrderService } from '@/lib/services/WorkOrderService'
import { WorkOrderInstructionService } from '@/lib/services/WorkOrderInstructionService'
import { InstructionExecutionService } from '@/lib/services/InstructionExecutionService'
import { LifecycleService } from '@/lib/services/LifecycleService'
import { ValidationError } from '@/lib/errors'
import { seedWorkOrderLifecycle } from '@/__tests__/fixtures/lifecycles'
import {
  instructionExecutions,
  items,
  workInstructionSteps,
  workflowHistory,
  workflowInstances,
} from '@/lib/db/schema'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

describe('InstructionExecutionService.start — one open run per unit', () => {
  const concurrent = new ConcurrentTestDatabase()

  beforeAll(async () => {
    concurrent.setup()
    // start() auto-transitions a Not Started order, so the WO lifecycle has
    // to exist — present in dev databases via the app seed, absent in CI's.
    await seedWorkOrderLifecycle(concurrent.db)
  })

  afterAll(async () => {
    await concurrent.teardown()
  })

  afterEach(async () => {
    await concurrent.cleanup()
  })

  /** A work order with one traveler line on it, and the technician running it. */
  async function travelerLine(label: string) {
    const { user, designId } = await concurrent.seedScope(label)

    const outputPart = (await ItemService.create(
      'Part',
      {
        designId,
        revision: 'A',
        name: `${label} Output`,
        partType: 'Manufacture',
      } as never,
      user.id,
    )) as { id: string }

    const template = (await ItemService.create(
      'WorkInstruction',
      {
        designId,
        revision: 'A',
        name: `${label} Procedure`,
        description: 'Concurrent run test',
        outputPartId: outputPart.id,
      } as never,
      user.id,
    )) as { id: string }

    await concurrent.db.insert(workInstructionSteps).values({
      workInstructionId: template.id,
      orderIndex: 0,
      title: 'Torque the bolts',
      content: { blocks: [] },
    })

    const wo = await WorkOrderService.create(
      {
        quantity: 1,
        requiresSignOff: false,
        partId: outputPart.id,
        assignedTo: [],
      } as never,
      user.id,
    )

    const line = await WorkOrderInstructionService.instantiate(
      wo.id,
      { workInstructionId: template.id },
      user.id,
    )

    return { user, line, workOrderId: wo.id }
  }

  async function openRuns(lineId: string, user: TestUser) {
    return concurrent.db
      .select({ id: instructionExecutions.id })
      .from(instructionExecutions)
      .where(
        and(
          eq(instructionExecutions.workOrderInstructionId, lineId),
          eq(instructionExecutions.executedBy, user.id),
          eq(instructionExecutions.status, 'In Progress'),
        ),
      )
  }

  /** Every open workflow instance for the order — the partial index allows one. */
  async function activeInstances(workOrderId: string) {
    return concurrent.db
      .select({
        id: workflowInstances.id,
        state: workflowInstances.currentState,
      })
      .from(workflowInstances)
      .where(
        and(
          eq(workflowInstances.itemId, workOrderId),
          isNull(workflowInstances.completedAt),
        ),
      )
  }

  /** `state_adopted` rows written against the order's instances. */
  async function adoptions(workOrderId: string) {
    return concurrent.db
      .select({ id: workflowHistory.id })
      .from(workflowHistory)
      .innerJoin(
        workflowInstances,
        eq(workflowInstances.id, workflowHistory.instanceId),
      )
      .where(
        and(
          eq(workflowInstances.itemId, workOrderId),
          eq(workflowHistory.action, 'state_adopted'),
        ),
      )
  }

  async function itemState(itemId: string) {
    const row = (
      await concurrent.db
        .select({ state: items.state })
        .from(items)
        .where(eq(items.id, itemId))
    )[0]
    return row?.state
  }

  it('opens exactly one run when five requests race for the same line', async () => {
    // These are the FIRST runs on a Not Started order, so they race the
    // lifecycle auto-start as well as the execution insert. Every caller must
    // come back with a run; none may fail because it lost either race.
    const { user, line, workOrderId } = await travelerLine('open-run-race')

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        InstructionExecutionService.start(line.id, user.id),
      ),
    )

    // The invariant: one physical run, and every caller holding its id — a
    // loser that received a *different* id would be a second run in disguise.
    const rows = await openRuns(line.id, user)
    expect(rows).toHaveLength(1)

    const ids = new Set(results.map((r) => r.execution.id))
    expect(ids.size).toBe(1)
    expect([...ids][0]).toBe(rows[0]!.id)

    // ...and the order started exactly once: one open workflow instance, and
    // the order itself moved out of its initial state.
    const instances = await activeInstances(workOrderId)
    expect(instances).toHaveLength(1)
    expect(instances[0]!.state).toBe('In Progress')
    expect(await itemState(workOrderId)).toBe('In Progress')
  })

  it('absorbs a lost race in the underlying free-lifecycle transition', async () => {
    // The auto-start's own defect, isolated: `transitionFreeItem` read the
    // instance and then created/moved it, so a loser hit either "already
    // exists" on the instance insert, the compare-and-swap miss, or "no valid
    // transition from current state" once the winner had already arrived.
    // The operation names a target state, so all three are the goal being met.
    const { user, workOrderId } = await travelerLine('free-transition-race')

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        LifecycleService.transitionFreeItem(
          workOrderId,
          'In Progress',
          user.id,
        ),
      ),
    )

    for (const result of results) {
      expect(result.toStateId).toBe('In Progress')
    }
    expect(await activeInstances(workOrderId)).toHaveLength(1)
    expect(await itemState(workOrderId)).toBe('In Progress')

    // No instance was rolled backward onto a caller's stale read of the item:
    // a `state_adopted` row here would be a state regression the order never
    // made, recorded in the audit trail.
    expect(await adoptions(workOrderId)).toHaveLength(0)
  })

  it('still rejects a target the lifecycle has no edge to', async () => {
    // Absorption is keyed on the observed end state, not on swallowing
    // failures: a move the lifecycle does not offer must still fail.
    const { user, workOrderId } = await travelerLine('unreachable-target')

    await expect(
      LifecycleService.transitionFreeItem(workOrderId, 'Complete', user.id),
    ).rejects.toBeInstanceOf(ValidationError)
    expect(await itemState(workOrderId)).toBe('Not Started')
  })

  it('still opens a distinct run per unit label', async () => {
    // The index buckets on COALESCE(unit_label,''), so two serial numbers are
    // two buckets and the second insert must not collide with the first.
    const { user, line } = await travelerLine('per-unit-run')

    const first = await InstructionExecutionService.start(
      line.id,
      user.id,
      'SN-0001',
    )
    const second = await InstructionExecutionService.start(
      line.id,
      user.id,
      'SN-0002',
    )

    expect(first.execution.id).not.toBe(second.execution.id)
    expect(await openRuns(line.id, user)).toHaveLength(2)
  })

  it('races two starts on the same unit label down to one run', async () => {
    const { user, line } = await travelerLine('per-unit-race')

    const results = await Promise.all([
      InstructionExecutionService.start(line.id, user.id, 'SN-0001'),
      InstructionExecutionService.start(line.id, user.id, 'SN-0001'),
    ])

    expect(new Set(results.map((r) => r.execution.id)).size).toBe(1)
    expect(await openRuns(line.id, user)).toHaveLength(1)
  })

  it('resumes a labelled run for an unlabelled start — deliberate, unchanged', async () => {
    // Pinned because it looks like a gap next to the index and is not one.
    // The resume SELECT only constrains unit_label when the caller supplies
    // one, so an unlabelled start matches the technician's open run whatever
    // its label. That is the fast path's pre-existing semantics; it opens no
    // second row, so the index has nothing to say about it, and changing it
    // would mean *more* runs, not fewer.
    const { user, line } = await travelerLine('null-label-run')

    const labelled = await InstructionExecutionService.start(
      line.id,
      user.id,
      'SN-0001',
    )
    const unlabelled = await InstructionExecutionService.start(line.id, user.id)

    expect(unlabelled.resumed).toBe(true)
    expect(unlabelled.execution.id).toBe(labelled.execution.id)
    expect(await openRuns(line.id, user)).toHaveLength(1)
  })

  it('opens a fresh run after the previous one completes', async () => {
    // The index is partial on 'In Progress' precisely so a finished run does
    // not block the next one.
    const { user, line } = await travelerLine('sequential-runs')

    const first = await InstructionExecutionService.start(line.id, user.id)
    await InstructionExecutionService.complete(first.execution.id, user.id)

    const second = await InstructionExecutionService.start(line.id, user.id)

    expect(second.resumed).toBe(false)
    expect(second.execution.id).not.toBe(first.execution.id)
    expect(await openRuns(line.id, user)).toHaveLength(1)
  })

  it('resumes rather than duplicating on a sequential second start', async () => {
    const { user, line } = await travelerLine('resume-run')

    const first = await InstructionExecutionService.start(line.id, user.id)
    const again = await InstructionExecutionService.start(line.id, user.id)

    expect(again.resumed).toBe(true)
    expect(again.execution.id).toBe(first.execution.id)
    expect(await openRuns(line.id, user)).toHaveLength(1)
  })
})
