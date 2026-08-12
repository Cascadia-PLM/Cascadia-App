// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * WorkOrderMaterialService Tests
 *
 * Data-integrity gate: consumption is the traceability spine. The
 * invariants that must always hold:
 * - a serialized unit is consumed by at most one work order at a time
 *   (edge exists ⟺ unit state is Consumed)
 * - register-on-consumption never duplicates a (part, serial) identity
 * - removing a line atomically returns the unit to Available
 * - lot/bulk lines accumulate quantity on a single edge per target
 *
 * Run: npx vitest run src/lib/services/WorkOrderMaterialService.test.ts
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
import { and, eq } from 'drizzle-orm'
import { ItemService } from '../items/services/ItemService'
import { DesignService } from './DesignService'
import { PhysicalPartService } from './PhysicalPartService'
import { WorkOrderService } from './WorkOrderService'
import {
  RELATIONSHIP_CONSUMES,
  WorkOrderMaterialService,
} from './WorkOrderMaterialService'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { seedWorkOrderLifecycle } from '@/__tests__/fixtures/lifecycles'
import { ValidationError } from '@/lib/errors'
import {
  itemRelationships,
  items,
  physicalParts,
  programs,
} from '@/lib/db/schema'
import { takeFirst } from '@/lib/db/take-first'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

