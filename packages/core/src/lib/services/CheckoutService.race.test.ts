// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Checkout acquisition under real concurrency
 *
 * Data-integrity gate. A checkout is an exclusive lock — the whole edit model
 * rests on "one person holds this item" — and it was acquired by reading the
 * row, deciding it was free, and then writing. Between those two statements
 * another caller can do the same, and both write. Two people then hold the
 * same exclusive lock, edit the same working copy, and the second save
 * overwrites the first with no conflict raised anywhere.
 *
 * On the other path there is no row yet, both callers find none, and both
 * insert — into a unique index. One of them got a raw 23505 back: a 500
 * naming a database constraint, for what is really "the other tab got there
 * first".
 *
 * Neither could be written before VER-1. `TestDatabase` runs every test on one
 * connection inside one transaction, so `Promise.all` over two service calls
 * is a queue, not a race, and both bugs look impossible. These use
 * `ConcurrentTestDatabase`, which is a real pool — so they commit, and the
 * harness cleans up after itself.
 *
 * Run: npx vitest run packages/core/src/lib/services/CheckoutService.race.test.ts
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { Part } from '@/lib/items/types/part'
import { ConcurrentTestDatabase } from '@/__tests__/helpers/concurrent-db'
import { insertTestUserWithRole } from '@/__tests__/fixtures/users'
import { CheckoutService } from '@/lib/services/CheckoutService'
import { BranchService } from '@/lib/services/BranchService'
import { ItemService } from '@/lib/items/services/ItemService'
import {
  AppError,
  NotFoundError,
  ResourceLockedError,
  ValidationError,
} from '@/lib/errors'
import { isUniqueViolation } from '@/lib/errors/pg'
import {
  branchItems,
  changeOrderAffectedItems,
  changeOrderDesigns,
} from '@/lib/db/schema'
import { ChangeOrderService } from '@/lib/items/services/ChangeOrderService'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

const CONTENDERS = 8

