// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Pulling a design into a change order, under real concurrency
 *
 * Data-integrity gate. The first item checked out of a design is what links
 * that design to the change order, and the link is three writes decided by
 * three reads: is the design linked, does the `eco/<number>` branch exist, and
 * has the "ChangeOrder created" commit been written. Two engineers touching
 * that design at the same moment both read "no", and the loser's inserts hit
 * `change_order_designs_unique` and `branches_design_name_unique` — a raw
 * 23505, reaching the client as RESOURCE_ALREADY_EXISTS, for an operation
 * whose contract is "associate this design if it is not associated yet". The
 * same reads also decide whether to write the creation commit, so both racers
 * believing they made the branch writes it twice.
 *
 * None of this is reproducible under `TestDatabase`: one connection inside one
 * transaction turns `Promise.all` into a queue, so the two calls never
 * overlap. These use `ConcurrentTestDatabase`, which is a real pool — the
 * calls genuinely interleave and commit, and the harness cleans up after
 * itself.
 *
 * Run: npx vitest run packages/core/src/lib/items/services/ChangeOrderService.race.test.ts
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import type { Part } from '@/lib/items/types/part'
import { ConcurrentTestDatabase } from '@/__tests__/helpers/concurrent-db'
import { insertTestUserWithRole } from '@/__tests__/fixtures/users'
import { ChangeOrderService } from '@/lib/items/services/ChangeOrderService'
import { ItemService } from '@/lib/items/services/ItemService'
import { DesignService } from '@/lib/services/DesignService'
import { isUniqueViolation } from '@/lib/errors/pg'
import { branches, changeOrderDesigns, commits } from '@/lib/db/schema'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

