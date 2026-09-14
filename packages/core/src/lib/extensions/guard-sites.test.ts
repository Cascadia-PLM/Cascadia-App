// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The `item.update` guard meets every path an item edit takes.
 *
 * Gate 2. A guard is a policy gate, and a gate with a side door is not one.
 * `ItemService.update` reroutes the first save of a checked-out item — the
 * most common edit on a change-order branch — to `CheckoutService.saveChanges`
 * before its own guard runs, and the branch-edit route calls `saveChanges`
 * directly. Neither dispatched the guard, so a rule on `item.update` saw only
 * in-place edits of rows that were never checked out. The guard now dispatches
 * inside `saveChanges`, for both of its arms.
 *
 * And the intent a guard sees carries lifecycle *flags*, so a rule can mean
 * "released" without comparing a state id to a literal.
 *
 * On the gate harness: a refusal writes nothing, which is what these read, and
 * nothing here reasons about committed seqs.
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
import { ITEM_UPDATE } from './operations'
import { ExtensionRegistry, defineExtension } from './registry'
import { ExtensionRefusedError } from './dispatch'
import { resetExtensionEnablementCache } from './enablement'
import type { ItemUpdateIntent } from './operations'
import type { TestUser } from '@/__tests__/fixtures/users'
import { ItemService } from '@/lib/items/services/ItemService'
import { BranchService } from '@/lib/services/BranchService'
import { CheckoutService } from '@/lib/services/CheckoutService'
import { DesignService } from '@/lib/services/DesignService'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import {
  branchItems,
  lifecycleDefinitions,
  lifecycleInstances,
  programs,
} from '@/lib/db/schema'
import { ItemTypeRegistry } from '@/lib/items/registry'
import { seedStandardPartLifecycle } from '@/__tests__/fixtures/lifecycles'
import { takeFirst } from '@/lib/db/take-first'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

// Unique to this file — avoids races with other files' ECO lifecycles.
const GUARD_SITES_ECO_LIFECYCLE_ID = '00000000-0000-4000-8000-000000000231'

describe('item.update guard coverage', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let designId: string
  let uniquePrefix: string

  beforeAll(async () => {
    await testDb.setup()
    await seedStandardPartLifecycle(testDb.db)
    await testDb.db
      .insert(lifecycleDefinitions)
      .values({
        id: GUARD_SITES_ECO_LIFECYCLE_ID,
        name: 'Test ECO Lifecycle - GuardSites',
        version: 1,
        workflowType: 'strict',
        definition: {
          states: [
            { id: 'Draft', name: 'Draft', isInitial: true, isFinal: false },
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
              name: 'Release',
              fromStateId: 'Draft',
              toStateId: 'Released',
            },
          ],
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
    ExtensionRegistry.clear()
    resetExtensionEnablementCache()
    uniquePrefix = `GS${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`

    user = await insertTestUser(testDb.db)
    const program = takeFirst(
      await testDb.db
        .insert(programs)
        .values({
          name: 'Guard Sites Program',
          code: `PROG-${uniquePrefix}`,
          createdBy: user.id,
        })
        .returning(),
    )
    const design = await DesignService.create(
      {
        programId: program.id,
        name: 'Guard Sites Design',
        code: `DESIGN-${uniquePrefix}`,
        designType: 'Engineering',
      },
      user.id,
    )
    designId = design.id!
  })

  afterEach(async () => {
    ExtensionRegistry.clear()
    resetExtensionEnablementCache()
    await testDb.rollback()
  })

  /** A checked-out part on a change-order branch, ready to be saved. */
  async function checkedOutPart(label: string) {
    const eco = await ItemService.create(
      'ChangeOrder',
      {
        revision: '-',
        name: `Guard Sites ${label} ECO`,
        changeType: 'ECO',
        priority: 'medium',
        reasonForChange: 'Guard coverage',
      } as any,
      user.id,
    )
    await testDb.db.insert(lifecycleInstances).values({
      workflowDefinitionId: GUARD_SITES_ECO_LIFECYCLE_ID,
      itemId: eco.id,
      currentState: 'Draft',
    })
    const { branch } = await BranchService.getOrCreateChangeOrderBranch(
      designId,
      eco.id,
      user.id,
    )
    const part = await ItemService.create(
      'Part',
      {
        itemNumber: `PN-${uniquePrefix}-${label}`,
        revision: '-',
        name: `${label} part`,
        designId,
        state: 'Draft',
      } as any,
      user.id,
    )
    await CheckoutService.checkout(
      { branchId: branch.id, itemMasterId: part.masterId! },
      user.id,
    )
    return { branch, part }
  }

  async function branchRow(branchId: string, masterId: string) {
    const [row] = await testDb.db
      .select()
      .from(branchItems)
      .where(
        and(
          eq(branchItems.branchId, branchId),
          eq(branchItems.itemMasterId, masterId),
        ),
      )
    return row
  }

  it('refuses the first save of a checked-out item, before its working copy is minted', async () => {
    defineExtension({
      id: 'test.guard-sites.frozen-names',
      on: ITEM_UPDATE,
      phase: 'guard',
      handler: ({ intent }) =>
        intent.changedFields.includes('name')
          ? { reason: 'names are frozen' }
          : undefined,
    })
    const { branch, part } = await checkedOutPart('mint')

    await expect(
      CheckoutService.saveChanges(
        {
          branchId: branch.id,
          itemId: part.id,
          changes: { name: 'Renamed' },
          commitMessage: 'First save',
        },
        user.id,
      ),
    ).rejects.toBeInstanceOf(ExtensionRefusedError)

    // Nothing minted: the branch still tracks the shared base version.
    const row = await branchRow(branch.id, part.masterId)
    expect(row?.changeType).toBeNull()
  })

  it('refuses a later save too, once a working copy exists', async () => {
    defineExtension({
      id: 'test.guard-sites.no-second-rename',
      on: ITEM_UPDATE,
      phase: 'guard',
      handler: ({ intent }) =>
        intent.changes.name === 'Renamed twice'
          ? { reason: 'one rename per change order' }
          : undefined,
    })
    const { branch, part } = await checkedOutPart('inplace')

    const first = await CheckoutService.saveChanges(
      {
        branchId: branch.id,
        itemId: part.id,
        changes: { name: 'Renamed once' },
        commitMessage: 'First save',
      },
      user.id,
    )

    await expect(
      CheckoutService.saveChanges(
        {
          branchId: branch.id,
          itemId: part.id,
          changes: { name: 'Renamed twice' },
          commitMessage: 'Second save',
        },
        user.id,
      ),
    ).rejects.toBeInstanceOf(ExtensionRefusedError)

    const workingCopy = await ItemService.findById(first.item.id)
    expect(workingCopy?.name).toBe('Renamed once')
  })

  it('shows the guard lifecycle flags, not only a state id to compare', async () => {
    const seen: Array<ItemUpdateIntent> = []
    defineExtension({
      id: 'test.guard-sites.observer',
      on: ITEM_UPDATE,
      phase: 'guard',
      handler: ({ intent }) => {
        seen.push(intent)
      },
    })
    const { branch, part } = await checkedOutPart('flags')

    await CheckoutService.saveChanges(
      {
        branchId: branch.id,
        itemId: part.id,
        changes: { name: 'Observed' },
        commitMessage: 'Observed save',
      },
      user.id,
    )

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      itemType: 'Part',
      masterId: part.masterId,
      stateIsReleased: false,
      stateIsFinal: false,
      stateFinalKind: null,
      changedFields: ['name'],
    })
  })
})
