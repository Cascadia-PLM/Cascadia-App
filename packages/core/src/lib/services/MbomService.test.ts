// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * MbomService — deriving a Manufacturing design from an Engineering one.
 *
 * Gate 1, whole-design multi-entity copy: one call creates a design, a branch,
 * a commit, an item per source part, a version row per item, a BOM edge per
 * source edge, and an EBOM_SOURCE link per item — inside one transaction, with
 * nothing that reports a partial copy. A dropped relationship or a
 * usage pointer aimed at the wrong row is silent: the MBOM looks complete and
 * is missing a level.
 *
 * These tests assert database state after the copy, not the shape of the calls
 * that produced it, and match error classes rather than messages.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { ItemService } from '../items/services/ItemService'
import { EBOM_SOURCE_RELATIONSHIP, MbomService } from './MbomService'
import { DesignService } from './DesignService'
import { BranchService } from './BranchService'
import { LifecycleService } from './LifecycleService'
import { WorkInstructionInheritanceService } from './WorkInstructionInheritanceService'
import type { Part } from '@/lib/items/types/part'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { seedStandardPartLifecycle } from '@/__tests__/fixtures/lifecycles'
import { takeFirst } from '@/lib/db/take-first'
import { NotFoundError, ValidationError } from '@/lib/errors'
import {
  itemRelationships,
  items,
  programs,
  upstreamChanges,
  workInstructionPartAttachments,
} from '@/lib/db/schema'

// Register item types so ItemService.create knows about Part
import '@/lib/items/registerItemTypes.server'