describe('CheckoutService.checkout — concurrent acquisition', () => {
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

  /** A branch, an item on it, and N users all entitled to check it out. */
  async function contendedItem() {
    const { user, designId } = await concurrent.seedScope('checkout-race')

    const part = await ItemService.create<Part>(
      'Part',
      {
        itemType: 'Part',
        designId,
        revision: 'A',
        name: 'Contended Part',
        partType: 'Manufacture',
      },
      user.id,
    )

    const branch = await BranchService.getMainBranch(designId)
    if (!branch) throw new Error('main branch missing')

    const contenders: Array<TestUser> = [user]
    for (let i = 1; i < CONTENDERS; i++) {
      const { user: extra } = await insertTestUserWithRole(
        concurrent.db,
        'User',
      )
      concurrent.trackUser(extra.id)
      contenders.push(extra)
    }

    return { branchId: branch.id, itemMasterId: part.masterId!, contenders }
  }

  async function rowsFor(branchId: string, itemMasterId: string) {
    return concurrent.db
      .select()
      .from(branchItems)
      .where(
        and(
          eq(branchItems.branchId, branchId),
          eq(branchItems.itemMasterId, itemMasterId),
        ),
      )
  }

  it('gives the lock to exactly one of eight simultaneous callers', async () => {
    const { branchId, itemMasterId, contenders } = await contendedItem()

    const outcomes = await Promise.allSettled(
      contenders.map((u) =>
        CheckoutService.checkout({ branchId, itemMasterId }, u.id),
      ),
    )

    const winners = outcomes.filter((o) => o.status === 'fulfilled')
    const losers = outcomes.filter((o) => o.status === 'rejected')

    expect(winners).toHaveLength(1)
    // The class, not the message — a loser must get the conflict the API
    // already models, never a raw driver error.
    for (const loser of losers) {
      expect(loser.reason).toBeInstanceOf(ResourceLockedError)
    }

    // One row, held by the one caller that succeeded.
    const rows = await rowsFor(branchId, itemMasterId)
    expect(rows).toHaveLength(1)
    const winner = (winners[0] as PromiseFulfilledResult<{ id: string }>).value
    expect(rows[0]?.id).toBe(winner.id)
    expect(rows[0]?.checkedOutBy).toBeTruthy()
    expect(contenders.map((u) => u.id).includes(rows[0]!.checkedOutBy!)).toBe(
      true,
    )
  })

  it('gives the lock to exactly one when the row already exists', async () => {
    // The other race. A row exists and is free — checked in, or brought onto
    // the branch and released — so every caller reads "available" and the
    // unguarded UPDATE used to hand all eight of them the same exclusive lock.
    const { branchId, itemMasterId, contenders } = await contendedItem()
    await CheckoutService.checkout(
      { branchId, itemMasterId },
      contenders[0]!.id,
    )
    // Released directly rather than through cancelCheckout, which *deletes* an
    // unchanged row rather than freeing it. The state under test is "row
    // exists, nobody holds it" — what a check-in after real edits leaves.
    await concurrent.db
      .update(branchItems)
      .set({ checkedOutBy: null, checkedOutAt: null })
      .where(
        and(
          eq(branchItems.branchId, branchId),
          eq(branchItems.itemMasterId, itemMasterId),
        ),
      )

    const before = await rowsFor(branchId, itemMasterId)
    expect(before).toHaveLength(1)
    expect(before[0]?.checkedOutBy).toBeNull()

    const outcomes = await Promise.allSettled(
      contenders.map((u) =>
        CheckoutService.checkout({ branchId, itemMasterId }, u.id),
      ),
    )

    const winners = outcomes.filter((o) => o.status === 'fulfilled')
    expect(winners).toHaveLength(1)
    for (const loser of outcomes.filter((o) => o.status === 'rejected')) {
      expect(loser.reason).toBeInstanceOf(ResourceLockedError)
    }

    const rows = await rowsFor(branchId, itemMasterId)
    expect(rows).toHaveLength(1)
    // The holder is the caller that won, not merely the last one to write.
    const winner = (
      winners[0] as PromiseFulfilledResult<{ checkedOutBy: string | null }>
    ).value
    expect(rows[0]?.checkedOutBy).toBe(winner.checkedOutBy)
  })

  it('registers the item on its change order exactly once', async () => {
    // registerBranchChange only does anything on an ECO branch, and only the
    // caller that actually inserted the row should reach it: eight callers
    // registering the same item is eight racing writes to the affected-items
    // list the reviewers read.
    const { user, designId } = await concurrent.seedScope('eco-race')
    const part = await ItemService.create<Part>(
      'Part',
      {
        itemType: 'Part',
        designId,
        revision: 'A',
        name: 'ECO Contended Part',
        partType: 'Manufacture',
      },
      user.id,
    )
    const eco = await ChangeOrderService.create(
      { revision: 'A', changeType: 'ECO', name: 'Race ECO' },
      [designId],
      user.id,
    )
    // The ECO's branch is created with the ECO, and named on the link row.
    const link = await concurrent.db
      .select({ branchId: changeOrderDesigns.branchId })
      .from(changeOrderDesigns)
      .where(
        and(
          eq(changeOrderDesigns.changeOrderId, eco.id!),
          eq(changeOrderDesigns.designId, designId),
        ),
      )
      .limit(1)
    const ecoBranchId = link.at(0)?.branchId
    if (!ecoBranchId) throw new Error('ECO branch missing')

    const contenders: Array<TestUser> = [user]
    for (let i = 1; i < CONTENDERS; i++) {
      const { user: extra } = await insertTestUserWithRole(
        concurrent.db,
        'User',
      )
      concurrent.trackUser(extra.id)
      contenders.push(extra)
    }

    await Promise.allSettled(
      contenders.map((u) =>
        CheckoutService.checkout(
          { branchId: ecoBranchId, itemMasterId: part.masterId! },
          u.id,
        ),
      ),
    )

    const registrations = await concurrent.db
      .select()
      .from(changeOrderAffectedItems)
      .where(
        and(
          eq(changeOrderAffectedItems.changeOrderId, eco.id!),
          eq(changeOrderAffectedItems.affectedItemMasterId, part.masterId!),
        ),
      )

    expect(registrations).toHaveLength(1)
  })

  it('lets the same caller ask eight times and get one row', async () => {
    const { branchId, itemMasterId, contenders } = await contendedItem()
    const [only] = contenders

    const outcomes = await Promise.all(
      Array.from({ length: CONTENDERS }, () =>
        CheckoutService.checkout({ branchId, itemMasterId }, only!.id),
      ),
    )

    // Idempotent: a double-click is not a conflict, and it is not a second row.
    const ids = new Set(outcomes.map((r) => r.id))
    expect(ids.size).toBe(1)

    const rows = await rowsFor(branchId, itemMasterId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.checkedOutBy).toBe(only!.id)
  })

  it('resolves the second checkout after a check-in rather than refusing it', async () => {
    const { branchId, itemMasterId, contenders } = await contendedItem()
    const [first, second] = contenders

    const held = await CheckoutService.checkout(
      { branchId, itemMasterId },
      first!.id,
    )
    expect(held.checkedOutBy).toBe(first!.id)

    await CheckoutService.cancelCheckout(itemMasterId, branchId, first!.id)

    // Free again, so the next caller takes it — the compare-and-set must not
    // have turned a released lock into a permanent refusal.
    const taken = await CheckoutService.checkout(
      { branchId, itemMasterId },
      second!.id,
    )
    expect(taken.checkedOutBy).toBe(second!.id)

    const rows = await rowsFor(branchId, itemMasterId)
    expect(rows).toHaveLength(1)
  })
})

