// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * QualificationService Tests
 *
 * Complex-algorithm gate: the rollup aggregates across SATISFIES edges
 * (part versions → requirements), Consumes edges (WO → instances), and
 * Evidences edges (instances → requirements), matching evidence on the
 * requirement lineage. This is the customer acceptance story:
 * "record feedstock X with certs 1.2.3; project Y consumes X; looking up
 * project Y shows 1.2.3 satisfied" — and flags what nobody certified.
 *
 * Run: npx vitest run src/lib/services/QualificationService.test.ts
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
import { WorkOrderService } from './WorkOrderService'
import { WorkOrderMaterialService } from './WorkOrderMaterialService'
import { SATISFIES_RELATIONSHIP } from './RequirementService'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { ValidationError } from '@/lib/errors'
import { itemRelationships, programs } from '@/lib/db/schema'
import { takeFirst } from '@/lib/db/take-first'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

describe('QualificationService', () => {
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

  /**
   * The customer scenario: feedstock (lot-tracked) with a material-cert
   * requirement, consumed by a work order building an assembly.
   */
  async function buildScenario() {
    const feedstock = (await ItemService.create(
      'Part',
      {
        designId,
        revision: 'A',
        name: 'Feedstock X',
        partType: 'Purchase',
        trackingMode: 'lot',
      } as any,
      user.id,
    )) as { id?: string; masterId?: string }

    const assembly = (await ItemService.create(
      'Part',
      {
        designId,
        revision: 'A',
        name: 'Project Y Assembly',
        partType: 'Manufacture',
        trackingMode: 'none',
      } as any,
      user.id,
    )) as { id?: string; masterId?: string }

    const requirement = (await ItemService.create(
      'Requirement',
      {
        designId,
        revision: 'A',
        name: 'Certifications 1.2.3',
        requirementType: 'Functional',
        text: 'Feedstock shall carry certifications 1.2.3',
      } as any,
      user.id,
    )) as { id?: string; masterId?: string }

    // Requirement flows in via the feedstock part (SATISFIES edge)
    await testDb.db.insert(itemRelationships).values({
      sourceId: feedstock.id!,
      targetId: requirement.id!,
      relationshipType: SATISFIES_RELATIONSHIP,
      createdBy: user.id,
    })

    const wo = await WorkOrderService.create(
      { partId: assembly.id, quantity: 1, assignedTo: [] } as any,
      user.id,
    )
    const lines = await WorkOrderMaterialService.consume(
      wo.id,
      { partMasterId: feedstock.masterId!, lotNumber: 'LOT-X', quantity: 2 },
      user.id,
    )

    return {
      feedstock,
      assembly,
      requirement,
      wo,
      lotItemId: lines[0]!.targetItemId,
    }
  }

  it('flags the requirement unsatisfied and the lot uncertified before evidence exists', async () => {
    const s = await buildScenario()

    const rollup = await QualificationService.rollupForWorkOrder(s.wo.id)

    expect(rollup.rows).toHaveLength(1)
    expect(rollup.rows[0]!.requirementNumber).toBeTruthy()
    expect(rollup.rows[0]!.satisfied).toBe(false)
    expect(rollup.rows[0]!.viaPartNumber).toBeTruthy()

    // The consumed lot has no documents and no evidence → gap
    expect(rollup.gaps).toHaveLength(1)
    expect(rollup.gaps[0]!.lotNumber).toBe('LOT-X')
  })

  it('marks the requirement satisfied once the lot evidences it', async () => {
    const s = await buildScenario()

    await QualificationService.addEvidence(
      s.lotItemId,
      s.requirement.id!,
      user.id,
      'mill cert §1.2.3',
    )

    const rollup = await QualificationService.rollupForWorkOrder(s.wo.id)

    expect(rollup.rows).toHaveLength(1)
    expect(rollup.rows[0]!.satisfied).toBe(true)
    expect(rollup.rows[0]!.evidence).toHaveLength(1)
    expect(rollup.rows[0]!.evidence[0]!.lotNumber).toBe('LOT-X')
    expect(rollup.rows[0]!.evidence[0]!.note).toBe('mill cert §1.2.3')

    // Evidenced instance no longer appears in the gap list
    expect(rollup.gaps).toHaveLength(0)
  })

  it('evidence is validated and idempotence-guarded', async () => {
    const s = await buildScenario()

    await QualificationService.addEvidence(
      s.lotItemId,
      s.requirement.id!,
      user.id,
    )
    await expect(
      QualificationService.addEvidence(s.lotItemId, s.requirement.id!, user.id),
    ).rejects.toThrow(ValidationError)

    // Only PhysicalPart → Requirement pairs are legal
    await expect(
      QualificationService.addEvidence(
        s.feedstock.id!,
        s.requirement.id!,
        user.id,
      ),
    ).rejects.toThrow()
    await expect(
      QualificationService.addEvidence(s.lotItemId, s.assembly.id!, user.id),
    ).rejects.toThrow()
  })

  it('listEvidence returns the asserted links and remove clears them', async () => {
    const s = await buildScenario()

    const link = await QualificationService.addEvidence(
      s.lotItemId,
      s.requirement.id!,
      user.id,
      'CoC on file',
    )
    expect(link.note).toBe('CoC on file')

    let links = await QualificationService.listEvidence(s.lotItemId)
    expect(links).toHaveLength(1)

    await QualificationService.removeEvidence(s.lotItemId, link.edgeId)
    links = await QualificationService.listEvidence(s.lotItemId)
    expect(links).toHaveLength(0)
  })
})