describe('MbomService', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let programId: string
  let sourceDesignId: string
  let sourceDesignCode: string
  let unique: string

  beforeAll(async () => {
    await testDb.setup()
    await seedStandardPartLifecycle(testDb.db)
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  /**
   * A source Engineering design with a two-level BOM: one assembly over two
   * children. Small enough to count by hand, deep enough that a dropped edge
   * shows up.
   */
  async function seedEngineeringDesign() {
    await testDb.beginTransaction()

    user = await insertTestUser(testDb.db)
    unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`

    const program = takeFirst(
      await testDb.db
        .insert(programs)
        .values({
          name: 'MBOM Test Program',
          code: `PROG-${unique}`,
          createdBy: user.id,
        })
        .returning(),
    )
    programId = program.id

    sourceDesignCode = `EBOM-${unique}`
    const design = await DesignService.create(
      {
        programId,
        name: 'Source EBOM',
        code: sourceDesignCode,
        designType: 'Engineering',
      },
      user.id,
    )
    sourceDesignId = design.id!
  }

  let partCounter = 0
  async function createPart(name: string, suffix?: string) {
    partCounter++
    const itemNumber = suffix ?? `P${partCounter}-${sourceDesignCode}`
    return ItemService.create<Part>(
      'Part',
      {
        itemNumber,
        revision: 'A',
        name,
        itemType: 'Part',
        designId: sourceDesignId,
      },
      user.id,
    )
  }

  async function addBomEdge(parentId: string, childId: string, quantity = '2') {
    await testDb.db.insert(itemRelationships).values({
      sourceId: parentId,
      targetId: childId,
      relationshipType: 'BOM',
      quantity,
      sourceDesignId,
      targetDesignId: sourceDesignId,
      createdBy: user.id,
      modifiedBy: user.id,
    })
  }

  /** Assembly + two children, all on the source design's main branch. */
  async function seedTwoLevelBom() {
    const assembly = await createPart('Assembly')
    const childA = await createPart('Child A')
    const childB = await createPart('Child B')
    await addBomEdge(assembly.id!, childA.id!)
    await addBomEdge(assembly.id!, childB.id!, '1')
    return { assembly, childA, childB }
  }

  function createMbom(overrides: Record<string, unknown> = {}) {
    return MbomService.createFromEbom(
      {
        sourceDesignId,
        name: 'Derived MBOM',
        code: `MBOM-${unique}`,
        copyBomStructure: true,
        linkToSource: true,
        renumberItems: true,
        ...overrides,
      },
      user.id,
    )
  }

  describe('createFromEbom — copy fidelity', () => {
    it('copies every source item and every BOM edge, and says how many', async () => {
      await seedEngineeringDesign()
      await seedTwoLevelBom()

      const result = await createMbom()

      expect(result.itemsCopied).toBe(3)
      expect(result.relationshipsCopied).toBe(2)

      const copied = await testDb.db
        .select()
        .from(items)
        .where(eq(items.designId, result.design.id))
      expect(copied).toHaveLength(3)

      const copiedIds = copied.map((row) => row.id)
      // Queried by copied item id rather than by design: the copy leaves
      // `sourceDesignId`/`targetDesignId` null on BOM edges (it fills them
      // only on the EBOM_SOURCE links). Nothing reads those columns for BOM
      // edges today, so this pins the copy rather than the scoping.
      const allEdges = await testDb.db
        .select()
        .from(itemRelationships)
        .where(eq(itemRelationships.relationshipType, 'BOM'))
      const edges = allEdges.filter((e) => copiedIds.includes(e.sourceId))
      expect(edges).toHaveLength(2)
      // Both ends of every copied edge are inside the MBOM — an edge still
      // pointing at an EBOM row would render as structure the MBOM does not
      // actually own.
      for (const edge of edges) {
        expect(copiedIds).toContain(edge.sourceId)
        expect(copiedIds).toContain(edge.targetId)
      }
      // Quantities survive the copy: a BOM whose quantities reset to 1 is
      // worse than no BOM. (The column is numeric, so they read back scaled.)
      expect(edges.map((e) => e.quantity).sort()).toEqual(['1.000', '2.000'])
    })

    it('points every copied item at the source it came from, unreleased and initial', async () => {
      await seedEngineeringDesign()
      const { assembly, childA, childB } = await seedTwoLevelBom()
      const sourceIds = [assembly.id, childA.id, childB.id]

      const result = await createMbom()

      const copied = await testDb.db
        .select()
        .from(items)
        .where(eq(items.designId, result.design.id))

      const initialState = await LifecycleService.getInitialStateId('Part')
      for (const row of copied) {
        expect(sourceIds).toContain(row.usageOf)
        expect(row.revision).toBe('-')
        expect(row.state).toBe(initialState)
        expect(row.isCurrent).toBe(true)
        // A fresh identity, not the source's — sharing a masterId would make
        // the MBOM item look like another version of the EBOM part.
        expect(sourceIds).not.toContain(row.masterId)
      }
    })

    it('creates the design, its main branch and an initial commit', async () => {
      await seedEngineeringDesign()
      await seedTwoLevelBom()

      const result = await createMbom()

      expect(result.design.designType).toBe('Manufacturing')
      expect(result.design.sourceDesignId).toBe(sourceDesignId)
      expect(result.mainBranch.branchType).toBe('main')
      expect(result.mainBranch.headCommitId).toBe(result.initialCommit.id)
      expect(result.initialCommit.branchId).toBe(result.mainBranch.id)

      // The design's default branch pointer is set, not left null — the
      // whole version layer resolves through it.
      const stored = await DesignService.getById(result.design.id)
      expect(stored?.defaultBranchId).toBe(result.mainBranch.id)

      const mainBranch = await BranchService.getMainBranch(result.design.id)
      expect(mainBranch?.id).toBe(result.mainBranch.id)
    })

    it('copies one item per item number, never a duplicate', async () => {
      await seedEngineeringDesign()
      const first = await createPart('Rev A', `TWIN-${sourceDesignCode}`)
      // A second current row under the same item number, on its own master —
      // two rows version resolution has no reason to collapse. A duplicate
      // here becomes two lines on the shop floor for one part.
      await testDb.db.insert(items).values({
        masterId: crypto.randomUUID(),
        designId: sourceDesignId,
        itemNumber: `TWIN-${sourceDesignCode}`,
        revision: 'B',
        itemType: 'Part',
        name: 'Rev B',
        state: first.state ?? '',
        isCurrent: true,
        createdBy: user.id,
        modifiedBy: user.id,
      })

      const result = await createMbom()

      const copied = await testDb.db
        .select()
        .from(items)
        .where(eq(items.designId, result.design.id))
      expect(copied).toHaveLength(1)
      // Deliberately not asserting *which* revision. `copyEbomStructureInternal`
      // has a highest-revision tie-break for two current rows under one item
      // number, and this seed does not reach it: version resolution scopes the
      // copy to what the branch actually tracks, so the unregistered second row
      // never arrives. The tie-break is defensive, and this test says so rather
      // than pinning a branch it cannot enter.
    })

    it('copies nothing when copyBomStructure is false', async () => {
      await seedEngineeringDesign()
      await seedTwoLevelBom()

      const result = await createMbom({ copyBomStructure: false })

      expect(result.itemsCopied).toBe(0)
      expect(result.relationshipsCopied).toBe(0)
      expect(result.sourceLinks).toBe(0)
      const copied = await testDb.db
        .select()
        .from(items)
        .where(eq(items.designId, result.design.id))
      expect(copied).toHaveLength(0)
    })
  })

  describe('createFromEbom — renumbering', () => {
    it('swaps the design-code suffix when the item number carries one', async () => {
      await seedEngineeringDesign()
      await createPart('Suffixed', `WIDGET-${sourceDesignCode}`)

      const result = await createMbom()

      const [copied] = await testDb.db
        .select()
        .from(items)
        .where(eq(items.designId, result.design.id))
      expect(copied?.itemNumber).toBe(`WIDGET-MBOM-${unique}`)
    })

    it('leaves an item number that does not end in the source code alone', async () => {
      await seedEngineeringDesign()
      await createPart('Unsuffixed', `STANDALONE-${unique}`)

      const result = await createMbom()

      const [copied] = await testDb.db
        .select()
        .from(items)
        .where(eq(items.designId, result.design.id))
      expect(copied?.itemNumber).toBe(`STANDALONE-${unique}`)
    })

    it('leaves every item number alone when renumberItems is false', async () => {
      await seedEngineeringDesign()
      await createPart('Suffixed', `WIDGET-${sourceDesignCode}`)

      const result = await createMbom({ renumberItems: false })

      const [copied] = await testDb.db
        .select()
        .from(items)
        .where(eq(items.designId, result.design.id))
      expect(copied?.itemNumber).toBe(`WIDGET-${sourceDesignCode}`)
    })
  })

  describe('createFromEbom — EBOM_SOURCE links', () => {
    it('writes one link per copied item when linkToSource is true', async () => {
      await seedEngineeringDesign()
      await seedTwoLevelBom()

      const result = await createMbom({ linkToSource: true })

      expect(result.sourceLinks).toBe(3)
      const links = await testDb.db
        .select()
        .from(itemRelationships)
        .where(
          and(
            eq(itemRelationships.targetDesignId, result.design.id),
            eq(itemRelationships.relationshipType, EBOM_SOURCE_RELATIONSHIP),
          ),
        )
      expect(links).toHaveLength(3)
      // Direction is definition → usage, and the domains say which side is
      // which — the cross-domain queries read both.
      for (const link of links) {
        expect(link.sourceDomain).toBe('engineering')
        expect(link.targetDomain).toBe('manufacturing')
        expect(link.sourceDesignId).toBe(sourceDesignId)
      }
    })

    it('writes none when linkToSource is false', async () => {
      await seedEngineeringDesign()
      await seedTwoLevelBom()

      const result = await createMbom({ linkToSource: false })

      expect(result.sourceLinks).toBe(0)
      expect(result.itemsCopied).toBe(3)
      const links = await testDb.db
        .select()
        .from(itemRelationships)
        .where(
          and(
            eq(itemRelationships.targetDesignId, result.design.id),
            eq(itemRelationships.relationshipType, EBOM_SOURCE_RELATIONSHIP),
          ),
        )
      expect(links).toHaveLength(0)
    })
  })

  /**
   * Work instruction inheritance — the traveler baseline.
   *
   * A work order's traveler is built by walking the MBOM and instantiating
   * every work instruction attached to every part in the tree, so these
   * attachment rows are what the shop floor eventually executes. A missed copy
   * silently drops a procedure from the traveler; a duplicated one has the
   * operator run it twice. `createFromEbom` swallows inheritance failures so
   * they never block MBOM creation — it logs a warning and reports
   * `instructionsInherited`, but the rows themselves are the truth these
   * assertions read.
   */
  describe('createFromEbom — work instruction inheritance', () => {
    /**
     * A work instruction authored against `outputPartId`. Creation also writes
     * the WI's own `isOutput` attachment on that part, and that one carries
     * `inheritToMBOM` false — so every work instruction arrives with a
     * flag-off attachment already in place.
     */
    async function createWorkInstruction(name: string, outputPartId: string) {
      return (await ItemService.create(
        'WorkInstruction',
        {
          designId: sourceDesignId,
          revision: 'A',
          name,
          outputPartId,
        } as never,
        user.id,
      )) as { id: string }
    }

    async function attach(
      workInstructionId: string,
      partId: string,
      inheritToMBOM: boolean,
    ) {
      return takeFirst(
        await testDb.db
          .insert(workInstructionPartAttachments)
          .values({
            workInstructionId,
            partId,
            inheritToMBOM,
            createdBy: user.id,
          })
          .returning(),
      )
    }

    function attachmentsOn(partId: string) {
      return testDb.db
        .select()
        .from(workInstructionPartAttachments)
        .where(eq(workInstructionPartAttachments.partId, partId))
    }

    /** Every attachment sitting on a part inside the given design. */
    async function attachmentsIn(designId: string) {
      const rows = await testDb.db
        .select({ attachment: workInstructionPartAttachments })
        .from(workInstructionPartAttachments)
        .innerJoin(items, eq(items.id, workInstructionPartAttachments.partId))
        .where(eq(items.designId, designId))
      return rows.map((row) => row.attachment)
    }

    /** The MBOM usage derived from a given EBOM item. */
    async function twinOf(sourceItemId: string, mbomDesignId: string) {
      return takeFirst(
        await testDb.db
          .select()
          .from(items)
          .where(
            and(
              eq(items.designId, mbomDesignId),
              eq(items.usageOf, sourceItemId),
            ),
          ),
        'MBOM twin',
      )
    }

    function sync(mbomDesignId: string) {
      return WorkInstructionInheritanceService.syncInheritedAttachments(
        sourceDesignId,
        mbomDesignId,
        user.id,
      )
    }

    it('copies a flagged attachment onto the MBOM twin exactly once, with provenance', async () => {
      await seedEngineeringDesign()
      const { assembly, childA } = await seedTwoLevelBom()
      const wi = await createWorkInstruction('Press-fit bearing', assembly.id!)
      const source = await attach(wi.id, childA.id!, true)

      const result = await createMbom()

      const twin = await twinOf(childA.id!, result.design.id)
      const copies = await attachmentsOn(twin.id)
      expect(copies).toHaveLength(1)
      const copy = takeFirst(copies)
      expect(copy.workInstructionId).toBe(wi.id)
      // Provenance, so a later reader can tell an inherited row from one an
      // MBOM planner attached by hand.
      expect(copy.inheritedFromId).toBe(source.id)
      // The copy does not cascade further, and it is not an output part — the
      // procedure still builds the EBOM part it was authored against.
      expect(copy.inheritToMBOM).toBe(false)
      expect(copy.isOutput).toBe(false)

      // The EBOM side is read, never rewritten.
      const stillFlagged = takeFirst(await attachmentsOn(childA.id!))
      expect(stillFlagged.inheritToMBOM).toBe(true)
    })

    it('copies nothing for an attachment whose inheritToMBOM flag is off', async () => {
      await seedEngineeringDesign()
      const { assembly, childA } = await seedTwoLevelBom()
      const wi = await createWorkInstruction('Torque check', assembly.id!)
      await attach(wi.id, childA.id!, false)

      const result = await createMbom()

      // Neither the explicit flag-off attachment on the child nor the WI's own
      // output-part attachment on the assembly reaches the MBOM: inheritance
      // is opt-in per attachment, and an MBOM that inherits every procedure
      // its EBOM ever carried is a traveler nobody can trust.
      const childTwin = await twinOf(childA.id!, result.design.id)
      const assemblyTwin = await twinOf(assembly.id!, result.design.id)
      expect(await attachmentsOn(childTwin.id)).toHaveLength(0)
      expect(await attachmentsOn(assemblyTwin.id)).toHaveLength(0)
      expect(await attachmentsIn(result.design.id)).toHaveLength(0)
    })

    it('leaves a flagged attachment alone when the source part has no MBOM twin', async () => {
      await seedEngineeringDesign()
      const { assembly, childA } = await seedTwoLevelBom()
      const wi = await createWorkInstruction('Bond gasket', assembly.id!)

      const result = await createMbom()

      // Two flagged attachments added after the MBOM was derived: one on a
      // part the MBOM has a twin for, one on a part created afterwards, which
      // it does not. Both, so the sync has to do its work and still leave the
      // second alone — the failure mode worth guarding is not "nothing
      // happened" but "copied onto whichever MBOM part answered the lookup".
      await attach(wi.id, childA.id!, true)
      const latecomer = await createPart('Added after the split')
      await attach(wi.id, latecomer.id!, true)

      const { synced } = await sync(result.design.id)

      expect(synced).toBe(1)
      const copies = await attachmentsIn(result.design.id)
      expect(copies).toHaveLength(1)
      const childTwin = await twinOf(childA.id!, result.design.id)
      expect(takeFirst(copies).partId).toBe(childTwin.id)
    })

    it('re-syncing an unchanged MBOM inserts nothing and reports nothing', async () => {
      await seedEngineeringDesign()
      const { assembly, childA } = await seedTwoLevelBom()
      const wi = await createWorkInstruction('Install bushing', assembly.id!)

      const result = await createMbom()

      // The case the manual re-sync exists for: a work instruction attached to
      // an EBOM part after the MBOM was derived.
      await attach(wi.id, childA.id!, true)

      const first = await sync(result.design.id)
      expect(first.synced).toBe(1)
      expect(await attachmentsIn(result.design.id)).toHaveLength(1)

      const second = await sync(result.design.id)

      // The unique constraint already made the second pass a no-op in the
      // database; the count used to claim otherwise, because it counted
      // insert attempts rather than rows written. Anyone watching that number
      // would have seen copies that never happened.
      expect(second.synced).toBe(0)
      expect(await attachmentsIn(result.design.id)).toHaveLength(1)
    })
  })

  describe('createFromEbom — validation', () => {
    it('refuses a source design that is not Engineering', async () => {
      await seedEngineeringDesign()
      // `DesignService.create` will not mint a Manufacturing design — the only
      // way to have one is to derive it, so an MBOM of an MBOM is the case
      // this guard actually has to catch.
      const derived = await createMbom()

      await expect(
        MbomService.createFromEbom(
          {
            sourceDesignId: derived.design.id,
            name: 'Derived twice',
            code: `MBOM2-${unique}`,
            copyBomStructure: true,
            linkToSource: true,
            renumberItems: true,
          },
          user.id,
        ),
      ).rejects.toThrow(ValidationError)
    })

    it('refuses a code another design already holds', async () => {
      await seedEngineeringDesign()

      await expect(createMbom({ code: sourceDesignCode })).rejects.toThrow(
        ValidationError,
      )
    })

    it('refuses a tag belonging to a different design', async () => {
      await seedEngineeringDesign()
      const other = await DesignService.create(
        {
          programId,
          name: 'Other EBOM',
          code: `OTHER-${unique}`,
          designType: 'Engineering',
        },
        user.id,
      )
      const tag = await DesignService.createTag(
        other.id,
        { name: `v1-${unique}`, tagType: 'baseline' },
        user.id,
      )

      await expect(createMbom({ sourceTagId: tag.id })).rejects.toThrow(
        ValidationError,
      )
    })

    it('reports a missing source design as not found', async () => {
      await seedEngineeringDesign()

      await expect(
        MbomService.createFromEbom(
          {
            sourceDesignId: '00000000-0000-0000-0000-000000000000',
            name: 'Derived',
            code: `MBOM3-${unique}`,
            copyBomStructure: true,
            linkToSource: true,
            renumberItems: true,
          },
          user.id,
        ),
      ).rejects.toThrow(NotFoundError)
    })
  })

  describe('upstream change review', () => {
    async function insertUpstreamChange() {
      const mbom = await createMbom()
      return {
        mbom,
        change: takeFirst(
          await testDb.db
            .insert(upstreamChanges)
            .values({
              targetDesignId: mbom.design.id,
              sourceDesignId,
              sourceCommitId: mbom.initialCommit.id,
              changedItems: [
                {
                  masterId: crypto.randomUUID(),
                  itemNumber: 'P1',
                  name: 'Child A',
                  itemType: 'Part',
                  previousRevision: 'A',
                  newRevision: 'B',
                  changeType: 'modified' as const,
                },
              ],
              status: 'pending',
            })
            .returning(),
        ),
      }
    }

    it.each([
      ['accept', 'accepted'],
      ['reject', 'rejected'],
      ['defer', 'deferred'],
    ] as const)(
      'maps %s to %s and records the reviewer',
      async (action, status) => {
        await seedEngineeringDesign()
        await seedTwoLevelBom()
        const { change } = await insertUpstreamChange()

        const result = await MbomService.reviewUpstreamChange(
          change.id,
          { action, notes: 'looked at it' },
          user.id,
        )

        expect(result).toEqual({ success: true, status })
        const [stored] = await testDb.db
          .select()
          .from(upstreamChanges)
          .where(eq(upstreamChanges.id, change.id))
        expect(stored?.status).toBe(status)
        expect(stored?.reviewedBy).toBe(user.id)
        expect(stored?.reviewedAt).toBeInstanceOf(Date)
        expect(stored?.reviewNotes).toBe('looked at it')
      },
    )

    it('reports an unknown change id as not found', async () => {
      await seedEngineeringDesign()

      await expect(
        MbomService.reviewUpstreamChange(
          '00000000-0000-0000-0000-000000000000',
          { action: 'accept' },
          user.id,
        ),
      ).rejects.toThrow(NotFoundError)
    })
  })

  describe('checkUpstreamChanges', () => {
    it('reports nothing while the source head is the commit the MBOM derived from', async () => {
      await seedEngineeringDesign()
      await seedTwoLevelBom()
      const result = await createMbom()

      const changes = await MbomService.checkUpstreamChanges(result.design.id)

      expect(changes).toEqual([])
    })

    it('refuses to answer for a design that is not a Manufacturing one', async () => {
      await seedEngineeringDesign()

      await expect(
        MbomService.checkUpstreamChanges(sourceDesignId),
      ).rejects.toThrow(ValidationError)
    })

    it('reports a missing design as not found', async () => {
      await seedEngineeringDesign()

      await expect(
        MbomService.checkUpstreamChanges(
          '00000000-0000-0000-0000-000000000000',
        ),
      ).rejects.toThrow(NotFoundError)
    })
  })

  describe('derived-design lookup', () => {
    it('lists the MBOMs derived from a source design', async () => {
      await seedEngineeringDesign()
      await seedTwoLevelBom()
      const result = await createMbom()

      const derived = await MbomService.getDerivedDesigns(sourceDesignId)

      expect(derived.map((d) => d.id)).toContain(result.design.id)
    })

    it('classifies both designs by their own type', async () => {
      await seedEngineeringDesign()
      const result = await createMbom()

      expect(await MbomService.isEngineeringDesign(sourceDesignId)).toBe(true)
      expect(await MbomService.isManufacturingDesign(sourceDesignId)).toBe(
        false,
      )
      expect(await MbomService.isManufacturingDesign(result.design.id)).toBe(
        true,
      )
      expect(await MbomService.isEngineeringDesign(result.design.id)).toBe(
        false,
      )
    })
  })
})
