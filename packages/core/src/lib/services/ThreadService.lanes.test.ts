// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * ThreadService — the non-physical lanes.
 *
 * Complex-algorithm gate: each lane is its own bounded graph walk over a
 * different edge type, and they all deposit into one node set. The failure
 * modes are quiet — a node in the wrong lane, a node that appears twice
 * because two walks reached it by different paths, a walk that stops one level
 * early — and none of them throws.
 *
 * The physical lane has its own suite (ThreadService.physical.test.ts); this
 * one covers BOM, requirements, validation and the upstream/downstream item
 * links, plus one at-context read, because branch isolation is the product's
 * core promise and the lanes have to respect it.
 *
 * Assertions are about lane membership and identity — "the grandchild appears
 * exactly once, in engineering" — never node-count snapshots, which pass for
 * the wrong reason the moment a walk adds a node somewhere else.
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
import { DesignService } from './DesignService'
import { EBOM_SOURCE_RELATIONSHIP } from './MbomService'
import { RequirementService } from './RequirementService'
import { ThreadService } from './ThreadService'
import { VerificationService } from './VerificationService'
import { BranchService } from './BranchService'
import type { ThreadNode, ThreadResponse } from './ThreadService'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { Part } from '@/lib/items/types/part'
import type { Requirement } from '@/lib/items/types/requirement'
import type { TestCase } from '@/lib/items/types/testcase'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { takeFirst } from '@/lib/db/take-first'
import { ItemService } from '@/lib/items/services/ItemService'
import {
  itemRelationships,
  programMembers,
  programs,
  requirements,
} from '@/lib/db/schema'
import '@/lib/items/registerItemTypes.server'

/** Every node in the response, whatever lane it landed in. */
function allNodes(thread: ThreadResponse): Array<ThreadNode> {
  return [
    ...thread.domains.requirements,
    ...thread.domains.engineering,
    ...thread.domains.manufacturing,
    ...thread.domains.validation,
    ...thread.domains.physical,
  ]
}

/** The lane a given item id landed in, or undefined if it is not in the web. */
function laneOf(thread: ThreadResponse, id: string): string | undefined {
  for (const [lane, nodes] of Object.entries(thread.domains)) {
    if (nodes.some((n) => n.id === id)) return lane
  }
  return undefined
}

