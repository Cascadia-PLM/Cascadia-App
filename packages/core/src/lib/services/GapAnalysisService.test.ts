// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Gap analysis: what counts as the design's, and counted once
 *
 * Complex-algorithm gate. This is a reporting rollup over multi-entity state —
 * requirements, their traceability edges, parts, test cases and the EBOM/MBOM
 * mapping — and it answers the same question twice: once as a gap list and
 * once as a coverage denominator, which a comment in the service notes must
 * not disagree. It had no tests at all, while carrying more hand-rolled
 * item-resolution sites (six) than any other file in the repo.
 *
 * The resolution is the thing under test. Every site asked `items.isCurrent`
 * rather than `VersionResolver`, and the two disagree in exactly one place: a
 * part *created* on an open change-order branch carries `isCurrent = true`, so
 * it was reported as a gap of the design and counted in the coverage
 * denominator while the change order was still unapproved — work that is not
 * in the design yet, depressing a completeness figure people read as
 * compliance. A part *revised* on a branch does not leak (its working copy is
 * `isCurrent = false`), and a design with merge history resolves identically
 * both ways, which is why this went unnoticed.
 *
 * Run: npx vitest run src/lib/services/GapAnalysisService.test.ts
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
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUserWithRole } from '@/__tests__/fixtures/users'
import { seedStandardPartLifecycle } from '@/__tests__/fixtures/lifecycles'
import { ItemService } from '@/lib/items/services/ItemService'
import { ChangeOrderService } from '@/lib/items/services/ChangeOrderService'
import { ChangeOrderMergeService } from '@/lib/services/ChangeOrderMergeService'
import { GapAnalysisService } from '@/lib/services/GapAnalysisService'
import { MbomService } from '@/lib/services/MbomService'
import { DesignService } from '@/lib/services/DesignService'
import { ProgramService } from '@/lib/services/ProgramService'
import { permissionService } from '@/lib/auth/permission-service'
import { ItemTypeRegistry } from '@/lib/items/registry'
import {
  ALLOCATED_TO_RELATIONSHIP,
  SATISFIES_RELATIONSHIP,
  VERIFIED_BY_RELATIONSHIP,
} from '@/lib/items/traceability-relationships'
import { VALIDATES_RELATIONSHIP } from '@/lib/services/VerificationService'
import {
  itemRelationships,
  items,
  lifecycleDefinitions,
  lifecycleInstances,
} from '@/lib/db/schema'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

const GAP_TEST_WORKFLOW_ID = '00000000-0000-4000-8000-000000000309'

type Created = { id: string; masterId: string; itemNumber: string }

