// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Caller metadata on an edge, and the server's keys that share its column.
 *
 * Gates 1 and 2. A trace claim's affirmation lives in the same `metadata`
 * column callers now write, and it is what decides whether the claim reads as
 * suspect. If a metadata write could set it, any editor could mark a stale
 * claim as checked — or name someone else as the checker; if a write could
 * drop it, every metadata edit would silently re-date the claim. Neither may
 * happen, through any write path.
 *
 * Run: npx vitest run cascadia-api/src/items/services/ItemRelationshipService.metadata.test.ts
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
import { userMetadataOf } from '@cascadia/commons/items/relationships/metadata'
import type { TestUser } from '@/__tests__/fixtures/users'
import { ItemService } from '@/items/services/ItemService'
import { ItemRelationshipService } from '@/items/services/ItemRelationshipService'
import { affirmationOf } from '@/items/trace-affirmation'
import { DesignService } from '@/services/DesignService'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { itemRelationships, programs } from '@/db/schema'
import { seedStandardPartLifecycle } from '@/__tests__/fixtures/lifecycles'
import { ItemTypeRegistry } from '@/items/registry'
import '@/items/registerItemTypes.server'

describe('relationship metadata writes', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let other: TestUser
  let designId: string
  let prefix: string

  beforeAll(async () => {
    await testDb.setup()
    await seedStandardPartLifecycle(testDb.db)
    await ItemTypeRegistry.reload()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    user = await insertTestUser(testDb.db)
    other = await insertTestUser(testDb.db)
    prefix = `MD${Date.now().toString().slice(-8)}`

    const program = (
      await testDb.db
        .insert(programs)
        .values({
          name: `Metadata ${prefix}`,
          code: `MP-${prefix}`,
          createdBy: user.id,
          updatedBy: user.id,
        })
        .returning()
    )[0]!
    const design = await DesignService.create(
      {
        programId: program.id,
        name: `Metadata design ${prefix}`,
        code: `MD-${prefix}`,
        designType: 'Engineering',
      } as any,
      user.id,
    )
    designId = design.id
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  async function item(itemType: 'Part' | 'Requirement', label: string) {
    return ItemService.create(
      itemType,
      {
        itemType,
        itemNumber: `${itemType === 'Part' ? 'PN' : 'RQ'}-${prefix}-${label}`,
        revision: '-',
        name: `${itemType} ${label}`,
        designId,
        state: 'Draft',
      } as any,
      user.id,
    )
  }

  async function storedMetadata(relationshipId: string): Promise<unknown> {
    const [row] = await testDb.db
      .select({ metadata: itemRelationships.metadata })
      .from(itemRelationships)
      .where(eq(itemRelationships.id, relationshipId))
    return row?.metadata
  }

  /** An affirmation as a forger would write it: someone else, other rows. */
  function forgedAffirmation() {
    return {
      sourceId: randomUUID(),
      targetId: randomUUID(),
      affirmedBy: other.id,
      affirmedAt: '2020-01-01T00:00:00.000Z',
    }
  }

  it("a trace link's affirmation survives every metadata write, and none can forge it", async () => {
    const part = await item('Part', 'sat')
    const requirement = await item('Requirement', 'req')

    // Created with a forged stamp alongside a caller key: the stamp is the
    // server's, naming the author and the rows the edge actually joins.
    const edge = await ItemService.addRelationship(
      part.id,
      requirement.id,
      'SATISFIES',
      user.id,
      {
        metadata: { note: 'per test report 7', affirmed: forgedAffirmation() },
      },
    )
    const born = affirmationOf(await storedMetadata(edge.id))
    expect(born).toMatchObject({
      sourceId: part.id,
      targetId: requirement.id,
      affirmedBy: user.id,
    })
    expect(userMetadataOf(await storedMetadata(edge.id))).toEqual({
      note: 'per test report 7',
    })

    // A replacement that echoes a different stamp keeps the stored one, and
    // replaces the caller's keys whole.
    await ItemRelationshipService.updateRelationship(edge.id, other.id, {
      metadata: { ticket: 'QA-12', affirmed: forgedAffirmation() },
    })
    expect(affirmationOf(await storedMetadata(edge.id))).toEqual(born)
    expect(userMetadataOf(await storedMetadata(edge.id))).toEqual({
      ticket: 'QA-12',
    })

    // Clearing the caller's keys is not clearing the claim's review record.
    await ItemRelationshipService.updateRelationship(edge.id, other.id, {
      metadata: null,
    })
    expect(affirmationOf(await storedMetadata(edge.id))).toEqual(born)
    expect(userMetadataOf(await storedMetadata(edge.id))).toBeNull()
  })

  it('a reserved key is never stored on an edge type the server does not stamp', async () => {
    const parent = await item('Part', 'parent')
    const single = await item('Part', 'single')
    const batched = await item('Part', 'batched')

    const edge = await ItemService.addRelationship(
      parent.id,
      single.id,
      'BOM',
      user.id,
      {
        quantity: '1',
        metadata: { supplierRef: 'S-1', affirmed: forgedAffirmation() },
      },
    )
    const [batchEdge] = await ItemRelationshipService.addRelationshipBatch([
      {
        sourceId: parent.id,
        targetId: batched.id,
        relationshipType: 'BOM',
        userId: user.id,
        data: {
          quantity: '1',
          metadata: { supplierRef: 'S-2', affirmed: forgedAffirmation() },
        },
      },
    ])

    expect(await storedMetadata(edge.id)).toEqual({ supplierRef: 'S-1' })
    expect(await storedMetadata(batchEdge!.id)).toEqual({ supplierRef: 'S-2' })

    await ItemRelationshipService.updateRelationship(edge.id, user.id, {
      metadata: { supplierRef: 'S-3', affirmed: forgedAffirmation() },
    })
    expect(await storedMetadata(edge.id)).toEqual({ supplierRef: 'S-3' })
  })
})
