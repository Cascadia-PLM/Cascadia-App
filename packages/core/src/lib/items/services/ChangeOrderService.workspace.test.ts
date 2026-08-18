// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Workspace → ECO adoption — data-integrity tests
 *
 * A workspace draft lives on a branch no merge ever reads, so the transfer
 * into an ECO is the step where work either enters change control intact or
 * quietly disappears. These tests pin the invariants:
 *
 *  - adoption moves the workspace's branch rows onto the ECO branch (content
 *    transferred, never copied) and registers each in the reviewed scope
 *  - a workspace-created draft, converted and released, ends up Released
 *    with a real revision and resolvable on main — the full pipeline
 *  - deleting the workspace after adoption cannot destroy the ECO's items
 *  - masters already in the ECO are skipped, not clobbered
 *
 * Run: npx vitest run src/lib/items/services/ChangeOrderService.workspace.test.ts
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
import { ItemService } from './ItemService'
import { ChangeOrderService } from './ChangeOrderService'
import type { TestUser } from '@/__tests__/fixtures/users'
import { ChangeOrderMergeService } from '@/lib/services/ChangeOrderMergeService'
import { BranchService } from '@/lib/services/BranchService'
import { CheckoutService } from '@/lib/services/CheckoutService'
import { DesignService } from '@/lib/services/DesignService'
import { RevisionService } from '@/lib/services/RevisionService'
import { VersionResolver } from '@/lib/services/VersionResolver'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import {
  branchItems,
  changeOrderAffectedItems,
  items,
  programs,
  workflowDefinitions,
  workflowInstances,
} from '@/lib/db/schema'
import { ItemTypeRegistry } from '@/lib/items/registry'
import { seedStandardPartLifecycle } from '@/__tests__/fixtures/lifecycles'
import { takeFirst } from '@/lib/db/take-first'
import { ValidationError } from '@/lib/errors'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

// Well-known test workflow ID, unique to this file to avoid cross-file races
const ADOPT_TEST_WORKFLOW_ID = '00000000-0000-4000-8000-000000000221'

