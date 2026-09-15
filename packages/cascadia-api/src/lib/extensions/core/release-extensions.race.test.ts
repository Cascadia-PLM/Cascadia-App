// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * What core's release extensions guarantee, as consumers.
 *
 * Gate 1 (data integrity): these two replaced post-commit dispatches whose
 * failures were swallowed, and the whole argument for moving them is delivery —
 * every arm, retried, caught up, and visibly parked. An assertion that does not
 * exercise real delivery proves none of that.
 *
 * **On the concurrent harness, deliberately.** `seq` is assigned by the
 * sequencing trigger when the emitting transaction *commits*, so nothing
 * published inside the gate harness's rolled-back transaction is ever assigned
 * one — a consumer there is shown an empty log and passes every "nothing was
 * delivered" assertion for entirely the wrong reason. Real commits, and this
 * file owns its cleanup.
 *
 * **Cleanup is by captured event id, never by type.** This suite publishes real
 * `design.released` facts, so deleting by type would delete rows another suite
 * committed.
 *
 * **Assertions are scoped the same way.** Another suite's release can commit
 * between two of this file's, so a test states what it expects over its own
 * events and their own seqs — never the log's head at some later moment, and
 * never "everything submitted".
 *
 * Each extension is built through its injectable `submit`, so the assertions
 * are about what was submitted rather than about a spy's call shape.
 */

import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { eq, inArray, max } from 'drizzle-orm'
import { createWiChangeAlertExtension } from './wi-change-alerts'
import { createSupersededWatermarkExtension } from './superseded-watermarks'
import type { DesignReleasedPayload } from '@/lib/events'
import type { ConsumedExtension } from '@/lib/extensions'
import { ConcurrentTestDatabase } from '@/__tests__/helpers/concurrent-db'
import { db } from '@/lib/db'
import { domainEvents, eventConsumers } from '@/lib/db/schema'
import {
  DESIGN_RELEASED,
  drainEventConsumer,
  ensureDomainEventSequencing,
  publishDomainEvent,
} from '@/lib/events'
import { asDomainEventConsumer } from '@/lib/extensions'

interface ReleasedItemOverrides {
  changeType?: 'modified' | 'added' | 'deleted'
  previousItemId?: string | null
}

