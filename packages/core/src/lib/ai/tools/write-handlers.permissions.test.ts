// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * AI/MCP write tools — program isolation (ISO-6)
 *
 * Security gate. `create_item`, `create_relationship` and
 * `transition_item_state` reached the services with only the wrapper's
 * type-level RBAC in front of them, and none of the three services draws the
 * boundary itself: `ItemService.create` has no design gate (unlike `update`
 * and `delete`), `ItemService.addRelationship` writes the edge
 * unconditionally, and `LifecycleService.transitionFreeItem` validates the
 * lifecycle but no program. So a chatbot user or an MCP agent holding ordinary
 * `parts` grants could plant an item in another program's design, hang two of
 * its parts together, or drive its items through their states — knowing only a
 * design code or an item id.
 *
 * Member and outsider hold the *same* role and differ only in program
 * membership, so a refusal here can come from nowhere but the instance-level
 * gate. The outsider owns a program of their own, so they are an ordinary user
 * rather than a user with nothing to reach.
 *
 * These tools answer in an envelope rather than throwing: the impl-level
 * try/catch turns the thrown `PermissionDeniedError` into
 * `{ success: false, error }`, which is the shape both surfaces hand to the
 * model. What is pinned here is therefore structural rather than a message —
 * no preview, no confirmation token minted, and nothing written — plus the
 * member's success through the same two-step flow, which is what shows the
 * refusal is about reach rather than about RBAC or arguments.
 *
 * The "no token" assertions are the load-bearing ones: the gates sit above
 * `consumeConfirmation` deliberately, because the preview echoes the design's
 * name, the two item numbers and the current state back to the caller. A gate
 * on execution alone would still disclose the target.
 *
 * Run: npx vitest run packages/core/src/lib/ai/tools/write-handlers.permissions.test.ts
 */

import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import {
  createItemHandler,
  createRelationshipHandler,
  transitionItemStateHandler,
  updateItemHandler,
} from './write-handlers'
import { toolRegistry } from './registry'
import type { ToolContext } from './permission-wrapper'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { ChangeOrder } from '@/lib/items/types/change-order'
import type { Document } from '@/lib/items/types/document'
import type { Part } from '@/lib/items/types/part'
import type { Task } from '@/lib/items/types/task'
import type { WorkInstruction } from '@/lib/items/types/work-instruction'
import { TestDatabase } from '@/__tests__/helpers/db'
import {
  assignRoleToUser,
  createCustomTestRole,
  insertTestRole,
  insertTestUser,
} from '@/__tests__/fixtures/users'
import {
  SYSTEM_USER_ID,
  overrideItemTypeConfig,
  seedSystemUser,
} from '@/__tests__/fixtures/lifecycles'
import { ItemService } from '@/lib/items/services/ItemService'
import { DesignService } from '@/lib/services/DesignService'
import { ProgramService } from '@/lib/services/ProgramService'
import { permissionService } from '@/lib/auth/permission-service'
import { LIFECYCLE_IDS } from '@/lib/items/lifecycle-ids'
import { branchItems, branches } from '@/lib/db/schema/versioning'
import {
  changeOrderDesigns,
  itemRelationships,
  items,
} from '@/lib/db/schema/items'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

/** The fields of the write tools' response envelope these tests assert on. */
interface WriteEnvelope {
  requiresConfirmation: boolean
  confirmationToken?: string
  success?: boolean
  error?: string
}