describe('ChangeOrderService.adoptWorkspaceItems', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let designId: string
  let uniquePrefix: string

  beforeAll(async () => {
    await testDb.setup()
    await seedStandardPartLifecycle(testDb.db)

    await testDb.db
      .insert(workflowDefinitions)
      .values({
        id: ADOPT_TEST_WORKFLOW_ID,
        name: 'Test ECO Workflow - WorkspaceAdoption',
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
            {
              id: 'Released',
              name: 'Released',
              isInitial: false,
              isFinal: true,
              finalKind: 'release',
            },
          ],
          transitions: [
            {
              id: 't1',
              name: 'Approve',
              fromStateId: 'Draft',
              toStateId: 'Approved',
            },
            {
              id: 't2',
              name: 'Release',
              fromStateId: 'Approved',
              toStateId: 'Released',
            },
          ],
          definitionType: 'workflow',
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
    uniquePrefix = `WA${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    user = await insertTestUser(testDb.db)

    const program = takeFirst(
      await testDb.db
        .insert(programs)
        .values({
          name: 'Adoption Test Program',
          code: `PROG-${uniquePrefix}`,
          createdBy: user.id,
        })
        .returning(),
    )

    const design = await DesignService.create(
      {
        programId: program.id,
        name: 'Adoption Test Design',
        code: `DESIGN-${uniquePrefix}`,
        designType: 'Engineering',
      },
      user.id,
    )
    designId = design.id
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  async function createChangeOrder() {
    const eco = await ItemService.create(
      'ChangeOrder',
      {
        revision: '-',
        name: 'Adoption Test ECO',
        changeType: 'ECO',
        reasonForChange: 'Test',
      } as any,
      user.id,
    )

    await testDb.db.insert(workflowInstances).values({
      workflowDefinitionId: ADOPT_TEST_WORKFLOW_ID,
      itemId: eco.id,
      currentState: 'Draft',
    })

    return eco
  }

  /** A workspace with one Part drafted on it (branch row changeType 'added'). */
  async function createWorkspaceWithDraft(suffix: string) {
    const workspace = await BranchService.createWorkspaceBranch(
      designId,
      user.id,
      `ws-${suffix}`,
    )
    const { item } = await ItemService.createOnBranch(
      'Part',
      {
        itemNumber: `PN-${uniquePrefix}-${suffix}`,
        revision: 'A',
        name: `Workspace Draft ${suffix}`,
        state: 'Draft',
        designId,
        partType: 'Manufacture',
      } as never,
      workspace.id,
      'Drafted on workspace',
      user.id,
    )
    return { workspace, item }
  }

  async function approveEco(ecoId: string) {
    await testDb.db
      .update(items)
      .set({ state: 'Approved' })
      .where(eq(items.id, ecoId))
    await testDb.db
      .update(workflowInstances)
      .set({ currentState: 'Approved' })
      .where(eq(workflowInstances.itemId, ecoId))
  }

  it('moves workspace-created content onto the ECO branch and registers scope', async () => {
    const { workspace, item } = await createWorkspaceWithDraft('move')
    const eco = await createChangeOrder()

    const result = await ChangeOrderService.adoptWorkspaceItems(
      eco.id,
      workspace.id,
      user.id,
    )

    expect(result.itemsAdopted).toBe(1)
    expect(result.itemsSkipped).toBe(0)

    // The workspace no longer carries the row
    const workspaceRows = await testDb.db
      .select()
      .from(branchItems)
      .where(eq(branchItems.branchId, workspace.id))
    expect(workspaceRows).toHaveLength(0)

    // The ECO branch carries the same item version — moved, not copied
    const ecoDesigns = await ChangeOrderService.getEcoDesigns(eco.id)
    expect(ecoDesigns).toHaveLength(1)
    const ecoBranchId = ecoDesigns[0]!.branchId
    expect(ecoBranchId).not.toBeNull()

    const ecoRows = await testDb.db
      .select()
      .from(branchItems)
      .where(eq(branchItems.branchId, ecoBranchId!))
    expect(ecoRows).toHaveLength(1)
    expect(ecoRows[0]!.currentItemId).toBe(item.id)
    expect(ecoRows[0]!.changeType).toBe('added')

    // Scope shows the draft as a first release
    const affected = await testDb.db
      .select()
      .from(changeOrderAffectedItems)
      .where(eq(changeOrderAffectedItems.changeOrderId, eco.id))
    expect(affected).toHaveLength(1)
    expect(affected[0]!.affectedItemMasterId).toBe(item.masterId)
    expect(affected[0]!.changeAction).toBe('release')
  })

  it('releases a converted workspace draft into main', async () => {
    const { workspace, item } = await createWorkspaceWithDraft('e2e')
    const eco = await createChangeOrder()

    await ChangeOrderService.adoptWorkspaceItems(eco.id, workspace.id, user.id)
    await approveEco(eco.id)
    await ChangeOrderMergeService.merge(eco.id, user.id)

    // The master must now resolve on main as a Released item with a real
    // revision — this is the invariant the pre-adoption flows broke
    const released = await VersionResolver.getReleasedVersion(
      item.masterId!,
      designId,
    )
    expect(released).not.toBeNull()
    expect(released!.state).toBe('Released')
    expect(RevisionService.isWorkingRevision(released!.revision)).toBe(false)

    // And main's branch bookkeeping tracks the master
    const mainBranch = await BranchService.getMainBranch(designId)
    const mainRow = await testDb.db
      .select()
      .from(branchItems)
      .where(
        and(
          eq(branchItems.branchId, mainBranch!.id),
          eq(branchItems.itemMasterId, item.masterId!),
        ),
      )
    expect(mainRow).toHaveLength(1)
  })

  it('keeps adopted drafts alive when the workspace is deleted afterwards', async () => {
    const { workspace, item } = await createWorkspaceWithDraft('del')
    const eco = await createChangeOrder()

    await ChangeOrderService.adoptWorkspaceItems(eco.id, workspace.id, user.id)
    await BranchService.deleteWorkspaceBranch(workspace.id, user.id)

    const survivor = await ItemService.findById(item.id!)
    expect(survivor).not.toBeNull()

    const deletedBranch = await BranchService.getById(workspace.id)
    expect(deletedBranch?.isArchived).toBe(true)

    // The ECO branch row still points at the surviving version
    const ecoDesigns = await ChangeOrderService.getEcoDesigns(eco.id)
    const ecoRows = await testDb.db
      .select()
      .from(branchItems)
      .where(eq(branchItems.branchId, ecoDesigns[0]!.branchId!))
    expect(ecoRows).toHaveLength(1)
    expect(ecoRows[0]!.currentItemId).toBe(item.id)
  })

  it('skips masters already in the change order scope, leaving them on the workspace', async () => {
    const { workspace, item } = await createWorkspaceWithDraft('skip')
    const eco = await createChangeOrder()

    await ChangeOrderService.addAffectedItem(
      eco.id,
      { affectedItemId: item.id, changeAction: 'release' },
      user.id,
    )

    const result = await ChangeOrderService.adoptWorkspaceItems(
      eco.id,
      workspace.id,
      user.id,
    )

    expect(result.itemsAdopted).toBe(0)
    expect(result.itemsSkipped).toBe(1)

    // Skipped rows stay where they were
    const workspaceRows = await testDb.db
      .select()
      .from(branchItems)
      .where(eq(branchItems.branchId, workspace.id))
    expect(workspaceRows).toHaveLength(1)
  })

  it('adopts an untouched checkout as revise scope against the released version', async () => {
    const part = await ItemService.create(
      'Part',
      {
        itemNumber: `PN-${uniquePrefix}-REL`,
        revision: 'A',
        name: 'Released Part',
        state: 'Released',
        designId,
        partType: 'Manufacture',
      } as any,
      user.id,
    )

    const workspace = await BranchService.createWorkspaceBranch(
      designId,
      user.id,
      'ws-checkout',
    )
    await CheckoutService.checkout(
      { itemMasterId: part.masterId!, branchId: workspace.id },
      user.id,
    )

    const eco = await createChangeOrder()
    const result = await ChangeOrderService.adoptWorkspaceItems(
      eco.id,
      workspace.id,
      user.id,
    )
    expect(result.itemsAdopted).toBe(1)

    const affected = await testDb.db
      .select()
      .from(changeOrderAffectedItems)
      .where(eq(changeOrderAffectedItems.changeOrderId, eco.id))
    expect(affected).toHaveLength(1)
    expect(affected[0]!.changeAction).toBe('revise')
    expect(affected[0]!.affectedItemId).toBe(part.id)
  })

  it('refuses non-workspace sources and empty workspaces', async () => {
    const eco = await createChangeOrder()

    const emptyWorkspace = await BranchService.createWorkspaceBranch(
      designId,
      user.id,
      'ws-empty',
    )
    await expect(
      ChangeOrderService.adoptWorkspaceItems(
        eco.id,
        emptyWorkspace.id,
        user.id,
      ),
    ).rejects.toThrow(ValidationError)

    const mainBranch = await BranchService.getMainBranch(designId)
    await expect(
      ChangeOrderService.adoptWorkspaceItems(eco.id, mainBranch!.id, user.id),
    ).rejects.toThrow(ValidationError)
  })

  it('refuses when the ECO scope is locked', async () => {
    const { workspace } = await createWorkspaceWithDraft('locked')
    const eco = await createChangeOrder()

    await testDb.db
      .update(workflowInstances)
      .set({ scopeLocked: true })
      .where(eq(workflowInstances.itemId, eco.id))

    await expect(
      ChangeOrderService.adoptWorkspaceItems(eco.id, workspace.id, user.id),
    ).rejects.toThrow(ValidationError)
  })
})