describe('core release extensions', () => {
  const concurrent = new ConcurrentTestDatabase()
  const publishedEventIds: Array<string> = []
  const createdConsumerIds: Array<string> = []
  const actorId = randomUUID()

  beforeAll(async () => {
    concurrent.setup()
    await ensureDomainEventSequencing(concurrent.db)
  })

  afterAll(async () => {
    await concurrent.teardown()
  })

  afterEach(async () => {
    if (publishedEventIds.length > 0) {
      await concurrent.db
        .delete(domainEvents)
        .where(inArray(domainEvents.id, publishedEventIds))
      publishedEventIds.length = 0
    }
    if (createdConsumerIds.length > 0) {
      await concurrent.db
        .delete(eventConsumers)
        .where(inArray(eventConsumers.id, createdConsumerIds))
      createdConsumerIds.length = 0
    }
    await concurrent.cleanup()
  })

  async function currentHead(): Promise<number> {
    const rows = await concurrent.db
      .select({ value: max(domainEvents.seq) })
      .from(domainEvents)
    return rows.at(0)?.value ?? 0
  }

  /** A consumer for one extension, with its cursor at the log's current head. */
  async function consumerFor(
    extension: ConsumedExtension<DesignReleasedPayload>,
    idSuffix: string,
  ) {
    const id = `${extension.id}.${idSuffix}`
    createdConsumerIds.push(id)
    await concurrent.db
      .insert(eventConsumers)
      .values({ id, lastSeq: await currentHead() })
      .onConflictDoNothing()
    return asDomainEventConsumer({ ...extension, id })
  }

  function releasePayload(
    branchId: string | null,
    items: Array<ReleasedItemOverrides>,
  ): DesignReleasedPayload {
    return {
      changeOrderId: randomUUID(),
      changeOrderLabel: 'ECO-000042 (Engineering Change Order)',
      designId: randomUUID(),
      branchId,
      targetBranchId: randomUUID(),
      mergeCommitId: randomUUID(),
      revisionsAssigned: { 'PN-1': 'B' },
      items: items.map((overrides, index) => ({
        itemId: randomUUID(),
        previousItemId:
          overrides.previousItemId === undefined
            ? randomUUID()
            : overrides.previousItemId,
        masterId: randomUUID(),
        itemNumber: `PN-${index + 1}`,
        name: `Part ${index + 1}`,
        itemType: 'Part',
        previousRevision: 'A',
        newRevision: 'B',
        changeType: overrides.changeType ?? 'modified',
        action: null,
      })),
    }
  }

  /** Publish one release fact in its own committed transaction, with its seq. */
  async function publishRelease(
    payload: DesignReleasedPayload,
  ): Promise<{ id: string; seq: number }> {
    const pending = await db.transaction((tx) =>
      publishDomainEvent(tx, DESIGN_RELEASED, {
        actorId,
        subject: { id: payload.designId },
        context: { designId: payload.designId },
        correlationId: payload.changeOrderId,
        payload,
      }),
    )
    publishedEventIds.push(pending.id)
    const row = await concurrent.db
      .select({ seq: domainEvents.seq })
      .from(domainEvents)
      .where(eq(domainEvents.id, pending.id))
      .then((rows) => rows.at(0))
    return { id: pending.id, seq: row?.seq ?? 0 }
  }

  /* ---------------------------------------------------------------- *
   * Parity — the invariant that would have caught the original hole
   * ---------------------------------------------------------------- */

  it('a branchless release produces the same invocations as a branch release', async () => {
    const submissions: Array<{ branch: string; changedPartIds: number }> = []

    const run = async (branchId: string | null, label: string) => {
      const release = releasePayload(branchId, [
        { changeType: 'modified' },
        { changeType: 'added' },
        { changeType: 'deleted' },
      ])
      const extension = createWiChangeAlertExtension({
        submit: async (payload) => {
          // Another suite's release can land while this drains.
          if (payload.changeOrderId !== release.changeOrderId) return
          submissions.push({
            branch: label,
            changedPartIds: payload.changedPartIds.length,
          })
          await Promise.resolve()
        },
      })
      const consumer = await consumerFor(extension, label)
      await publishRelease(release)
      await drainEventConsumer(consumer)
    }

    // The branch-merge arm, then the branchless arm, over the same shape of
    // affected items. The old dispatch lived inside `mergeBranchToMain`, so
    // the second of these alerted nobody and nothing recorded that it was owed.
    await run(randomUUID(), 'branch')
    await run(null, 'branchless')

    expect(submissions).toEqual([
      { branch: 'branch', changedPartIds: 2 },
      { branch: 'branchless', changedPartIds: 2 },
    ])
  })

  /* ---------------------------------------------------------------- *
   * Catch-up
   * ---------------------------------------------------------------- */

  it('catches up in seq order on releases committed while it was not running', async () => {
    const seen: Array<string> = []
    const extension = createWiChangeAlertExtension({
      submit: async (payload) => {
        seen.push(payload.changeOrderId)
        await Promise.resolve()
      },
    })
    const consumer = await consumerFor(extension, 'catchup')

    // Three releases, three transactions, nothing draining them.
    const expected: Array<string> = []
    let lastPublishedSeq = 0
    for (let i = 0; i < 3; i++) {
      const payload = releasePayload(randomUUID(), [{ changeType: 'modified' }])
      expected.push(payload.changeOrderId)
      lastPublishedSeq = (await publishRelease(payload)).seq
    }
    expect(seen).toEqual([])

    await drainEventConsumer(consumer)

    // In seq order, among whatever else committed meanwhile.
    expect(seen.filter((id) => expected.includes(id))).toEqual(expected)
    const cursor = await concurrent.db
      .select()
      .from(eventConsumers)
      .where(eq(eventConsumers.id, consumer.id))
      .then((rows) => rows.at(0))
    expect(cursor?.lastSeq).toBeGreaterThanOrEqual(lastPublishedSeq)
  })

  /* ---------------------------------------------------------------- *
   * Isolation — what separate cursors are bought for
   * ---------------------------------------------------------------- */

  it('a failing extension stops at its own event and leaves the other alone', async () => {
    const first = releasePayload(randomUUID(), [{ changeType: 'modified' }])
    const second = releasePayload(randomUUID(), [{ changeType: 'modified' }])
    const alerted: Array<string> = []
    const failing = createWiChangeAlertExtension({
      submit: async (payload) => {
        // Refuses this test's second release by identity rather than by call
        // count: another suite's release can land between the two.
        if (payload.changeOrderId === second.changeOrderId) {
          throw new Error('submission refused')
        }
        alerted.push(payload.changeOrderId)
        await Promise.resolve()
      },
    })
    const stamped: Array<string> = []
    const healthy = createSupersededWatermarkExtension({
      submit: async (payload) => {
        stamped.push(payload.itemId)
        await Promise.resolve()
      },
    })

    const failingConsumer = await consumerFor(failing, 'isolation-fail')
    const healthyConsumer = await consumerFor(healthy, 'isolation-ok')

    const firstEvent = await publishRelease(first)
    const secondEvent = await publishRelease(second)

    await drainEventConsumer(failingConsumer)
    await drainEventConsumer(healthyConsumer)

    // The first event was handled; the cursor stopped below the failure.
    expect(alerted).toContain(first.changeOrderId)
    expect(alerted).not.toContain(second.changeOrderId)
    const failedRow = await concurrent.db
      .select()
      .from(eventConsumers)
      .where(eq(eventConsumers.id, failingConsumer.id))
      .then((rows) => rows.at(0))
    expect(failedRow?.lastSeq).toBeGreaterThanOrEqual(firstEvent.seq)
    expect(failedRow?.lastSeq).toBeLessThan(secondEvent.seq)
    expect(failedRow?.failureCount).toBe(1)
    expect(failedRow?.lastError).toContain('submission refused')
    // The error names the extension rather than arriving anonymously.
    expect(failedRow?.lastError).toContain(failing.id)

    // The other extension is entirely unaffected — which is the property two
    // cursors are bought for. Two files each: no PDFs are found for these
    // synthetic ids, so it submits nothing but still advances.
    const healthyRow = await concurrent.db
      .select()
      .from(eventConsumers)
      .where(eq(eventConsumers.id, healthyConsumer.id))
      .then((rows) => rows.at(0))
    expect(healthyRow?.failureCount).toBe(0)
    expect(healthyRow?.lastSeq).toBeGreaterThanOrEqual(secondEvent.seq)
    expect(stamped).toEqual([])
  })

  /* ---------------------------------------------------------------- *
   * Redelivery
   * ---------------------------------------------------------------- */

  it('draining twice submits once; rewinding the cursor redelivers', async () => {
    const seen: Array<string> = []
    const extension = createWiChangeAlertExtension({
      submit: async (payload) => {
        seen.push(payload.changeOrderId)
        await Promise.resolve()
      },
    })
    const consumer = await consumerFor(extension, 'redelivery')

    const payload = releasePayload(randomUUID(), [{ changeType: 'modified' }])
    const { seq } = await publishRelease(payload)

    await drainEventConsumer(consumer)
    await drainEventConsumer(consumer)

    // Draining again is a no-op: the cursor advanced past it. Counted over this
    // release alone, since another suite's can land meanwhile.
    const ours = () => seen.filter((id) => id === payload.changeOrderId)
    expect(ours()).toEqual([payload.changeOrderId])

    // Rewinding it does redeliver, and that is the contract rather than a
    // defect: delivery is at-least-once, so a handler must be idempotent in
    // its *effect*. For these two that idempotency lives downstream — the
    // watermark job skips a file that already carries the mark, and re-alerting
    // a work instruction is harmless.
    await concurrent.db
      .update(eventConsumers)
      .set({ lastSeq: seq - 1 })
      .where(eq(eventConsumers.id, consumer.id))
    await drainEventConsumer(consumer)

    expect(ours()).toEqual([payload.changeOrderId, payload.changeOrderId])
  })

  /* ---------------------------------------------------------------- *
   * The watermark's own filtering
   * ---------------------------------------------------------------- */

  it('stamps only revisions this release superseded', async () => {
    const submissions: Array<string> = []
    const extension = createSupersededWatermarkExtension({
      submit: async (payload) => {
        submissions.push(payload.itemId)
        await Promise.resolve()
      },
    })
    const consumer = await consumerFor(extension, 'filtering')

    // An added item supersedes nothing, and a modified one with no previous
    // row (which the branchless `release` action produces) supersedes nothing
    // either. Neither should be stamped, and neither has files anyway — the
    // assertion that matters is that the filter runs before the file read.
    await publishRelease(
      releasePayload(randomUUID(), [
        { changeType: 'added', previousItemId: null },
        { changeType: 'modified', previousItemId: null },
        { changeType: 'deleted' },
      ]),
    )
    await drainEventConsumer(consumer)

    expect(submissions).toEqual([])
    const row = await concurrent.db
      .select()
      .from(eventConsumers)
      .where(eq(eventConsumers.id, consumer.id))
      .then((rows) => rows.at(0))
    expect(row?.failureCount).toBe(0)
  })
})
