// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * MaterializationService Tests
 *
 * Data-integrity tests for materializing a design session into real PLM data.
 * The invariants under test:
 * - The executed behavior matches the plan shown in the preview
 *   (same mode, same target, same counts).
 * - Every created item lands in the 'Draft' state on the target design.
 * - For a released (branch-protected) design, an ECO is created and the new
 *   items land on its branch as 'added' working copies — main stays untouched.
 *
 * Run: npx vitest run src/design-engine/materialize.test.ts
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { MaterializationService } from './materialize'
import { DesignSessionService } from './session-service'
import type { DesignSession } from './session-service'
import type {
  BomDraft,
  DesignArtifacts,
  MaterializationJournal,
  MaterializationResult,
} from './types'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { BaseItem } from '@/items/types/base'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { DesignService } from '@/services/DesignService'
import { ConflictError } from '@/errors'
import { ItemService } from '@/items/services/ItemService'
import {
  branchItems,
  branches,
  changeOrderAffectedItems,
  changeOrderDesigns,
  designs,
  itemRelationships,
  items,
  programs,
} from '@/db/schema'
import {
  lifecycleDefinitions,
  lifecycleInstances,
} from '@/db/schema/lifecycles'
import {
  SYSTEM_USER_ID,
  overrideItemTypeConfig,
  seedStandardPartLifecycle,
} from '@/__tests__/fixtures/lifecycles'

// Import to register item types
import '@/items/registerItemTypes.server'

// Unique ECO workflow definition ID for this test file, so it doesn't race with
// other test files that seed their own ChangeOrder workflows against the shared DB.
const CHANGE_ORDER_WORKFLOW_ID = '00000000-0000-4000-8000-0000000001d3'

// Minimal ChangeOrder workflow so ChangeOrderService.autoStartWorkflow() can
// start an instance in the initial (Draft) state during eco_required materialization.
const changeOrderWorkflowDefinition = {
  states: [
    { id: 'Draft', name: 'Draft', isInitial: true, isFinal: false },
    { id: 'InReview', name: 'InReview', isInitial: false, isFinal: false },
    {
      id: 'Approved',
      name: 'Approved',
      isInitial: false,
      isFinal: true,
      finalKind: 'release',
    },
  ],
  transitions: [
    { id: 't1', name: 'Submit', fromStateId: 'Draft', toStateId: 'InReview' },
    {
      id: 't2',
      name: 'Approve',
      fromStateId: 'InReview',
      toStateId: 'Approved',
    },
  ],
  applicableItemTypes: ['ChangeOrder'],
}

function buildArtifacts(): DesignArtifacts {
  const bom: BomDraft = {
    rootAssembly: {
      tempId: 'asm-1',
      name: 'Bracket Assembly',
      isNew: true,
      quantity: 1,
      partType: 'Manufacture',
      children: [
        {
          tempId: 'part-1',
          name: 'Base Plate',
          isNew: true,
          quantity: 1,
          partType: 'Manufacture',
          material: 'Aluminum 6061',
          children: [],
          requirementTempIds: ['req-1'],
          rationale: 'Structural base',
          confidence: 0.9,
        },
        {
          tempId: 'part-2',
          name: 'M4 Screw',
          isNew: true,
          quantity: 4,
          partType: 'Purchase',
          children: [],
          requirementTempIds: [],
          rationale: 'Fastening',
          confidence: 0.95,
        },
      ],
      requirementTempIds: ['req-1'],
      rationale: 'Top-level assembly',
      confidence: 0.9,
    },
    proposedParts: [],
    requirementsCoverage: { 'req-1': ['part-1'] },
    uncoveredRequirements: [],
    validationIssues: [],
  }

  return {
    description: 'A bracket assembly for mounting sensors',
    requirements: [
      {
        tempId: 'req-1',
        name: 'Holds 1kg load',
        description: 'The assembly must support a 1kg load',
        requirementType: 'Functional',
        priority: 'high',
        verificationMethod: 'Test',
        rationale: 'Primary use case',
        confidence: 0.9,
        source: 'ai',
      },
    ],
    bom,
    clarifications: [],
    userMessages: [],
  }
}

