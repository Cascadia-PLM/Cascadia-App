// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * CrossDesignReferenceService — data-integrity gate.
 *
 * A cross-design reference is one row in `design_cross_references`, and the
 * whole of its branch semantics lives in three facts about that row: its
 * `branchId`, its `changeType`, and whether it exists at all. Nothing resolves
 * it afterwards — this service *is* the resolver — so a mistake in any one of
 * the write paths stays invisible until an ECO releases and either loses a
 * reference the engineer added or resurrects one they deleted.
 *
 * What this suite pins:
 *
 *  - `createReference` refuses the three inputs that would write a meaningless
 *    row (missing item, design-less item, self-reference) and stamps
 *    branchId/'added' on a branch versus null/null on main;
 *  - `removeReference`'s three-way semantics, each test named for its case: a
 *    row added on a branch and removed on that same branch is physically
 *    deleted, a baseline row removed on a branch gets exactly one idempotent
 *    'deleted' marker however many times it is removed, and a removal on main
 *    physically deletes;
 *  - `getReferencesForDesign` resolves a branch view as baseline + added −
 *    deleted, and never leaks a marker row into the result;
 *  - `pullInReference` is idempotent once the row is gone;
 *  - the release-fidelity invariant: after `mergeReferencesOnRelease`, the main
 *    view equals the pre-merge branch view row for row — not a spot-check of a
 *    few fields, an equality of two resolved views.
 *
 * The release path is exercised at the service seam only.
 * `ChangeOrderMergeService.race.test.ts` owns the concurrency coverage for the
 * transaction this runs inside; repeating it here would buy nothing.
 *
 * Run: npx vitest run packages/core/src/lib/services/CrossDesignReferenceService.test.ts
 */

import { randomUUID } from 'node:crypto'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import { eq } from 'drizzle-orm'
import { CrossDesignReferenceService } from './CrossDesignReferenceService'
import type { CrossDesignReference } from './CrossDesignReferenceService'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import {
  branches,
  designCrossReferences,
  designs,
  items,
  programs,
} from '@/lib/db/schema'
import { takeFirst } from '@/lib/db/take-first'
import { NotFoundError, ValidationError } from '@/lib/errors'

/**
 * A resolved view row reduced to everything a release is *not* allowed to
 * change. `branchId` and `changeType` are the two fields promotion rewrites
 * (branch → null, 'added' → null); every other field — the row identity
 * included — has to survive the merge untouched, which is what makes the
 * comparison a fidelity check rather than a restatement of the merge code.
 */
function fidelityProjection(refs: Array<CrossDesignReference>) {
  return refs
    .map((r) => ({
      id: r.id,
      referencingDesignId: r.referencingDesignId,
      referencedItemId: r.referencedItemId,
      sourceDesignId: r.sourceDesignId,
      inDesignStructure: r.inDesignStructure,
      notes: r.notes,
      createdAt: r.createdAt,
      itemNumber: r.itemNumber,
      itemName: r.itemName,
      itemRevision: r.itemRevision,
      itemState: r.itemState,
      itemType: r.itemType,
      sourceDesignCode: r.sourceDesignCode,
      sourceDesignName: r.sourceDesignName,
    }))
    .sort((a, b) => a.referencedItemId.localeCompare(b.referencedItemId))
}