describe('AI write tools — program isolation', () => {
  const testDb = new TestDatabase()

  let member: TestUser
  let outsider: TestUser
  let designId: string
  let designCode: string
  let assemblyId: string
  let componentId: string
  let instructionId: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    permissionService.clearCache()

    // One role, both users, and pointedly no `programs:manage` — that is the
    // cross-program bypass. It grants everything the three tools ask for at
    // the type level, `work_instructions:update` included: that is what
    // `transition_item_state` charges for the work instruction below, since
    // AI2-4 made the tuple follow the target's own type. Granting it is what
    // stops the wrapper from being the thing that refuses.
    const engineerRole = await insertTestRole(
      testDb.db,
      createCustomTestRole(`AI Write Engineer ${randomUUID().slice(0, 8)}`, {
        parts: ['create', 'read', 'update'],
        designs: ['create', 'read'],
        change_orders: ['create', 'read', 'update'],
        work_instructions: ['create', 'read', 'update'],
      }),
    )

    member = await insertTestUser(testDb.db)
    outsider = await insertTestUser(testDb.db)
    await assignRoleToUser(testDb.db, member.id, engineerRole.id)
    await assignRoleToUser(testDb.db, outsider.id, engineerRole.id)
    permissionService.clearCache()

    const program = await ProgramService.create(
      {
        name: 'AI Write Program',
        code: `AIW-${Date.now()}-${randomUUID().slice(0, 4).toUpperCase()}`,
      },
      member.id,
    )
    const design = await DesignService.create(
      {
        programId: program.id,
        name: 'AI Write Design',
        code: `AIWD-${Date.now()}-${randomUUID().slice(0, 4).toUpperCase()}`,
        designType: 'Engineering',
      },
      member.id,
    )
    designId = design.id
    designCode = design.code

    // The outsider is a normal user with a program of their own.
    await ProgramService.create(
      {
        name: 'AI Write Outsider Program',
        code: `AIWO-${Date.now()}-${randomUUID().slice(0, 4).toUpperCase()}`,
      },
      outsider.id,
    )

    const assembly = await ItemService.create<Part>(
      'Part',
      {
        itemType: 'Part',
        designId,
        name: 'Confidential Assembly',
        partType: 'Manufacture',
      },
      member.id,
    )
    const component = await ItemService.create<Part>(
      'Part',
      {
        itemType: 'Part',
        designId,
        name: 'Confidential Component',
        partType: 'Manufacture',
      },
      member.id,
    )
    assemblyId = assembly.id!
    componentId = component.id!

    // A Free-lifecycle item that carries a design: the arm of
    // `transition_item_state` that nothing downstream re-gates. (The
    // ChangeOrder arm is re-gated by `executeWorkflowTransition`.)
    const instruction = await ItemService.create<WorkInstruction>(
      'WorkInstruction',
      {
        itemType: 'WorkInstruction',
        designId,
        name: 'Confidential Procedure',
        outputPartId: assemblyId,
      },
      member.id,
    )
    instructionId = instruction.id!
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  const ctx = (
    user: TestUser,
    extra: Partial<ToolContext> = {},
  ): ToolContext => ({ userId: user.id, ...extra })

  /** Every item currently in the member's design. */
  async function itemsInDesign(): Promise<number> {
    const rows = await testDb.db
      .select({ id: items.id })
      .from(items)
      .where(eq(items.designId, designId))
    return rows.length
  }

  /** Every edge currently hanging off the member's assembly. */
  async function edgesFromAssembly(): Promise<number> {
    const rows = await testDb.db
      .select({ id: itemRelationships.id })
      .from(itemRelationships)
      .where(eq(itemRelationships.sourceId, assemblyId))
    return rows.length
  }

  /** The work instruction's stored lifecycle state. */
  async function instructionState(): Promise<string> {
    const rows = await testDb.db
      .select({ state: items.state })
      .from(items)
      .where(eq(items.id, instructionId))
    const row = rows.at(0)
    expect(row).toBeDefined()
    return row!.state
  }

  function expectRefused(response: WriteEnvelope, label: string): void {
    expect(response.success, label).toBe(false)
    expect(response.error, label).toBeTruthy()
    // Refused at the preview step: no token was minted, so the caller cannot
    // even take the second step, and nothing about the target came back.
    expect(response.confirmationToken, label).toBeUndefined()
    expect(response.requiresConfirmation, label).toBe(false)
  }

  function expectPreview(response: WriteEnvelope, label: string): string {
    expect(response.requiresConfirmation, label).toBe(true)
    expect(typeof response.confirmationToken, label).toBe('string')
    return response.confirmationToken!
  }

  it("refuses an outsider create_item into the member's design, by id and by code", async () => {
    const before = await itemsInDesign()

    for (const [label, design] of [
      ['by id', designId],
      ['by code', designCode],
    ] as const) {
      const response = await createItemHandler(
        { itemType: 'Part', name: 'Planted Part', designId: design },
        ctx(outsider),
      )
      expectRefused(response, `create_item ${label}`)
    }

    expect(await itemsInDesign()).toBe(before)
  })

  it("refuses an outsider create_relationship between the member's parts", async () => {
    const before = await edgesFromAssembly()

    const response = await createRelationshipHandler(
      {
        sourceItemId: assemblyId,
        targetItemId: componentId,
        relationshipType: 'BOM',
        quantity: 2,
      },
      ctx(outsider),
    )
    expectRefused(response, 'create_relationship')

    expect(await edgesFromAssembly()).toBe(before)
  })

  it("refuses an outsider transition_item_state on the member's item", async () => {
    const before = await instructionState()

    const response = await transitionItemStateHandler(
      { itemId: instructionId, targetState: 'In Review' },
      ctx(outsider),
    )
    expectRefused(response, 'transition_item_state')

    expect(await instructionState()).toBe(before)
  })

  it('serves the member all three, through the two-step flow', async () => {
    const itemsBefore = await itemsInDesign()
    const edgesBefore = await edgesFromAssembly()
    const stateBefore = await instructionState()

    const createInput = {
      itemType: 'Part',
      name: 'Legitimate Part',
      designId,
    }
    const createToken = expectPreview(
      await createItemHandler(createInput, ctx(member)),
      'create_item preview',
    )
    const created = await createItemHandler(
      { ...createInput, confirmationToken: createToken },
      ctx(member),
    )
    expect(created.success, 'create_item').toBe(true)

    const relationshipInput = {
      sourceItemId: assemblyId,
      targetItemId: componentId,
      relationshipType: 'BOM' as const,
      quantity: 2,
    }
    const relationshipToken = expectPreview(
      await createRelationshipHandler(relationshipInput, ctx(member)),
      'create_relationship preview',
    )
    const related = await createRelationshipHandler(
      { ...relationshipInput, confirmationToken: relationshipToken },
      ctx(member),
    )
    expect(related.success, 'create_relationship').toBe(true)

    const transitionInput = {
      itemId: instructionId,
      targetState: 'In Review',
    }
    const transitionToken = expectPreview(
      await transitionItemStateHandler(transitionInput, ctx(member)),
      'transition_item_state preview',
    )
    const transitioned = await transitionItemStateHandler(
      { ...transitionInput, confirmationToken: transitionToken },
      ctx(member),
    )
    expect(transitioned.success, 'transition_item_state').toBe(true)

    // The mirror of the three refusal invariants: for the member, each write
    // actually lands.
    expect(await itemsInDesign()).toBe(itemsBefore + 1)
    expect(await edgesFromAssembly()).toBe(edgesBefore + 1)
    expect(await instructionState()).not.toBe(stateBefore)
  })

  it('refuses over MCP too, with a scoped key', async () => {
    // The registry documents the handlers as the enforcement point. Driving
    // `invoke` with a full keyScope shows the gate is not something the chat
    // surface adds on top of them.
    const context = ctx(outsider, {
      keyScope: {
        parts: ['create', 'read', 'update'],
        // The work instruction's own resource, for the reason above.
        work_instructions: ['update'],
      },
    })

    const calls = [
      ['create_item', { itemType: 'Part', name: 'Planted Part', designId }],
      [
        'create_relationship',
        {
          sourceItemId: assemblyId,
          targetItemId: componentId,
          relationshipType: 'BOM',
        },
      ],
      [
        'transition_item_state',
        { itemId: instructionId, targetState: 'In Review' },
      ],
    ] as const

    const itemsBefore = await itemsInDesign()
    const edgesBefore = await edgesFromAssembly()
    const stateBefore = await instructionState()

    for (const [name, input] of calls) {
      const entry = toolRegistry.find((e) => e.name === name)
      expect(entry, name).toBeDefined()
      expectRefused(
        (await entry!.invoke(input, context)) as WriteEnvelope,
        name,
      )
    }

    expect(await itemsInDesign()).toBe(itemsBefore)
    expect(await edgesFromAssembly()).toBe(edgesBefore)
    expect(await instructionState()).toBe(stateBefore)
  })
})

