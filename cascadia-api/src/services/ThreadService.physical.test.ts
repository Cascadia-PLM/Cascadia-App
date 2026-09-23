// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * ThreadService physical-domain tests
 *
 * Complex-algorithm gate: the physical thread is a recursive walk over
 * Consumes/Produces edges plus synthetic INSTANCE_OF/BUILDS bridges, mapped
 * into a design-less swim lane. The fixture is the proposal's canonical
 * chain:
 *
 *   feedstock lot LOT-A
 *     └─ consumed by WO-comp → produces component units C-1, C-2
 *          └─ C-1 consumed by WO-asm → produces assembly unit A-1
 *
 * Invariants: every focal type (Part, WorkOrder, PhysicalPart) reaches the
 * web with correct lane placement and null design fields; bulk consumption
 * lands on the focal lineage node; evidence pulls requirements; a cached
 * thread never survives a consumption (invalidation); the as-built
 * comparison classifies designed/consumed lineages.
 *
 * Run: npx vitest run src/lib/services/ThreadService.physical.test.ts
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
import { QualificationService } from './QualificationService'
import { ThreadCacheService } from './ThreadCacheService'
import { ThreadComparisonService } from './ThreadComparisonService'
import { ThreadService } from './ThreadService'
import { WorkOrderService } from './WorkOrderService'
import { WorkOrderMaterialService } from './WorkOrderMaterialService'
import type { ThreadRequest } from './ThreadService'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { itemRelationships, programs } from '@/lib/db/schema'
import { takeFirst } from '@/lib/db/take-first'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