describe('WorkOrderMaterialService', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let designId: string

  beforeAll(async () => {
    await testDb.setup()
    // The state-guard test transitions WO status through the sanctioned
    // lifecycle path, which needs the WO lifecycle definition — present in
    // dev databases via the app seed, absent in CI's fresh scratch DB.
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

  async function createPart(trackingMode: 'none' | 'lot' | 'serial') {
    const part = await ItemService.create(
      'Part',
      {
        designId,
        revision: 'A',
        name: `Material (${trackingMode})`,
        partType: 'Purchase',
        trackingMode,
      } as any,
      user.id,
    )
    return part as { id?: string; masterId?: string }
  }

  async function createWorkOrder() {
    return WorkOrderService.create(
      { quantity: 1, assignedTo: [] } as any,
      user.id,
    )
  }

  async function edgesFor(workOrderId: string) {
    return testDb.db
      .select()
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.sourceId, workOrderId),
          eq(itemRelationships.relationshipType, RELATIONSHIP_CONSUMES),
        ),
      )
  }

  describe('serialized consumption', () => {
    it('register-on-consumption creates the unit, the edge, and sets Consumed together', async () => {
      const part = await createPart('serial')
      const wo = await createWorkOrder()

      const lines = await WorkOrderMaterialService.consume(
        wo.id,
        { partMasterId: part.masterId!, serialNumber: 'SN-100' },
        user.id,
      )

      expect(lines).toHaveLength(1)
      expect(lines[0]!.kind).toBe('unit')
      expect(lines[0]!.serialNumber).toBe('SN-100')
      expect(lines[0]!.quantity).toBe(1)

      // The paired invariant: edge exists AND unit state is Consumed
      const edges = await edgesFor(wo.id)
      expect(edges).toHaveLength(1)
      const [unitItem] = await testDb.db
        .select({ state: items.state })
        .from(items)
        .where(eq(items.id, edges[0]!.targetId))
      expect(unitItem!.state).toBe('Consumed')

      // Register-on-consumption created exactly one identity
      const units = await testDb.db
        .select()
        .from(physicalParts)
        .where(eq(physicalParts.partMasterId, part.masterId!))
      expect(units).toHaveLength(1)
    })

    it('rejects consuming the same serial twice (same or different WO)', async () => {
      const part = await createPart('serial')
      const woA = await createWorkOrder()
      const woB = await createWorkOrder()

      await WorkOrderMaterialService.consume(
        woA.id,
        { partMasterId: part.masterId!, serialNumber: 'SN-DUP' },
        user.id,
      )

      await expect(
        WorkOrderMaterialService.consume(
          woA.id,
          { partMasterId: part.masterId!, serialNumber: 'SN-DUP' },
          user.id,
        ),
      ).rejects.toThrow(ValidationError)

      await expect(
        WorkOrderMaterialService.consume(
          woB.id,
          { partMasterId: part.masterId!, serialNumber: 'SN-DUP' },
          user.id,
        ),
      ).rejects.toThrow(ValidationError)

      // Still exactly one unit, one edge
      const units = await testDb.db
        .select()
        .from(physicalParts)
        .where(eq(physicalParts.partMasterId, part.masterId!))
      expect(units).toHaveLength(1)
      expect(await edgesFor(woA.id)).toHaveLength(1)
      expect(await edgesFor(woB.id)).toHaveLength(0)
    })

    it('consumes a pre-registered Available unit without duplicating it', async () => {
      const part = await createPart('serial')
      const wo = await createWorkOrder()

      const { physicalPart } = await PhysicalPartService.register(
        { partMasterId: part.masterId!, serialNumber: 'SN-PRE' },
        user.id,
      )

      const lines = await WorkOrderMaterialService.consume(
        wo.id,
        { partMasterId: part.masterId!, serialNumber: 'SN-PRE' },
        user.id,
      )

      expect(lines[0]!.targetItemId).toBe(physicalPart.id)
      const units = await testDb.db
        .select()
        .from(physicalParts)
        .where(eq(physicalParts.partMasterId, part.masterId!))
      expect(units).toHaveLength(1)
    })

    it('remove returns the unit to Available and deletes the edge', async () => {
      const part = await createPart('serial')
      const wo = await createWorkOrder()

      const lines = await WorkOrderMaterialService.consume(
        wo.id,
        { partMasterId: part.masterId!, serialNumber: 'SN-UNDO' },
        user.id,
      )

      const after = await WorkOrderMaterialService.remove(
        wo.id,
        lines[0]!.edgeId,
        user.id,
      )
      expect(after).toHaveLength(0)
      expect(await edgesFor(wo.id)).toHaveLength(0)

      const [unitItem] = await testDb.db
        .select({ state: items.state })
        .from(items)
        .where(eq(items.id, lines[0]!.targetItemId))
      expect(unitItem!.state).toBe('Available')

      // And it can be consumed again after the undo
      const again = await WorkOrderMaterialService.consume(
        wo.id,
        { partMasterId: part.masterId!, serialNumber: 'SN-UNDO' },
        user.id,
      )
      expect(again).toHaveLength(1)
    })

    it('requires a serial number for serial-tracked parts', async () => {
      const part = await createPart('serial')
      const wo = await createWorkOrder()

      await expect(
        WorkOrderMaterialService.consume(
          wo.id,
          { partMasterId: part.masterId!, quantity: 2 },
          user.id,
        ),
      ).rejects.toThrow(ValidationError)
    })
  })

  describe('lot and bulk consumption', () => {
    it('accumulates lot quantity on a single edge', async () => {
      const part = await createPart('lot')
      const wo = await createWorkOrder()

      await WorkOrderMaterialService.consume(
        wo.id,
        { partMasterId: part.masterId!, lotNumber: 'LOT-9', quantity: 5 },
        user.id,
      )
      const lines = await WorkOrderMaterialService.consume(
        wo.id,
        { partMasterId: part.masterId!, lotNumber: 'LOT-9', quantity: 3 },
        user.id,
      )

      expect(lines).toHaveLength(1)
      expect(lines[0]!.kind).toBe('lot')
      expect(lines[0]!.lotNumber).toBe('LOT-9')
      expect(lines[0]!.quantity).toBe(8)
      expect(await edgesFor(wo.id)).toHaveLength(1)

      // The lot stays Available — lots are not exhausted by consumption
      const [lotItem] = await testDb.db
        .select({ state: items.state })
        .from(items)
        .where(eq(items.id, lines[0]!.targetItemId))
      expect(lotItem!.state).toBe('Available')
    })

    it('bulk consumption pins the current part version and accumulates', async () => {
      const part = await createPart('none')
      const wo = await createWorkOrder()

      await WorkOrderMaterialService.consume(
        wo.id,
        { partMasterId: part.masterId!, quantity: 10 },
        user.id,
      )
      const lines = await WorkOrderMaterialService.consume(
        wo.id,
        { partMasterId: part.masterId!, quantity: 2 },
        user.id,
      )

      expect(lines).toHaveLength(1)
      expect(lines[0]!.kind).toBe('bulk')
      expect(lines[0]!.quantity).toBe(12)
      // Target is the part version row itself
      expect(lines[0]!.targetItemId).toBe(part.id)
    })
  })

  describe('work order state guard', () => {
    it('rejects material changes on a Complete work order', async () => {
      const part = await createPart('none')
      const wo = await createWorkOrder()

      await WorkOrderService.updateStatus(wo.id, 'In Progress', user.id)
      await WorkOrderService.updateStatus(wo.id, 'Complete', user.id)

      await expect(
        WorkOrderMaterialService.consume(
          wo.id,
          { partMasterId: part.masterId!, quantity: 1 },
          user.id,
        ),
      ).rejects.toThrow(ValidationError)
    })
  })
})