/**
 * AI/MCP write tools — the permission resource follows the target (AI2-4)
 *
 * Security gate. `update_item` and `transition_item_state` are single entry
 * points onto every registered item type — the first writes whatever
 * `ItemService.findById` returns, the second drives every Free lifecycle
 * through `LifecycleService.transitionFreeItem` — yet each declared one fixed
 * RBAC tuple to the wrapper: `parts:update` and `change_orders:update`
 * respectively. Nothing below the wrapper re-checks RBAC, so those tuples were
 * the whole gate, and they were wrong in both directions. A grant on `parts`
 * renamed Documents and Tasks it was never given; a grant on `documents` could
 * not edit a Document; and `change_orders:update` — the ECO approver's grant —
 * moved every Task, TestPlan and WorkInstruction in reach through its states
 * while the type's own `update` grant did nothing.
 *
 * Each pair below is two users differing only in which resource their role
 * names, driving the identical call against the identical item, so a refusal
 * can come from nothing but the resource tuple. That mirror is what carries
 * the weight: the wrapper refuses by *throwing*, above the handler, so the
 * denial itself can only be asserted as a rejection — there is no envelope and
 * no typed error to match on. What the pairing pins is that one call is served
 * for one grant and refused for the other.
 *
 * The denial lands on the preview leg for the same reason ISO-6's gates sit
 * where they do: the wrapper runs before `consumeConfirmation`, so a refused
 * caller never reaches the preview that would echo the item's number and state
 * back at them, and never gets a token.
 *
 * `create_relationship` was deliberately left out of the program that added
 * this suite — realigning it changes who may attach edges to a non-Part item,
 * a permission-surface change with a real audience rather than a mechanical
 * refactor. It is covered below by the same mirror, charging the *source*
 * item's type: `requireItemAccess` already gates both source and target at
 * the instance level inside the handler, so only the type dimension was open.
 *
 * Run: npx vitest run packages/core/src/lib/ai/tools/write-handlers.permissions.test.ts
 */
