// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * PhysicalPartService Tests
 *
 * Data-integrity gate: register() creates a two-table item (items +
 * physical_parts) atomically and is find-or-create on the traceability
 * identity (partMasterId + serialNumber|lotNumber). The invariant that
 * matters downstream: exactly one PhysicalPart record ever exists per
 * identity, no matter how many times or how concurrently it is registered.
 *
 * Run: npx vitest run src/lib/services/PhysicalPartService.test.ts
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
import { PhysicalPartService } from './PhysicalPartService'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { NotFoundError, ValidationError } from '@/lib/errors'
import { items, physicalParts, programs } from '@/lib/db/schema'
import { takeFirst } from '@/lib/db/take-first'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

describe('PhysicalPartService', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let programId: string
  let designId: string

  beforeAll(async () => {
    await testDb.setup()
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
    programId = program.id

    const design = await DesignService.create(
      {
        programId,
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

  async function createPart(trackingMode: 'none' | 'lot' | 'serial') {
    const part = await ItemService.create(
      'Part',
      {
        designId,
        revision: 'A',
        name: `Tracked Part (${trackingMode})`,
        partType: 'Purchase',
        trackingMode,
      } as any,
      user.id,
    )
    return part as { id?: string; masterId?: string }
  }

  describe('register', () => {
    it('creates the items row and physical_parts row atomically', async () => {
      const part = await createPart('serial')

      const result = await PhysicalPartService.register(
        { partMasterId: part.masterId!, serialNumber: 'SN-0001' },
        user.id,
      )

      expect(result.created).toBe(true)
      expect(result.physicalPart.instanceKind).toBe('unit')
      expect(result.physicalPart.serialNumber).toBe('SN-0001')
      expect(result.physicalPart.state).toBe('Available')
      expect(result.physicalPart.itemNumber).toMatch(/^PP-\d{6}$/)

      // Both halves of the two-table pattern exist and agree
      const [itemRow] = await testDb.db
        .select()
        .from(items)
        .where(eq(items.id, result.physicalPart.id))
      const [ppRow] = await testDb.db
        .select()
        .from(physicalParts)
        .where(eq(physicalParts.itemId, result.physicalPart.id))

      expect(itemRow).toBeDefined()
      expect(itemRow!.itemType).toBe('PhysicalPart')
      expect(ppRow).toBeDefined()
      expect(ppRow!.partMasterId).toBe(part.masterId)
    })

    it('is idempotent per (part, serial): re-register returns the same record', async () => {
      const part = await createPart('serial')

      const first = await PhysicalPartService.register(
        { partMasterId: part.masterId!, serialNumber: 'SN-0042' },
        user.id,
      )
      const second = await PhysicalPartService.register(
        { partMasterId: part.masterId!, serialNumber: 'SN-0042' },
        user.id,
      )

      expect(first.created).toBe(true)
      expect(second.created).toBe(false)
      expect(second.physicalPart.id).toBe(first.physicalPart.id)

      const rows = await testDb.db
        .select()
        .from(physicalParts)
        .where(eq(physicalParts.partMasterId, part.masterId!))
      expect(rows).toHaveLength(1)
    })

    it('allows the same serial on different part lineages', async () => {
      const partA = await createPart('serial')
      const partB = await createPart('serial')

      const a = await PhysicalPartService.register(
        { partMasterId: partA.masterId!, serialNumber: 'SHARED-SN' },
        user.id,
      )
      const b = await PhysicalPartService.register(
        { partMasterId: partB.masterId!, serialNumber: 'SHARED-SN' },
        user.id,
      )

      expect(a.created).toBe(true)
      expect(b.created).toBe(true)
      expect(a.physicalPart.id).not.toBe(b.physicalPart.id)
    })

    it('registers lots for lot-tracked parts', async () => {
      const part = await createPart('lot')

      const result = await PhysicalPartService.register(
        { partMasterId: part.masterId!, lotNumber: 'LOT-4137' },
        user.id,
      )

      expect(result.created).toBe(true)
      expect(result.physicalPart.instanceKind).toBe('lot')
      expect(result.physicalPart.lotNumber).toBe('LOT-4137')
      expect(result.physicalPart.serialNumber).toBeNull()
    })

    it('rejects a serial for a part whose trackingMode is not serial', async () => {
      const part = await createPart('lot')

      await expect(
        PhysicalPartService.register(
          { partMasterId: part.masterId!, serialNumber: 'SN-1' },
          user.id,
        ),
      ).rejects.toThrow(ValidationError)
    })

    it('rejects registration for untracked parts', async () => {
      const part = await createPart('none')

      await expect(
        PhysicalPartService.register(
          { partMasterId: part.masterId!, lotNumber: 'LOT-1' },
          user.id,
        ),
      ).rejects.toThrow(ValidationError)
    })

    it('rejects identity with both serial and lot', async () => {
      const part = await createPart('serial')

      await expect(
        PhysicalPartService.register(
          {
            partMasterId: part.masterId!,
            serialNumber: 'SN-1',
            lotNumber: 'LOT-1',
          },
          user.id,
        ),
      ).rejects.toThrow()
    })

    it('throws NotFoundError for an unknown part lineage', async () => {
      await expect(
        PhysicalPartService.register(
          {
            partMasterId: '00000000-0000-0000-0000-000000000000',
            serialNumber: 'SN-1',
          },
          user.id,
        ),
      ).rejects.toThrow(NotFoundError)
    })
  })

  describe('lookups', () => {
    it('findByIdentity and search resolve the registered record', async () => {
      const part = await createPart('serial')
      const { physicalPart } = await PhysicalPartService.register(
        { partMasterId: part.masterId!, serialNumber: 'FIND-ME-01' },
        user.id,
      )

      const byIdentity = await PhysicalPartService.findByIdentity(
        part.masterId!,
        { serialNumber: 'FIND-ME-01' },
      )
      expect(byIdentity?.id).toBe(physicalPart.id)

      // `accessDesignIds: null` is cross-program authority — this case is about
      // the lookups, unbounded on purpose. The boundary itself is asserted end
      // to end in `routes/program-isolation.permissions.test.ts`, against the
      // route that resolves the scope.
      const bySearch = await PhysicalPartService.search({
        q: 'FIND-ME',
        accessDesignIds: null,
      })
      expect(bySearch.map((r) => r.id)).toContain(physicalPart.id)

      const byPart = await PhysicalPartService.search({
        partMasterId: part.masterId!,
        accessDesignIds: null,
      })
      expect(byPart).toHaveLength(1)
      expect(byPart[0]!.partItemNumber).toBeTruthy()
    })
  })
})
