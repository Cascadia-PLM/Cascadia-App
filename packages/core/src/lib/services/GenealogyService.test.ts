// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * GenealogyService Tests
 *
 * Complex-algorithm gate: genealogy is a recursive derivation over
 * Consumes/Produces edges, not stored data. The fixture is the proposal's
 * canonical chain:
 *
 *   feedstock lot LOT-A
 *     └─ consumed by WO-comp → produces component units C-1, C-2
 *          └─ C-1 consumed by WO-asm → produces assembly unit A-1
 *
 * Invariants: composition of A-1 reaches the feedstock lot transitively;
 * where-used of the lot climbs to A-1; recall by lot returns A-1 as the
 * end item; production is idempotent and a serial is born exactly once.
 *
 * Run: npx vitest run src/lib/services/GenealogyService.test.ts
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
import { ItemService } from '../items/services/ItemService'
import { DesignService } from './DesignService'
import { GenealogyService } from './GenealogyService'
import { WorkOrderService } from './WorkOrderService'
import { WorkOrderMaterialService } from './WorkOrderMaterialService'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { ValidationError } from '@/lib/errors'
import { programs } from '@/lib/db/schema'
import { takeFirst } from '@/lib/db/take-first'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

describe('GenealogyService', () => {
  const testDb = new TestDatabase()
  let user: TestUser
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

  async function createPart(
    name: string,
    trackingMode: 'none' | 'lot' | 'serial',
  ) {
    const part = await ItemService.create(
      'Part',
      {
        designId,
        revision: 'A',
        name,
        partType: 'Manufacture',
        trackingMode,
      } as any,
      user.id,
    )
    return part as { id?: string; masterId?: string }
  }

  /** Build the canonical two-level chain and return every actor. */
  async function buildChain() {
    const feedstock = await createPart('Feedstock', 'lot')
    const component = await createPart('Component', 'serial')
    const assembly = await createPart('Assembly', 'serial')

    const woComp = await WorkOrderService.create(
      { partId: component.id, quantity: 2, assignedTo: [] } as any,
      user.id,
    )
    await WorkOrderMaterialService.consume(
      woComp.id,
      { partMasterId: feedstock.masterId!, lotNumber: 'LOT-A', quantity: 4 },
      user.id,
    )
    const producedComponents = await WorkOrderMaterialService.produce(
      woComp.id,
      ['C-1', 'C-2'],
      user.id,
    )

    const woAsm = await WorkOrderService.create(
      { partId: assembly.id, quantity: 1, assignedTo: [] } as any,
      user.id,
    )
    await WorkOrderMaterialService.consume(
      woAsm.id,
      { partMasterId: component.masterId!, serialNumber: 'C-1' },
      user.id,
    )
    const producedAssemblies = await WorkOrderMaterialService.produce(
      woAsm.id,
      ['A-1'],
      user.id,
    )

    const lotLine = (await WorkOrderMaterialService.list(woComp.id))[0]!
    return {
      feedstock,
      component,
      assembly,
      woComp,
      woAsm,
      lotItemId: lotLine.targetItemId,
      componentUnits: producedComponents,
      assemblyUnit: producedAssemblies[0]!,
    }
  }

  it('composition of the assembly reaches the feedstock lot transitively', async () => {
    const chain = await buildChain()

    const { composition } = await GenealogyService.forPhysicalPart(
      chain.assemblyUnit.unitItemId,
    )

    // Level 1: the consumed component unit C-1
    expect(composition).toHaveLength(1)
    expect(composition[0]!.serialNumber).toBe('C-1')
    expect(composition[0]!.workOrder?.id).toBe(chain.woAsm.id)

    // Level 2: the feedstock lot behind C-1
    const level2 = composition[0]!.children
    expect(level2).toHaveLength(1)
    expect(level2[0]!.kind).toBe('lot')
    expect(level2[0]!.lotNumber).toBe('LOT-A')
    expect(level2[0]!.quantity).toBe(4)
  })

  it('where-used of the feedstock lot climbs to the assembly end item', async () => {
    const chain = await buildChain()

    const { whereUsed } = await GenealogyService.forPhysicalPart(
      chain.lotItemId,
    )

    // Level 1: both component units produced by the consuming WO
    expect(whereUsed).toHaveLength(2)
    const serials = whereUsed.map((n) => n.serialNumber).sort()
    expect(serials).toEqual(['C-1', 'C-2'])

    // C-1 climbs to A-1; C-2 (never consumed) is a leaf
    const c1 = whereUsed.find((n) => n.serialNumber === 'C-1')!
    expect(c1.children).toHaveLength(1)
    expect(c1.children[0]!.serialNumber).toBe('A-1')
    const c2 = whereUsed.find((n) => n.serialNumber === 'C-2')!
    expect(c2.children).toHaveLength(0)
  })

  it('recall by lot returns end items only', async () => {
    const chain = await buildChain()

    const results = await GenealogyService.recall({
      lotNumber: 'LOT-A',
      accessDesignIds: null,
    })
    expect(results).toHaveLength(1)
    expect(results[0]!.physicalPart.lotNumber).toBe('LOT-A')

    const endSerials = results[0]!.endItems.map((n) => n.serialNumber).sort()
    // A-1 (via C-1) and C-2 (unconsumed component) are the frontier
    expect(endSerials).toEqual(['A-1', 'C-2'])
    void chain
  })

  it('production is idempotent and a serial is born exactly once', async () => {
    const chain = await buildChain()

    // Re-recording the same serials on the same WO changes nothing
    const again = await WorkOrderMaterialService.produce(
      chain.woComp.id,
      ['C-1', 'C-2'],
      user.id,
    )
    expect(again).toHaveLength(2)

    // A different WO cannot claim an already-produced serial
    const woOther = await WorkOrderService.create(
      { partId: chain.component.id, quantity: 1, assignedTo: [] } as any,
      user.id,
    )
    await expect(
      WorkOrderMaterialService.produce(woOther.id, ['C-1'], user.id),
    ).rejects.toThrow(ValidationError)
  })

  it('produce requires a part and serial tracking on it', async () => {
    const bulkPart = await createPart('Bulk', 'none')
    const woNoPart = await WorkOrderService.create(
      { quantity: 1, assignedTo: [] } as any,
      user.id,
    )
    await expect(
      WorkOrderMaterialService.produce(woNoPart.id, ['X-1'], user.id),
    ).rejects.toThrow(ValidationError)

    const woBulk = await WorkOrderService.create(
      { partId: bulkPart.id, quantity: 1, assignedTo: [] } as any,
      user.id,
    )
    await expect(
      WorkOrderMaterialService.produce(woBulk.id, ['X-1'], user.id),
    ).rejects.toThrow(ValidationError)
  })

  it('as-built pin points at the exact part version the WO builds', async () => {
    const chain = await buildChain()
    expect(chain.assemblyUnit.asBuiltItemId).toBe(chain.assembly.id)
    expect(chain.componentUnits[0]!.asBuiltItemId).toBe(chain.component.id)
  })
})