describe('AI write tools — permission resource follows the target item type', () => {
  const testDb = new TestDatabase()
  let restoreTaskLifecycle: (() => Promise<void>) | undefined

  let partsUser: TestUser
  let documentsUser: TestUser
  let tasksUser: TestUser
  let ecoUser: TestUser

  let documentId: string
  let taskId: string
  let changeOrderId: string
  let releasedPartId: string

  beforeAll(async () => {
    await testDb.setup()
    await seedSystemUser(testDb.db)

    // `item_type_configs` holds one row per item type for the whole instance
    // and another suite points Task at a Driven lifecycle. Write the link this
    // suite needs and reload, rather than trusting what was left behind — the
    // registry caches per process, so the reload here is what pins Task to its
    // Free lifecycle for the rest of this file.
    restoreTaskLifecycle = await overrideItemTypeConfig(
      testDb.db,
      'Task',
      { lifecycleDefinitionId: LIFECYCLE_IDS.task },
      SYSTEM_USER_ID,
    )
  })

  afterAll(async () => {
    // Shared row: put back what this suite found before it wrote.
    await restoreTaskLifecycle?.()
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    permissionService.clearCache()

    // Four narrow roles. Every one carries `read` on everything the handlers
    // touch, and every user joins the same program, so the only thing that
    // differs between any two of them is which resource they hold `update`
    // on. `insertTestUserWithRole` takes a built-in role name and cannot
    // express these, so they are built with `createCustomTestRole`.
    const readEverything = {
      parts: ['read'],
      documents: ['read'],
      tasks: ['read'],
      change_orders: ['read'],
      designs: ['read'],
      programs: ['read'],
    }
    const suffix = randomUUID().slice(0, 8)
    const rolePermissions = {
      parts: { ...readEverything, parts: ['create', 'read', 'update'] },
      documents: { ...readEverything, documents: ['read', 'update'] },
      tasks: { ...readEverything, tasks: ['read', 'update'] },
      // The ECO approver: change orders and parts, but nothing on tasks.
      eco: {
        ...readEverything,
        parts: ['create', 'read', 'update'],
        change_orders: ['create', 'read', 'update'],
      },
    }

    const byRole: Record<string, TestUser> = {}
    for (const [key, permissions] of Object.entries(rolePermissions)) {
      const role = await insertTestRole(
        testDb.db,
        createCustomTestRole(`AI2-4 ${key} ${suffix}`, permissions),
      )
      const user = await insertTestUser(testDb.db)
      await assignRoleToUser(testDb.db, user.id, role.id)
      byRole[key] = user
    }
    permissionService.clearCache()

    partsUser = byRole.parts!
    documentsUser = byRole.documents!
    tasksUser = byRole.tasks!
    ecoUser = byRole.eco!

    const program = await ProgramService.create(
      {
        name: 'AI2-4 Program',
        code: `AI24-${Date.now()}-${randomUUID().slice(0, 4).toUpperCase()}`,
      },
      partsUser.id,
    )
    for (const user of [documentsUser, tasksUser, ecoUser]) {
      await ProgramService.addMember(
        program.id,
        user.id,
        'engineer',
        partsUser.id,
      )
    }

    const design = await DesignService.create(
      {
        programId: program.id,
        name: 'AI2-4 Design',
        code: `AI24D-${Date.now()}-${randomUUID().slice(0, 4).toUpperCase()}`,
        designType: 'Engineering',
      },
      partsUser.id,
    )

    const document = await ItemService.create<Document>(
      'Document',
      { itemType: 'Document', designId: design.id, name: 'Spec Sheet' },
      partsUser.id,
    )
    documentId = document.id!

    const task = await ItemService.create<Task>(
      'Task',
      { itemType: 'Task', designId: design.id, name: 'Review the spec' },
      partsUser.id,
    )
    taskId = task.id!

    const changeOrder = await ItemService.create<ChangeOrder>(
      'ChangeOrder',
      {
        itemType: 'ChangeOrder',
        name: 'AI2-4 ECO',
        changeType: 'ECO',
        priority: 'medium',
        reasonForChange: 'Permission resource coverage',
      },
      ecoUser.id,
    )
    changeOrderId = changeOrder.id!

    // The released part lives in a design of its own: releasing it protects
    // that design's main branch, which would otherwise change how every other
    // item here is edited.
    const ecoDesign = await DesignService.create(
      {
        programId: program.id,
        name: 'AI2-4 Released Design',
        code: `AI24R-${Date.now()}-${randomUUID().slice(0, 4).toUpperCase()}`,
        designType: 'Engineering',
      },
      partsUser.id,
    )
    const releasedPart = await ItemService.create<Part>(
      'Part',
      {
        itemType: 'Part',
        designId: ecoDesign.id,
        name: 'Released Bracket',
        partType: 'Manufacture',
        state: 'Released',
      },
      partsUser.id,
      { bypassBranchProtection: true },
    )
    releasedPartId = releasedPart.id!

    // `requireEcoAccess` reads the ECO's design links, so the ECO has to name
    // one to be reachable at all. `checkoutItemToEco` would create this row
    // itself; seeding it keeps the ECO openable before any checkout happens.
    await testDb.db.insert(changeOrderDesigns).values({
      changeOrderId,
      designId: ecoDesign.id,
    })
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  const ctx = (user: TestUser): ToolContext => ({ userId: user.id })

  /**
   * The wrapper refuses by throwing, above the handler — so a denial is a
   * rejection rather than the `{ success: false }` envelope the handlers
   * produce for their own refusals. Nothing comes back, so nothing about the
   * target leaks; what makes this specific rather than vacuous is the paired
   * assertion that the other user's identical call is served.
   */
  async function expectRefusedByRbac(
    call: Promise<unknown>,
    label: string,
  ): Promise<void> {
    await expect(call, label).rejects.toBeInstanceOf(Error)
  }

  /** The stored name of an item, to show a refused write changed nothing. */
  async function nameOf(itemId: string): Promise<string | null> {
    const rows = await testDb.db
      .select({ name: items.name })
      .from(items)
      .where(eq(items.id, itemId))
    const row = rows.at(0)
    expect(row).toBeDefined()
    return row!.name
  }

  /** The stored lifecycle state of an item. */
  async function stateOf(itemId: string): Promise<string> {
    const rows = await testDb.db
      .select({ state: items.state })
      .from(items)
      .where(eq(items.id, itemId))
    const row = rows.at(0)
    expect(row).toBeDefined()
    return row!.state
  }

  /** Every edge currently hanging off a given source item. */
  async function edgesFrom(sourceId: string): Promise<number> {
    const rows = await testDb.db
      .select({ id: itemRelationships.id })
      .from(itemRelationships)
      .where(eq(itemRelationships.sourceId, sourceId))
    return rows.length
  }

  /** Working copies this ECO has taken, across its branches. */
  async function branchItemsForEco(): Promise<number> {
    const rows = await testDb.db
      .select({ id: branchItems.id })
      .from(branchItems)
      .innerJoin(branches, eq(branchItems.branchId, branches.id))
      .where(eq(branches.changeOrderItemId, changeOrderId))
    return rows.length
  }

  it('refuses update_item on a Document and a Task to a parts-only grant', async () => {
    const documentBefore = await nameOf(documentId)
    const taskBefore = await nameOf(taskId)

    await expectRefusedByRbac(
      updateItemHandler(
        { itemId: documentId, name: 'Renamed' },
        ctx(partsUser),
      ),
      'update_item on Document',
    )
    await expectRefusedByRbac(
      updateItemHandler({ itemId: taskId, name: 'Renamed' }, ctx(partsUser)),
      'update_item on Task',
    )

    expect(await nameOf(documentId)).toBe(documentBefore)
    expect(await nameOf(taskId)).toBe(taskBefore)
  })

  it('serves update_item on a Document to a documents grant', async () => {
    const input = { itemId: documentId, name: 'Spec Sheet, revised' }

    const preview = (await updateItemHandler(
      input,
      ctx(documentsUser),
    )) as WriteEnvelope
    expect(preview.requiresConfirmation, 'preview').toBe(true)
    expect(typeof preview.confirmationToken, 'preview token').toBe('string')

    const executed = (await updateItemHandler(
      { ...input, confirmationToken: preview.confirmationToken! },
      ctx(documentsUser),
    )) as WriteEnvelope
    expect(executed.success, 'execute').toBe(true)
    expect(await nameOf(documentId)).toBe('Spec Sheet, revised')
  })

  it('transitions a Task for a tasks grant and refuses the ECO approver', async () => {
    const before = await stateOf(taskId)
    const input = { itemId: taskId, targetState: 'To Do' }

    // The ECO approver holds `change_orders:update` — the tuple this tool used
    // to declare whatever the item's type — and nothing on tasks.
    await expectRefusedByRbac(
      transitionItemStateHandler(input, ctx(ecoUser)),
      'transition Task as ECO approver',
    )
    expect(await stateOf(taskId)).toBe(before)

    const preview = (await transitionItemStateHandler(
      input,
      ctx(tasksUser),
    )) as WriteEnvelope
    expect(preview.requiresConfirmation, 'preview').toBe(true)
    const token = preview.confirmationToken
    expect(typeof token, 'preview token').toBe('string')

    const executed = (await transitionItemStateHandler(
      { ...input, confirmationToken: token! },
      ctx(tasksUser),
    )) as WriteEnvelope
    expect(executed.success, 'execute').toBe(true)
    expect(await stateOf(taskId)).not.toBe(before)
  })

  it('still requires change_orders:update to transition a ChangeOrder', async () => {
    const input = { itemId: changeOrderId, targetState: 'In Review' }

    await expectRefusedByRbac(
      transitionItemStateHandler(input, ctx(tasksUser)),
      'transition ChangeOrder without change_orders:update',
    )

    // The mirror stops at the preview: driving an ECO's workflow is the
    // change-order machinery's business, and what is under test here is only
    // that the wrapper admitted the caller. Reaching a preview at all means it
    // did — the wrapper runs strictly before the handler.
    const preview = (await transitionItemStateHandler(
      input,
      ctx(ecoUser),
    )) as WriteEnvelope
    expect(preview.requiresConfirmation, 'preview').toBe(true)
    expect(typeof preview.confirmationToken, 'preview token').toBe('string')
  })

  it('still requires change_orders:update to route an update through an ECO', async () => {
    const before = await nameOf(releasedPartId)
    const input = {
      itemId: releasedPartId,
      changeOrderId,
      name: 'Released Bracket, revised',
    }

    // `parts:update` clears the wrapper, so this caller does reach the preview
    // and does get a token — the ECO guard lives inside the handler, where the
    // checkout is actually taken, and refuses on the execute leg.
    const preview = (await updateItemHandler(
      input,
      ctx(partsUser),
    )) as WriteEnvelope
    expect(preview.requiresConfirmation, 'preview').toBe(true)

    const refused = (await updateItemHandler(
      { ...input, confirmationToken: preview.confirmationToken! },
      ctx(partsUser),
    )) as WriteEnvelope
    expect(refused.success, 'execute without change_orders:update').toBe(false)
    expect(await nameOf(releasedPartId)).toBe(before)
    // Nothing was checked out either: the guard sits above the checkout.
    expect(await branchItemsForEco()).toBe(0)

    const ecoPreview = (await updateItemHandler(
      input,
      ctx(ecoUser),
    )) as WriteEnvelope
    const executed = (await updateItemHandler(
      { ...input, confirmationToken: ecoPreview.confirmationToken! },
      ctx(ecoUser),
    )) as WriteEnvelope
    expect(executed.success, 'execute with change_orders:update').toBe(true)
    expect(await branchItemsForEco()).toBe(1)
  })

  it('refuses create_relationship from a Document to a parts-only grant, and serves a documents grant', async () => {
    const before = await edgesFrom(documentId)
    // `Document` and `Affects` edges are unconstrained by item type (only
    // `BOM` requires Parts on both ends), so a Document source is enough to
    // show the resource now follows it rather than staying fixed at `parts`.
    const input = {
      sourceItemId: documentId,
      targetItemId: taskId,
      relationshipType: 'Document' as const,
    }

    // The tuple this tool used to hard-code regardless of the source's type.
    await expectRefusedByRbac(
      createRelationshipHandler(input, ctx(partsUser)),
      'create_relationship from a Document as parts-only grant',
    )
    expect(await edgesFrom(documentId)).toBe(before)

    const preview = (await createRelationshipHandler(
      input,
      ctx(documentsUser),
    )) as WriteEnvelope
    expect(preview.requiresConfirmation, 'preview').toBe(true)
    const token = preview.confirmationToken
    expect(typeof token, 'preview token').toBe('string')

    const executed = (await createRelationshipHandler(
      { ...input, confirmationToken: token! },
      ctx(documentsUser),
    )) as WriteEnvelope
    expect(executed.success, 'execute').toBe(true)
    expect(await edgesFrom(documentId)).toBe(before + 1)
  })
})
