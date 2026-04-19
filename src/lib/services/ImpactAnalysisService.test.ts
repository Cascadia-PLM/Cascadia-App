/**
 * ImpactAnalysisService Tests
 *
 * Integration tests for the ImpactAnalysisService class.
 * Tests cover BOM traversal (upstream/downstream/both), depth limiting,
 * cross-domain relationships, severity calculation, summary generation,
 * and recommendation logic.
 *
 * Run: npm run test -- src/lib/services/ImpactAnalysisService.test.ts
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
import { ImpactAnalysisService } from './ImpactAnalysisService'
import { DesignService } from './DesignService'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { itemRelationships, items, programs } from '@/lib/db/schema'
import { ItemService } from '@/lib/items/services/ItemService'
import { NotFoundError } from '@/lib/errors'
import '@/lib/items/registerItemTypes.server'

describe('ImpactAnalysisService', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let programId: string
  let designId: string

  // Unique suffix for codes to avoid collisions across parallel tests
  let uniqueId: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    user = await insertTestUser(testDb.db)

    uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`

    // Create program
    const [program] = await testDb.db
      .insert(programs)
      .values({
        name: 'Test Program',
        code: `PROG-${uniqueId}`,
        createdBy: user.id,
      })
      .returning()
    programId = program.id

    // Create design with main branch
    const design = await DesignService.create(
      {
        programId,
        name: 'Test Design',
        code: `DES-${uniqueId}`,
        designType: 'Engineering',
      },
      user.id,
    )
    designId = design.id
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  // ---- Helpers ----

  let partCounter = 0

  async function createPart(
    name: string,
    opts?: { state?: string; designId?: string },
  ) {
    partCounter++
    return ItemService.create(
      'Part',
      {
        name,
        itemNumber: `PRT-${uniqueId}-${partCounter}`,
        revision: 'A',
        designId: opts?.designId ?? designId,
        state: opts?.state,
      } as any,
      user.id,
      { bypassBranchProtection: true },
    )
  }

  async function createRequirement(name: string) {
    partCounter++
    return ItemService.create(
      'Requirement',
      {
        name,
        itemNumber: `REQ-${uniqueId}-${partCounter}`,
        revision: 'A',
        designId,
        type: 'Functional',
        priority: 'MustHave',
      } as any,
      user.id,
      { bypassBranchProtection: true },
    )
  }

  async function createBomRelationship(parentId: string, childId: string) {
    await testDb.db.insert(itemRelationships).values({
      sourceId: parentId,
      targetId: childId,
      relationshipType: 'BOM',
      createdBy: user.id,
      modifiedBy: user.id,
    })
  }

  async function createRelationship(
    sourceId: string,
    targetId: string,
    relationshipType: string,
  ) {
    await testDb.db.insert(itemRelationships).values({
      sourceId,
      targetId,
      relationshipType,
      createdBy: user.id,
      modifiedBy: user.id,
    })
  }

  // ---- Basic analysis ----

  describe('basic analysis', () => {
    it('analyzes an item with no relationships', async () => {
      const part = await createPart('Standalone Part')

      const result = await ImpactAnalysisService.analyze({
        itemId: part.id,
        changeType: 'revision',
        direction: 'both',
      })

      expect(result.sourceItem.id).toBe(part.id)
      expect(result.sourceItem.itemNumber).toBe(part.itemNumber)
      expect(result.changeType).toBe('revision')
      expect(result.impactedItems).toHaveLength(0)
      expect(result.summary.totalImpacted).toBe(0)
      expect(result.analyzedAt).toBeInstanceOf(Date)
    })

    it('throws NotFoundError for non-existent item', async () => {
      await expect(
        ImpactAnalysisService.analyze({
          itemId: crypto.randomUUID(),
          changeType: 'revision',
          direction: 'both',
        }),
      ).rejects.toThrow(NotFoundError)
    })

    it('returns source item details correctly', async () => {
      const part = await createPart('Detail Part')

      const result = await ImpactAnalysisService.analyze({
        itemId: part.id,
        changeType: 'obsolescence',
        direction: 'downstream',
      })

      expect(result.sourceItem).toMatchObject({
        id: part.id,
        itemNumber: part.itemNumber,
        name: 'Detail Part',
        itemType: 'Part',
        revision: 'A',
        designId,
      })
    })
  })

  // ---- BOM downstream traversal ----

  describe('downstream BOM traversal', () => {
    it('finds direct BOM children', async () => {
      const assembly = await createPart('Assembly')
      const child1 = await createPart('Child 1')
      const child2 = await createPart('Child 2')

      await createBomRelationship(assembly.id, child1.id)
      await createBomRelationship(assembly.id, child2.id)

      const result = await ImpactAnalysisService.analyze({
        itemId: assembly.id,
        changeType: 'revision',
        direction: 'downstream',
      })

      expect(result.impactedItems).toHaveLength(2)
      const impactedIds = result.impactedItems.map((i) => i.item.id)
      expect(impactedIds).toContain(child1.id)
      expect(impactedIds).toContain(child2.id)

      // All direct children should have depth 1 and impactType 'direct'
      for (const item of result.impactedItems) {
        expect(item.depth).toBe(1)
        expect(item.impactType).toBe('direct')
        expect(item.relationshipType).toBe('BOM')
      }
    })

    it('traverses multi-level BOM hierarchy downstream', async () => {
      const assembly = await createPart('Assembly')
      const subAssembly = await createPart('SubAssembly')
      const component = await createPart('Component')

      await createBomRelationship(assembly.id, subAssembly.id)
      await createBomRelationship(subAssembly.id, component.id)

      const result = await ImpactAnalysisService.analyze({
        itemId: assembly.id,
        changeType: 'revision',
        direction: 'downstream',
      })

      expect(result.impactedItems).toHaveLength(2)

      const subAsmItem = result.impactedItems.find(
        (i) => i.item.id === subAssembly.id,
      )
      const compItem = result.impactedItems.find(
        (i) => i.item.id === component.id,
      )

      expect(subAsmItem).toBeDefined()
      expect(subAsmItem!.depth).toBe(1)
      expect(subAsmItem!.impactType).toBe('direct')

      expect(compItem).toBeDefined()
      expect(compItem!.depth).toBe(2)
      expect(compItem!.impactType).toBe('indirect')
    })
  })

  // ---- BOM upstream traversal ----

  describe('upstream BOM traversal', () => {
    it('finds direct BOM parents (where-used)', async () => {
      const assembly = await createPart('Assembly')
      const component = await createPart('Component')

      await createBomRelationship(assembly.id, component.id)

      const result = await ImpactAnalysisService.analyze({
        itemId: component.id,
        changeType: 'revision',
        direction: 'upstream',
      })

      expect(result.impactedItems).toHaveLength(1)
      expect(result.impactedItems[0].item.id).toBe(assembly.id)
      expect(result.impactedItems[0].depth).toBe(1)
      expect(result.impactedItems[0].impactType).toBe('direct')
    })

    it('traverses multi-level BOM hierarchy upstream', async () => {
      const topAssembly = await createPart('Top Assembly')
      const subAssembly = await createPart('SubAssembly')
      const component = await createPart('Component')

      await createBomRelationship(topAssembly.id, subAssembly.id)
      await createBomRelationship(subAssembly.id, component.id)

      const result = await ImpactAnalysisService.analyze({
        itemId: component.id,
        changeType: 'revision',
        direction: 'upstream',
      })

      expect(result.impactedItems).toHaveLength(2)

      const subAsmItem = result.impactedItems.find(
        (i) => i.item.id === subAssembly.id,
      )
      const topItem = result.impactedItems.find(
        (i) => i.item.id === topAssembly.id,
      )

      expect(subAsmItem).toBeDefined()
      expect(subAsmItem!.depth).toBe(1)

      expect(topItem).toBeDefined()
      expect(topItem!.depth).toBe(2)
    })
  })

  // ---- Both directions ----

  describe('both directions', () => {
    it('finds items in both upstream and downstream directions', async () => {
      const parent = await createPart('Parent Assembly')
      const middle = await createPart('Middle Part')
      const child = await createPart('Child Component')

      await createBomRelationship(parent.id, middle.id)
      await createBomRelationship(middle.id, child.id)

      const result = await ImpactAnalysisService.analyze({
        itemId: middle.id,
        changeType: 'revision',
        direction: 'both',
      })

      const impactedIds = result.impactedItems.map((i) => i.item.id)
      expect(impactedIds).toContain(parent.id)
      expect(impactedIds).toContain(child.id)
      expect(result.impactedItems).toHaveLength(2)
    })
  })

  // ---- Depth limiting ----

  describe('depth limiting', () => {
    it('limits traversal to maxDepth=1 (immediate neighbors only)', async () => {
      const assembly = await createPart('Assembly')
      const subAssembly = await createPart('SubAssembly')
      const component = await createPart('Component')

      await createBomRelationship(assembly.id, subAssembly.id)
      await createBomRelationship(subAssembly.id, component.id)

      const result = await ImpactAnalysisService.analyze({
        itemId: assembly.id,
        changeType: 'revision',
        direction: 'downstream',
        maxDepth: 1,
      })

      // Should only find SubAssembly (depth 1), not Component (depth 2)
      expect(result.impactedItems).toHaveLength(1)
      expect(result.impactedItems[0].item.id).toBe(subAssembly.id)
      expect(result.impactedItems[0].depth).toBe(1)
    })

    it('defaults to maxDepth=5 when not specified', async () => {
      // Create a 6-level deep chain
      const parts = []
      for (let i = 0; i < 7; i++) {
        parts.push(await createPart(`Level ${i}`))
      }
      for (let i = 0; i < 6; i++) {
        await createBomRelationship(parts[i].id, parts[i + 1].id)
      }

      const result = await ImpactAnalysisService.analyze({
        itemId: parts[0].id,
        changeType: 'revision',
        direction: 'downstream',
        // No maxDepth specified => default 5
      })

      // Should find levels 1-5 but not level 6
      expect(result.impactedItems.length).toBe(5)
      const depths = result.impactedItems.map((i) => i.depth).sort()
      expect(depths).toEqual([1, 2, 3, 4, 5])
    })

    it('with maxDepth=2 finds two levels', async () => {
      const a = await createPart('A')
      const b = await createPart('B')
      const c = await createPart('C')
      const d = await createPart('D')

      await createBomRelationship(a.id, b.id)
      await createBomRelationship(b.id, c.id)
      await createBomRelationship(c.id, d.id)

      const result = await ImpactAnalysisService.analyze({
        itemId: a.id,
        changeType: 'revision',
        direction: 'downstream',
        maxDepth: 2,
      })

      // Should find B (depth 1) and C (depth 2), but not D (depth 3)
      expect(result.impactedItems).toHaveLength(2)
      const ids = result.impactedItems.map((i) => i.item.id)
      expect(ids).toContain(b.id)
      expect(ids).toContain(c.id)
      expect(ids).not.toContain(d.id)
    })
  })

  // ---- Visited set prevents cycles ----

  describe('cycle prevention', () => {
    it('does not visit the same item twice when traversing both directions', async () => {
      const a = await createPart('Part A')
      const b = await createPart('Part B')

      // A -> B (BOM)
      await createBomRelationship(a.id, b.id)

      // Analyzing A in both directions: downstream finds B, upstream finds nothing
      // B should appear only once
      const result = await ImpactAnalysisService.analyze({
        itemId: a.id,
        changeType: 'revision',
        direction: 'both',
      })

      const bOccurrences = result.impactedItems.filter(
        (i) => i.item.id === b.id,
      )
      expect(bOccurrences).toHaveLength(1)
    })
  })

  // ---- isCurrent filter ----

  describe('isCurrent filter', () => {
    it('skips items where isCurrent is false', async () => {
      const assembly = await createPart('Assembly')
      const component = await createPart('Old Component')

      await createBomRelationship(assembly.id, component.id)

      // Mark the component as not current
      await testDb.db
        .update(items)
        .set({ isCurrent: false })
        .where(eq(items.id, component.id))

      const result = await ImpactAnalysisService.analyze({
        itemId: assembly.id,
        changeType: 'revision',
        direction: 'downstream',
      })

      // Component should be skipped because isCurrent=false
      expect(result.impactedItems).toHaveLength(0)
    })
  })

  // ---- Severity calculation ----

  describe('severity calculation', () => {
    it('assigns high severity to direct BOM neighbors (depth=1)', async () => {
      const assembly = await createPart('Assembly')
      const child = await createPart('Child')

      await createBomRelationship(assembly.id, child.id)

      const result = await ImpactAnalysisService.analyze({
        itemId: assembly.id,
        changeType: 'revision',
        direction: 'downstream',
      })

      expect(result.impactedItems).toHaveLength(1)
      expect(result.impactedItems[0].severity).toBe('high')
    })

    it('assigns critical severity to Released items with obsolescence change type', async () => {
      const assembly = await createPart('Assembly')
      const child = await createPart('Released Child', { state: 'Released' })

      await createBomRelationship(assembly.id, child.id)

      // Set child to Released state directly
      await testDb.db
        .update(items)
        .set({ state: 'Released' })
        .where(eq(items.id, child.id))

      const result = await ImpactAnalysisService.analyze({
        itemId: assembly.id,
        changeType: 'obsolescence',
        direction: 'downstream',
      })

      expect(result.impactedItems).toHaveLength(1)
      expect(result.impactedItems[0].severity).toBe('critical')
    })

    it('assigns high severity to Released items with non-obsolescence change type', async () => {
      const assembly = await createPart('Assembly')
      const child = await createPart('Released Child')

      await createBomRelationship(assembly.id, child.id)

      await testDb.db
        .update(items)
        .set({ state: 'Released' })
        .where(eq(items.id, child.id))

      const result = await ImpactAnalysisService.analyze({
        itemId: assembly.id,
        changeType: 'revision',
        direction: 'downstream',
      })

      expect(result.impactedItems).toHaveLength(1)
      expect(result.impactedItems[0].severity).toBe('high')
    })

    it('assigns medium severity to indirect impacts (depth 2-3)', async () => {
      const a = await createPart('A')
      const b = await createPart('B')
      const c = await createPart('C')

      await createBomRelationship(a.id, b.id)
      await createBomRelationship(b.id, c.id)

      const result = await ImpactAnalysisService.analyze({
        itemId: a.id,
        changeType: 'revision',
        direction: 'downstream',
      })

      const depth2Item = result.impactedItems.find((i) => i.depth === 2)
      expect(depth2Item).toBeDefined()
      expect(depth2Item!.severity).toBe('medium')
    })

    it('assigns low severity to distant impacts (depth 4+)', async () => {
      // Create chain: A -> B -> C -> D -> E
      const parts = []
      for (let i = 0; i < 5; i++) {
        parts.push(await createPart(`Part ${i}`))
      }
      for (let i = 0; i < 4; i++) {
        await createBomRelationship(parts[i].id, parts[i + 1].id)
      }

      const result = await ImpactAnalysisService.analyze({
        itemId: parts[0].id,
        changeType: 'revision',
        direction: 'downstream',
      })

      const depth4Item = result.impactedItems.find((i) => i.depth === 4)
      expect(depth4Item).toBeDefined()
      expect(depth4Item!.severity).toBe('low')
    })
  })

  // ---- Cross-design severity ----

  describe('cross-design impacts', () => {
    it('assigns critical severity to Released items in a different design', async () => {
      // Create a second design
      const design2 = await DesignService.create(
        {
          programId,
          name: 'Second Design',
          code: `DES2-${uniqueId}`,
          designType: 'Engineering',
        },
        user.id,
      )

      const partA = await createPart('Part A')
      const partB = await createPart('Part B', { designId: design2.id })

      // Set partB to Released
      await testDb.db
        .update(items)
        .set({ state: 'Released' })
        .where(eq(items.id, partB.id))

      // Create a cross-domain SATISFIES relationship (partA -> partB)
      await createRelationship(partA.id, partB.id, 'SATISFIES')

      const result = await ImpactAnalysisService.analyze({
        itemId: partA.id,
        changeType: 'revision',
        direction: 'both',
      })

      // partB is in another design and is Released => critical
      const partBImpact = result.impactedItems.find(
        (i) => i.item.id === partB.id,
      )
      expect(partBImpact).toBeDefined()
      expect(partBImpact!.severity).toBe('critical')
    })

    it('counts cross-design items in summary', async () => {
      const design2 = await DesignService.create(
        {
          programId,
          name: 'Other Design',
          code: `DES3-${uniqueId}`,
          designType: 'Engineering',
        },
        user.id,
      )

      const partA = await createPart('Part A')
      const partB = await createPart('Part B', { designId: design2.id })

      await createRelationship(partA.id, partB.id, 'SATISFIES')

      const result = await ImpactAnalysisService.analyze({
        itemId: partA.id,
        changeType: 'revision',
        direction: 'both',
      })

      expect(result.summary.crossDesignCount).toBe(1)
    })
  })

  // ---- Cross-domain relationships ----

  describe('cross-domain relationships', () => {
    it('finds items connected by SATISFIES relationship', async () => {
      const part = await createPart('Test Part')
      const req = await createRequirement('Test Requirement')

      // Part SATISFIES Requirement
      await createRelationship(part.id, req.id, 'SATISFIES')

      const result = await ImpactAnalysisService.analyze({
        itemId: part.id,
        changeType: 'specification_change',
        direction: 'downstream',
      })

      // The cross-domain traversal should find the requirement
      const reqImpact = result.impactedItems.find((i) => i.item.id === req.id)
      expect(reqImpact).toBeDefined()
      expect(reqImpact!.relationshipType).toBe('SATISFIES')
      expect(reqImpact!.domain).toBe('requirements')
    })

    it('respects direction filter for cross-domain relationships', async () => {
      const part = await createPart('Part')
      const req = await createRequirement('Req')

      // Part SATISFIES Requirement (source=Part, target=Requirement)
      await createRelationship(part.id, req.id, 'SATISFIES')

      // Upstream from the Part should find the Requirement (as target->source)
      // Actually, cross-domain upstream means !isSource (the item is the target)
      // Part is the source in SATISFIES, so analyzing Part upstream should NOT find Req
      // But analyzing Req upstream SHOULD find Part
      const resultUpstream = await ImpactAnalysisService.analyze({
        itemId: part.id,
        changeType: 'revision',
        direction: 'upstream',
      })

      // Part is the source in the relationship. upstream = !isSource.
      // Since Part is always the source here, upstream from Part sees no cross-domain.
      const reqInUpstream = resultUpstream.impactedItems.find(
        (i) => i.item.id === req.id,
      )
      expect(reqInUpstream).toBeUndefined()

      // Downstream from Part should find Req
      const resultDownstream = await ImpactAnalysisService.analyze({
        itemId: part.id,
        changeType: 'revision',
        direction: 'downstream',
      })

      const reqInDownstream = resultDownstream.impactedItems.find(
        (i) => i.item.id === req.id,
      )
      expect(reqInDownstream).toBeDefined()
    })

    it('finds EBOM_SOURCE relationships', async () => {
      const ebomPart = await createPart('EBOM Part')
      const mbomPart = await createPart('MBOM Part')

      await createRelationship(ebomPart.id, mbomPart.id, 'EBOM_SOURCE')

      const result = await ImpactAnalysisService.analyze({
        itemId: ebomPart.id,
        changeType: 'revision',
        direction: 'downstream',
      })

      const mbomImpact = result.impactedItems.find(
        (i) => i.item.id === mbomPart.id,
      )
      expect(mbomImpact).toBeDefined()
      expect(mbomImpact!.relationshipType).toBe('EBOM_SOURCE')
    })
  })

  // ---- Summary generation ----

  describe('summary generation', () => {
    it('correctly counts total impacted items', async () => {
      const assembly = await createPart('Assembly')
      const child1 = await createPart('Child 1')
      const child2 = await createPart('Child 2')
      const child3 = await createPart('Child 3')

      await createBomRelationship(assembly.id, child1.id)
      await createBomRelationship(assembly.id, child2.id)
      await createBomRelationship(assembly.id, child3.id)

      const result = await ImpactAnalysisService.analyze({
        itemId: assembly.id,
        changeType: 'revision',
        direction: 'downstream',
      })

      expect(result.summary.totalImpacted).toBe(3)
    })

    it('breaks down counts by severity', async () => {
      const assembly = await createPart('Assembly')
      const child = await createPart('Direct Child')
      const grandchild = await createPart('Grandchild')

      await createBomRelationship(assembly.id, child.id)
      await createBomRelationship(child.id, grandchild.id)

      const result = await ImpactAnalysisService.analyze({
        itemId: assembly.id,
        changeType: 'revision',
        direction: 'downstream',
      })

      // Depth 1 = high, depth 2 = medium
      expect(result.summary.bySeverity.high).toBe(1)
      expect(result.summary.bySeverity.medium).toBe(1)
      expect(result.summary.totalImpacted).toBe(2)
    })

    it('breaks down counts by domain', async () => {
      const part = await createPart('Test Part')
      const req = await createRequirement('Test Req')

      await createRelationship(part.id, req.id, 'SATISFIES')

      const result = await ImpactAnalysisService.analyze({
        itemId: part.id,
        changeType: 'revision',
        direction: 'both',
      })

      // Requirement domain should be counted
      expect(result.summary.byDomain.requirements).toBeGreaterThanOrEqual(1)
    })

    it('initializes all domain and severity counts', async () => {
      const part = await createPart('Solo Part')

      const result = await ImpactAnalysisService.analyze({
        itemId: part.id,
        changeType: 'revision',
        direction: 'both',
      })

      // All domain keys should exist with value 0
      expect(result.summary.byDomain).toEqual({
        requirements: 0,
        engineering: 0,
        manufacturing: 0,
        validation: 0,
      })

      // All severity keys should exist with value 0
      expect(result.summary.bySeverity).toEqual({
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
      })

      expect(result.summary.crossDesignCount).toBe(0)
    })
  })

  // ---- Recommendations ----

  describe('recommendations', () => {
    it('generates default recommendation when no issues detected', async () => {
      const part = await createPart('Solo Part')

      const result = await ImpactAnalysisService.analyze({
        itemId: part.id,
        changeType: 'revision',
        direction: 'both',
      })

      expect(result.recommendations).toHaveLength(1)
      expect(result.recommendations[0]).toContain('No critical issues detected')
    })

    it('recommends coordination for cross-design impacts', async () => {
      const design2 = await DesignService.create(
        {
          programId,
          name: 'Design Cross',
          code: `DXD-${uniqueId}`,
          designType: 'Engineering',
        },
        user.id,
      )

      const partA = await createPart('Part A')
      const partB = await createPart('Part B', { designId: design2.id })

      await createRelationship(partA.id, partB.id, 'SATISFIES')

      const result = await ImpactAnalysisService.analyze({
        itemId: partA.id,
        changeType: 'revision',
        direction: 'both',
      })

      const coordRec = result.recommendations.find((r) =>
        r.includes('Coordinate with'),
      )
      expect(coordRec).toBeDefined()
    })

    it('recommends stakeholder review for critical impacts', async () => {
      const assembly = await createPart('Assembly')
      const child = await createPart('Released Child')

      await createBomRelationship(assembly.id, child.id)

      // Make child Released + obsolescence for critical severity
      await testDb.db
        .update(items)
        .set({ state: 'Released' })
        .where(eq(items.id, child.id))

      const result = await ImpactAnalysisService.analyze({
        itemId: assembly.id,
        changeType: 'obsolescence',
        direction: 'downstream',
      })

      const criticalRec = result.recommendations.find((r) =>
        r.includes('critical impact'),
      )
      expect(criticalRec).toBeDefined()
    })

    it('recommends requirement re-verification when requirements are impacted', async () => {
      const part = await createPart('Test Part')
      const req = await createRequirement('Test Req')

      await createRelationship(part.id, req.id, 'SATISFIES')

      const result = await ImpactAnalysisService.analyze({
        itemId: part.id,
        changeType: 'revision',
        direction: 'both',
      })

      const reqRec = result.recommendations.find((r) =>
        r.includes('requirement'),
      )
      expect(reqRec).toBeDefined()
    })

    it('recommends replacement items for obsolescence of released items', async () => {
      const assembly = await createPart('Assembly')
      const child = await createPart('Child')

      await createBomRelationship(assembly.id, child.id)

      await testDb.db
        .update(items)
        .set({ state: 'Released' })
        .where(eq(items.id, child.id))

      const result = await ImpactAnalysisService.analyze({
        itemId: assembly.id,
        changeType: 'obsolescence',
        direction: 'downstream',
      })

      const replacementRec = result.recommendations.find((r) =>
        r.includes('replacement'),
      )
      expect(replacementRec).toBeDefined()
    })

    it('recommends BOM verification for bom_removal change type', async () => {
      const parent = await createPart('Parent')
      const component = await createPart('Component')

      await createBomRelationship(parent.id, component.id)

      // Analyze the component, upstream finds parent
      const result = await ImpactAnalysisService.analyze({
        itemId: component.id,
        changeType: 'bom_removal',
        direction: 'upstream',
      })

      const bomRec = result.recommendations.find((r) =>
        r.includes('parent assembly'),
      )
      expect(bomRec).toBeDefined()
    })
  })

  // ---- Impact details / reasons ----

  describe('impact details', () => {
    it('generates BOM-specific reason for direct children', async () => {
      const assembly = await createPart('Assembly')
      const child = await createPart('Child')

      await createBomRelationship(assembly.id, child.id)

      const result = await ImpactAnalysisService.analyze({
        itemId: assembly.id,
        changeType: 'revision',
        direction: 'downstream',
      })

      expect(result.impactedItems[0].reason).toContain('BOM')
    })

    it('generates obsolescence action for BOM items', async () => {
      const assembly = await createPart('Assembly')
      const child = await createPart('Child')

      await createBomRelationship(assembly.id, child.id)

      const result = await ImpactAnalysisService.analyze({
        itemId: assembly.id,
        changeType: 'obsolescence',
        direction: 'downstream',
      })

      expect(result.impactedItems[0].requiredAction).toContain(
        'replacement part',
      )
    })

    it('generates SATISFIES-specific reason', async () => {
      const part = await createPart('Part')
      const req = await createRequirement('Req')

      await createRelationship(part.id, req.id, 'SATISFIES')

      const result = await ImpactAnalysisService.analyze({
        itemId: part.id,
        changeType: 'specification_change',
        direction: 'downstream',
      })

      const reqImpact = result.impactedItems.find((i) => i.item.id === req.id)
      expect(reqImpact).toBeDefined()
      expect(reqImpact!.reason).toContain('requirement')
      expect(reqImpact!.requiredAction).toContain('satisfaction')
    })
  })

  // ---- Domain filtering ----

  describe('includeDomains filtering', () => {
    it('filters out items not in included domains', async () => {
      const part = await createPart('Part')
      const req = await createRequirement('Req')

      await createRelationship(part.id, req.id, 'SATISFIES')

      // Only include engineering domain, exclude requirements
      const result = await ImpactAnalysisService.analyze({
        itemId: part.id,
        changeType: 'revision',
        direction: 'both',
        includeDomains: ['engineering'],
      })

      // Requirement should be filtered out since it's in 'requirements' domain
      const reqImpact = result.impactedItems.find((i) => i.item.id === req.id)
      expect(reqImpact).toBeUndefined()
    })
  })

  // ---- Impact path ----

  describe('impact path', () => {
    it('includes item numbers in the impact path', async () => {
      const assembly = await createPart('Assembly')
      const child = await createPart('Child')

      await createBomRelationship(assembly.id, child.id)

      const result = await ImpactAnalysisService.analyze({
        itemId: assembly.id,
        changeType: 'revision',
        direction: 'downstream',
      })

      expect(result.impactedItems[0].impactPath).toContain(assembly.itemNumber)
      expect(result.impactedItems[0].impactPath).toContain(child.itemNumber)
    })
  })
})
