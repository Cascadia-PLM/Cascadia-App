// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * WorkOrderInstructionService + InstructionExecutionService tests
 *
 * Data-integrity gate: the traveler is the manufacturing record. The
 * invariants that must always hold:
 * - a traveler line is a FROZEN copy: template edits/deletion never mutate
 *   it, and re-freezing is impossible once execution has begun
 * - executions always belong to a line; line status derives from countable
 *   runs (Complete/Approved) vs requiredCount, never stored
 * - a work order cannot complete while a non-skipped line is open, by any
 *   route — the gate and the completedAt stamp both ride the one shared
 *   transition path; skip is the audited escape hatch and cannot erase
 *   completed work
 * - sign-off routing follows the order's requiresSignOff, and approval no
 *   longer fabricates completed quantity
 *
 * Run: npx vitest run src/lib/services/WorkOrderInstructionService.test.ts
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
import { DesignService } from './DesignService'
import { LifecycleService } from './LifecycleService'
import { WorkOrderService } from './WorkOrderService'
import { WorkOrderInstructionService } from './WorkOrderInstructionService'
import { InstructionExecutionService } from './InstructionExecutionService'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { seedWorkOrderLifecycle } from '@/__tests__/fixtures/lifecycles'
import { ValidationError } from '@/lib/errors'
import {
  itemRelationships,
  items,
  programMembers,
  programs,
  workInstructionPartAttachments,
  workInstructionSteps,
  workOrders,
} from '@/lib/db/schema'
import { takeFirst } from '@/lib/db/take-first'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