/**
 * Full contention, same as the checkout races above.
 *
 * This was pinned to two for a while: `registerBranchChange` and
 * `unregisterBranchChange` resolved the branch through a pool-bound
 * `BranchService.getById`, so every delete transaction held a second
 * connection while its first was still open, and eight of them on this
 * harness's five-connection pool livelocked waiting on each other. Both now
 * read the branch through the caller's `tx`, so a delete transaction needs
 * exactly one connection for its whole life and eight in flight queue instead
 * of deadlocking.
 *
 * That is what makes this number the ratchet: reintroduce a pool-bound call
 * anywhere inside `deleteOnBranch`'s transaction and this race stops finishing
 * rather than quietly passing at reduced concurrency.
 */
const DELETE_CONTENDERS = CONTENDERS

/**
 * Deleting on a branch under real concurrency
 *
 * Same data-integrity gate, same shape. `deleteOnBranch` read `branch_items`
 * on the pool, decided from that read, and then wrote — including a bare
 * insert into `branch_items_unique`, so the loser of a two-caller race got a
 * raw 23505 back. It also cleared `checkedOutBy` unconditionally, which is
 * how a delete could take an exclusive lock away from the engineer holding
 * it. Both need a real pool to reproduce, for the reason the file header
 * gives.
 */
describe('CheckoutService.deleteOnBranch — concurrent deletes', () => {
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

  /** An ECO branch, a released master it does not track yet, and N users. */
  async function untrackedOnEco(label: string) {
    const { user, designId } = await concurrent.seedScope(label)

    const part = await ItemService.create<Part>(
      'Part',
      {
        itemType: 'Part',
        designId,
        revision: 'A',
        name: 'Contended Deletion',
        partType: 'Manufacture',
      },
      user.id,
    )

    const eco = await ChangeOrderService.create(
      { revision: 'A', changeType: 'ECO', name: 'Delete race ECO' },
      [designId],
      user.id,
    )
    const link = await concurrent.db
      .select({ branchId: changeOrderDesigns.branchId })
      .from(changeOrderDesigns)
      .where(
        and(
          eq(changeOrderDesigns.changeOrderId, eco.id!),
          eq(changeOrderDesigns.designId, designId),
        ),
      )
      .limit(1)
    const branchId = link.at(0)?.branchId
    if (!branchId) throw new Error('ECO branch missing')

    const contenders: Array<TestUser> = [user]
    for (let i = 1; i < DELETE_CONTENDERS; i++) {
      const { user: extra } = await insertTestUserWithRole(
        concurrent.db,
        'User',
      )
      concurrent.trackUser(extra.id)
      contenders.push(extra)
    }

    return {
      branchId,
      changeOrderId: eco.id!,
      itemMasterId: part.masterId!,
      contenders,
    }
  }

  async function deleteRowsFor(branchId: string, itemMasterId: string) {
    return concurrent.db
      .select()
      .from(branchItems)
      .where(
        and(
          eq(branchItems.branchId, branchId),
          eq(branchItems.itemMasterId, itemMasterId),
        ),
      )
  }

  async function scopeRowsFor(changeOrderId: string, itemMasterId: string) {
    return concurrent.db
      .select()
      .from(changeOrderAffectedItems)
      .where(
        and(
          eq(changeOrderAffectedItems.changeOrderId, changeOrderId),
          eq(changeOrderAffectedItems.affectedItemMasterId, itemMasterId),
        ),
      )
  }

  it('mints exactly one deleted row when eight callers delete at once', async () => {
    const { branchId, changeOrderId, itemMasterId, contenders } =
      await untrackedOnEco('delete-race')
    const only = contenders[0]!

    const outcomes = await Promise.allSettled(
      Array.from({ length: DELETE_CONTENDERS }, () =>
        CheckoutService.deleteOnBranch(
          itemMasterId,
          branchId,
          'Deleted concurrently',
          only.id,
        ),
      ),
    )

    expect(outcomes.some((o) => o.status === 'fulfilled')).toBe(true)
    // A loser either falls through onto the row the winner minted, or finds
    // the master already gone from the branch. Neither is a driver error: the
    // bare insert used to surface `branch_items_unique` as a 500.
    for (const loser of outcomes.filter((o) => o.status === 'rejected')) {
      expect(loser.reason).toBeInstanceOf(NotFoundError)
    }

    const rows = await deleteRowsFor(branchId, itemMasterId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.changeType).toBe('deleted')
    expect(rows[0]?.checkedOutBy).toBeNull()

    // Every one of the eight also registers the deletion on the change
    // order, from inside its own transaction. This was deliberately not
    // asserted while `registerBranchChange` was check-then-insert against a
    // table with no unique key; `uq_coai_change_order_master` plus the
    // conflict clause is what makes it hold rather than flake.
    const scope = await scopeRowsFor(changeOrderId, itemMasterId)
    expect(scope).toHaveLength(1)
    expect(scope[0]?.changeAction).toBe('obsolete')
  })

  it('never lets a delete and a checkout both win the same master', async () => {
    const { branchId, itemMasterId, contenders } =
      await untrackedOnEco('delete-vs-checkout')
    const [holder, deleter] = contenders

    const [checkoutOutcome, deleteOutcome] = await Promise.allSettled([
      CheckoutService.checkout({ branchId, itemMasterId }, holder!.id),
      CheckoutService.deleteOnBranch(
        itemMasterId,
        branchId,
        'Deleted while another user checks out',
        deleter!.id,
      ),
    ])

    // One row either way — the two paths must not both insert.
    const rows = await deleteRowsFor(branchId, itemMasterId)
    expect(rows).toHaveLength(1)

    if (deleteOutcome.status === 'rejected') {
      // The checkout got there first, so the delete refused and left the
      // lock standing rather than clearing it out from under the holder.
      expect(deleteOutcome.reason).toBeInstanceOf(ResourceLockedError)
      expect(checkoutOutcome.status).toBe('fulfilled')
      expect(rows[0]?.checkedOutBy).toBe(holder!.id)
      expect(rows[0]?.changeType).not.toBe('deleted')
    } else {
      // The delete got there first. The master is recorded deleted, and the
      // checkout either lost outright or resolved onto that same row.
      expect(rows[0]?.changeType).toBe('deleted')
    }
  })
})

