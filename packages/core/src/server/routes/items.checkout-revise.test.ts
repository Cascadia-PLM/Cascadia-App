// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Revise-checkout → save — data integrity tests
 *
 * The UI's Revise flow checks a released item out to an ECO branch
 * (`POST /items/:id/checkout`), which mints a branch working copy up front,
 * then edits and saves. These tests pin the contract that flow stands on:
 *
 *  - the checkout response's `branchItem.currentItemId` names the working
 *    copy — a different row of the same master — and the released row is not
 *    touched by the checkout (the detail pages navigate to that id to edit)
 *  - a save addressed to the working copy lands there; the released row on
 *    main keeps its content and stays current
 *  - a save addressed to the released row itself, with no branch, is refused
 *    (BRANCH_PROTECTED) rather than applied — never silently corrupted
 *  - a branch-addressed save (`PUT /items/:id?branchId=`) by the released
 *    row's id lands on the working copy, not the released row
 *  - re-running the checkout returns the same working copy instead of
 *    minting another
 *
 * Run: npx vitest run packages/core/src/server/routes/items.checkout-revise.test.ts
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
import itemsRoutes from './items'
import partsRoutes from './parts'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUserWithRole } from '@/__tests__/fixtures/users'
import { seedStandardPartLifecycle } from '@/__tests__/fixtures/lifecycles'
import { ItemService } from '@/lib/items/services/ItemService'
import { DesignService } from '@/lib/services/DesignService'
import { BranchService } from '@/lib/services/BranchService'
import { SessionManager } from '@/lib/auth/session'
import { permissionService } from '@/lib/auth/permission-service'
import { itemVersions, items, programMembers, programs } from '@/lib/db/schema'
import { takeFirst } from '@/lib/db/take-first'

import '@/lib/items/registerItemTypes.server'

interface CheckoutResponse {
  data: {
    branchItem: {
      currentItemId: string | null
      changeType: string | null
      checkedOutBy: string | null
    }
  }
}

