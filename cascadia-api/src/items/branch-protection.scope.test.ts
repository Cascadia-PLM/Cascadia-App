// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Branch protection scope — one verdict per item, under both scopes
 *
 * Security and data-integrity gate. A program's `branchProtectionScope`
 * decides what a protected main refuses: everything (`design`, the default)
 * or only released items and the BOM structure beneath them
 * (`released-items`). `canEditOnMain` is the one place that decides; these
 * tests pin what must hold whichever caller asks.
 *
 *  - A released assembly does not require its children to be released, so a
 *    Draft child — and a grandchild beneath it — is protected under
 *    `released-items`: a field edit, a checkout on main and a BOM line added
 *    under it are all refused. Under `design` they always were.
 *  - A Draft in no released structure is editable on main under
 *    `released-items`, and refused under `design`.
 *  - "Released" is the item as main resolves it, not an arbitrary row of its
 *    master: a stale Draft row of a master main now holds released is not
 *    editable, and cannot be checked out there.
 *  - A new item may go onto main under `released-items`, unless it asks to
 *    start released.
 *  - The edit-context the Edit button reads, the design and branch status
 *    surfaces, and the AI write tools' change-order suggestion all give the
 *    gates' answer.
 *
 * Run: npx vitest run cascadia-api/src/items/branch-protection.scope.test.ts
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
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import type { BranchProtectionScope } from '@cascadia/commons/types/program'
import type { Part } from '@cascadia/commons/items/types/part'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUserWithRole } from '@/__tests__/fixtures/users'
import { SessionManager } from '@/auth/session'
import { permissionService } from '@/auth/permission-service'
import { createItemHandler, updateItemHandler } from '@/ai/tools/write-handlers'
import { items, programs } from '@/db/schema'
import { takeFirst } from '@/db/take-first'
import { BranchProtectionError, ValidationError } from '@/errors'
import { ItemService } from '@/items/services/ItemService'
import branchesRoutes from '@/server/routes/branches'
import designsRoutes from '@/server/routes/designs'
import itemsRoutes from '@/server/routes/items'
import { CheckoutService } from '@/services/CheckoutService'
import { CommitService } from '@/services/CommitService'
import { DesignService } from '@/services/DesignService'

import '@/items/registerItemTypes.server'

interface EditContextResponse {
  data: { editContext: { isMainProtected: boolean } }
}

interface DesignStatusResponse {
  data: {
    protection: {
      isMainBranchProtected: boolean
      branchProtectionScope: BranchProtectionScope
    }
    branchOptions: {
      canEditMainDirectly: boolean
      canCreateOnMain: boolean
      branchProtectionScope: BranchProtectionScope
    }
  }
}

interface BranchStatusResponse {
  data: {
    status: {
      isProtected: boolean
      isEditable: boolean
      branchProtectionScope: BranchProtectionScope
    }
  }
}

interface ToolEnvelope {
  requiresConfirmation: boolean
  suggestCreateChangeOrder?: boolean
}

const SCOPES: Array<BranchProtectionScope> = ['design', 'released-items']