describe('WorkOrderInstructionService', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let designId: string

  beforeAll(async () => {
    await testDb.setup()
    // Execution start auto-transitions Not Started orders, and the
    // completion gate rides updateStatus — both need the WO lifecycle,
    // present in dev databases via the app seed, absent in CI's fresh DB.
    await seedWorkOrderLifecycle(testDb.db)
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
          name: 'Test Program',
          code: `PROG-${Date.now()}`,
          createdBy: user.id,
        })
        .returning(),
    )

    // The program's creator is not automatically a member when the row is
    // inserted directly (ProgramService.create is what enrols them), and
    // ItemService.update/delete now refuse a write to a design the caller
    // cannot reach. Enrol the acting user so these cases exercise their own
    // subject rather than the program boundary.
    await testDb.db.insert(programMembers).values({
      programId: program.id,
      userId: user.id,
      role: 'admin',
      invitedBy: user.id,
    })

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

  async function createTemplate(
    name: string,
    stepTitles: Array<string>,
    outputPartId?: string,
  ) {
    // A template is authored against the part it builds, and that part is what
    // puts the work instruction in a design — so one is made if not supplied.
    const outputPart = outputPartId ?? (await createPart(`${name} Output`)).id
    const wi = (await ItemService.create(
      'WorkInstruction',
      {
        designId,
        revision: 'A',
        name,
        description: `${name} description`,
        outputPartId: outputPart,
      } as never,
      user.id,
    )) as { id: string }
    for (const [index, title] of stepTitles.entries()) {
      await testDb.db.insert(workInstructionSteps).values({
        workInstructionId: wi.id,
        orderIndex: index,
        title,
        content: {
          blocks: [
            {
              id: `${wi.id}-blk-${index}`,
              type: 'dataField',
              fieldType: 'numeric',
              fieldLabel: `${title} value`,
            },
          ],
        },
      })
    }
    return wi
  }

  async function createPart(name: string) {
    return (await ItemService.create(
      'Part',
      {
        designId,
        revision: 'A',
        name,
        partType: 'Manufacture',
      } as never,
      user.id,
    )) as { id: string }
  }

  async function createWorkOrder(
    opts: {
      quantity?: number
      requiresSignOff?: boolean
      partId?: string
    } = {},
  ) {
    return WorkOrderService.create(
      {
        quantity: opts.quantity ?? 1,
        requiresSignOff: opts.requiresSignOff ?? false,
        partId: opts.partId ?? null,
        assignedTo: [],
      } as never,
      user.id,
    )
  }

  async function attach(workInstructionId: string, partId: string) {
    await testDb.db.insert(workInstructionPartAttachments).values({
      workInstructionId,
      partId,
      createdBy: user.id,
    })
  }

  async function woState(workOrderId: string) {
    const [row] = await testDb.db
      .select({ state: items.state })
      .from(items)
      .where(eq(items.id, workOrderId))
    return row?.state
  }

  async function completedAt(workOrderId: string) {
    const [row] = await testDb.db
      .select({ completedAt: workOrders.completedAt })
      .from(workOrders)
      .where(eq(workOrders.itemId, workOrderId))
    return row?.completedAt ?? null
  }

  async function completeRun(lineId: string) {
    const { execution } = await InstructionExecutionService.start(
      lineId,
      user.id,
    )
    return InstructionExecutionService.complete(execution.id, user.id)
  }

  describe('snapshot freezing', () => {
    it('instantiation freezes the template; later edits do not leak into the line', async () => {
      const template = await createTemplate('Torque bolts', [
        'Step A',
        'Step B',
      ])
      const wo = await createWorkOrder()

      const line = await WorkOrderInstructionService.instantiate(
        wo.id,
        { workInstructionId: template.id },
        user.id,
      )
      expect(line.snapshot.steps).toHaveLength(2)
      expect(line.title).toBe('Torque bolts')

      // Mutate the template afterwards: rename a step and add a third.
      await testDb.db
        .update(workInstructionSteps)
        .set({ title: 'Step A (revised)' })
        .where(eq(workInstructionSteps.workInstructionId, template.id))
      await testDb.db.insert(workInstructionSteps).values({
        workInstructionId: template.id,
        orderIndex: 2,
        title: 'Step C',
        content: { blocks: [] },
      })

      const after = await WorkOrderInstructionService.get(wo.id, line.id)
      expect(after.snapshot.steps).toHaveLength(2)
      expect(after.snapshot.steps.map((s) => s.title)).toEqual([
        'Step A',
        'Step B',
      ])

      // An explicit refresh re-freezes to the template's current content.
      const refreshed = await WorkOrderInstructionService.refreshSnapshot(
        wo.id,
        line.id,
      )
      expect(refreshed.snapshot.steps).toHaveLength(3)
    })

    it('survives template deletion: provenance nulls, snapshot stays executable', async () => {
      const template = await createTemplate('Deburr edges', ['Only step'])
      const wo = await createWorkOrder()
      const line = await WorkOrderInstructionService.instantiate(
        wo.id,
        { workInstructionId: template.id },
        user.id,
      )

      await ItemService.delete(template.id, user.id)

      const after = await WorkOrderInstructionService.get(wo.id, line.id)
      expect(after.workInstructionId).toBeNull()
      expect(after.snapshot.steps).toHaveLength(1)

      // Still executable from the snapshot…
      const done = await completeRun(line.id)
      expect(done?.status).toBe('Complete')

      // …but no template to re-freeze from.
      await expect(
        WorkOrderInstructionService.refreshSnapshot(wo.id, line.id),
      ).rejects.toThrow(ValidationError)
    })

    it('refresh and remove are rejected once the line has recorded executions', async () => {
      const template = await createTemplate('Inspect welds', ['Look closely'])
      const wo = await createWorkOrder()
      const line = await WorkOrderInstructionService.instantiate(
        wo.id,
        { workInstructionId: template.id },
        user.id,
      )

      await InstructionExecutionService.start(line.id, user.id)

      await expect(
        WorkOrderInstructionService.refreshSnapshot(wo.id, line.id),
      ).rejects.toThrow(ValidationError)
      await expect(
        WorkOrderInstructionService.remove(wo.id, line.id),
      ).rejects.toThrow(ValidationError)

      // An unexecuted line removes cleanly.
      const other = await WorkOrderInstructionService.instantiate(
        wo.id,
        { workInstructionId: template.id },
        user.id,
      )
      await expect(
        WorkOrderInstructionService.remove(wo.id, other.id),
      ).resolves.toBeUndefined()
    })

    it('perUnit pins requiredCount to the order quantity at instantiation', async () => {
      const template = await createTemplate('Serialize unit', ['Scan'])
      const wo = await createWorkOrder({ quantity: 5 })
      const line = await WorkOrderInstructionService.instantiate(
        wo.id,
        { workInstructionId: template.id, perUnit: true },
        user.id,
      )
      expect(line.requiredCount).toBe(5)
    })
  })

  describe('populate from BOM applicability', () => {
    it('walks the BOM (children before assembly) and is idempotent', async () => {
      const assembly = await createPart('Assembly')
      const child = await createPart('Child bracket')
      await testDb.db.insert(itemRelationships).values({
        sourceId: assembly.id,
        targetId: child.id,
        relationshipType: 'BOM',
        quantity: '2',
        createdBy: user.id,
      })

      const assemblyWi = await createTemplate('Assemble housing', ['A'])
      const childWi = await createTemplate('Fabricate bracket', ['B'])
      await attach(assemblyWi.id, assembly.id)
      await attach(childWi.id, child.id)

      const wo = await createWorkOrder({ partId: assembly.id })
      const first = await WorkOrderInstructionService.populate(wo.id, user.id)
      expect(first.created).toHaveLength(2)
      expect(first.skipped).toBe(0)

      // Deepest parts first: the child's fabrication precedes assembly.
      const lines = await WorkOrderInstructionService.list(wo.id)
      expect(lines.map((line) => line.title)).toEqual([
        'Fabricate bracket',
        'Assemble housing',
      ])
      expect(lines[0]?.partId).toBe(child.id)

      const second = await WorkOrderInstructionService.populate(wo.id, user.id)
      expect(second.created).toHaveLength(0)
      expect(second.skipped).toBe(2)
    })

    it('rejects populate on an order with no part', async () => {
      const wo = await createWorkOrder()
      await expect(
        WorkOrderInstructionService.populate(wo.id, user.id),
      ).rejects.toThrow(ValidationError)
    })
  })

  describe('execution lifecycle', () => {
    it('starting a run auto-starts a Not Started order', async () => {
      const template = await createTemplate('Bond panels', ['Mix', 'Apply'])
      const wo = await createWorkOrder()
      const line = await WorkOrderInstructionService.instantiate(
        wo.id,
        { workInstructionId: template.id },
        user.id,
      )

      expect(await woState(wo.id)).toBe('Not Started')
      const { execution, resumed } = await InstructionExecutionService.start(
        line.id,
        user.id,
      )
      expect(resumed).toBe(false)
      expect(execution.status).toBe('In Progress')
      expect(await woState(wo.id)).toBe('In Progress')
    })

    it('resumes the technician’s open run instead of stacking a duplicate', async () => {
      const template = await createTemplate('Pot electronics', ['Pour'])
      const wo = await createWorkOrder()
      const line = await WorkOrderInstructionService.instantiate(
        wo.id,
        { workInstructionId: template.id },
        user.id,
      )

      const first = await InstructionExecutionService.start(line.id, user.id)
      const second = await InstructionExecutionService.start(line.id, user.id)
      expect(second.resumed).toBe(true)
      expect(second.execution.id).toBe(first.execution.id)
    })

    it('rejects runs on skipped lines and on finished orders', async () => {
      const template = await createTemplate('Paint', ['Spray'])
      const wo = await createWorkOrder()
      const line = await WorkOrderInstructionService.instantiate(
        wo.id,
        { workInstructionId: template.id },
        user.id,
      )

      await WorkOrderInstructionService.skip(
        wo.id,
        line.id,
        user.id,
        'Customer supplied pre-painted housings',
      )
      await expect(
        InstructionExecutionService.start(line.id, user.id),
      ).rejects.toThrow(ValidationError)

      await WorkOrderInstructionService.unskip(wo.id, line.id)
      await WorkOrderService.updateStatus(wo.id, 'Cancelled', user.id)
      await expect(
        InstructionExecutionService.start(line.id, user.id),
      ).rejects.toThrow(ValidationError)
    })

    it('derives line status from countable runs vs requiredCount', async () => {
      const template = await createTemplate('Crimp harness', ['Crimp'])
      const wo = await createWorkOrder({ quantity: 2 })
      const line = await WorkOrderInstructionService.instantiate(
        wo.id,
        { workInstructionId: template.id, perUnit: true },
        user.id,
      )

      expect(
        (await WorkOrderInstructionService.get(wo.id, line.id)).status,
      ).toBe('Not Started')

      await completeRun(line.id)
      const afterOne = await WorkOrderInstructionService.get(wo.id, line.id)
      expect(afterOne.status).toBe('In Progress')
      expect(afterOne.completedCount).toBe(1)

      await completeRun(line.id)
      const afterTwo = await WorkOrderInstructionService.get(wo.id, line.id)
      expect(afterTwo.status).toBe('Complete')
      expect(afterTwo.completedCount).toBe(2)
    })

    it('abandoned runs become Incomplete records and never count', async () => {
      const template = await createTemplate('Leak test', ['Pressurize'])
      const wo = await createWorkOrder()
      const line = await WorkOrderInstructionService.instantiate(
        wo.id,
        { workInstructionId: template.id },
        user.id,
      )

      const { execution } = await InstructionExecutionService.start(
        line.id,
        user.id,
      )
      const abandoned = await InstructionExecutionService.abandon(
        execution.id,
        user.id,
      )
      expect(abandoned?.status).toBe('Incomplete')

      const after = await WorkOrderInstructionService.get(wo.id, line.id)
      expect(after.status).toBe('In Progress') // attempted, not done
      expect(after.completedCount).toBe(0)
    })
  })

  describe('sign-off routing', () => {
    it('routes completion to Pending Approval and counts only after approval — without touching quantityCompleted', async () => {
      const template = await createTemplate('Final QC', ['Check'])
      const wo = await createWorkOrder({ requiresSignOff: true })
      const line = await WorkOrderInstructionService.instantiate(
        wo.id,
        { workInstructionId: template.id },
        user.id,
      )

      const { execution } = await InstructionExecutionService.start(
        line.id,
        user.id,
      )
      const completed = await InstructionExecutionService.complete(
        execution.id,
        user.id,
      )
      expect(completed?.status).toBe('Pending Approval')

      // Pending approval is not a countable run.
      expect(
        (await WorkOrderInstructionService.get(wo.id, line.id)).status,
      ).toBe('In Progress')

      const reviewer = await insertTestUser(testDb.db)
      const approved = await InstructionExecutionService.submitSignOff(
        execution.id,
        reviewer.id,
        'approved',
      )
      expect(approved.status).toBe('Approved')
      expect(
        (await WorkOrderInstructionService.get(wo.id, line.id)).status,
      ).toBe('Complete')

      // Approval is evidence the procedure ran — not that a unit shipped.
      const [woRow] = await testDb.db
        .select({ quantityCompleted: workOrders.quantityCompleted })
        .from(workOrders)
        .where(eq(workOrders.itemId, wo.id))
      expect(woRow?.quantityCompleted).toBe(0)
    })

    it('rejected runs can be resubmitted only by the original executor', async () => {
      const template = await createTemplate('Calibrate', ['Zero'])
      const wo = await createWorkOrder({ requiresSignOff: true })
      const line = await WorkOrderInstructionService.instantiate(
        wo.id,
        { workInstructionId: template.id },
        user.id,
      )

      const { execution } = await InstructionExecutionService.start(
        line.id,
        user.id,
      )
      await InstructionExecutionService.complete(execution.id, user.id)

      const reviewer = await insertTestUser(testDb.db)
      const rejected = await InstructionExecutionService.submitSignOff(
        execution.id,
        reviewer.id,
        'rejected',
        'Measurement out of tolerance',
      )
      expect(rejected.status).toBe('Rejected')

      await expect(
        InstructionExecutionService.resubmitForApproval(
          execution.id,
          reviewer.id,
        ),
      ).rejects.toThrow(ValidationError)

      const resubmitted = await InstructionExecutionService.resubmitForApproval(
        execution.id,
        user.id,
      )
      expect(resubmitted?.status).toBe('Pending Approval')
    })
  })

  describe('work order completion gate', () => {
    it('blocks completion while lines are open; skip (with reason) and completion both clear the gate', async () => {
      const template = await createTemplate('Assemble', ['Do it'])
      const optional = await createTemplate('Optional coating', ['Coat'])
      const wo = await createWorkOrder()
      const mainLine = await WorkOrderInstructionService.instantiate(
        wo.id,
        { workInstructionId: template.id },
        user.id,
      )
      const optionalLine = await WorkOrderInstructionService.instantiate(
        wo.id,
        { workInstructionId: optional.id },
        user.id,
      )

      await completeRun(mainLine.id) // also moves the order In Progress

      // The optional line is still open — completion must be refused.
      await expect(
        WorkOrderService.updateStatus(wo.id, 'Complete', user.id),
      ).rejects.toThrow(ValidationError)
      expect(await woState(wo.id)).toBe('In Progress')

      // Skipping is audited: no reason, no skip.
      await expect(
        WorkOrderInstructionService.skip(wo.id, optionalLine.id, user.id, ''),
      ).rejects.toThrow()

      await WorkOrderInstructionService.skip(
        wo.id,
        optionalLine.id,
        user.id,
        'Coating not ordered for this batch',
      )
      const updated = await WorkOrderService.updateStatus(
        wo.id,
        'Complete',
        user.id,
      )
      expect(updated.status).toBe('Complete')
      expect(await completedAt(wo.id)).not.toBeNull()
    })

    it('a completed line cannot be skipped (history is not erasable)', async () => {
      const template = await createTemplate('Rivet', ['Set rivets'])
      const wo = await createWorkOrder()
      const line = await WorkOrderInstructionService.instantiate(
        wo.id,
        { workInstructionId: template.id },
        user.id,
      )
      await completeRun(line.id)

      await expect(
        WorkOrderInstructionService.skip(
          wo.id,
          line.id,
          user.id,
          'trying to hide work',
        ),
      ).rejects.toThrow(ValidationError)
    })

    it('gates the generic transition path identically, and stamps completedAt when it clears', async () => {
      // The invariant is route-independent: no work order reaches a
      // `finalKind: 'complete'` state over an unfinished traveler, by any
      // door. POST /api/v1/items/:id/transition and the
      // transition_item_state AI tool both reach transitionFreeItem with
      // nothing of their own in between, so the shared path is what is
      // asserted here rather than each caller.
      const template = await createTemplate('Weld', ['Run bead'])
      const optional = await createTemplate('Optional inspection', ['Inspect'])
      const wo = await createWorkOrder()
      const mainLine = await WorkOrderInstructionService.instantiate(
        wo.id,
        { workInstructionId: template.id },
        user.id,
      )
      const optionalLine = await WorkOrderInstructionService.instantiate(
        wo.id,
        { workInstructionId: optional.id },
        user.id,
      )

      // In Progress, so the lifecycle genuinely offers the edge to Complete:
      // a refusal below is the traveler gate, not the transition map.
      await completeRun(mainLine.id)
      expect(await woState(wo.id)).toBe('In Progress')

      await expect(
        LifecycleService.transitionFreeItem(wo.id, 'Complete', user.id),
      ).rejects.toThrow(ValidationError)

      // Asserted on the row, not on which error was raised — and on
      // completedAt too, since a Complete order with a NULL stamp is the
      // half of the defect that silently drops out of cycle-time reports.
      expect(await woState(wo.id)).toBe('In Progress')
      expect(await completedAt(wo.id)).toBeNull()

      await WorkOrderInstructionService.skip(
        wo.id,
        optionalLine.id,
        user.id,
        'Inspection waived for this batch',
      )
      await LifecycleService.transitionFreeItem(wo.id, 'Complete', user.id)

      expect(await woState(wo.id)).toBe('Complete')
      const stamped = await completedAt(wo.id)
      expect(stamped).not.toBeNull()

      // Re-asserting the goal is a no-op: it must not slide the completion
      // timestamp of a record that is already closed.
      await LifecycleService.transitionFreeItem(wo.id, 'Complete', user.id)
      expect((await completedAt(wo.id))?.getTime()).toBe(stamped!.getTime())
    })

    it('cancellation is not gated by the traveler', async () => {
      const template = await createTemplate('Never run', ['Step'])
      const wo = await createWorkOrder()
      await WorkOrderInstructionService.instantiate(
        wo.id,
        { workInstructionId: template.id },
        user.id,
      )
      const cancelled = await WorkOrderService.updateStatus(
        wo.id,
        'Cancelled',
        user.id,
      )
      expect(cancelled.status).toBe('Cancelled')
    })
  })
})
