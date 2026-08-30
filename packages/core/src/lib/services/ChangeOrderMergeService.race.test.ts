// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * ECO release under real concurrency
 *
 * Data-integrity gate. A release validates its branch and then merges it in a
 * serializable transaction — but validation ran *outside* that transaction,
 * so its answer could go stale: another change order releasing the same item
 * between validation and merge was silently superseded, its released content
 * replaced with the stale branch's. SERIALIZABLE cannot catch the case where
 * the other release commits before this merge's snapshot even opens — no
 * overlap, no 40001 — which is why the merge re-runs the concurrent-
 * modification check as the first statement inside its own transaction.
 *
 * The second bug is the retry path: `withSerializableRetry` re-runs the
 * transaction closure after a 40001, and every accumulator the closure
 * mutated (revisions assigned, item changes, upstream notifications) used to
 * be declared outside it — so a retried release reported its work twice and
 * handed post-commit dispatches item ids from rows the rollback erased.
 *
 * The branchless release — a change order with no branch content, whose
 * affected items are applied directly — carried neither protection until
 * RACE-5. Its two passes are the same check-then-act on the same rows, so two
 * change orders listing one master each read the pre-release state and each
 * minted the revision. They now run SERIALIZABLE under the same retry, with
 * their accumulators moved inside the retry closure.
 *
 * None of these tests could exist before VER-1: under `TestDatabase` every
 * call shares one connection inside one transaction, so two merges cannot
 * overlap and a rollback-retry cannot be observed. These commit for real
 * through `ConcurrentTestDatabase`, and the harness cleans up after itself.
 *
 * Run: npx vitest run packages/core/src/lib/services/ChangeOrderMergeService.race.test.ts
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { and, eq } from 'drizzle-orm'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { Part } from '@/lib/items/types/part'
import { ConcurrentTestDatabase } from '@/__tests__/helpers/concurrent-db'
import { ItemService } from '@/lib/items/services/ItemService'
import { ChangeOrderService } from '@/lib/items/services/ChangeOrderService'
import { ChangeOrderMergeService } from '@/lib/services/ChangeOrderMergeService'
import { BranchService } from '@/lib/services/BranchService'
import { CheckoutService } from '@/lib/services/CheckoutService'
import { MergeConflictError } from '@/lib/errors'
import { pgErrorCode } from '@/lib/db/retry'
import {
  branchItems,
  changeOrderDesigns,
  commits,
  items,
} from '@/lib/db/schema'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