describe('CrossDesignReferenceService', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let uniquePrefix: string
  /** The design that displays the references. */
  let referencingDesignId: string
  /** The design that owns the referenced items. */
  let sourceDesignId: string
  /** An ECO branch on the referencing design. */
  let branchId: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()

    uniquePrefix = `XR${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    user = await insertTestUser(testDb.db)

    const program = takeFirst(
      await testDb.db
        .insert(programs)
        .values({
          name: 'Cross-Reference Test Program',
          code: `PROG-${uniquePrefix}`,
          createdBy: user.id,
        })
        .returning(),
    )

    referencingDesignId = await insertDesign(program.id, 'REF')
    sourceDesignId = await insertDesign(program.id, 'SRC')

    const branch = takeFirst(
      await testDb.db
        .insert(branches)
        .values({
          designId: referencingDesignId,
          name: `eco/${uniquePrefix}`,
          branchType: 'eco',
          createdBy: user.id,
        })
        .returning(),
    )
    branchId = branch.id
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  async function insertDesign(
    programId: string,
    suffix: string,
  ): Promise<string> {
    const design = takeFirst(
      await testDb.db
        .insert(designs)
        .values({
          programId,
          name: `Cross-Reference ${suffix}`,
          code: `DESIGN-${uniquePrefix}-${suffix}`,
          designType: 'Engineering',
          createdBy: user.id,
        })
        .returning(),
    )
    return design.id
  }

  /** Direct items insert — a bare row is all this service reads. */
  async function insertItemRow(
    designId: string | null,
    suffix: string,
  ): Promise<string> {
    const row = takeFirst(
      await testDb.db
        .insert(items)
        .values({
          itemNumber: `PN-${uniquePrefix}-${suffix}`,
          itemType: 'Part',
          revision: 'A',
          name: `Part ${suffix}`,
          state: 'Draft',
          masterId: randomUUID(),
          designId,
          createdBy: user.id,
          modifiedBy: user.id,
        })
        .returning(),
    )
    return row.id
  }

  /** Every stored row for the referencing design, markers included. */
  async function storedRows() {
    return testDb.db
      .select()
      .from(designCrossReferences)
      .where(eq(designCrossReferences.referencingDesignId, referencingDesignId))
  }

  describe('createReference', () => {
    it('refuses a reference to an item that does not exist', async () => {
      await expect(
        CrossDesignReferenceService.createReference(
          { referencingDesignId, referencedItemId: randomUUID() },
          user.id,
        ),
      ).rejects.toThrow(NotFoundError)

      expect(await storedRows()).toHaveLength(0)
    })

    it('refuses a reference to an item that belongs to no design', async () => {
      // Design-less item types (Task, Issue, WorkOrder) carry designId NULL.
      // There is no source design to denormalize, so the row cannot be written.
      const orphan = await insertItemRow(null, 'ORPHAN')

      await expect(
        CrossDesignReferenceService.createReference(
          { referencingDesignId, referencedItemId: orphan },
          user.id,
        ),
      ).rejects.toThrow(ValidationError)

      expect(await storedRows()).toHaveLength(0)
    })

    it('refuses a reference to an item in the referencing design itself', async () => {
      const local = await insertItemRow(referencingDesignId, 'LOCAL')

      await expect(
        CrossDesignReferenceService.createReference(
          { referencingDesignId, referencedItemId: local },
          user.id,
        ),
      ).rejects.toThrow(ValidationError)

      expect(await storedRows()).toHaveLength(0)
    })

    it("stamps branchId and changeType 'added' when created on a branch", async () => {
      const target = await insertItemRow(sourceDesignId, 'ADDED')

      const ref = await CrossDesignReferenceService.createReference(
        { referencingDesignId, referencedItemId: target, branchId },
        user.id,
      )

      expect(ref.branchId).toBe(branchId)
      expect(ref.changeType).toBe('added')
      // sourceDesignId is denormalized from the item, never from the caller.
      expect(ref.sourceDesignId).toBe(sourceDesignId)
    })

    it('leaves branchId and changeType null when created on main', async () => {
      const target = await insertItemRow(sourceDesignId, 'BASELINE')

      const ref = await CrossDesignReferenceService.createReference(
        { referencingDesignId, referencedItemId: target },
        user.id,
      )

      expect(ref.branchId).toBeNull()
      expect(ref.changeType).toBeNull()
      expect(ref.sourceDesignId).toBe(sourceDesignId)
    })
  })

  describe('removeReference', () => {
    it('throws NotFoundError for a reference id that does not exist', async () => {
      await expect(
        CrossDesignReferenceService.removeReference(
          randomUUID(),
          branchId,
          user.id,
        ),
      ).rejects.toThrow(NotFoundError)
    })

    it("case 'added on this branch': physically deletes the row, leaving no marker", async () => {
      const target = await insertItemRow(sourceDesignId, 'ADDED')
      const ref = await CrossDesignReferenceService.createReference(
        { referencingDesignId, referencedItemId: target, branchId },
        user.id,
      )

      await CrossDesignReferenceService.removeReference(
        ref.id,
        branchId,
        user.id,
      )

      // Adding and then removing on the same branch is a no-op against main:
      // there is nothing to mask, so a marker would be a lie.
      expect(await storedRows()).toHaveLength(0)
    })

    it("case 'baseline removed on a branch': leaves a 'deleted' marker and keeps the baseline row", async () => {
      const target = await insertItemRow(sourceDesignId, 'BASELINE')
      const baseline = await CrossDesignReferenceService.createReference(
        { referencingDesignId, referencedItemId: target },
        user.id,
      )

      await CrossDesignReferenceService.removeReference(
        baseline.id,
        branchId,
        user.id,
      )

      const rows = await storedRows()
      expect(rows).toHaveLength(2)
      // The baseline survives untouched — main must not see the branch's edit.
      const stillBaseline = rows.find((r) => r.id === baseline.id)
      expect(stillBaseline?.branchId).toBeNull()
      expect(stillBaseline?.changeType).toBeNull()
      // The marker is branch-scoped and names the same item.
      const marker = rows.find((r) => r.id !== baseline.id)
      expect(marker?.branchId).toBe(branchId)
      expect(marker?.changeType).toBe('deleted')
      expect(marker?.referencedItemId).toBe(target)
    })

    it("case 'baseline removed on a branch', twice: still exactly one marker", async () => {
      const target = await insertItemRow(sourceDesignId, 'BASELINE')
      const baseline = await CrossDesignReferenceService.createReference(
        { referencingDesignId, referencedItemId: target },
        user.id,
      )

      await CrossDesignReferenceService.removeReference(
        baseline.id,
        branchId,
        user.id,
      )
      // A repeat is a legitimate client retry, not an error: the second insert
      // conflicts on (design, item, branch) and is dropped.
      await CrossDesignReferenceService.removeReference(
        baseline.id,
        branchId,
        user.id,
      )

      const rows = await storedRows()
      expect(rows.filter((r) => r.changeType === 'deleted')).toHaveLength(1)
      expect(rows).toHaveLength(2)
    })

    it("case 'removed on main': physically deletes the row", async () => {
      const target = await insertItemRow(sourceDesignId, 'BASELINE')
      const baseline = await CrossDesignReferenceService.createReference(
        { referencingDesignId, referencedItemId: target },
        user.id,
      )

      await CrossDesignReferenceService.removeReference(
        baseline.id,
        null,
        user.id,
      )

      expect(await storedRows()).toHaveLength(0)
    })
  })

  describe('getReferencesForDesign', () => {
    it('main view returns only baseline refs, never a branch row', async () => {
      const onMain = await insertItemRow(sourceDesignId, 'MAIN')
      const onBranch = await insertItemRow(sourceDesignId, 'BRANCH')

      await CrossDesignReferenceService.createReference(
        { referencingDesignId, referencedItemId: onMain },
        user.id,
      )
      await CrossDesignReferenceService.createReference(
        { referencingDesignId, referencedItemId: onBranch, branchId },
        user.id,
      )

      const view = await CrossDesignReferenceService.getReferencesForDesign(
        referencingDesignId,
        null,
      )

      expect(view.map((r) => r.referencedItemId)).toEqual([onMain])
    })

    it('branch view is baseline + branch-added − branch-deleted, with no marker rows', async () => {
      const kept = await insertItemRow(sourceDesignId, 'KEPT')
      const dropped = await insertItemRow(sourceDesignId, 'DROPPED')
      const added = await insertItemRow(sourceDesignId, 'ADDED')

      await CrossDesignReferenceService.createReference(
        { referencingDesignId, referencedItemId: kept },
        user.id,
      )
      const droppedRef = await CrossDesignReferenceService.createReference(
        { referencingDesignId, referencedItemId: dropped },
        user.id,
      )
      await CrossDesignReferenceService.createReference(
        { referencingDesignId, referencedItemId: added, branchId },
        user.id,
      )
      await CrossDesignReferenceService.removeReference(
        droppedRef.id,
        branchId,
        user.id,
      )

      const branchView =
        await CrossDesignReferenceService.getReferencesForDesign(
          referencingDesignId,
          branchId,
        )

      expect(branchView.map((r) => r.referencedItemId).sort()).toEqual(
        [kept, added].sort(),
      )
      // The marker is bookkeeping, not a reference — it must never surface.
      expect(branchView.some((r) => r.changeType === 'deleted')).toBe(false)

      // Main is unaffected by any of the branch's work.
      const mainView = await CrossDesignReferenceService.getReferencesForDesign(
        referencingDesignId,
        null,
      )
      expect(mainView.map((r) => r.referencedItemId).sort()).toEqual(
        [kept, dropped].sort(),
      )
    })

    it('joins item and source-design metadata onto each row', async () => {
      const target = await insertItemRow(sourceDesignId, 'JOINED')
      await CrossDesignReferenceService.createReference(
        { referencingDesignId, referencedItemId: target },
        user.id,
      )

      const view = await CrossDesignReferenceService.getReferencesForDesign(
        referencingDesignId,
        null,
      )

      expect(view).toHaveLength(1)
      expect(view[0]?.itemNumber).toBe(`PN-${uniquePrefix}-JOINED`)
      expect(view[0]?.sourceDesignCode).toBe(`DESIGN-${uniquePrefix}-SRC`)
    })
  })

  describe('pullInReference', () => {
    it('returns the reference metadata once, then null for the same id', async () => {
      const target = await insertItemRow(sourceDesignId, 'PULLED')
      const ref = await CrossDesignReferenceService.createReference(
        { referencingDesignId, referencedItemId: target, branchId },
        user.id,
      )

      const first = await CrossDesignReferenceService.pullInReference(
        ref.id,
        branchId,
        user.id,
      )
      expect(first).toEqual({
        referencedItemId: target,
        referencingDesignId,
        sourceDesignId,
      })

      // Pull-in is the first half of a usage-copy chain that may be retried;
      // a second call must not throw, it must report there is nothing to do.
      const second = await CrossDesignReferenceService.pullInReference(
        ref.id,
        branchId,
        user.id,
      )
      expect(second).toBeNull()
      expect(await storedRows()).toHaveLength(0)
    })
  })

  describe('mergeReferencesOnRelease', () => {
    it('after release the main view equals the pre-merge branch view, row for row', async () => {
      const kept = await insertItemRow(sourceDesignId, 'KEPT')
      const dropped = await insertItemRow(sourceDesignId, 'DROPPED')
      const added = await insertItemRow(sourceDesignId, 'ADDED')

      // Baseline on main before the ECO opened.
      await CrossDesignReferenceService.createReference(
        { referencingDesignId, referencedItemId: kept, notes: 'kept as-is' },
        user.id,
      )
      const droppedRef = await CrossDesignReferenceService.createReference(
        { referencingDesignId, referencedItemId: dropped },
        user.id,
      )

      // The ECO's work: one reference added, one baseline reference removed.
      await CrossDesignReferenceService.createReference(
        {
          referencingDesignId,
          referencedItemId: added,
          branchId,
          notes: 'added on the ECO',
        },
        user.id,
      )
      await CrossDesignReferenceService.removeReference(
        droppedRef.id,
        branchId,
        user.id,
      )

      const branchViewBefore =
        await CrossDesignReferenceService.getReferencesForDesign(
          referencingDesignId,
          branchId,
        )
      expect(branchViewBefore.map((r) => r.referencedItemId).sort()).toEqual(
        [kept, added].sort(),
      )

      await CrossDesignReferenceService.mergeReferencesOnRelease(
        referencingDesignId,
        branchId,
      )

      const mainViewAfter =
        await CrossDesignReferenceService.getReferencesForDesign(
          referencingDesignId,
          null,
        )

      // The invariant releasing an ECO exists to preserve: what the engineer
      // saw on the branch is exactly what everyone sees on main afterwards.
      expect(fidelityProjection(mainViewAfter)).toEqual(
        fidelityProjection(branchViewBefore),
      )

      // And nothing branch-scoped is left behind to be re-merged.
      const rows = await storedRows()
      expect(rows.map((r) => r.referencedItemId).sort()).toEqual(
        [kept, added].sort(),
      )
      expect(
        rows.every((r) => r.branchId === null && r.changeType === null),
      ).toBe(true)
    })

    it('leaves another branch of the same design untouched', async () => {
      const released = await insertItemRow(sourceDesignId, 'RELEASED')
      const other = await insertItemRow(sourceDesignId, 'OTHER')
      const otherBranch = takeFirst(
        await testDb.db
          .insert(branches)
          .values({
            designId: referencingDesignId,
            name: `eco/${uniquePrefix}-OTHER`,
            branchType: 'eco',
            createdBy: user.id,
          })
          .returning(),
      )

      await CrossDesignReferenceService.createReference(
        { referencingDesignId, referencedItemId: released, branchId },
        user.id,
      )
      const otherRef = await CrossDesignReferenceService.createReference(
        {
          referencingDesignId,
          referencedItemId: other,
          branchId: otherBranch.id,
        },
        user.id,
      )

      await CrossDesignReferenceService.mergeReferencesOnRelease(
        referencingDesignId,
        branchId,
      )

      const rows = await storedRows()
      const untouched = rows.find((r) => r.id === otherRef.id)
      expect(untouched?.branchId).toBe(otherBranch.id)
      expect(untouched?.changeType).toBe('added')
      // Main sees only the released branch's addition.
      const mainView = await CrossDesignReferenceService.getReferencesForDesign(
        referencingDesignId,
        null,
      )
      expect(mainView.map((r) => r.referencedItemId)).toEqual([released])
    })
  })
})