describe('branch protection scope', () => {
  const testDb = new TestDatabase()
  const app = new Hono()
    .route('/api/v1/items', itemsRoutes)
    .route('/api/v1/designs', designsRoutes)
    .route('/api/v1/branches', branchesRoutes)

  let user: TestUser
  let cookie: string
  let programId: string
  let designId: string
  let mainBranchId: string
  let prefix: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    permissionService.clearCache()
    prefix = `BPS-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`

    // Administrator: every type-level grant the gates and tools ask for, and
    // the cross-program reach — nothing here is about RBAC, so nothing may be
    // refused by it.
    user = (await insertTestUserWithRole(testDb.db, 'Administrator')).user
    cookie = `session=${(await SessionManager.createSession(user.id)).sessionToken}`

    programId = takeFirst(
      await testDb.db
        .insert(programs)
        .values({
          name: 'Scope Program',
          code: `P-${prefix}`,
          createdBy: user.id,
        })
        .returning(),
    ).id

    const design = await DesignService.create(
      {
        programId,
        name: 'Scope Design',
        code: `D-${prefix}`,
        designType: 'Engineering',
      },
      user.id,
    )
    designId = design.id
    mainBranchId = design.mainBranch!.id
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  async function setScope(scope: BranchProtectionScope): Promise<void> {
    await testDb.db
      .update(programs)
      .set({ settings: { branchProtectionScope: scope } })
      .where(eq(programs.id, programId))
  }

  /** A Draft part on main, created while main still takes it. */
  async function draftPart(name: string): Promise<Part> {
    return ItemService.create<Part>(
      'Part',
      {
        itemType: 'Part',
        itemNumber: `PN-${prefix}-${name}`,
        name,
        designId,
        partType: 'Manufacture',
      },
      user.id,
    )
  }

  /** Releases a part on main in place — the state a merge leaves it in. */
  async function release(part: Part): Promise<void> {
    await testDb.db
      .update(items)
      .set({ state: 'Released', revision: 'A' })
      .where(eq(items.id, part.id!))
  }

  /**
   * A released assembly A with a Draft child C and a Draft grandchild G
   * beneath it, and a Draft U in no assembly at all. The structure is built
   * while the design is unreleased; then A alone is released, as releasing an
   * assembly allows.
   */
  async function releasedAssemblyWithDraftChildren() {
    const a = await draftPart('ASSY')
    const c = await draftPart('CHILD')
    const g = await draftPart('GRANDCHILD')
    const u = await draftPart('UNRELATED')
    await ItemService.addRelationship(a.id!, c.id!, 'BOM', user.id)
    await ItemService.addRelationship(c.id!, g.id!, 'BOM', user.id)
    await release(a)
    return { a, c, g, u }
  }

  function request(path: string, method = 'GET') {
    return app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    })
  }

  async function editContextSaysProtected(itemId: string): Promise<boolean> {
    const res = await request(`/api/v1/items/${itemId}/edit-context`)
    expect(res.status).toBe(200)
    return ((await res.json()) as EditContextResponse).data.editContext
      .isMainProtected
  }

  /** Whether a direct field edit on main is refused, by the gate itself. */
  async function updateRefused(itemId: string): Promise<boolean> {
    try {
      await ItemService.update(itemId, { name: 'Edited on main' }, user.id)
      return false
    } catch (error) {
      expect(error).toBeInstanceOf(BranchProtectionError)
      return true
    }
  }

  async function checkoutOnMainRefused(masterId: string): Promise<boolean> {
    try {
      await CheckoutService.checkout(
        { itemMasterId: masterId, branchId: mainBranchId },
        user.id,
      )
      return false
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError)
      return true
    }
  }

  async function aiSuggestsChangeOrder(itemId: string): Promise<boolean> {
    const response = (await updateItemHandler(
      { itemId, name: 'Edited by the assistant' },
      { userId: user.id },
    )) as ToolEnvelope
    return response.suggestCreateChangeOrder === true
  }

  describe.each(SCOPES)('under the %s scope', (scope) => {
    beforeEach(async () => {
      await setScope(scope)
    })

    it('protects a Draft child, and its own child, of a released assembly', async () => {
      const { c, g, u } = await releasedAssemblyWithDraftChildren()

      for (const [label, part] of [
        ['child', c],
        ['grandchild', g],
      ] as const) {
        expect(await updateRefused(part.id!), `${label} edit`).toBe(true)
        expect(
          await checkoutOnMainRefused(part.masterId!),
          `${label} checkout on main`,
        ).toBe(true)
      }

      // A BOM line added under the Draft child changes the released
      // assembly's structure as surely as editing the child does.
      await expect(
        ItemService.addRelationship(c.id!, u.id!, 'BOM', user.id),
      ).rejects.toThrow(BranchProtectionError)
    })

    it('gives one verdict per item: the gates, the edit-context and the AI tool agree', async () => {
      const { a, c, g, u } = await releasedAssemblyWithDraftChildren()

      // Only a Draft outside any released structure is editable on main, and
      // only when the program protects released items alone.
      const expected = {
        assembly: true,
        child: true,
        grandchild: true,
        unrelated: scope === 'design',
      }

      for (const [label, part] of [
        ['assembly', a],
        ['child', c],
        ['grandchild', g],
        ['unrelated', u],
      ] as const) {
        const protectedOnMain = expected[label]
        // Read-only answers first; the writes below change nothing they read.
        expect(await aiSuggestsChangeOrder(part.id!), `${label}: AI`).toBe(
          protectedOnMain,
        )
        expect(
          await editContextSaysProtected(part.id!),
          `${label}: edit-context`,
        ).toBe(protectedOnMain)
        expect(
          await checkoutOnMainRefused(part.masterId!),
          `${label}: checkout on main`,
        ).toBe(protectedOnMain)
        expect(await updateRefused(part.id!), `${label}: edit`).toBe(
          protectedOnMain,
        )
      }
    })

    it('decides creation on main the same way everywhere it is asked', async () => {
      await release(await draftPart('BASELINE'))
      const mayCreate = scope === 'released-items'

      const status = await request(`/api/v1/designs/${designId}/status`)
      expect(status.status).toBe(200)
      const { protection, branchOptions } = (
        (await status.json()) as DesignStatusResponse
      ).data
      expect(protection.isMainBranchProtected).toBe(true)
      expect(protection.branchProtectionScope).toBe(scope)
      expect(branchOptions.branchProtectionScope).toBe(scope)
      expect(branchOptions.canCreateOnMain).toBe(mayCreate)
      // v1 meaning kept: not every item on main is editable, under either
      // scope, once main is protected.
      expect(branchOptions.canEditMainDirectly).toBe(false)

      const mainStatus = await request(
        `/api/v1/branches/${mainBranchId}/status`,
      )
      expect(mainStatus.status).toBe(200)
      const branch = ((await mainStatus.json()) as BranchStatusResponse).data
        .status
      expect(branch.isProtected).toBe(true)
      expect(branch.isEditable).toBe(false)
      expect(branch.branchProtectionScope).toBe(scope)

      const ai = (await createItemHandler(
        { itemType: 'Part', name: 'Assistant Draft', designId },
        { userId: user.id },
      )) as ToolEnvelope
      expect(ai.suggestCreateChangeOrder === true).toBe(!mayCreate)

      // One at a time: the harness shares one connection.
      const viaCreate = () =>
        ItemService.create<Part>(
          'Part',
          {
            itemType: 'Part',
            itemNumber: `PN-${prefix}-NEW`,
            name: 'New Draft',
            designId,
            partType: 'Manufacture',
          },
          user.id,
        )
      const viaBranch = () =>
        CheckoutService.createOnBranch(
          {
            designId,
            itemNumber: `PN-${prefix}-NEW-ON-MAIN`,
            itemType: 'Part',
            name: 'New Draft On Main',
          },
          mainBranchId,
          'Added on main',
          user.id,
        )
      if (mayCreate) {
        await expect(viaCreate()).resolves.toBeDefined()
        await expect(viaBranch()).resolves.toBeDefined()
      } else {
        await expect(viaCreate()).rejects.toThrow(BranchProtectionError)
        await expect(viaBranch()).rejects.toThrow(ValidationError)
      }
    })

    it('never lets a new item start released on a protected main', async () => {
      await release(await draftPart('BASELINE'))

      await expect(
        ItemService.create<Part>(
          'Part',
          {
            itemType: 'Part',
            itemNumber: `PN-${prefix}-PLANTED`,
            name: 'Planted Release',
            state: 'Released',
            designId,
            partType: 'Manufacture',
          },
          user.id,
        ),
      ).rejects.toThrow(BranchProtectionError)

      await expect(
        CheckoutService.createOnBranch(
          {
            designId,
            itemNumber: `PN-${prefix}-PLANTED-ON-MAIN`,
            itemType: 'Part',
            name: 'Planted Release On Main',
            state: 'Released',
          },
          mainBranchId,
          'Planted on main',
          user.id,
        ),
      ).rejects.toThrow(ValidationError)
    })
  })

  it('reads "released" from the item as main resolves it, not from any row of its master', async () => {
    await setScope('released-items')

    // A Draft created on main, then released: the old row no longer current,
    // a new version row of the same master committed on main — the shape a
    // release leaves. The Draft row is written first, so a read that takes
    // whichever row of the master comes back first sees a Draft.
    const draft = await draftPart('STALE')
    await testDb.db
      .update(items)
      .set({ isCurrent: false })
      .where(eq(items.id, draft.id!))
    const released = takeFirst(
      await testDb.db
        .insert(items)
        .values({
          masterId: draft.masterId!,
          designId,
          itemNumber: draft.itemNumber!,
          revision: 'A',
          itemType: 'Part',
          name: draft.name,
          state: 'Released',
          isCurrent: true,
          createdBy: user.id,
          modifiedBy: user.id,
        })
        .returning(),
    )
    await CommitService.create(
      {
        branchId: mainBranchId,
        message: 'Release STALE',
        itemChanges: [
          {
            itemId: released.id,
            changeType: 'modified',
            previousItemId: draft.id!,
          },
        ],
      },
      user.id,
    )

    expect(await checkoutOnMainRefused(draft.masterId!)).toBe(true)
    // The stale Draft row is no more editable than the released one.
    expect(await updateRefused(draft.id!)).toBe(true)
    expect(await editContextSaysProtected(draft.id!)).toBe(true)
    expect(await editContextSaysProtected(released.id)).toBe(true)
  })

  it('lets an unprotected Draft change its own structure under the released-items scope', async () => {
    await setScope('released-items')
    const { g, u } = await releasedAssemblyWithDraftChildren()

    // U's structure is U's own: listing a protected part beneath it changes
    // nothing released.
    await expect(
      ItemService.addRelationship(u.id!, g.id!, 'BOM', user.id),
    ).resolves.toBeDefined()
  })
})