/**
 * The affected-items list under real concurrency
 *
 * Same data-integrity gate, one table over. Three writers put a master into a
 * change order's scope — `addAffectedItem` from the Add dialog,
 * `registerBranchChange` from every path that reaches an ECO branch directly,
 * and `checkoutItemToEco` from the checkout-to-ECO route — and all three did
 * it by selecting, finding nothing, and inserting. Two of them interleaving
 * left the same item listed twice, with two different actions ('revise' and
 * 'obsolete' both validate on their own), and the merge then processed them in
 * unspecified table order: which one the release applied came down to which
 * row came back first.
 *
 * `uq_coai_change_order_master` is what makes the second write impossible;
 * these pin what the loser gets instead. Never a raw 23505 — that was the
 * other half of the same bug on the paths that had no pre-check at all.
 */
describe('ChangeOrderService — concurrent affected-item registration', () => {
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

  /** An ECO with a branch, an item in its design, and nothing in scope yet. */
  async function unscopedOnEco(label: string) {
    const { user, designId } = await concurrent.seedScope(label)

    const part = await ItemService.create<Part>(
      'Part',
      {
        itemType: 'Part',
        designId,
        revision: 'A',
        name: 'Contended Scope Part',
        partType: 'Manufacture',
      },
      user.id,
    )

    const eco = await ChangeOrderService.create(
      { revision: 'A', changeType: 'ECO', name: 'Scope race ECO' },
      [designId],
      user.id,
    )
    const link = await concurrent.db
      .select({ branchId: changeOrderDesigns.branchId })
      .from(changeOrderDesigns)
      .where(
        and(
          eq(changeOrderDesigns.changeOrderId, eco.id!),
          eq(changeOrderDesigns.designId, designId),
        ),
      )
      .limit(1)
    const branchId = link.at(0)?.branchId
    if (!branchId) throw new Error('ECO branch missing')

    const { user: other } = await insertTestUserWithRole(concurrent.db, 'User')
    concurrent.trackUser(other.id)

    return {
      branchId,
      changeOrderId: eco.id!,
      itemId: part.id!,
      itemMasterId: part.masterId!,
      adder: user,
      rival: other,
    }
  }

  async function scopeRowsFor(changeOrderId: string, itemMasterId: string) {
    return concurrent.db
      .select()
      .from(changeOrderAffectedItems)
      .where(
        and(
          eq(changeOrderAffectedItems.changeOrderId, changeOrderId),
          eq(changeOrderAffectedItems.affectedItemMasterId, itemMasterId),
        ),
      )
  }

  /**
   * What a loser is allowed to be. `AppError` is the whole claim: a driver
   * error reaches the client as a 500 naming a database index, which is not
   * an answer to "someone else added this first".
   */
  function expectNoRawConflict(outcome: PromiseSettledResult<unknown>) {
    if (outcome.status !== 'rejected') return
    expect(isUniqueViolation(outcome.reason)).toBe(false)
    expect(outcome.reason).toBeInstanceOf(AppError)
  }

  it('keeps one scope row when the Add dialog races a checkout-to-ECO', async () => {
    const { changeOrderId, itemId, itemMasterId, adder, rival } =
      await unscopedOnEco('scope-add-vs-eco-checkout')

    const outcomes = await Promise.allSettled([
      ChangeOrderService.addAffectedItem(
        changeOrderId,
        { affectedItemId: itemId, changeAction: 'release' },
        adder.id,
      ),
      ChangeOrderService.checkoutItemToEco(changeOrderId, itemId, rival.id),
    ])

    const rows = await scopeRowsFor(changeOrderId, itemMasterId)
    expect(rows).toHaveLength(1)

    const [addOutcome] = outcomes
    // The two paths disagree about what losing means, and both answers are
    // right: the dialog owes the user a sentence, the checkout owes them the
    // row they asked for, which already exists.
    if (addOutcome.status === 'rejected') {
      expect(addOutcome.reason).toBeInstanceOf(ValidationError)
    }
    for (const outcome of outcomes) expectNoRawConflict(outcome)
  })

  it('keeps one scope row when the Add dialog races a branch checkout', async () => {
    const { branchId, changeOrderId, itemId, itemMasterId, adder, rival } =
      await unscopedOnEco('scope-add-vs-branch-checkout')

    const outcomes = await Promise.allSettled([
      ChangeOrderService.addAffectedItem(
        changeOrderId,
        { affectedItemId: itemId, changeAction: 'release' },
        adder.id,
      ),
      CheckoutService.checkout({ branchId, itemMasterId }, rival.id),
    ])

    const rows = await scopeRowsFor(changeOrderId, itemMasterId)
    expect(rows).toHaveLength(1)

    // `registerBranchChange` is idempotent by contract, so the checkout must
    // succeed whichever order the two land in — losing the insert is the
    // no-op it was already promising.
    const [addOutcome, checkoutOutcome] = outcomes
    expect(checkoutOutcome.status).toBe('fulfilled')

    if (addOutcome.status === 'rejected') {
      expect(addOutcome.reason).toBeInstanceOf(ValidationError)
    }
    for (const outcome of outcomes) expectNoRawConflict(outcome)
  })

  it('answers a lost insert with the same refusal as the pre-check', async () => {
    // Deterministic, because the timing-dependent tests above cannot prove
    // which branch they took. `addAffectedItem` runs its duplicate check only
    // for an input naming `affectedItemId`, so an input naming the master
    // alone arrives at the insert with nothing in front of it — the state a
    // caller that lost the race is in. This is what pins the 23505 →
    // ValidationError mapping, and with it the constraint name the catch
    // matches on: rename the index and leave that string behind, and a
    // duplicate goes back to being a 500 naming a database index.
    const { changeOrderId, itemId, itemMasterId, adder } =
      await unscopedOnEco('scope-lost-insert')

    await ChangeOrderService.addAffectedItem(
      changeOrderId,
      { affectedItemId: itemId, changeAction: 'release' },
      adder.id,
    )

    await expect(
      ChangeOrderService.addAffectedItem(
        changeOrderId,
        { affectedItemMasterId: itemMasterId, changeAction: 'obsolete' },
        adder.id,
      ),
    ).rejects.toBeInstanceOf(ValidationError)

    expect(await scopeRowsFor(changeOrderId, itemMasterId)).toHaveLength(1)
  })
})