describe('MaterializationService', () => {
  const testDb = new TestDatabase()
  let restoreItemTypeConfig: (() => Promise<void>) | undefined
  let user: TestUser
  let programId: string

  beforeAll(async () => {
    await testDb.setup()

    // System user + Part lifecycle (gives Parts a 'release' action from Draft).
    await seedStandardPartLifecycle(testDb.db)

    // Seed a ChangeOrder workflow and point the ChangeOrder item type at it so
    // autoStartWorkflow() resolves a workflow for the ECO change type.
    await testDb.db
      .insert(lifecycleDefinitions)
      .values({
        id: CHANGE_ORDER_WORKFLOW_ID,
        name: 'ECO - Materialize Test Workflow',
        version: 1,
        workflowType: 'strict',
        definition: changeOrderWorkflowDefinition,
        isActive: true,
        lifecycleType: 'Driving',
      })
      .onConflictDoNothing()

    const changeOrderConfig = {
      lifecycleDefinitionId: CHANGE_ORDER_WORKFLOW_ID,
      lifecyclesByChangeType: {
        ECO: CHANGE_ORDER_WORKFLOW_ID,
        ECN: CHANGE_ORDER_WORKFLOW_ID,
        Deviation: CHANGE_ORDER_WORKFLOW_ID,
        MCO: CHANGE_ORDER_WORKFLOW_ID,
      },
    }
    restoreItemTypeConfig = await overrideItemTypeConfig(
      testDb.db,
      'ChangeOrder',
      changeOrderConfig,
      SYSTEM_USER_ID,
    )
  })

  afterAll(async () => {
    // Shared row: put back what this suite found before it wrote.
    await restoreItemTypeConfig?.()
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()

    user = await insertTestUser(testDb.db)

    const [program] = await testDb.db
      .insert(programs)
      .values({
        name: 'Sensor Platform',
        code: `PROG-${Date.now()}`,
        createdBy: user.id,
      })
      .returning()
    programId = program!.id
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  async function createSession(designId?: string): Promise<DesignSession> {
    const session = await DesignSessionService.create(user.id, {
      description: 'A bracket assembly for mounting sensors',
      programId,
      designId,
    })
    const artifacts = buildArtifacts()
    await DesignSessionService.updateArtifacts(session.id, artifacts)
    return { ...session, artifacts }
  }

  it('creates a new design with all items in Draft on main, matching the previewed plan', async () => {
    const session = await createSession()

    const preview = await MaterializationService.preview(session)
    expect(preview.plan.mode).toBe('create_design')
    expect(preview.plan.supported).toBe(true)
    expect(preview.plan.initialState).toBe('Draft')
    expect(preview.plan.targetBranch).toBe('main')
    expect(preview.plan.programName).toBe('Sensor Platform')
    expect(preview.newPartsCount).toBe(3)
    expect(preview.newRequirementsCount).toBe(1)
    expect(preview.bomRelationshipsCount).toBe(2)

    const result = await MaterializationService.execute(session, user.id)

    // Execution matches the previewed plan
    expect(result.mode).toBe(preview.plan.mode)
    expect(result.initialState).toBe('Draft')
    expect(result.createdItems).toHaveLength(
      preview.newPartsCount + preview.newRequirementsCount,
    )
    expect(result.bomRelationshipsCreated).toBe(preview.bomRelationshipsCount)

    // A new design exists in the session's program
    const [design] = await testDb.db
      .select()
      .from(designs)
      .where(eq(designs.id, result.designId))
    expect(design).toBeDefined()
    expect(design!.programId).toBe(programId)
    expect(result.designName).toBe(design!.name)

    // Invariant: every created item is in Draft state on the new design
    const createdIds = result.createdItems.map((i) => i.itemId)
    const createdRows = await testDb.db
      .select()
      .from(items)
      .where(inArray(items.id, createdIds))
    expect(createdRows).toHaveLength(createdIds.length)
    for (const row of createdRows) {
      expect(row.state).toBe('Draft')
      expect(row.designId).toBe(result.designId)
    }

    // BOM relationships persisted between the created parts
    const rels = await testDb.db
      .select()
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.relationshipType, 'BOM'),
          inArray(itemRelationships.sourceId, createdIds),
        ),
      )
    expect(rels).toHaveLength(preview.bomRelationshipsCount)

    // Session is completed and points at the materialized design
    const fresh = await DesignSessionService.getById(session.id)
    expect(fresh?.materializedDesignId).toBe(result.designId)
    expect(fresh?.status).toBe('completed')
  })

  it('never materializes a rejected requirement', async () => {
    const session = await createSession()
    const artifacts = session.artifacts!
    artifacts.requirements.push({
      tempId: 'req-rejected',
      name: 'Waterproof to IP68',
      description: 'Full submersion protection',
      requirementType: 'Constraint',
      priority: 'low',
      verificationMethod: 'Test',
      rationale: 'Speculative',
      confidence: 0.4,
      source: 'ai',
      reviewStatus: 'rejected',
      reviewNote: 'Out of scope for v1',
    })
    await DesignSessionService.updateArtifacts(session.id, artifacts)
    const updated = { ...session, artifacts }

    const preview = await MaterializationService.preview(updated)
    expect(preview.newRequirementsCount).toBe(1)
    expect(
      preview.items.find((i) => i.tempId === 'req-rejected'),
    ).toBeUndefined()

    const result = await MaterializationService.execute(updated, user.id)
    expect(
      result.createdItems.find((i) => i.tempId === 'req-rejected'),
    ).toBeUndefined()
    expect(
      result.createdItems.filter((i) => i.itemType === 'Requirement'),
    ).toHaveLength(1)
  })

  it('adds items to an existing pre-release design instead of creating a new one', async () => {
    const design = await DesignService.create(
      {
        programId,
        name: 'Existing Design',
        code: `EX-${Date.now()}`,
        designType: 'Engineering',
      },
      user.id,
    )

    const session = await createSession(design.id)

    const preview = await MaterializationService.preview(session)
    expect(preview.plan.mode).toBe('add_to_design')
    expect(preview.plan.targetDesignId).toBe(design.id)
    expect(preview.plan.targetDesignName).toBe('Existing Design')

    const result = await MaterializationService.execute(session, user.id)
    expect(result.designId).toBe(design.id)
    expect(result.mode).toBe('add_to_design')

    // No additional design was created in the program
    const programDesigns = await testDb.db
      .select({ id: designs.id })
      .from(designs)
      .where(eq(designs.programId, programId))
    expect(programDesigns).toHaveLength(1)

    // All created items are in Draft on the existing design
    const createdIds = result.createdItems.map((i) => i.itemId)
    const createdRows = await testDb.db
      .select()
      .from(items)
      .where(inArray(items.id, createdIds))
    for (const row of createdRows) {
      expect(row.state).toBe('Draft')
      expect(row.designId).toBe(design.id)
    }
  })

  it('materializes into a released design via an ECO, leaving main untouched', async () => {
    const design = await DesignService.create(
      {
        programId,
        name: 'Released Design',
        code: `REL-${Date.now()}`,
        designType: 'Engineering',
      },
      user.id,
    )
    const designId = design.id

    // Release an item to put the design in post-release (protected) phase
    const releasedPart = await ItemService.create<BaseItem>(
      'Part',
      {
        name: 'Released Part',
        revision: 'A',
        itemType: 'Part',
        designId,
      },
      user.id,
    )
    await testDb.db
      .update(items)
      .set({ state: 'Released' })
      .where(eq(items.id, releasedPart.id!))

    const session = await createSession(designId)

    // The plan routes through an ECO (now a supported mode)
    const preview = await MaterializationService.preview(session)
    expect(preview.plan.mode).toBe('eco_required')
    expect(preview.plan.supported).toBe(true)
    expect(preview.plan.ecoName).toBeTruthy()

    const result = await MaterializationService.execute(session, user.id)

    // Result reflects the ECO path
    expect(result.mode).toBe('eco_required')
    expect(result.ecoId).toBeTruthy()
    expect(result.ecoNumber).toBeTruthy()
    expect(result.createdItems).toHaveLength(
      preview.newPartsCount + preview.newRequirementsCount,
    )
    expect(result.bomRelationshipsCreated).toBe(preview.bomRelationshipsCount)

    // The ECO exists as a ChangeOrder item
    const [changeOrder] = await testDb.db
      .select()
      .from(items)
      .where(eq(items.id, result.ecoId!))
    expect(changeOrder).toBeDefined()
    expect(changeOrder!.itemType).toBe('ChangeOrder')

    // A design association with a dedicated ECO branch was created
    const [ecoDesign] = await testDb.db
      .select()
      .from(changeOrderDesigns)
      .where(
        and(
          eq(changeOrderDesigns.changeOrderId, result.ecoId!),
          eq(changeOrderDesigns.designId, designId),
        ),
      )
    expect(ecoDesign).toBeDefined()
    expect(ecoDesign!.branchId).toBeTruthy()
    const changeOrderBranchId = ecoDesign!.branchId!

    const [ecoBranch] = await testDb.db
      .select()
      .from(branches)
      .where(eq(branches.id, changeOrderBranchId))
    expect(ecoBranch!.branchType).toBe('eco')

    // Invariant: every created item is an 'added' working copy on the ECO branch
    const createdIds = result.createdItems.map((i) => i.itemId)
    const createdRows = await testDb.db
      .select()
      .from(items)
      .where(inArray(items.id, createdIds))
    const createdMasterIds = createdRows.map((r) => r.masterId)
    for (const row of createdRows) {
      expect(row.state).toBe('Draft')
    }

    const changeOrderBranchItems = await testDb.db
      .select()
      .from(branchItems)
      .where(
        and(
          eq(branchItems.branchId, changeOrderBranchId),
          inArray(branchItems.itemMasterId, createdMasterIds),
        ),
      )
    expect(changeOrderBranchItems).toHaveLength(createdIds.length)
    for (const bi of changeOrderBranchItems) {
      expect(bi.changeType).toBe('added')
    }

    // Parts are registered on the ECO with the 'release' change action so they
    // show in the Affected Items tab (requirements register too when their
    // lifecycle supports 'release'; that is best-effort and not asserted here).
    const partIds = result.createdItems
      .filter((i) => i.itemType === 'Part')
      .map((i) => i.itemId)
    const affected = await testDb.db
      .select()
      .from(changeOrderAffectedItems)
      .where(eq(changeOrderAffectedItems.changeOrderId, result.ecoId!))
    for (const a of affected) {
      expect(a.changeAction).toBe('release')
    }
    const affectedIds = affected.map((a) => a.affectedItemId)
    for (const partId of partIds) {
      expect(affectedIds).toContain(partId)
    }

    // Invariant: main is untouched — none of the new items are on the main branch
    const [mainBranch] = await testDb.db
      .select()
      .from(branches)
      .where(
        and(eq(branches.designId, designId), eq(branches.branchType, 'main')),
      )
    const mainBranchItems = await testDb.db
      .select()
      .from(branchItems)
      .where(
        and(
          eq(branchItems.branchId, mainBranch!.id),
          inArray(branchItems.itemMasterId, createdMasterIds),
        ),
      )
    expect(mainBranchItems).toHaveLength(0)

    // Session is completed and points at the target design
    const fresh = await DesignSessionService.getById(session.id)
    expect(fresh?.materializedDesignId).toBe(designId)
    expect(fresh?.status).toBe('completed')
  })

  describe('journal-based resume (DE-3)', () => {
    /** Fail the first creation of the named item, then behave normally. */
    function failOnceOn(name: string) {
      const realCreate = ItemService.create.bind(ItemService)
      let failed = false
      return vi
        .spyOn(ItemService, 'create')
        .mockImplementation(async (type, data, userId, opts) => {
          if (!failed && data.name === name) {
            failed = true
            throw new Error(`injected failure creating ${name}`)
          }
          return realCreate(type, data, userId, opts)
        })
    }

    it('resumes a mid-tree failure with no duplicate items or edges, identical to a clean run', async () => {
      const session = await createSession()

      const spy = failOnceOn('M4 Screw')
      // Message match on purpose: this is the sentinel this test injected,
      // and pinning it is how we know the run died where we aimed it.
      await expect(
        MaterializationService.execute(session, user.id),
      ).rejects.toThrow('injected failure')
      spy.mockRestore()

      // The failure is journaled with the completed steps preserved.
      let fresh = await DesignSessionService.getById(session.id)
      const journal = fresh?.materializationJournal
      expect(journal?.status).toBe('failed')
      expect(journal?.designId).toBeTruthy()
      expect(Object.keys(journal?.items ?? {}).length).toBeGreaterThan(0)

      // Re-run: resumes from the journal.
      const result = await MaterializationService.execute(session, user.id)

      // Identical to a clean single run: 3 parts + 1 requirement, 2 edges.
      expect(result.createdItems).toHaveLength(4)
      expect(result.bomRelationshipsCreated).toBe(2)

      // No duplicates in the database: every created name appears once.
      const rows = await testDb.db
        .select({ id: items.id, name: items.name })
        .from(items)
        .where(eq(items.designId, result.designId))
      const names = rows.map((r) => r.name).sort()
      expect(names).toEqual([
        'Base Plate',
        'Bracket Assembly',
        'Holds 1kg load',
        'M4 Screw',
      ])

      const createdIds = rows.map((r) => r.id)
      const rels = await testDb.db
        .select()
        .from(itemRelationships)
        .where(
          and(
            eq(itemRelationships.relationshipType, 'BOM'),
            inArray(itemRelationships.sourceId, createdIds),
          ),
        )
      expect(rels).toHaveLength(2)

      // Success cleared the journal; only one design was created.
      fresh = await DesignSessionService.getById(session.id)
      expect(fresh?.materializationJournal).toBeNull()
      expect(fresh?.status).toBe('completed')
      const programDesigns = await testDb.db
        .select({ id: designs.id })
        .from(designs)
        .where(eq(designs.programId, programId))
      expect(programDesigns).toHaveLength(1)
    })

    it('resumes an eco_required failure with exactly one ECO and one workflow start', async () => {
      const design = await DesignService.create(
        {
          programId,
          name: 'Released Design',
          code: `RELJ-${Date.now()}`,
          designType: 'Engineering',
        },
        user.id,
      )
      const releasedPart = await ItemService.create<BaseItem>(
        'Part',
        {
          name: 'Released Part',
          revision: 'A',
          itemType: 'Part',
          designId: design.id,
        },
        user.id,
      )
      await testDb.db
        .update(items)
        .set({ state: 'Released' })
        .where(eq(items.id, releasedPart.id!))

      const session = await createSession(design.id)

      // Fail on the first materialized item — after the ECO, its workflow,
      // and its branch already exist. On the ECO path items go through
      // createOnBranch, so the injection lives there.
      const realCreateOnBranch = ItemService.createOnBranch.bind(ItemService)
      let injected = false
      const spy = vi
        .spyOn(ItemService, 'createOnBranch')
        .mockImplementation(async (type, data, branchId, message, userId) => {
          if (!injected && data.name === 'Holds 1kg load') {
            injected = true
            throw new Error('injected failure creating Holds 1kg load')
          }
          return realCreateOnBranch(type, data, branchId, message, userId)
        })
      // Message match on purpose: this is the sentinel this test injected,
      // and pinning it is how we know the run died where we aimed it.
      await expect(
        MaterializationService.execute(session, user.id),
      ).rejects.toThrow('injected failure')
      spy.mockRestore()

      const journal = (await DesignSessionService.getById(session.id))
        ?.materializationJournal
      expect(journal?.status).toBe('failed')
      expect(journal?.ecoId).toBeTruthy()
      expect(journal?.ecoWorkflowStarted).toBe(true)
      expect(journal?.ecoBranchId).toBeTruthy()

      const result = await MaterializationService.execute(session, user.id)
      expect(result.ecoId).toBe(journal?.ecoId)
      expect(result.createdItems).toHaveLength(4)

      // Exactly one ChangeOrder exists for this materialization.
      const changeOrderRows = await testDb.db
        .select({ id: items.id })
        .from(items)
        .where(
          and(eq(items.itemType, 'ChangeOrder'), eq(items.createdBy, user.id)),
        )
      expect(changeOrderRows).toHaveLength(1)
    })

    it('a concurrent double-execute admits exactly one run', async () => {
      const session = await createSession()

      const outcomes = await Promise.allSettled([
        MaterializationService.execute(session, user.id),
        MaterializationService.execute(session, user.id),
      ])

      const rejected = outcomes.filter((o) => o.status === 'rejected')
      expect(outcomes.length - rejected.length).toBe(1)
      expect(rejected).toHaveLength(1)
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        ConflictError,
      )

      // The winner produced one complete tree, no duplicates.
      const fresh = await DesignSessionService.getById(session.id)
      expect(fresh?.status).toBe('completed')
      const rows = await testDb.db
        .select({ name: items.name })
        .from(items)
        .where(eq(items.designId, fresh!.materializedDesignId!))
      expect(rows).toHaveLength(4)
    })

    it('takes over a stale running journal instead of refusing forever', async () => {
      const session = await createSession()

      // A crashed run left a 'running' journal past the staleness window.
      await DesignSessionService.saveMaterializationJournal(session.id, {
        status: 'running',
        startedAt: new Date(
          Date.now() -
            DesignSessionService.MATERIALIZATION_CLAIM_STALE_MS -
            60_000,
        ).toISOString(),
        items: {},
        relationships: [],
      })

      const result = await MaterializationService.execute(session, user.id)
      expect(result.createdItems).toHaveLength(4)
      expect(
        (await DesignSessionService.getById(session.id))
          ?.materializationJournal,
      ).toBeNull()
    })
  })

  describe('crash-window reconciliation (AI2-5)', () => {
    /**
     * Rewind a session to the state a crash *between* a step's database write
     * and its journal write leaves behind: the rows are all committed, but
     * the journal has never heard of the named steps.
     *
     * That window is what the journal alone cannot cover — it records the
     * steps that completed, so a step it omits is indistinguishable from one
     * that never ran. Building the journal back from a real run's result and
     * then deleting entries reproduces exactly that ambiguity, without having
     * to kill a process mid-transaction.
     */
    async function rewindJournal(
      sessionId: string,
      result: MaterializationResult,
      forget: {
        items?: Array<string>
        relationships?: Array<string>
        eco?: boolean
      },
    ): Promise<void> {
      const forgottenItems = forget.items ?? []
      const journal: MaterializationJournal = {
        status: 'failed',
        startedAt: new Date().toISOString(),
        designId: result.designId,
        designName: result.designName ?? null,
        ...(forget.eco
          ? {}
          : {
              ecoId: result.ecoId,
              ecoNumber: result.ecoNumber,
              ecoWorkflowStarted: result.ecoId !== undefined,
            }),
        items: Object.fromEntries(
          result.createdItems
            .filter((i) => !forgottenItems.includes(i.tempId))
            .map((i) => [
              i.tempId,
              {
                itemId: i.itemId,
                itemNumber: i.itemNumber,
                itemType: i.itemType,
                name: i.name,
              },
            ]),
        ),
        relationships: forget.relationships ?? [],
      }
      await DesignSessionService.saveMaterializationJournal(sessionId, journal)
    }

    it('adopts an item created in the crash window instead of minting a second one', async () => {
      const session = await createSession()
      const first = await MaterializationService.execute(session, user.id)

      const screw = first.createdItems.find((i) => i.tempId === 'part-2')
      expect(screw).toBeDefined()

      // 'M4 Screw' is in the database; the journal never learned about it,
      // nor about the BOM edge that hangs off it.
      await rewindJournal(session.id, first, {
        items: ['part-2'],
        relationships: ['asm-1->part-1'],
      })

      const second = await MaterializationService.execute(session, user.id)

      // Invariant: one item for that tempId, carrying the number the first
      // run minted — a second create would have minted a second number.
      const resumed = second.createdItems.find((i) => i.tempId === 'part-2')
      expect(resumed?.itemId).toBe(screw!.itemId)
      expect(resumed?.itemNumber).toBe(screw!.itemNumber)

      const screwRows = await testDb.db
        .select({ id: items.id })
        .from(items)
        .where(
          and(eq(items.designId, first.designId), eq(items.name, 'M4 Screw')),
        )
      expect(screwRows).toHaveLength(1)

      // Nothing else duplicated either: still one design, four items, two edges.
      const allRows = await testDb.db
        .select({ id: items.id })
        .from(items)
        .where(eq(items.designId, first.designId))
      expect(allRows).toHaveLength(4)

      const programDesigns = await testDb.db
        .select({ id: designs.id })
        .from(designs)
        .where(eq(designs.programId, programId))
      expect(programDesigns).toHaveLength(1)

      const rels = await testDb.db
        .select()
        .from(itemRelationships)
        .where(
          and(
            eq(itemRelationships.relationshipType, 'BOM'),
            inArray(
              itemRelationships.sourceId,
              allRows.map((r) => r.id),
            ),
          ),
        )
      expect(rels).toHaveLength(2)
    })

    it('adopts the design created in the crash window rather than making a second one', async () => {
      const session = await createSession()
      const first = await MaterializationService.execute(session, user.id)

      // The design (and every item on it) exists; the journal knows none of it.
      await DesignSessionService.saveMaterializationJournal(session.id, {
        status: 'failed',
        startedAt: new Date().toISOString(),
        items: {},
        relationships: [],
      })

      const second = await MaterializationService.execute(session, user.id)
      expect(second.designId).toBe(first.designId)

      const programDesigns = await testDb.db
        .select({ id: designs.id })
        .from(designs)
        .where(eq(designs.programId, programId))
      expect(programDesigns).toHaveLength(1)

      const allRows = await testDb.db
        .select({ id: items.id })
        .from(items)
        .where(eq(items.designId, first.designId))
      expect(allRows).toHaveLength(4)
    })

    it('adopts the ECO and its workflow instance, minting neither a second time', async () => {
      const design = await DesignService.create(
        {
          programId,
          name: 'Released Design',
          code: `RELC-${Date.now()}`,
          designType: 'Engineering',
        },
        user.id,
      )
      const releasedPart = await ItemService.create<BaseItem>(
        'Part',
        {
          name: 'Released Part',
          revision: 'A',
          itemType: 'Part',
          designId: design.id,
        },
        user.id,
      )
      await testDb.db
        .update(items)
        .set({ state: 'Released' })
        .where(eq(items.id, releasedPart.id!))

      const session = await createSession(design.id)
      const first = await MaterializationService.execute(session, user.id)
      expect(first.ecoId).toBeTruthy()

      const instancesBefore = await testDb.db
        .select({ id: lifecycleInstances.id })
        .from(lifecycleInstances)
        .where(eq(lifecycleInstances.itemId, first.ecoId!))
      expect(instancesBefore).toHaveLength(1)

      // The ECO, its workflow instance, its branch and all four items exist;
      // the journal remembers none of them.
      await rewindJournal(session.id, first, {
        eco: true,
        items: first.createdItems.map((i) => i.tempId),
      })

      const second = await MaterializationService.execute(session, user.id)

      // Invariant: the same ECO, the same workflow instance, the same items.
      expect(second.ecoId).toBe(first.ecoId)
      expect(second.ecoNumber).toBe(first.ecoNumber)

      const changeOrderRows = await testDb.db
        .select({ id: items.id })
        .from(items)
        .where(
          and(eq(items.itemType, 'ChangeOrder'), eq(items.createdBy, user.id)),
        )
      expect(changeOrderRows).toHaveLength(1)

      const instancesAfter = await testDb.db
        .select({ id: lifecycleInstances.id })
        .from(lifecycleInstances)
        .where(eq(lifecycleInstances.itemId, first.ecoId!))
      expect(instancesAfter).toHaveLength(1)
      expect(instancesAfter[0]!.id).toBe(instancesBefore[0]!.id)

      for (const created of first.createdItems) {
        const again = second.createdItems.find(
          (i) => i.tempId === created.tempId,
        )
        expect(again?.itemId).toBe(created.itemId)
        expect(again?.itemNumber).toBe(created.itemNumber)
      }
    })

    it('keeps a concurrent artifacts edit that lands while materialization runs', async () => {
      const session = await createSession()

      // A reviewer's PATCH — a compare-and-set write against the version it
      // read, exactly as the route does it — lands after execute() took its
      // artifacts snapshot. Hooked onto the last step before the final
      // artifacts write, which is the window the defect lived in.
      const realSet =
        DesignSessionService.setMaterializedDesign.bind(DesignSessionService)
      const spy = vi
        .spyOn(DesignSessionService, 'setMaterializedDesign')
        .mockImplementation(async (id, designId) => {
          const live = await DesignSessionService.getById(id)
          await DesignSessionService.updateArtifacts(
            id,
            {
              ...live!.artifacts!,
              itemComments: [
                {
                  id: 'ic-1',
                  targetType: 'bom_node',
                  targetTempId: 'part-1',
                  text: 'check the fit before release',
                  createdAt: new Date().toISOString(),
                  stage: 'bom_review',
                },
              ],
            },
            live!.artifactsVersion,
          )
          return realSet(id, designId)
        })

      const result = await MaterializationService.execute(session, user.id)
      spy.mockRestore()

      // Invariant: both writes survive. The result is recorded (the CAD stage
      // reads its tempId→itemId map from it) and the comment is still there.
      const fresh = await DesignSessionService.getById(session.id)
      expect(fresh?.artifacts?.materializationResult?.designId).toBe(
        result.designId,
      )
      expect(
        fresh?.artifacts?.materializationResult?.createdItems,
      ).toHaveLength(4)
      expect(fresh?.artifacts?.itemComments).toHaveLength(1)
      expect(fresh?.artifacts?.itemComments?.[0]?.id).toBe('ic-1')
    })
  })
})