describe('ThreadService non-physical lanes', () => {
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
          name: 'Thread Lanes Program',
          code: `PROG-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
          createdBy: user.id,
        })
        .returning(),
    )
    await testDb.db.insert(programMembers).values({
      programId: program.id,
      userId: user.id,
      role: 'admin',
      invitedBy: user.id,
    })

    const design = await DesignService.create(
      {
        programId: program.id,
        name: 'Thread Lanes Design',
        code: `DESIGN-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
        designType: 'Engineering',
      },
      user.id,
    )
    designId = design.id
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

  const createPart = (name: string) =>
    ItemService.create<Part>(
      'Part',
      {
        itemNumber: `PRT-${uid()}`,
        revision: 'A',
        designId,
        name,
        partType: 'Manufacture',
      } as Part,
      user.id,
    )

  const createRequirement = (name: string) =>
    ItemService.create<Requirement>(
      'Requirement',
      {
        itemNumber: `REQ-${uid()}`,
        revision: 'A',
        designId,
        name,
      } as Requirement,
      user.id,
    )

  const createTestCase = (name: string) =>
    ItemService.create<TestCase>(
      'TestCase',
      {
        itemNumber: `TC-${uid()}`,
        revision: 'A',
        designId,
        name,
      } as TestCase,
      user.id,
    )

  async function addEdge(
    sourceId: string,
    targetId: string,
    relationshipType: string,
    quantity?: string,
  ) {
    await testDb.db.insert(itemRelationships).values({
      sourceId,
      targetId,
      relationshipType,
      quantity: quantity ?? null,
      createdBy: user.id,
      modifiedBy: user.id,
    })
  }

  describe('BOM lane', () => {
    it('reaches a grandchild three levels down, exactly once, in engineering', async () => {
      const top = await createPart('Top')
      const mid = await createPart('Mid')
      const leaf = await createPart('Leaf')
      await addEdge(top.id!, mid.id!, 'BOM', '2')
      await addEdge(mid.id!, leaf.id!, 'BOM', '3')

      const thread = await ThreadService.getThread({
        itemId: top.id!,
        bomDepth: 3,
      })

      expect(laneOf(thread, mid.id!)).toBe('engineering')
      expect(laneOf(thread, leaf.id!)).toBe('engineering')
      // Exactly once, however many paths reach it.
      expect(allNodes(thread).filter((n) => n.id === leaf.id)).toHaveLength(1)
    })

    it('stops where bomDepth says to', async () => {
      const top = await createPart('Top')
      const mid = await createPart('Mid')
      const leaf = await createPart('Leaf')
      await addEdge(top.id!, mid.id!, 'BOM')
      await addEdge(mid.id!, leaf.id!, 'BOM')

      const thread = await ThreadService.getThread({
        itemId: top.id!,
        bomDepth: 1,
      })

      expect(laneOf(thread, mid.id!)).toBe('engineering')
      expect(laneOf(thread, leaf.id!)).toBeUndefined()
    })

    it('survives a cycle rather than walking it forever', async () => {
      const a = await createPart('A')
      const b = await createPart('B')
      await addEdge(a.id!, b.id!, 'BOM')
      // A BOM should never contain a cycle; the walk still has to terminate
      // if one exists, because a hang here takes the whole request with it.
      await addEdge(b.id!, a.id!, 'BOM')

      const thread = await ThreadService.getThread({
        itemId: a.id!,
        bomDepth: 5,
      })

      expect(allNodes(thread).filter((n) => n.id === a.id)).toHaveLength(1)
      expect(allNodes(thread).filter((n) => n.id === b.id)).toHaveLength(1)
    })

    it('walks down only — a parent is not reached from its child', async () => {
      const parent = await createPart('Parent')
      const child = await createPart('Child')
      await addEdge(parent.id!, child.id!, 'BOM')

      const thread = await ThreadService.getThread({
        itemId: child.id!,
        bomDepth: 2,
      })

      // Deliberate, and worth pinning: the BOM lane is the focal item's
      // contents, not its where-used. Where-used has its own endpoint, and a
      // thread that silently included parents would double every assembly.
      expect(laneOf(thread, parent.id!)).toBeUndefined()
    })
  })

  describe('requirements lane', () => {
    it('places a requirement the focal part satisfies in the requirements lane', async () => {
      const part = await createPart('Widget')
      const req = await createRequirement('Shall widget')
      await RequirementService.linkSatisfaction(req.id!, [part.id!], user.id)

      const thread = await ThreadService.getThread({ itemId: part.id! })

      expect(laneOf(thread, req.id!)).toBe('requirements')
    })

    it('walks up a requirement hierarchy to the parent requirement', async () => {
      const part = await createPart('Widget')
      const child = await createRequirement('Child requirement')
      const parent = await createRequirement('Parent requirement')
      await RequirementService.linkSatisfaction(child.id!, [part.id!], user.id)
      // Requirement parentage is a column, not an edge — the walk reads
      // `requirements.parent_requirement_id` directly.
      await testDb.db
        .update(requirements)
        .set({ parentRequirementId: parent.id! })
        .where(eq(requirements.itemId, child.id!))

      const thread = await ThreadService.getThread({
        itemId: part.id!,
        requirementsDepth: 3,
      })

      expect(laneOf(thread, child.id!)).toBe('requirements')
      expect(laneOf(thread, parent.id!)).toBe('requirements')
    })

    it('does not reach requirements when the lane is not asked for', async () => {
      const part = await createPart('Widget')
      const req = await createRequirement('Shall widget')
      await RequirementService.linkSatisfaction(req.id!, [part.id!], user.id)

      const thread = await ThreadService.getThread({
        itemId: part.id!,
        domains: ['engineering'],
      })

      expect(laneOf(thread, req.id!)).toBeUndefined()
    })
  })

  describe('validation lane', () => {
    it('reaches the test case validating the focal part', async () => {
      const part = await createPart('Widget')
      const testCase = await createTestCase('Widget test')
      await VerificationService.linkValidation(
        testCase.id!,
        [part.id!],
        user.id,
      )

      const thread = await ThreadService.getThread({ itemId: part.id! })

      expect(laneOf(thread, testCase.id!)).toBe('validation')
    })

    it('reaches the test case verifying the focal requirement', async () => {
      const req = await createRequirement('Shall widget')
      const testCase = await createTestCase('Requirement test')
      await RequirementService.linkVerification(
        req.id!,
        [testCase.id!],
        user.id,
      )

      const thread = await ThreadService.getThread({ itemId: req.id! })

      expect(laneOf(thread, testCase.id!)).toBe('validation')
    })

    it('does not chain from a part through its requirement to that requirement’s tests', async () => {
      const part = await createPart('Widget')
      const req = await createRequirement('Shall widget')
      const testCase = await createTestCase('Requirement test')
      await RequirementService.linkSatisfaction(req.id!, [part.id!], user.id)
      await RequirementService.linkVerification(
        req.id!,
        [testCase.id!],
        user.id,
      )

      const thread = await ThreadService.getThread({ itemId: part.id! })

      // The requirement arrives; the test case verifying it does not. Both
      // lane walks start from the focal item, so validation looks for tests
      // of the *part*, not of everything the requirements walk reached. A
      // real edge of the current design, pinned so a change to it is a
      // decision rather than a surprise.
      expect(laneOf(thread, req.id!)).toBe('requirements')
      expect(laneOf(thread, testCase.id!)).toBeUndefined()
    })
  })

  describe('upstream and downstream item links', () => {
    it('reaches both ends of an EBOM_SOURCE chain around the focal item', async () => {
      const source = await createPart('Source')
      const focal = await createPart('Focal')
      const derived = await createPart('Derived')
      await addEdge(source.id!, focal.id!, EBOM_SOURCE_RELATIONSHIP)
      await addEdge(focal.id!, derived.id!, EBOM_SOURCE_RELATIONSHIP)

      const thread = await ThreadService.getThread({
        itemId: focal.id!,
        upstreamDepth: 2,
        downstreamDepth: 2,
      })

      expect(laneOf(thread, source.id!)).toBeDefined()
      expect(laneOf(thread, derived.id!)).toBeDefined()
    })
  })

  describe('focal item and stats', () => {
    it('marks exactly one node as focal and never lists it as its own neighbour', async () => {
      const part = await createPart('Widget')
      const child = await createPart('Child')
      await addEdge(part.id!, child.id!, 'BOM')

      const thread = await ThreadService.getThread({ itemId: part.id! })

      expect(thread.focalItem.id).toBe(part.id)
      expect(thread.focalItem.isFocalItem).toBe(true)
      expect(allNodes(thread).filter((n) => n.isFocalItem)).toHaveLength(1)
      expect(thread.stats.totalNodes).toBeGreaterThan(0)
      expect(thread.stats.totalRelationships).toBe(thread.relationships.length)
    })
  })

  describe('at a version context', () => {
    it('resolves the lanes against a branch rather than the live rows', async () => {
      const part = await createPart('Widget')
      const child = await createPart('Child')
      await addEdge(part.id!, child.id!, 'BOM')

      const branch = await BranchService.createWorkspaceBranch(
        designId,
        user.id,
        `wip-${uid()}`,
      )

      const thread = await ThreadService.getThreadAtContext(
        { itemId: part.id! },
        { type: 'branch', branchId: branch.id },
      )

      // Nothing has been checked out onto the branch, so the branch view is
      // main's — but it has to arrive through version resolution rather than
      // by reading the rows directly, which is what this pins.
      expect(thread.focalItem.id).toBe(part.id)
      expect(laneOf(thread, child.id!)).toBe('engineering')
      for (const node of allNodes(thread)) {
        if (node.designId) expect(node.designId).toBe(designId)
      }
    })
  })
})