describe('gap analysis', () => {
  const testDb = new TestDatabase()

  let user: TestUser
  let programId: string
  let designId: string
  let designCode: string
  let unique: string

  beforeAll(async () => {
    await testDb.setup()
    await seedStandardPartLifecycle(testDb.db)
    await testDb.db
      .insert(lifecycleDefinitions)
      .values({
        id: GAP_TEST_WORKFLOW_ID,
        name: 'Test ECO Workflow - GapAnalysis',
        version: 1,
        workflowType: 'strict',
        definition: {
          states: [
            { id: 'Draft', name: 'Draft', isInitial: true, isFinal: false },
            {
              id: 'Approved',
              name: 'Approved',
              isInitial: false,
              isFinal: false,
            },
          ],
          transitions: [
            {
              id: 't1',
              name: 'Approve',
              fromStateId: 'Draft',
              toStateId: 'Approved',
            },
          ],
          applicableItemTypes: ['ChangeOrder'],
        },
        isActive: true,
        lifecycleType: 'Driving',
      })
      .onConflictDoNothing()
    await ItemTypeRegistry.reload()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()

    unique = `GA${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    user = (await insertTestUserWithRole(testDb.db, 'User')).user
    permissionService.clearCache()

    const program = await ProgramService.create(
      { name: 'Gap Program', code: `GAP-${unique}` },
      user.id,
    )
    programId = program.id

    designCode = `GAD-${unique}`
    const design = await DesignService.create(
      {
        programId,
        name: 'Gap Design',
        code: designCode,
        designType: 'Engineering',
      },
      user.id,
    )
    designId = design.id
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  async function create(type: string, suffix: string, extra = {}) {
    return (await ItemService.create(
      type,
      {
        itemNumber: `${type.slice(0, 3).toUpperCase()}-${unique}-${suffix}`,
        revision: 'A',
        name: `${type} ${suffix}`,
        designId,
        ...extra,
      } as never,
      user.id,
    )) as Created
  }

  /** A traceability edge, which is a plain row — none of these is a BOM line. */
  async function link(sourceId: string, targetId: string, type: string) {
    await testDb.db.insert(itemRelationships).values({
      sourceId,
      targetId,
      relationshipType: type,
      createdBy: user.id,
      modifiedBy: user.id,
    })
  }

  async function release(...created: Array<Created>) {
    for (const one of created) {
      await testDb.db
        .update(items)
        .set({ state: 'Released' })
        .where(eq(items.id, one.id))
    }
  }

  async function createChangeOrder(name: string) {
    const changeOrder = (await ItemService.create(
      'ChangeOrder',
      {
        revision: '-',
        name,
        changeType: 'ECO',
        priority: 'medium',
        reasonForChange: 'Test',
      } as never,
      user.id,
    )) as { id: string }
    await testDb.db.insert(lifecycleInstances).values({
      workflowDefinitionId: GAP_TEST_WORKFLOW_ID,
      itemId: changeOrder.id,
      currentState: 'Draft',
    })
    return changeOrder
  }

  /** Revise `part` on a new change order and hand back the branch it minted. */
  async function reviseOnChangeOrder(part: Created, name: string) {
    const changeOrder = await createChangeOrder(name)
    await ChangeOrderService.addAffectedItem(
      changeOrder.id,
      { affectedItemId: part.id, changeAction: 'revise' },
      user.id,
    )
    const branchId = (
      await ChangeOrderService.getChangeOrderDesigns(changeOrder.id)
    ).find((d) => d.designId === designId)?.branchId
    expect(branchId).toBeTruthy()
    return { changeOrderId: changeOrder.id, branchId: branchId! }
  }

  async function approveAndMerge(changeOrderId: string) {
    await testDb.db
      .update(items)
      .set({ state: 'Approved' })
      .where(eq(items.id, changeOrderId))
    await testDb.db
      .update(lifecycleInstances)
      .set({ currentState: 'Approved' })
      .where(eq(lifecycleInstances.itemId, changeOrderId))
    await ChangeOrderMergeService.merge(changeOrderId, user.id)
  }

  const analyze = () => GapAnalysisService.analyze({ designId })
  const gapsOfType = (
    result: Awaited<ReturnType<typeof analyze>>,
    type: string,
  ) =>
    result.gaps
      .filter((g) => g.type === type)
      .map((g) => g.itemNumber)
      .sort()

  // ==========================================================================
  // Requirements
  // ==========================================================================

  it('reports an untraced requirement once, and counts it once', async () => {
    const requirement = await create('Requirement', 'R1', {
      priority: 'MustHave',
    })

    const result = await analyze()

    expect(gapsOfType(result, 'unallocated_requirement')).toEqual([
      requirement.itemNumber,
    ])
    expect(result.coverage.requirements).toMatchObject({
      total: 1,
      allocated: 0,
      satisfied: 0,
      verified: 0,
    })
  })

  it('walks a requirement along its trace: unallocated, then unsatisfied, then unverified, then clear', async () => {
    const requirement = await create('Requirement', 'R1', {
      priority: 'MustHave',
    })
    const part = await create('Part', 'P1')
    const testCase = await create('TestCase', 'T1')

    expect(gapsOfType(await analyze(), 'unallocated_requirement')).toEqual([
      requirement.itemNumber,
    ])

    // ALLOCATED_TO is the requirement's own outgoing edge.
    await link(requirement.id, part.id, ALLOCATED_TO_RELATIONSHIP)
    let result = await analyze()
    expect(gapsOfType(result, 'unallocated_requirement')).toEqual([])
    expect(gapsOfType(result, 'unsatisfied_requirement')).toEqual([
      requirement.itemNumber,
    ])
    expect(result.coverage.requirements.allocated).toBe(1)

    // SATISFIES points AT the requirement, from the part that implements it.
    await link(part.id, requirement.id, SATISFIES_RELATIONSHIP)
    result = await analyze()
    expect(gapsOfType(result, 'unsatisfied_requirement')).toEqual([])
    expect(gapsOfType(result, 'unverified_requirement')).toEqual([
      requirement.itemNumber,
    ])
    expect(result.coverage.requirements.satisfied).toBe(1)

    // VERIFIED_BY likewise, from the test case that verifies it.
    await link(testCase.id, requirement.id, VERIFIED_BY_RELATIONSHIP)
    result = await analyze()
    expect(gapsOfType(result, 'unverified_requirement')).toEqual([])
    expect(result.coverage.requirements.verified).toBe(1)
  })

  // ==========================================================================
  // Engineering
  // ==========================================================================

  it('reports the part with no test case, not the one a test case validates', async () => {
    const tested = await create('Part', 'P1')
    const untested = await create('Part', 'P2')
    const testCase = await create('TestCase', 'T1')
    await link(testCase.id, tested.id, VALIDATES_RELATIONSHIP)

    const result = await analyze()

    expect(gapsOfType(result, 'untested_part')).toEqual([untested.itemNumber])
    expect(result.coverage.engineering).toMatchObject({ total: 2, tested: 1 })
  })

  // ==========================================================================
  // Manufacturing — the EBOM/MBOM mapping
  // ==========================================================================

  it('finds no orphans in an MBOM whose every item was linked on derivation', async () => {
    // Derivation copies the root Part's reachable subtree, so both parts hang
    // off one root.
    const p1 = await create('Part', 'P1')
    const p2 = await create('Part', 'P2')
    await link(p1.id, p2.id, 'BOM')

    const mbom = await MbomService.createFromEbom(
      {
        sourceDesignId: designId,
        name: 'Derived MBOM',
        code: `GAM-${unique}`,
        copyBomStructure: true,
        linkToSource: true,
        renumberItems: true,
      },
      user.id,
    )

    const mbomResult = await GapAnalysisService.analyze({
      designId: mbom.design.id,
    })

    expect(
      mbomResult.gaps.filter((g) => g.type === 'orphan_mbom_item'),
    ).toHaveLength(0)
    expect(mbomResult.coverage.manufacturing).toMatchObject({
      total: 2,
      linkedToEbom: 2,
    })
  })

  it('reports an MBOM part that nothing derived as an orphan', async () => {
    await create('Part', 'P1')
    const mbom = await MbomService.createFromEbom(
      {
        sourceDesignId: designId,
        name: 'Derived MBOM',
        code: `GAM-${unique}`,
        copyBomStructure: true,
        linkToSource: true,
        renumberItems: true,
      },
      user.id,
    )

    // A part added to the MBOM by hand — manufacturing-only, no EBOM twin.
    const handAdded = (await ItemService.create(
      'Part',
      {
        itemNumber: `PRT-${unique}-MFGONLY`,
        revision: 'A',
        name: 'Manufacturing-only fixture',
        designId: mbom.design.id,
      } as never,
      user.id,
    )) as Created

    const mbomResult = await GapAnalysisService.analyze({
      designId: mbom.design.id,
    })

    expect(
      mbomResult.gaps
        .filter((g) => g.type === 'orphan_mbom_item')
        .map((g) => g.itemNumber),
    ).toEqual([handAdded.itemNumber])
  })

  // ==========================================================================
  // What counts as the design's
  // ==========================================================================

  it('does not count a part created on an open change order as the design’s gap', async () => {
    const releasedPart = await create('Part', 'P1')
    await release(releasedPart)

    const { branchId } = await reviseOnChangeOrder(releasedPart, 'Gap ECO')

    // A part that exists only on the branch: the change order is unapproved,
    // so this is not in the design yet.
    await ItemService.createOnBranch(
      'Part',
      {
        itemNumber: `PRT-${unique}-BRANCHONLY`,
        revision: '-',
        name: 'Branch-only part',
        designId,
      } as never,
      branchId,
      'Authored on the change order',
      user.id,
    )

    const result = await analyze()

    expect(gapsOfType(result, 'untested_part')).toEqual([
      releasedPart.itemNumber,
    ])
    // And the denominator the completeness figure divides by is the design's,
    // not the design plus everything in flight against it.
    expect(result.coverage.engineering.total).toBe(1)
  })

  it('counts a revised part once, at the revision main holds, across the release', async () => {
    const part = await create('Part', 'P1')
    const other = await create('Part', 'P2')
    await release(part, other)

    const { changeOrderId } = await reviseOnChangeOrder(part, 'Gap ECO')

    // While the change order is open, main still holds revision A.
    let result = await analyze()
    expect(gapsOfType(result, 'untested_part')).toEqual(
      [part.itemNumber, other.itemNumber].sort(),
    )
    expect(result.coverage.engineering.total).toBe(2)

    await approveAndMerge(changeOrderId)

    // And after it releases, still once each — at B for the revised part,
    // never once per revision.
    result = await analyze()
    expect(gapsOfType(result, 'untested_part')).toEqual(
      [part.itemNumber, other.itemNumber].sort(),
    )
    expect(result.coverage.engineering.total).toBe(2)
    const revised = result.gaps.find(
      (g) => g.itemNumber === part.itemNumber && g.type === 'untested_part',
    )
    expect(revised?.revision).toBe('B')
  })

  it('answers the gap list and the coverage denominator from one population', async () => {
    const requirement = await create('Requirement', 'R1', {
      priority: 'MustHave',
    })
    await create('Part', 'P1')
    await create('Part', 'P2')
    const testCase = await create('TestCase', 'T1')
    await link(testCase.id, requirement.id, VERIFIED_BY_RELATIONSHIP)

    const result = await analyze()

    // Every requirement gap names a requirement the coverage counted, and
    // every part gap a part it counted.
    const requirementGaps = result.gaps.filter(
      (g) => g.domain === 'requirements',
    )
    expect(requirementGaps.length).toBeLessThanOrEqual(
      result.coverage.requirements.total,
    )
    expect(result.coverage.requirements.total).toBe(1)

    const untested = gapsOfType(result, 'untested_part')
    expect(untested).toHaveLength(result.coverage.engineering.total)
  })

  it('reports an unknown design as not found', async () => {
    await expect(
      GapAnalysisService.analyze({
        designId: '00000000-0000-4000-8000-0000000000ff',
      }),
    ).rejects.toThrow()
  })
})