describe('ThreadService physical domain', () => {
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
      c1: producedComponents.find((u) => u.serialNumber === 'C-1')!,
      c2: producedComponents.find((u) => u.serialNumber === 'C-2')!,
      assemblyUnit: producedAssemblies[0]!,
    }
  }

  it('part focal: instances and their WO web fill the physical lane with null design fields', async () => {
    const chain = await buildChain()

    const thread = await ThreadService.getThread({
      itemId: chain.assembly.id!,
    })

    const physicalIds = thread.domains.physical.map((n) => n.id)
    // Full chain at default depth: unit → WO-asm → C-1 → WO-comp → LOT-A/C-2
    expect(physicalIds).toContain(chain.assemblyUnit.unitItemId)
    expect(physicalIds).toContain(chain.woAsm.id)
    expect(physicalIds).toContain(chain.c1.unitItemId)
    expect(physicalIds).toContain(chain.woComp.id)
    expect(physicalIds).toContain(chain.lotItemId)

    // Physical nodes are design-less by contract
    for (const node of thread.domains.physical) {
      expect(node.domain).toBe('physical')
      expect(node.designId).toBeNull()
      expect(node.designCode).toBeNull()
    }

    // The instance bridges to the focal part lineage
    const instanceEdge = thread.relationships.find(
      (r) =>
        r.relationshipType === 'INSTANCE_OF' &&
        r.sourceId === chain.assemblyUnit.unitItemId,
    )
    expect(instanceEdge?.targetId).toBe(chain.assembly.id)

    // Produces edge WO-asm → A-1 rides the lane (same-domain)
    const producesEdge = thread.relationships.find(
      (r) =>
        r.relationshipType === 'Produces' &&
        r.sourceId === chain.woAsm.id &&
        r.targetId === chain.assemblyUnit.unitItemId,
    )
    expect(producesEdge?.domain).toBe('same')

    // Stats count the lane
    expect(thread.stats.totalNodes).toBeGreaterThanOrEqual(
      thread.domains.physical.length + 1,
    )
  })

  it('part focal without the physical domain requested stays physical-free', async () => {
    const chain = await buildChain()

    const thread = await ThreadService.getThread({
      itemId: chain.assembly.id!,
      domains: ['engineering', 'manufacturing'],
    })

    expect(thread.domains.physical).toEqual([])
    expect(
      thread.relationships.some(
        (r) => r.sourceId === chain.woAsm.id || r.targetId === chain.woAsm.id,
      ),
    ).toBe(false)
  })

  it('lot part focal climbs consuming WOs to end items', async () => {
    const chain = await buildChain()

    const thread = await ThreadService.getThread({
      itemId: chain.feedstock.id!,
    })

    const physicalIds = thread.domains.physical.map((n) => n.id)
    expect(physicalIds).toContain(chain.lotItemId)
    expect(physicalIds).toContain(chain.woComp.id)
    expect(physicalIds).toContain(chain.c1.unitItemId)
    expect(physicalIds).toContain(chain.c2.unitItemId)
    expect(physicalIds).toContain(chain.woAsm.id)
    expect(physicalIds).toContain(chain.assemblyUnit.unitItemId)
  })

  it('bulk consumption lands the Consumes edge on the focal lineage node', async () => {
    const bulk = await createPart('Hardware', 'none')
    const built = await createPart('Bracket', 'serial')
    const wo = await WorkOrderService.create(
      { partId: built.id, quantity: 1, assignedTo: [] } as any,
      user.id,
    )
    await WorkOrderMaterialService.consume(
      wo.id,
      { partMasterId: bulk.masterId!, quantity: 2.5 },
      user.id,
    )

    const thread = await ThreadService.getThread({ itemId: bulk.id! })

    expect(thread.domains.physical.map((n) => n.id)).toContain(wo.id)
    const consumesEdge = thread.relationships.find(
      (r) => r.relationshipType === 'Consumes' && r.sourceId === wo.id,
    )
    expect(consumesEdge?.targetId).toBe(bulk.id)
    expect(Number(consumesEdge?.quantity)).toBe(2.5)
  })

  it('work order focal walks both directions and bridges to the built part', async () => {
    const chain = await buildChain()

    const thread = await ThreadService.getThread({ itemId: chain.woAsm.id })

    expect(thread.focalItem.domain).toBe('physical')
    expect(thread.focalItem.designId).toBeNull()

    const physicalIds = thread.domains.physical.map((n) => n.id)
    expect(physicalIds).toContain(chain.woAsm.id)
    expect(physicalIds).toContain(chain.c1.unitItemId)
    expect(physicalIds).toContain(chain.assemblyUnit.unitItemId)

    // BUILDS bridge into the design domains
    expect(thread.domains.engineering.map((n) => n.id)).toContain(
      chain.assembly.id,
    )
    const buildsEdge = thread.relationships.find(
      (r) => r.relationshipType === 'BUILDS' && r.sourceId === chain.woAsm.id,
    )
    expect(buildsEdge?.targetId).toBe(chain.assembly.id)
  })

  it('physical part focal reaches producing and consuming WOs plus its part version', async () => {
    const chain = await buildChain()

    const thread = await ThreadService.getThread({
      itemId: chain.c1.unitItemId,
    })

    expect(thread.focalItem.domain).toBe('physical')

    const physicalIds = thread.domains.physical.map((n) => n.id)
    expect(physicalIds).toContain(chain.woComp.id)
    expect(physicalIds).toContain(chain.woAsm.id)

    // INSTANCE_OF bridge to the as-built part version
    expect(thread.domains.engineering.map((n) => n.id)).toContain(
      chain.component.id,
    )
    const instanceEdge = thread.relationships.find(
      (r) =>
        r.relationshipType === 'INSTANCE_OF' &&
        r.sourceId === chain.c1.unitItemId,
    )
    expect(instanceEdge?.targetId).toBe(chain.component.id)
  })

  it('evidence on a reached instance pulls its requirement into the thread', async () => {
    const chain = await buildChain()

    const requirement = (await ItemService.create(
      'Requirement',
      { designId, revision: 'A', name: 'Material certification' } as any,
      user.id,
    )) as { id?: string }
    await QualificationService.addEvidence(
      chain.lotItemId,
      requirement.id!,
      user.id,
      'mill cert §1.2.3',
    )

    const thread = await ThreadService.getThread({
      itemId: chain.feedstock.id!,
    })

    expect(thread.domains.requirements.map((n) => n.id)).toContain(
      requirement.id,
    )
    const evidenceEdge = thread.relationships.find(
      (r) =>
        r.relationshipType === 'Evidences' && r.sourceId === chain.lotItemId,
    )
    expect(evidenceEdge?.targetId).toBe(requirement.id)
  })

  it('a cached thread never survives a consumption', async () => {
    const chain = await buildChain()

    const request: ThreadRequest = { itemId: chain.assembly.id! }
    const first = await ThreadService.getThread(request)
    // Pin the cache deterministically (getThread's own write is async)
    await ThreadCacheService.cacheThread(request, first, 0)

    // C-2 exists but is not yet consumed by WO-asm
    expect(
      first.relationships.some(
        (r) =>
          r.relationshipType === 'Consumes' &&
          r.sourceId === chain.woAsm.id &&
          r.targetId === chain.c2.unitItemId,
      ),
    ).toBe(false)

    await WorkOrderMaterialService.consume(
      chain.woAsm.id,
      { partMasterId: chain.component.masterId!, serialNumber: 'C-2' },
      user.id,
    )

    const after = await ThreadService.getThread(request)
    expect(
      after.relationships.some(
        (r) =>
          r.relationshipType === 'Consumes' &&
          r.sourceId === chain.woAsm.id &&
          r.targetId === chain.c2.unitItemId,
      ),
    ).toBe(true)
  })

  it('as-built comparison classifies match, missing, and extra lineages', async () => {
    const chain = await buildChain()

    // As-designed BOM of the built assembly revision: 1× Component,
    // 2× Gasket (never consumed → missing)
    const gasket = await createPart('Gasket', 'none')
    await testDb.db.insert(itemRelationships).values([
      {
        sourceId: chain.assembly.id!,
        targetId: chain.component.id!,
        relationshipType: 'BOM',
        quantity: '1',
        createdBy: user.id,
      },
      {
        sourceId: chain.assembly.id!,
        targetId: gasket.id!,
        relationshipType: 'BOM',
        quantity: '2',
        createdBy: user.id,
      },
    ])

    // Consumed but not designed in → extra
    const shim = await createPart('Shim', 'none')
    await WorkOrderMaterialService.consume(
      chain.woAsm.id,
      { partMasterId: shim.masterId!, quantity: 3 },
      user.id,
    )

    const cmp = await ThreadComparisonService.compareAsBuilt(
      chain.assemblyUnit.unitItemId,
    )

    expect(cmp.asBuiltItem?.id).toBe(chain.assembly.id)
    expect(cmp.workOrder?.id).toBe(chain.woAsm.id)
    expect(cmp.producedUnitCount).toBe(1)

    const byMaster = new Map(cmp.lines.map((l) => [l.partMasterId, l]))
    const componentLine = byMaster.get(chain.component.masterId!)
    expect(componentLine?.status).toBe('match')
    expect(componentLine?.designedQuantity).toBe(1)
    expect(componentLine?.consumedQuantity).toBe(1)

    const gasketLine = byMaster.get(gasket.masterId!)
    expect(gasketLine?.status).toBe('missing')
    expect(gasketLine?.consumedQuantity).toBeNull()

    const shimLine = byMaster.get(shim.masterId!)
    expect(shimLine?.status).toBe('extra')
    expect(shimLine?.designedQuantity).toBeNull()
    expect(shimLine?.consumedQuantity).toBe(3)
  })

  it('as-built comparison flags a batch quantity mismatch', async () => {
    const chain = await buildChain()

    // WO-comp produced 2 units; BOM says 4× feedstock per unit → expected 8,
    // consumed 4 → mismatch at batch level
    await testDb.db.insert(itemRelationships).values({
      sourceId: chain.component.id!,
      targetId: chain.feedstock.id!,
      relationshipType: 'BOM',
      quantity: '4',
      createdBy: user.id,
    })

    const cmp = await ThreadComparisonService.compareAsBuilt(
      chain.c1.unitItemId,
    )
    expect(cmp.producedUnitCount).toBe(2)
    const feedstockLine = cmp.lines.find(
      (l) => l.partMasterId === chain.feedstock.masterId,
    )
    expect(feedstockLine?.status).toBe('quantity_mismatch')
    expect(feedstockLine?.designedQuantity).toBe(4)
    expect(feedstockLine?.consumedQuantity).toBe(4)
  })
})