describe('revise-checkout → save', () => {
  const testDb = new TestDatabase()
  const app = new Hono()
    .route('/api/v1/items', itemsRoutes)
    .route('/api/v1/parts', partsRoutes)

  let admin: TestUser
  let cookie: string
  let designId: string
  let ecoBranchId: string
  let part: { id: string; masterId: string }

  beforeAll(async () => {
    await testDb.setup()
    // The revise inference reads the Part lifecycle's mappings — seed the
    // canonical link rather than trusting what another suite left behind.
    await seedStandardPartLifecycle(testDb.db)
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    permissionService.clearCache()

    admin = (await insertTestUserWithRole(testDb.db, 'Administrator')).user

    const program = takeFirst(
      await testDb.db
        .insert(programs)
        .values({
          name: 'Revise Checkout Program',
          code: `PROG-RC-${Date.now()}`,
          createdBy: admin.id,
        })
        .returning(),
    )
    await testDb.db.insert(programMembers).values({
      programId: program.id,
      userId: admin.id,
      role: 'engineer',
    })

    const design = await DesignService.create(
      {
        programId: program.id,
        name: 'Revise Checkout Design',
        code: `DESIGN-RC-${Date.now()}`,
        designType: 'Engineering',
      },
      admin.id,
    )
    designId = design.id

    // A released part on main — the design is post-release, so main is
    // protected and edits must go through a branch working copy.
    const createReleasedPart = (): Promise<{ id: string; masterId: string }> =>
      ItemService.create(
        'Part',
        {
          itemNumber: `PN-RC-${Date.now()}`,
          revision: 'A',
          name: 'Released Name',
          state: 'Released',
          designId,
          partType: 'Manufacture',
        } as never,
        admin.id,
        { bypassBranchProtection: true },
      )
    part = await createReleasedPart()
    await testDb.db.insert(itemVersions).values({
      commitId: design.initialCommit!.id,
      itemId: part.id,
      changeType: 'added',
    })

    const createEco = (): Promise<{ id: string }> =>
      ItemService.create(
        'ChangeOrder',
        {
          revision: 'A',
          name: 'Revise ECO',
          changeType: 'ECO',
          priority: 'medium',
          reasonForChange: 'Revise-checkout test',
          designId,
        } as never,
        admin.id,
      )
    const eco = await createEco()
    const { branch } = await BranchService.getOrCreateEcoBranch(
      designId,
      eco.id,
      admin.id,
    )
    ecoBranchId = branch.id

    cookie = `session=${(await SessionManager.createSession(admin.id)).sessionToken}`
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  function request(path: string, method: string, body?: unknown) {
    return app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  async function checkout(): Promise<string> {
    const res = await request(`/api/v1/items/${part.id}/checkout`, 'POST', {
      branchId: ecoBranchId,
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as CheckoutResponse
    const currentItemId = body.data.branchItem.currentItemId
    expect(currentItemId).toBeTruthy()
    return currentItemId!
  }

  async function itemRow(id: string) {
    return takeFirst(
      await testDb.db.select().from(items).where(eq(items.id, id)).limit(1),
    )
  }

  it('checkout mints a working copy and reports its id; the released row is untouched', async () => {
    const res = await request(`/api/v1/items/${part.id}/checkout`, 'POST', {
      branchId: ecoBranchId,
    })
    expect(res.status).toBe(201)
    const { branchItem } = ((await res.json()) as CheckoutResponse).data

    expect(branchItem.currentItemId).not.toBe(part.id)
    expect(branchItem.changeType).toBe('modified')
    expect(branchItem.checkedOutBy).toBe(admin.id)

    // The copy is its own row of the same master, off to the side of main
    const copy = await itemRow(branchItem.currentItemId!)
    expect(copy.masterId).toBe(part.masterId)
    expect(copy.isCurrent).toBe(false)

    const released = await itemRow(part.id)
    expect(released.name).toBe('Released Name')
    expect(released.state).toBe('Released')
    expect(released.isCurrent).toBe(true)
  })

  it('a save addressed to the working copy lands there; the released row keeps its content', async () => {
    const workingCopyId = await checkout()

    const res = await request(`/api/v1/parts/${workingCopyId}`, 'PUT', {
      name: 'Edited on branch',
      description: 'ECO edit',
    })
    expect(res.status).toBe(200)

    const copy = await itemRow(workingCopyId)
    expect(copy.name).toBe('Edited on branch')

    const released = await itemRow(part.id)
    expect(released.name).toBe('Released Name')
    expect(released.state).toBe('Released')
    expect(released.isCurrent).toBe(true)
  })

  it('a branchless save addressed to the released row is refused, not applied', async () => {
    await checkout()

    const res = await request(`/api/v1/parts/${part.id}`, 'PUT', {
      name: 'Must not land',
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('BRANCH_PROTECTED')

    const released = await itemRow(part.id)
    expect(released.name).toBe('Released Name')
  })

  it('a branch-addressed save by the released row id lands on the working copy', async () => {
    const workingCopyId = await checkout()

    const res = await request(
      `/api/v1/items/${part.id}?branchId=${ecoBranchId}`,
      'PUT',
      { name: 'Edited via base id' },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { item: { id: string } } }
    expect(body.data.item.id).toBe(workingCopyId)

    const copy = await itemRow(workingCopyId)
    expect(copy.name).toBe('Edited via base id')

    const released = await itemRow(part.id)
    expect(released.name).toBe('Released Name')
  })

  it('re-running the checkout returns the same working copy instead of minting another', async () => {
    const first = await checkout()
    const second = await checkout()
    expect(second).toBe(first)

    // Exactly two rows of the master: the released version and one copy
    const rows = await testDb.db
      .select({ id: items.id })
      .from(items)
      .where(eq(items.masterId, part.masterId))
    expect(rows).toHaveLength(2)
  })
})
