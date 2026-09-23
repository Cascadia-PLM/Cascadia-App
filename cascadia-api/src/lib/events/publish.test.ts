// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Invariants of `publishDomainEvent` — the transactional outbox write.
 *
 * Gate 1 (data integrity): an event row must exist iff the surrounding
 * mutation committed; anything weaker corrupts the log's meaning.
 */

import { randomUUID } from 'node:crypto'
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
import { z } from 'zod'
import { TestDatabase } from '@/__tests__/helpers/db'
import { db } from '@/lib/db'
import { domainEvents } from '@/lib/db/schema'
import { ValidationError } from '@/lib/errors'
import {
  EventTypeRegistry,
  defineDomainEvent,
  publishDomainEvent,
} from '@/lib/events'

const PUBLISH_SPEC_EVENT = defineDomainEvent({
  type: 'test.events.publish_spec',
  schemaVersion: 1,
  description: 'Test-only event for publish invariants',
  subjectType: 'test',
  payloadSchema: z.object({
    marker: z.string(),
    order: z.number().optional(),
  }),
})

describe('publishDomainEvent', () => {
  const testDb = new TestDatabase()

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  it('persists the full envelope inside the caller transaction', async () => {
    const correlationId = randomUUID()
    const subjectId = randomUUID()
    const masterId = randomUUID()
    const designId = randomUUID()
    const actorId = randomUUID()

    const event = await db.transaction(async (tx) =>
      publishDomainEvent(tx, PUBLISH_SPEC_EVENT, {
        actorId,
        subject: { id: subjectId, masterId },
        context: { designId },
        correlationId,
        payload: { marker: 'envelope' },
      }),
    )

    expect(event.type).toBe('test.events.publish_spec')
    expect(event.schemaVersion).toBe(1)

    const rows = await testDb.db
      .select()
      .from(domainEvents)
      .where(eq(domainEvents.correlationId, correlationId))
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.id).toBe(event.id)
    expect(row.actorId).toBe(actorId)
    // subjectType falls back to the definition's default
    expect(row.subjectType).toBe('test')
    expect(row.subjectId).toBe(subjectId)
    expect(row.subjectMasterId).toBe(masterId)
    expect(row.designId).toBe(designId)
    expect(row.payload).toEqual({ marker: 'envelope' })
    expect(row.occurredAt).toBeInstanceOf(Date)
    // seq is assigned at commit, and this transaction never commits: the
    // row is visible to its own transaction with no position in the log.
    expect(row.seq).toBeNull()
  })

  it('rolls back with the enclosing transaction — no phantom events', async () => {
    const correlationId = randomUUID()

    await expect(
      db.transaction(async (tx) => {
        await publishDomainEvent(tx, PUBLISH_SPEC_EVENT, {
          correlationId,
          payload: { marker: 'phantom' },
        })
        throw new Error('domain mutation failed after emit')
      }),
    ).rejects.toThrow('domain mutation failed after emit')

    const rows = await testDb.db
      .select()
      .from(domainEvents)
      .where(eq(domainEvents.correlationId, correlationId))
    expect(rows).toHaveLength(0)
  })

  it('rejects payloads that fail the definition schema', async () => {
    const correlationId = randomUUID()

    await expect(
      db.transaction(async (tx) =>
        publishDomainEvent(tx, PUBLISH_SPEC_EVENT, {
          correlationId,
          payload: { marker: 42 } as never,
        }),
      ),
    ).rejects.toThrow(ValidationError)

    const rows = await testDb.db
      .select()
      .from(domainEvents)
      .where(eq(domainEvents.correlationId, correlationId))
    expect(rows).toHaveLength(0)
  })

  it('registers the definition in the catalog', () => {
    expect(EventTypeRegistry.hasType('test.events.publish_spec')).toBe(true)
    const def = EventTypeRegistry.getType('test.events.publish_spec')
    expect(def?.schemaVersion).toBe(1)
  })
})