describe('ChangeOrderService — concurrent design association', () => {
  const concurrent = new ConcurrentTestDatabase()

  beforeAll(() => {
    concurrent.setup()
  })

  afterAll(async () => {
    await concurrent.teardown()
  })

  afterEach(async () => {
    await concurrent.cleanup()
  })

  /**
   * A change order against one design, plus a second design in the same
   * program that it does not touch yet — the state in which the next call
   * naming an item of that design is the one that links it.
   */
  async function unlinkedDesign(label: string) {
    const {
      user,
      programId,
      designId: seeded,
    } = await concurrent.seedScope(label)

    const eco = await ChangeOrderService.create(
      { revision: 'A', changeType: 'ECO', name: `Design race ${label}` },
      [seeded],
      user.id,
    )

    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    const design = await DesignService.create(
      {
        programId,
        name: `Unlinked ${label}`,
        code: `CRU-${unique}`,
        designType: 'Engineering',
      },
      user.id,
    )
    concurrent.trackDesign(design.id)

    const parts: Array<Part> = []
    for (const suffix of ['one', 'two']) {
      parts.push(
        await ItemService.create<Part>(
          'Part',
          {
            itemType: 'Part',
            designId: design.id,
            revision: 'A',
            name: `Unlinked ${suffix}`,
            partType: 'Manufacture',
          },
          user.id,
        ),
      )
    }

    const { user: rival } = await insertTestUserWithRole(concurrent.db, 'User')
    concurrent.trackUser(rival.id)

    return {
      changeOrderId: eco.id!,
      ecoNumber: eco.itemNumber!,
      designId: design.id,
      parts,
      owner: user,
      rival,
    }
  }

  async function linksFor(changeOrderId: string, designId: string) {
    return concurrent.db
      .select()
      .from(changeOrderDesigns)
      .where(
        and(
          eq(changeOrderDesigns.changeOrderId, changeOrderId),
          eq(changeOrderDesigns.designId, designId),
        ),
      )
  }

  async function ecoBranchesFor(designId: string, ecoNumber: string) {
    return concurrent.db
      .select()
      .from(branches)
      .where(
        and(
          eq(branches.designId, designId),
          eq(branches.name, `eco/${ecoNumber}`),
        ),
      )
  }

  async function creationCommitsFor(branchId: string, ecoNumber: string) {
    return concurrent.db
      .select()
      .from(commits)
      .where(
        and(
          eq(commits.branchId, branchId),
          eq(commits.message, `ChangeOrder ${ecoNumber} created`),
        ),
      )
  }

  /**
   * The regression itself: a loser must never see the constraint. This is
   * checked before the fulfilment assertion so that a returning 23505 reads as
   * what it is rather than as "expected fulfilled, got rejected".
   */
  function expectNoRawConflict(outcome: PromiseSettledResult<unknown>) {
    if (outcome.status !== 'rejected') return
    expect(isUniqueViolation(outcome.reason)).toBe(false)
  }

  /** Rethrow the underlying failure, which says more than a status assertion. */
  function expectFulfilled<T>(
    outcome: PromiseSettledResult<T>,
  ): PromiseFulfilledResult<T> {
    expectNoRawConflict(outcome)
    if (outcome.status === 'rejected') throw outcome.reason
    return outcome
  }

  it('links the design once when two checkouts race to be its first', async () => {
    const { changeOrderId, ecoNumber, designId, parts, owner, rival } =
      await unlinkedDesign('eco-first-checkout')
    const [first, second] = parts

    const outcomes = await Promise.allSettled([
      ChangeOrderService.checkoutItemToEco(changeOrderId, first!.id!, owner.id),
      ChangeOrderService.checkoutItemToEco(
        changeOrderId,
        second!.id!,
        rival.id,
      ),
    ])

    // Both callers asked for something that is true afterwards either way, so
    // both are owed a success — losing the insert is not a conflict here.
    const [won, alsoWon] = outcomes.map(expectFulfilled)

    const links = await linksFor(changeOrderId, designId)
    expect(links).toHaveLength(1)

    const ecoBranches = await ecoBranchesFor(designId, ecoNumber)
    expect(ecoBranches).toHaveLength(1)

    // Consistent branch ids: whichever call lost the branch insert must have
    // re-resolved onto the winner's branch, and the link must name it.
    expect(alsoWon!.value.branch.id).toBe(won!.value.branch.id)
    expect(links[0]?.branchId).toBe(won!.value.branch.id)
    expect(ecoBranches[0]?.id).toBe(won!.value.branch.id)
  })

  it('links the design once when the same item is checked out twice at once', async () => {
    // The double-click, and the narrowest form of the race: one caller, one
    // item, two calls in flight. Both are the same request, so both succeed.
    const { changeOrderId, ecoNumber, designId, parts, owner } =
      await unlinkedDesign('eco-double-checkout')
    const [only] = parts

    const outcomes = await Promise.allSettled([
      ChangeOrderService.checkoutItemToEco(changeOrderId, only!.id!, owner.id),
      ChangeOrderService.checkoutItemToEco(changeOrderId, only!.id!, owner.id),
    ])

    const [won, alsoWon] = outcomes.map(expectFulfilled)

    expect(await linksFor(changeOrderId, designId)).toHaveLength(1)
    expect(await ecoBranchesFor(designId, ecoNumber)).toHaveLength(1)
    expect(alsoWon!.value.branch.id).toBe(won!.value.branch.id)
    expect(alsoWon!.value.branchItem.id).toBe(won!.value.branchItem.id)
  })

  it('links the design once when two affected-item adds race', async () => {
    // Same association, reached through `ensureDesignAssociation` and from
    // inside a transaction each — where a failed statement aborts the caller's
    // whole transaction, not just the write that failed.
    const { changeOrderId, ecoNumber, designId, parts, owner, rival } =
      await unlinkedDesign('eco-first-add')
    const [first, second] = parts

    const outcomes = await Promise.allSettled([
      ChangeOrderService.addAffectedItem(
        changeOrderId,
        { affectedItemId: first!.id!, changeAction: 'release' },
        owner.id,
      ),
      ChangeOrderService.addAffectedItem(
        changeOrderId,
        { affectedItemId: second!.id!, changeAction: 'release' },
        rival.id,
      ),
    ])

    for (const outcome of outcomes) expectFulfilled(outcome)

    const links = await linksFor(changeOrderId, designId)
    expect(links).toHaveLength(1)

    const ecoBranches = await ecoBranchesFor(designId, ecoNumber)
    expect(ecoBranches).toHaveLength(1)
    expect(links[0]?.branchId).toBe(ecoBranches[0]?.id)

    // Only the caller that actually created the branch writes the registration
    // commit. Both believing they did is how the design's history acquired two
    // of them.
    const created = await creationCommitsFor(ecoBranches[0]!.id, ecoNumber)
    expect(created).toHaveLength(1)
  })
})
