// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The release claim under real concurrency
 *
 * Data-integrity gate. `claimRelease` is what stops one workflow instance
 * being released twice: the close path claims the instance, merges branches
 * and assigns revision letters, and a second close arriving mid-flight would
 * mint a second set of revisions for the same change. The claim is a
 * compare-and-swap — one `UPDATE` whose `WHERE` carries the whole precondition
 * (still in the expected state, not completed, and either unclaimed or claimed
 * so long ago the claimant must be dead) — so the row lock decides the winner
 * and every loser sees zero rows affected.
 *
 * That is exactly the property `TestDatabase` cannot check. Its single
 * connection inside one gate transaction serializes every caller, so a claim
 * test written there never touches a row lock: it would pass just as happily
 * against a check-then-write that reads `releasingAt`, finds it null, and
 * writes — the shape that hands the release to everyone who asks. The serial
 * tests beside `WorkflowService.test.ts`'s transition-hardening block pin the
 * policy (a live claim blocks, a stale one is taken over); this file is the
 * half that pins the atomicity, on real connections that commit.
 *
 * `ConcurrentTestDatabase` tracks users, programs and designs. A workflow
 * definition is none of those, so this file owns that cleanup — instances
 * cascade from their item, but the definition outlives it and its name is
 * unique, so leaving one behind would poison the next run.
 *
 * Run: npx vitest run packages/core/src/lib/workflows/WorkflowService.claim.race.test.ts
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { WorkflowService } from './WorkflowService'
import type { CreateWorkflowInput } from './types'
import { ConcurrentTestDatabase } from '@/__tests__/helpers/concurrent-db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { insertTestPart } from '@/__tests__/fixtures/items'
import { workflowDefinitions, workflowInstances } from '@/lib/db/schema'

/**
 * Five contenders, not two. Two callers can miss each other by accident — the
 * first can finish before the second's statement is even parsed — and the test
 * then proves only that a sequential second claim is refused, which the serial
 * suite already covers. Five saturates the harness's pool and puts several
 * statements on the same row at once.
 */
const CONTENDERS = 5

describe('WorkflowService.claimRelease — concurrent claims', () => {
  const concurrent = new ConcurrentTestDatabase()

  /** Definition ids this file created, deleted before the harness drops users. */
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

  /**
   * A definition, an item, and a running instance sitting in `draft` — the
   * state a change order is in when its close is requested.
   */
  async function claimFixture(label: string) {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

    const user = await insertTestUser(concurrent.db)
    concurrent.trackUser(user.id)

    const input: CreateWorkflowInput = {
      name: `Claim Race ${label} ${unique}`,
      lifecycleType: 'Driving',
      workflowType: 'strict',
      states: [
        { id: 'draft', name: 'Draft', isInitial: true },
        {
          id: 'approved',
          name: 'Approved',
          isFinal: true,
          finalKind: 'release',
        },
      ],
      transitions: [
        {
          id: 't1',
          name: 'Approve',
          fromStateId: 'draft',
          toStateId: 'approved',
        },
      ],
    }
    const workflow = await WorkflowService.create(input)
    createdDefinitions.push(workflow.id)

    // The item is scoped to its author, which is how `concurrent.cleanup()`
    // finds it — no design is needed, and giving it one would only widen the
    // cleanup surface in a database shared with the rest of the run.
    const { item } = await insertTestPart(concurrent.db, null, user.id, {
      itemNumber: `WFC-${label}-${unique}`,
    })

    const instance = await WorkflowService.startInstance(workflow.id, item.id, {
      actorId: user.id,
    })

    return { user, item, instance }
  }

  /** Backdate a held claim past the timeout — what a died-mid-release looks like. */
  async function makeClaimStale(instanceId: string) {
    await concurrent.db
      .update(workflowInstances)
      .set({
        releasingAt: new Date(
          Date.now() - WorkflowService.RELEASE_CLAIM_TIMEOUT_MS - 60_000,
        ),
      })
      .where(eq(workflowInstances.id, instanceId))
  }

  it('gives the release to exactly one of five simultaneous claims', async () => {
    const { instance } = await claimFixture('unclaimed')

    const outcomes = await Promise.all(
      Array.from({ length: CONTENDERS }, () =>
        WorkflowService.claimRelease(instance.id, 'draft'),
      ),
    )

    const winners = outcomes.filter((o) => o.claimed)
    const losers = outcomes.filter((o) => !o.claimed)
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(CONTENDERS - 1)

    // Which refusal the losers got matters as much as that they lost: the
    // instance is still in `draft`, still not completed, and now carries a
    // claim, so "a release is already in progress" is the only branch of
    // `claimRelease`'s diagnosis that these row values admit.
    const after = await WorkflowService.getInstance(instance.id)
    expect(after?.currentState).toBe('draft')
    expect(after?.completedAt).toBeUndefined()
    expect(after?.releasingAt).toBeDefined()
    for (const loser of losers) {
      expect(loser.error).toMatch(/already in progress/i)
    }
  })

  it('gives a stale claim to exactly one of five simultaneous takeovers', async () => {
    // The sharper race. Every contender reads a claim that is old enough to
    // take over, so a check-then-write would let all five through and the
    // instance would be released five times. Only the CAS's staleness arm
    // living inside the `UPDATE`'s own `WHERE` makes the row lock pick one.
    const { instance } = await claimFixture('stale')

    const held = await WorkflowService.claimRelease(instance.id, 'draft')
    expect(held.claimed).toBe(true)
    await makeClaimStale(instance.id)

    const outcomes = await Promise.all(
      Array.from({ length: CONTENDERS }, () =>
        WorkflowService.claimRelease(instance.id, 'draft'),
      ),
    )

    expect(outcomes.filter((o) => o.claimed)).toHaveLength(1)
    for (const loser of outcomes.filter((o) => !o.claimed)) {
      expect(loser.error).toMatch(/already in progress/i)
    }

    // The winner's own stamp is fresh, so the takeover closed the window it
    // walked through rather than leaving it open for the next arrival.
    const late = await WorkflowService.claimRelease(instance.id, 'draft')
    expect(late.claimed).toBe(false)
  })

  it('lets claims on distinct instances proceed in parallel', async () => {
    // The lock is on the row, not on the table: two change orders closing at
    // the same moment is the ordinary case, and serializing them would be a
    // regression of a different kind from the one above.
    const first = await claimFixture('distinct-a')
    const second = await claimFixture('distinct-b')

    const [a, b] = await Promise.all([
      WorkflowService.claimRelease(first.instance.id, 'draft'),
      WorkflowService.claimRelease(second.instance.id, 'draft'),
    ])

    expect(a.claimed).toBe(true)
    expect(b.claimed).toBe(true)
  })
})
