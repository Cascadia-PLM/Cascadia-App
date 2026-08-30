// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Adding a state approver under real concurrency
 *
 * Security gate — this is the table approval gating reads. `addStateApprover`
 * selected for an existing row and then inserted, with nothing between the two
 * statements: two administrators configuring the same state at once both read
 * "not an approver yet" and both wrote. The pair is invisible to gating, which
 * collapses it in `mergeApproverLists`, and very visible everywhere else — the
 * approver list shows the person twice, and `removeStateApprover` deletes by
 * id, so taking them off the state left them still approving it.
 *
 * `uq_wf_state_approvers` makes the loser of that race fail, and the insert is
 * wrapped so the failure arrives as the same `ConflictError` the pre-check
 * raises. The outcome it describes is true either way — the approver is on the
 * state — so the caller gets a 409 rather than a 500 that reads like a
 * malfunction.
 *
 * This cannot be tested under `TestDatabase`: one connection inside one
 * transaction serializes every call, so the race cannot occur. These commit
 * for real through `ConcurrentTestDatabase`, which cleans up after itself.
 *
 * Run: npx vitest run packages/core/src/lib/workflows/WorkflowApprovalService.race.test.ts
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { WorkflowApprovalService } from './WorkflowApprovalService'
import { ConcurrentTestDatabase } from '@/__tests__/helpers/concurrent-db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { takeFirst } from '@/lib/db/take-first'
import { ConflictError } from '@/lib/errors'
import {
  workflowDefinitions,
  workflowInstances,
  workflowStateApprovers,
} from '@/lib/db/schema'

describe('WorkflowApprovalService.addStateApprover — one row per approver', () => {
  const concurrent = new ConcurrentTestDatabase()

  /**
   * `ConcurrentTestDatabase` tracks users, programs and designs; a workflow
   * definition is none of those, so this file owns its own cleanup. Approver
   * rows and instances cascade from the definition, and the definition has to
   * go before `concurrent.cleanup()` deletes the users its `created_by`
   * columns name.
   */
  const createdDefinitions: Array<string> = []

  beforeAll(() => {
    concurrent.setup()
  })

  afterAll(async () => {
    await concurrent.teardown()
  })

  afterEach(async () => {
    if (createdDefinitions.length > 0) {
      await concurrent.db
        .delete(workflowInstances)
        .where(
          inArray(workflowInstances.workflowDefinitionId, createdDefinitions),
        )
      await concurrent.db
        .delete(workflowDefinitions)
        .where(inArray(workflowDefinitions.id, createdDefinitions))
      createdDefinitions.length = 0
    }
    await concurrent.cleanup()
  })

  /** A workflow definition, the administrator configuring it, and an approver. */
  async function approvalFixture(label: string) {
    const admin = await insertTestUser(concurrent.db)
    concurrent.trackUser(admin.id)
    const approver = await insertTestUser(concurrent.db)
    concurrent.trackUser(approver.id)

    const definition = takeFirst(
      await concurrent.db
        .insert(workflowDefinitions)
        .values({
          name: `Race ${label} ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          version: 1,
          workflowType: 'strict',
          definition: { states: [], transitions: [] },
        })
        .returning(),
    )
    createdDefinitions.push(definition.id)

    return { admin, approver, definitionId: definition.id }
  }

  async function approverRows(definitionId: string, approverId: string) {
    return concurrent.db
      .select({ id: workflowStateApprovers.id })
      .from(workflowStateApprovers)
      .where(
        and(
          eq(workflowStateApprovers.workflowDefinitionId, definitionId),
          eq(workflowStateApprovers.stateId, 'Review'),
          eq(workflowStateApprovers.approverId, approverId),
        ),
      )
  }

  it('leaves one row and one winner when five requests add the same approver', async () => {
    // Five, not two: with only two callers the pre-check can happen to close
    // the window on its own and the insert guard never runs. Whichever path
    // each caller takes, the invariant is the same — one row, one success, and
    // every loser holding a ConflictError rather than a raw driver failure.
    const { admin, approver, definitionId } = await approvalFixture('add')

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        WorkflowApprovalService.addStateApprover(
          definitionId,
          'Review',
          { type: 'user', id: approver.id, isRequired: true },
          admin.id,
        ),
      ),
    )

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(4)
    for (const failure of rejected) {
      expect(failure.reason).toBeInstanceOf(ConflictError)
    }

    expect(await approverRows(definitionId, approver.id)).toHaveLength(1)
  })

  it('still admits distinct approvers racing on the same state', async () => {
    // The constraint keys on the approver, not on the state: two people being
    // added to one state at the same moment is the ordinary case and must not
    // collide.
    const { admin, approver, definitionId } = await approvalFixture('distinct')
    const second = await insertTestUser(concurrent.db)
    concurrent.trackUser(second.id)

    const results = await Promise.all([
      WorkflowApprovalService.addStateApprover(
        definitionId,
        'Review',
        { type: 'user', id: approver.id, isRequired: true },
        admin.id,
      ),
      WorkflowApprovalService.addStateApprover(
        definitionId,
        'Review',
        { type: 'user', id: second.id, isRequired: true },
        admin.id,
      ),
    ])

    expect(new Set(results.map((r) => r.id)).size).toBe(2)
    expect(await approverRows(definitionId, approver.id)).toHaveLength(1)
    expect(await approverRows(definitionId, second.id)).toHaveLength(1)
  })

  it('reports the sequential duplicate the same way as the raced one', async () => {
    // The friendly path is still the pre-check, and it has to keep raising the
    // error the race now also produces — a caller cannot tell which statement
    // refused, and should not have to.
    const { admin, approver, definitionId } = await approvalFixture('repeat')

    await WorkflowApprovalService.addStateApprover(
      definitionId,
      'Review',
      { type: 'user', id: approver.id, isRequired: true },
      admin.id,
    )

    await expect(
      WorkflowApprovalService.addStateApprover(
        definitionId,
        'Review',
        { type: 'user', id: approver.id, isRequired: false },
        admin.id,
      ),
    ).rejects.toBeInstanceOf(ConflictError)

    expect(await approverRows(definitionId, approver.id)).toHaveLength(1)
  })
})
