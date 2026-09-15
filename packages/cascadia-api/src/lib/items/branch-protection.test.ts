// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Branch protection's exemption is derived from the kind of lifecycle an item
 * type is assigned, so what the predicate answers when that kind cannot be
 * resolved decides whether a protected main is actually protected. These
 * tests pin the fail-closed side: a lookup that errors is never an exemption,
 * a type whose kind is unknown is treated as ECO-controlled, and either way
 * no direct write reaches a protected main. The security gate is what earns
 * them a file of their own.
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
import { eq } from 'drizzle-orm'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { seedWorkOrderLifecycle } from '@/__tests__/fixtures/lifecycles'
import { branches, commits, designs, items } from '@/lib/db/schema'
import { takeFirst } from '@/lib/db/take-first'
import { BranchProtectionError } from '@/lib/errors'
import { isBranchProtectionExempt } from '@/lib/items/branch-protection'
import { ItemTypeRegistry } from '@/lib/items/registry'
import { ItemService } from '@/lib/items/services/ItemService'
import { LifecycleService } from '@/lib/services/LifecycleService'
import { LifecycleDefinitionService } from '@/lib/lifecycles/LifecycleDefinitionService'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

/** A well-formed id that no definition row carries. */
const MISSING_DEFINITION_ID = '00000000-0000-4000-8000-00000000dead'

/** A design with a main branch and an initial commit, the way the app makes one. */
async function insertDesignWithMain(
  testDb: TestDatabase,
  userId: string,
  suffix: string,
): Promise<string> {
  const design = takeFirst(
    await testDb.db
      .insert(designs)
      .values({
        name: 'Branch Protection Design',
        code: `BP-${suffix}`,
        designType: 'Engineering',
        createdBy: userId,
      })
      .returning(),
  )
  const mainBranch = takeFirst(
    await testDb.db
      .insert(branches)
      .values({
        designId: design.id,
        name: 'main',
        branchType: 'main',
        createdBy: userId,
      })
      .returning(),
  )
  const initialCommit = takeFirst(
    await testDb.db
      .insert(commits)
      .values({
        designId: design.id,
        branchId: mainBranch.id,
        message: 'Initial commit',
        createdBy: userId,
      })
      .returning(),
  )
  await testDb.db
    .update(branches)
    .set({ headCommitId: initialCommit.id, baseCommitId: initialCommit.id })
    .where(eq(branches.id, mainBranch.id))
  await testDb.db
    .update(designs)
    .set({ defaultBranchId: mainBranch.id })
    .where(eq(designs.id, design.id))
  return design.id
}

describe('isBranchProtectionExempt', () => {
  const testDb = new TestDatabase()

  beforeAll(async () => {
    await testDb.setup()
    // A Free lifecycle this suite can rely on: the shared default seed is
    // first-writer-wins, and other suites re-link Task and Tool.
    await seedWorkOrderLifecycle(testDb.db)
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    // Start every case from a cold memo so the lookup under test really runs
    ItemTypeRegistry.invalidateLifecycleCache()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    ItemTypeRegistry.invalidateLifecycleCache()
    await testDb.rollback()
  })

  it('exempts only the kinds known not to be ECO-controlled', async () => {
    expect(await isBranchProtectionExempt('Part')).toBe(false) // Driven
    expect(await isBranchProtectionExempt('WorkOrder')).toBe(true) // Free
    expect(await isBranchProtectionExempt('ChangeOrder')).toBe(true) // Driving
  })

  it('protects a type with no lifecycle assigned', async () => {
    vi.spyOn(ItemTypeRegistry, 'getLifecycleDefinitionId').mockReturnValue(
      undefined,
    )

    expect(await LifecycleService.getLifecycleType('Part')).toBeNull()
    expect(await isBranchProtectionExempt('Part')).toBe(false)
  })

  it('protects a type whose assigned lifecycle matches no row', async () => {
    vi.spyOn(ItemTypeRegistry, 'getLifecycleDefinitionId').mockReturnValue(
      MISSING_DEFINITION_ID,
    )

    expect(await LifecycleService.getLifecycleType('Part')).toBeNull()
    expect(await isBranchProtectionExempt('Part')).toBe(false)
  })

  it('propagates a failed lookup instead of answering exempt, and does not memoize the failure', async () => {
    vi.spyOn(LifecycleDefinitionService, 'getById').mockRejectedValueOnce(
      new Error('connection reset'),
    )

    await expect(isBranchProtectionExempt('Part')).rejects.toThrow(
      'connection reset',
    )
    // The next lookup reaches the database and answers from it
    expect(await isBranchProtectionExempt('Part')).toBe(false)
  })
})

describe('a protected main whose lifecycle lookup fails', () => {
  const testDb = new TestDatabase()
  let userId: string
  let designId: string
  let suffix: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    ItemTypeRegistry.invalidateLifecycleCache()
    suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    userId = (await insertTestUser(testDb.db)).id
    designId = await insertDesignWithMain(testDb, userId, suffix)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    ItemTypeRegistry.invalidateLifecycleCache()
    await testDb.rollback()
  })

  /** Every lifecycle lookup from here on fails the way a dropped connection does. */
  function failLifecycleLookups(): void {
    ItemTypeRegistry.invalidateLifecycleCache()
    vi.spyOn(LifecycleDefinitionService, 'getById').mockRejectedValue(
      new Error('connection reset'),
    )
  }

  it('refuses a direct create, exactly as it does when the lookup succeeds', async () => {
    // A released Part on main is what protects it
    await testDb.db.insert(items).values({
      masterId: crypto.randomUUID(),
      designId,
      itemNumber: `PN-${suffix}-RELEASED`,
      revision: 'A',
      name: 'Released part',
      itemType: 'Part',
      state: 'Released',
      isCurrent: true,
      createdBy: userId,
      modifiedBy: userId,
    })
    const itemNumber = `PN-${suffix}-DIRECT`
    const attempt = () =>
      ItemService.create(
        'Part',
        { itemNumber, revision: 'A', name: 'Direct write', designId } as any,
        userId,
      )

    // Control: with a healthy lookup the protected main refuses the write
    await expect(attempt()).rejects.toThrow(BranchProtectionError)

    failLifecycleLookups()
    await expect(attempt()).rejects.toThrow()

    const written = await testDb.db
      .select({ id: items.id })
      .from(items)
      .where(eq(items.itemNumber, itemNumber))
    expect(written).toHaveLength(0)
  })

  it('refuses a direct update to a released item, exactly as it does when the lookup succeeds', async () => {
    // Created while main was still open, then released the way a merge would leave it
    const created = await ItemService.create(
      'Part',
      {
        itemNumber: `PN-${suffix}-EDIT`,
        revision: 'A',
        name: 'Released part',
        designId,
      } as any,
      userId,
    )
    await testDb.db
      .update(items)
      .set({ state: 'Released' })
      .where(eq(items.id, created.id))
    const attempt = () =>
      ItemService.update(created.id, { name: 'Edited on main' }, userId)

    await expect(attempt()).rejects.toThrow(BranchProtectionError)

    failLifecycleLookups()
    await expect(attempt()).rejects.toThrow()

    const row = takeFirst(
      await testDb.db
        .select({ name: items.name })
        .from(items)
        .where(eq(items.id, created.id)),
    )
    expect(row.name).toBe('Released part')
  })
})
