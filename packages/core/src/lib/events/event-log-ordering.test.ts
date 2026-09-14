// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The flagship guarantee of the event log, proven across real sessions:
 * a consumer can never skip an event whose transaction commits late — and it
 * never has to wait for one, either.
 *
 * The failure mode a sequence default would have: T1 inserts seq N and
 * stalls before commit; T2 inserts seq N+1 and commits immediately. A naive
 * cursor reader sees N+1, advances past N, and loses N forever when T1
 * finally commits. With commit-time sequencing the interleaving is harmless
 * by construction: T2's event is sequenced first because it committed first,
 * T1's event takes the next seq when it eventually commits, and the cursor
 * that advanced past T2's event is still below it. Here we build exactly that
 * interleaving with two dedicated connections and assert the consumer (a)
 * completes promptly while T1 is still in flight, (b) delivers T2's event,
 * and (c) delivers T1's afterwards, above the cursor.
 *
 * This file does NOT use the gate-transaction harness — the scenario needs
 * real concurrent sessions and real commits. It cleans up after itself by
 * deleting its own event types and consumer rows.
 */

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq, max } from 'drizzle-orm'
import postgres from 'postgres'
import { z } from 'zod'
import type { DomainEventConsumer } from '@/lib/events'
import * as schema from '@/lib/db/schema'
import { db } from '@/lib/db'
import { domainEvents, eventConsumers } from '@/lib/db/schema'
import {
  defineDomainEvent,
  drainEventConsumer,
  ensureDomainEventSequencing,
  publishDomainEvent,
  runEventConsumerOnce,
} from '@/lib/events'

const ORDERING_EVENT = defineDomainEvent({
  type: 'test.events.ordering_spec',
  schemaVersion: 1,
  description: 'Test-only event for cross-session ordering',
  payloadSchema: z.object({ marker: z.string() }),
})

const connectionUrl = process.env.TEST_DATABASE_URL!
const createdConsumerIds: Array<string> = []

function connect() {
  const client = postgres(connectionUrl, { max: 1 })
  return { client, db: drizzle(client, { schema }) }
}

async function registerConsumerAtHead(id: string): Promise<void> {
  const rows = await db
    .select({ value: max(domainEvents.seq) })
    .from(domainEvents)
  const head = rows.at(0)?.value ?? 0
  await db.insert(eventConsumers).values({ id, lastSeq: head })
  createdConsumerIds.push(id)
}

async function seqOf(id: string): Promise<number | null> {
  const rows = await db
    .select({ seq: domainEvents.seq })
    .from(domainEvents)
    .where(eq(domainEvents.id, id))
  return rows.at(0)?.seq ?? null
}

beforeAll(async () => {
  await ensureDomainEventSequencing(db)
})

afterAll(async () => {
  // This file commits for real — remove everything it created.
  await db
    .delete(domainEvents)
    .where(eq(domainEvents.type, 'test.events.ordering_spec'))
  for (const id of createdConsumerIds) {
    await db.delete(eventConsumers).where(eq(eventConsumers.id, id))
  }
})

describe('event log ordering across sessions', () => {
  it('neither waits for nor skips an event whose transaction commits late', async () => {
    const session1 = connect()
    const session2 = connect()
    try {
      const consumerId = `test.ordering-${randomUUID().slice(0, 12)}`
      await registerConsumerAtHead(consumerId)

      const seen: Array<string> = []
      const consumer: DomainEventConsumer = {
        id: consumerId,
        eventTypes: ['test.events.ordering_spec'],
        handler: (event) => {
          seen.push((event.payload as { marker: string }).marker)
          return Promise.resolve()
        },
      }

      // T1: publish E1 and stall before committing.
      let releaseT1!: () => void
      const t1Gate = new Promise<void>((resolve) => {
        releaseT1 = resolve
      })
      let signalE1Inserted!: () => void
      const e1Inserted = new Promise<void>((resolve) => {
        signalE1Inserted = resolve
      })
      let e1Id = ''
      const t1 = session1.db.transaction(async (tx) => {
        const e1 = await publishDomainEvent(tx, ORDERING_EVENT, {
          payload: { marker: 'E1-slow' },
        })
        e1Id = e1.id
        signalE1Inserted()
        await t1Gate
      })
      // E1 must be inserted before E2 publishes, or the interleaving under
      // test isn't the one we built.
      await e1Inserted

      // T2: publish E2 and commit immediately — publishers never block on
      // each other, and E2 is sequenced now because it committed now.
      const e2 = await session2.db.transaction(async (tx) =>
        publishDomainEvent(tx, ORDERING_EVENT, {
          payload: { marker: 'E2-fast' },
        }),
      )
      const e2Seq = await seqOf(e2.id)
      expect(e2Seq).not.toBeNull()
      expect(await seqOf(e1Id)).toBeNull()

      // The consumer must NOT wait on T1: it completes promptly and
      // delivers E2, the only committed event.
      const raced = await Promise.race([
        runEventConsumerOnce(consumer).then(() => 'completed' as const),
        new Promise<'timed out'>((resolve) =>
          setTimeout(() => resolve('timed out'), 5000),
        ),
      ])
      expect(raced).toBe('completed')
      expect(seen).toEqual(['E2-fast'])

      // T1 commits: E1 takes the next seq — above E2's, above the cursor —
      // and the next run delivers it. Nothing was skipped.
      releaseT1()
      await t1
      const e1Seq = await seqOf(e1Id)
      expect(e1Seq).not.toBeNull()
      expect(e1Seq!).toBeGreaterThan(e2Seq!)

      await drainEventConsumer(consumer)
      expect(seen).toEqual(['E2-fast', 'E1-slow'])

      const cursorRows = await db
        .select()
        .from(eventConsumers)
        .where(eq(eventConsumers.id, consumerId))
      // At least E1's seq: other suites commit real events into the same
      // log, and the drain skips past any that landed after it.
      expect(cursorRows.at(0)?.lastSeq).toBeGreaterThanOrEqual(e1Seq!)
    } finally {
      await session1.client.end()
      await session2.client.end()
    }
  }, 30000)

  it('only one runner claims a consumer at a time (SKIP LOCKED)', async () => {
    const session1 = connect()
    try {
      const consumerId = `test.ordering-lock-${randomUUID().slice(0, 12)}`
      await registerConsumerAtHead(consumerId)

      const consumer: DomainEventConsumer = {
        id: consumerId,
        eventTypes: '*',
        handler: async () => {},
      }

      // Session 1 claims the cursor row and holds it.
      let releaseHold!: () => void
      const holdGate = new Promise<void>((resolve) => {
        releaseHold = resolve
      })
      let signalClaimed!: () => void
      const rowClaimed = new Promise<void>((resolve) => {
        signalClaimed = resolve
      })
      const holder = session1.db.transaction(async (tx) => {
        await tx
          .select()
          .from(eventConsumers)
          .where(eq(eventConsumers.id, consumerId))
          .for('update')
        signalClaimed()
        await holdGate
      })

      // Wait until the holder actually has the row lock.
      await rowClaimed

      const result = await runEventConsumerOnce(consumer)
      expect(result.status).toBe('locked')
      expect(result.processed).toBe(0)

      releaseHold()
      await holder
    } finally {
      await session1.client.end()
    }
  }, 30000)
})