describe('ChangeOrderMergeService — releases under real concurrency', () => {
  const concurrent = new ConcurrentTestDatabase()

  beforeAll(() => {
    concurrent.setup()
  })

  afterAll(async () => {
    await concurrent.teardown()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await concurrent.cleanup()
  })

  /** A part tracked as released on main — the state every ECO branches from. */
  async function seededReleasedPart() {
    const { user, designId } = await concurrent.seedScope('merge-race')

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

    const main = await BranchService.getMainBranch(designId)
    if (!main) throw new Error('main branch missing')

    await concurrent.db.insert(branchItems).values({
      branchId: main.id,
      itemMasterId: part.masterId!,
      currentItemId: part.id!,
      baseItemId: part.id!,
      changeType: null,
    })

    return { user, designId, part, mainBranchId: main.id }
  }

  /**
   * An ECO whose branch holds a real edit to the part — built through the
   * same services a client drives (create, checkout, save), so the branch
   * has a working copy, the affected-items list is registered, and the merge
   * has nothing to complain about except what the test is aiming at.
   */
  async function ecoWithEdit(
    user: TestUser,
    designId: string,
    part: { id?: string; masterId?: string | null },
    label: string,
  ) {
    const eco = await ChangeOrderService.create(
      { revision: 'A', changeType: 'ECO', name: `Race ECO ${label}` },
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

    await CheckoutService.checkout(
      { branchId, itemMasterId: part.masterId! },
      user.id,
    )
    const editedName = `Contended Part edited by ${label}`
    await CheckoutService.saveChanges(
      {
        branchId,
        itemId: part.id!,
        changes: { name: editedName },
        commitMessage: `edit for ${label}`,
      },
      user.id,
    )

    return { ecoId: eco.id!, branchId, editedName }
  }

  async function mainCurrentItem(mainBranchId: string, itemMasterId: string) {
    const row = await concurrent.db
      .select({ item: items })
      .from(branchItems)
      .innerJoin(items, eq(branchItems.currentItemId, items.id))
      .where(
        and(
          eq(branchItems.branchId, mainBranchId),
          eq(branchItems.itemMasterId, itemMasterId),
        ),
      )
      .limit(1)
    return row.at(0)?.item
  }

  /**
   * A part that has never been released — the branchless path's subject.
   *
   * No revision is passed: `ItemService.create` resolves the lifecycle's
   * unreleased marker, so the first release is what mints revision A.
   */
  async function seededDraftPart(label: string) {
    const { user, designId } = await concurrent.seedScope(label)

    const part = await ItemService.create<Part>(
      'Part',
      {
        itemType: 'Part',
        designId,
        name: `Draft Part ${label}`,
        partType: 'Manufacture',
      },
      user.id,
    )

    const main = await BranchService.getMainBranch(designId)
    if (!main) throw new Error('main branch missing')

    await concurrent.db.insert(branchItems).values({
      branchId: main.id,
      itemMasterId: part.masterId!,
      currentItemId: part.id!,
      baseItemId: part.id!,
      changeType: null,
    })

    return { user, designId, part, mainBranchId: main.id }
  }

  /**
   * A change order that releases `part` with no branch content behind it.
   *
   * `release` creates no working copy, so the ECO's branch stays empty,
   * `validateMerge` reports 'no_changes', `mergeBranches` skips it, and
   * `merge()` falls through to `applyAffectedItems` — the pass under test.
   */
  async function branchlessReleaseEco(
    user: TestUser,
    designId: string,
    part: { id?: string },
    label: string,
  ) {
    const eco = await ChangeOrderService.create(
      { revision: 'A', changeType: 'ECO', name: `Branchless ECO ${label}` },
      [designId],
      user.id,
    )
    await ChangeOrderService.addAffectedItem(
      eco.id!,
      { affectedItemId: part.id!, changeAction: 'release' },
      user.id,
    )
    return { ecoId: eco.id! }
  }

  it('lets exactly one of two concurrent conflicting releases win', async () => {
    const { user, designId, part, mainBranchId } = await seededReleasedPart()
    const ecoA = await ecoWithEdit(user, designId, part, 'ECO-A')
    const ecoB = await ecoWithEdit(user, designId, part, 'ECO-B')

    const outcomes = await Promise.allSettled([
      ChangeOrderMergeService.merge(ecoA.ecoId, user.id),
      ChangeOrderMergeService.merge(ecoB.ecoId, user.id),
    ])

    const fulfilledIdx = outcomes.flatMap((o, i) =>
      o.status === 'fulfilled' ? [i] : [],
    )
    const rejected = outcomes.filter((o) => o.status === 'rejected')

    // Exactly one release lands. Which one is timing's choice, never asserted.
    expect(fulfilledIdx).toHaveLength(1)
    expect(rejected).toHaveLength(1)

    // The loser gets the conflict the API models — or, under sustained
    // contention, the underlying retryable conflict once retries exhaust.
    // Never a silent second success, never an unrelated error.
    const reason = (rejected[0] as PromiseRejectedResult).reason as Error
    if (!(reason instanceof MergeConflictError)) {
      expect(['40001', '40P01', '23505']).toContain(pgErrorCode(reason))
    }

    // Main holds the winner's content — nothing reverted, nothing superseded
    // by stale data — and the master has exactly one current version.
    const winner = fulfilledIdx[0] === 0 ? ecoA : ecoB
    const current = await mainCurrentItem(mainBranchId, part.masterId!)
    expect(current).toBeDefined()
    expect(current!.name).toBe(winner.editedName)
    expect(current!.revision).toBe('B')

    const currentRows = await concurrent.db
      .select()
      .from(items)
      .where(and(eq(items.masterId, part.masterId!), eq(items.isCurrent, true)))
    expect(currentRows).toHaveLength(1)
    expect(currentRows[0]!.id).toBe(current!.id)
  })

  it('refuses a merge whose validation ran before another ECO released', async () => {
    // The no-overlap case SERIALIZABLE cannot see: ECO-B commits entirely
    // between ECO-A's validation and A's merge transaction. A's snapshot
    // opens after B's commit, so no serialization failure fires — only the
    // re-check inside the transaction stands between B's release and being
    // silently superseded by A's stale branch.
    const { user, designId, part, mainBranchId } = await seededReleasedPart()
    const ecoA = await ecoWithEdit(user, designId, part, 'ECO-A')
    const ecoB = await ecoWithEdit(user, designId, part, 'ECO-B')

    const validation = await ChangeOrderMergeService.validateMerge(
      ecoA.branchId,
    )
    expect(validation.canMerge).toBe(true)

    await ChangeOrderMergeService.merge(ecoB.ecoId, user.id)

    await expect(
      ChangeOrderMergeService.mergeBranchToMain(
        ecoA.branchId,
        ecoA.ecoId,
        user.id,
      ),
    ).rejects.toThrow(MergeConflictError)

    // B's release is intact.
    const current = await mainCurrentItem(mainBranchId, part.masterId!)
    expect(current!.name).toBe(ecoB.editedName)
    expect(current!.revision).toBe('B')
  })

  it('reports a retried release once, not once per attempt', async () => {
    const { user, designId, part } = await seededReleasedPart()
    const eco = await ecoWithEdit(user, designId, part, 'ECO-RETRY')

    // Force one serialization failure late in the transaction body — after
    // the item loop has filled every accumulator — then let the retry run
    // clean. archiveBranch is the last spy-able call inside the transaction.
    const archiveSpy = vi.spyOn(BranchService, 'archiveBranch')
    archiveSpy.mockImplementationOnce(() => {
      throw Object.assign(new Error('synthetic serialization failure'), {
        code: '40001',
      })
    })

    const result = await ChangeOrderMergeService.merge(eco.ecoId, user.id)

    // The retry actually happened — attempt one aborted at archiveBranch,
    // attempt two ran it for real.
    expect(archiveSpy.mock.calls.length).toBeGreaterThanOrEqual(2)

    // One item released once: no double-counted work from the aborted
    // attempt, no phantom item ids handed to post-commit dispatches.
    const mergeResult = result.designs[0]!.mergeResult
    expect(mergeResult.itemsMerged).toBe(1)
    expect(mergeResult.itemsAdded).toBe(0)
    expect(mergeResult.itemsDeleted).toBe(0)
    expect(mergeResult.changedItems).toHaveLength(1)
    expect(Object.keys(mergeResult.revisionsAssigned)).toHaveLength(1)
    expect(result.totalRevisionsAssigned).toBe(1)

    // Every item id the result names exists — a polluted accumulator carries
    // ids from rolled-back rows.
    const released = await concurrent.db
      .select()
      .from(items)
      .where(and(eq(items.masterId, part.masterId!), eq(items.isCurrent, true)))
    expect(released).toHaveLength(1)
    expect(released[0]!.revision).toBe('B')
    expect(released[0]!.name).toBe(eco.editedName)
  })

  it('settles two concurrent branchless releases on one revision letter', async () => {
    // The branch path's exposure, without a branch: two change orders listing
    // the same master, each reading its state and revision and deciding from
    // them what to write. At READ COMMITTED both read the draft row, both
    // decide a revision is owed, and both mint one — the second overwriting
    // the first's work while reporting it as its own. SERIALIZABLE turns the
    // overlap into a 40001 for whichever loses, and the retry re-reads the
    // released row and correctly does nothing.
    const { user, designId, part, mainBranchId } =
      await seededDraftPart('branchless-race')
    const ecoA = await branchlessReleaseEco(user, designId, part, 'A')
    const ecoB = await branchlessReleaseEco(user, designId, part, 'B')

    const outcomes = await Promise.allSettled([
      ChangeOrderMergeService.merge(ecoA.ecoId, user.id),
      ChangeOrderMergeService.merge(ecoB.ecoId, user.id),
    ])

    // Nothing raw escapes. A release either lands, or loses with the conflict
    // the API models — or, once retries exhaust under sustained contention,
    // with the underlying retryable code. Never an unclassified 23505.
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        const reason = outcome.reason as Error
        if (!(reason instanceof MergeConflictError)) {
          expect(['40001', '40P01', '23505']).toContain(pgErrorCode(reason))
        }
      }
    }

    // One revision letter exists for the master, and exactly one version of
    // it is current.
    const rows = await concurrent.db
      .select()
      .from(items)
      .where(eq(items.masterId, part.masterId!))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.revision).toBe('A')

    const currentRows = rows.filter((r) => r.isCurrent)
    expect(currentRows).toHaveLength(1)

    const current = await mainCurrentItem(mainBranchId, part.masterId!)
    expect(current!.id).toBe(rows[0]!.id)

    // And the releases between them claim exactly the one revision that was
    // actually minted. Two change orders each reporting they assigned it is
    // the check-then-act this test exists for.
    const claimed = outcomes
      .flatMap((o) => (o.status === 'fulfilled' ? [o.value] : []))
      .reduce((sum, r) => sum + r.totalRevisionsAssigned, 0)
    expect(claimed).toBe(1)
  })

  it('reports a retried branchless release once, not once per attempt', async () => {
    const { user, designId, part } = await seededDraftPart('branchless-retry')
    const eco = await branchlessReleaseEco(user, designId, part, 'RETRY')

    // Force one serialization failure at the end of the pass — after the
    // release has been applied and the accumulator filled. archiveBranch is
    // the last spy-able call inside the transaction, as in the branch-merge
    // retry test above.
    const archiveSpy = vi.spyOn(BranchService, 'archiveBranch')
    archiveSpy.mockImplementationOnce(() => {
      throw Object.assign(new Error('synthetic serialization failure'), {
        code: '40001',
      })
    })

    const result = await ChangeOrderMergeService.merge(eco.ecoId, user.id)

    // Attempt one aborted at archiveBranch; attempt two ran it for real.
    expect(archiveSpy.mock.calls.length).toBeGreaterThanOrEqual(2)

    // One revision assigned, counted once. A counter living outside the retry
    // closure reports two.
    expect(result.totalRevisionsAssigned).toBe(1)

    const rows = await concurrent.db
      .select()
      .from(items)
      .where(eq(items.masterId, part.masterId!))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.revision).toBe('A')
    expect(rows[0]!.isCurrent).toBe(true)

    // The aborted attempt's release commit rolled back with it: the change
    // order records its release once, not once per attempt.
    const releaseCommits = await concurrent.db
      .select()
      .from(commits)
      .where(eq(commits.changeOrderItemId, eco.ecoId))
    expect(releaseCommits).toHaveLength(1)
  })

  it('reports a retried remaining-actions pass once, not once per attempt', async () => {
    // The sibling pass, which runs *after* a branch merged and applies the
    // affected items the merge did not: it carries the same accumulator and
    // now the same retry, so it needs the same proof. The change order does
    // both — a branch edit to one part, a state-only release of another.
    const { user, designId, part } = await seededReleasedPart()
    const eco = await ecoWithEdit(user, designId, part, 'ECO-MIXED')

    const stateOnly = await ItemService.create<Part>(
      'Part',
      {
        itemType: 'Part',
        designId,
        name: 'State-only Part',
        partType: 'Manufacture',
      },
      user.id,
    )
    await ChangeOrderService.addAffectedItem(
      eco.ecoId,
      { affectedItemId: stateOnly.id!, changeAction: 'release' },
      user.id,
    )

    // Fail the one write this pass makes for that part, after its revision
    // has been counted. Scoped by item id rather than call ordinal: the
    // branch merge ahead of it never touches this item, so the injection
    // lands in applyRemainingActions and nowhere else.
    const realUpdate = ItemService.update.bind(ItemService)
    let injected = false
    vi.spyOn(ItemService, 'update').mockImplementation(
      async (...args: Parameters<typeof ItemService.update>) => {
        if (!injected && args[0] === stateOnly.id) {
          injected = true
          throw Object.assign(new Error('synthetic serialization failure'), {
            code: '40001',
          })
        }
        return realUpdate(...args)
      },
    )

    const result = await ChangeOrderMergeService.merge(eco.ecoId, user.id)

    expect(injected).toBe(true)

    // Two revisions were minted — B for the branch-merged part, A for the
    // state-only one — and two are reported. A counter outside the retry
    // closure reports three.
    expect(result.totalRevisionsAssigned).toBe(2)

    const merged = await concurrent.db
      .select()
      .from(items)
      .where(and(eq(items.masterId, part.masterId!), eq(items.isCurrent, true)))
    expect(merged[0]!.revision).toBe('B')

    const releasedStateOnly = await concurrent.db
      .select()
      .from(items)
      .where(eq(items.masterId, stateOnly.masterId!))
    expect(releasedStateOnly).toHaveLength(1)
    expect(releasedStateOnly[0]!.revision).toBe('A')
  })
})
