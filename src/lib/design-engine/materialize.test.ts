// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

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
 * Run: npx vitest run src/lib/design-engine/materialize.test.ts
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
import { and, eq, inArray } from 'drizzle-orm'
import { MaterializationService } from './materialize'
import { DesignSessionService } from './session-service'
import type { DesignSession } from './session-service'
import type { BomDraft, DesignArtifacts } from './types'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { BaseItem } from '@/lib/items/types/base'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { DesignService } from '@/lib/services/DesignService'
import { ItemService } from '@/lib/items/services/ItemService'
import {
  branchItems,
  branches,
  changeOrderAffectedItems,
  changeOrderDesigns,
  designs,
  itemRelationships,
  items,
  programs,
} from '@/lib/db/schema'
import { workflowDefinitions } from '@/lib/db/schema/workflows'
import { itemTypeConfigs } from '@/lib/db/schema/config'
import { ItemTypeRegistry } from '@/lib/items/registry'
import {
  SYSTEM_USER_ID,
  seedStandardPartLifecycle,
} from '@/__tests__/fixtures/lifecycles'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

// Unique ECO workflow definition ID for this test file, so it doesn't race with
// other test files that seed their own ChangeOrder workflows against the shared DB.
const ECO_WORKFLOW_ID = '00000000-0000-4000-8000-0000000001d3'

// Minimal ChangeOrder workflow so ChangeOrderService.autoStartWorkflow() can
// start an instance in the initial (Draft) state during eco_required materialization.
const ecoWorkflowDefinition = {
  states: [
    { id: 'Draft', name: 'Draft', isInitial: true, isFinal: false },
    { id: 'InReview', name: 'InReview', isInitial: false, isFinal: false },
    { id: 'Approved', name: 'Approved', isInitial: false, isFinal: true },
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
  definitionType: 'workflow',
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
  let user: TestUser
  let programId: string

  beforeAll(async () => {
    await testDb.setup()

    // System user + Part lifecycle (gives Parts a 'release' action from Draft).
    await seedStandardPartLifecycle(testDb.db)

    // Seed a ChangeOrder workflow and point the ChangeOrder item type at it so
    // autoStartWorkflow() resolves a workflow for the ECO change type.
    await testDb.db
      .insert(workflowDefinitions)
      .values({
        id: ECO_WORKFLOW_ID,
        name: 'ECO - Materialize Test Workflow',
        version: 1,
        workflowType: 'strict',
        definition: ecoWorkflowDefinition,
        isActive: true,
      })
      .onConflictDoNothing()

    const changeOrderConfig = {
      lifecycleDefinitionId: ECO_WORKFLOW_ID,
      workflowsByChangeType: {
        ECO: ECO_WORKFLOW_ID,
        ECN: ECO_WORKFLOW_ID,
        Deviation: ECO_WORKFLOW_ID,
        MCO: ECO_WORKFLOW_ID,
      },
    }
    await testDb.db
      .insert(itemTypeConfigs)
      .values({
        itemType: 'ChangeOrder',
        config: changeOrderConfig,
        modifiedBy: SYSTEM_USER_ID,
      })
      .onConflictDoUpdate({
        target: itemTypeConfigs.itemType,
        set: { config: changeOrderConfig, modifiedBy: SYSTEM_USER_ID },
      })

    // Reload the registry so it picks up the seeded lifecycle/workflow config.
    await ItemTypeRegistry.reload()
  })

  afterAll(async () => {
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
    const designId = design.id!

    // Release an item to put the design in post-release (protected) phase
    const releasedPart = await ItemService.create(
      'Part',
      {
        name: 'Released Part',
        revision: 'A',
        itemType: 'Part',
        designId,
      } as BaseItem,
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
    const [eco] = await testDb.db
      .select()
      .from(items)
      .where(eq(items.id, result.ecoId!))
    expect(eco).toBeDefined()
    expect(eco!.itemType).toBe('ChangeOrder')

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
    const ecoBranchId = ecoDesign!.branchId!

    const [ecoBranch] = await testDb.db
      .select()
      .from(branches)
      .where(eq(branches.id, ecoBranchId))
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

    const ecoBranchItems = await testDb.db
      .select()
      .from(branchItems)
      .where(
        and(
          eq(branchItems.branchId, ecoBranchId),
          inArray(branchItems.itemMasterId, createdMasterIds),
        ),
      )
    expect(ecoBranchItems).toHaveLength(createdIds.length)
    for (const bi of ecoBranchItems) {
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
})
