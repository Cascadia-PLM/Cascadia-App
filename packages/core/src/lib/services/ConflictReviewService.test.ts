// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * ConflictReviewService Tests
 *
 * A conflict review is an acknowledgement, not a resolution: an engineer marks
 * a warning-level merge conflict as "seen" so it stops counting against the
 * ECO's unreviewed-warning tally. The acknowledgement is only honest for as
 * long as the conflict it acknowledged is the conflict that is still there —
 * so every review stores a signature of the conflict's content, and a review
 * whose signature no longer matches is reported back as needing re-review.
 * Without that, editing the item after acknowledgement would leave a stale
 * "reviewed" badge sitting on top of a changed conflict, and the change would
 * reach release unseen.
 *
 * Data-integrity gate: the signature is what stops an acknowledgement from
 * masking a conflict it never covered. Complex-algorithm gate: the signature
 * is a hash over field conflicts that arrive in whatever order detection
 * produced them, so it must sort before hashing or the same conflict hashes
 * two ways and every review looks stale.
 *
 * The suite tests the service contract the four /conflict-reviews endpoints
 * consume; it does not run detection itself, which is covered by
 * ConflictDetectionService.test.ts.
 *
 * Run: npx vitest run packages/core/src/lib/services/ConflictReviewService.test.ts
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
import { eq } from 'drizzle-orm'
import { ConflictReviewService } from './ConflictReviewService'
import type { FieldConflict, ItemConflict } from './ConflictDetectionService'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { insertTestChangeOrder } from '@/__tests__/fixtures/items'
import { conflictReviews } from '@/lib/db/schema'
import { takeFirst } from '@/lib/db/take-first'

/** A field conflict on `weight`, parameterised by what the other side holds. */
function weightConflict(theirValue: string): FieldConflict {
  return {
    fieldName: 'weight',
    baseValue: '2.5',
    ourValue: '2.4',
    theirValue,
  }
}

/** A second field conflict, so ordering has something to permute. */
const materialConflict: FieldConflict = {
  fieldName: 'material',
  baseValue: 'AL-6061',
  ourValue: 'AL-7075',
  theirValue: 'Ti-6Al-4V',
}

describe('ConflictReviewService', () => {
  const testDb = new TestDatabase()

  let reviewer: TestUser
  let secondReviewer: TestUser
  /** The ECO whose reviews are under test. */
  let ecoId: string
  /** A second ECO — the other side of a cross-ECO conflict, and the wrong
   * owner in the unmark-scoping test. */
  let otherEcoId: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()

    reviewer = await insertTestUser(testDb.db)
    secondReviewer = await insertTestUser(testDb.db)

    // conflict_reviews.changeOrderId and theirEcoId both FK items.id, so the
    // ECOs have to be real rows. ECOs carry a null designId in this codebase.
    const eco = await insertTestChangeOrder(testDb.db, null, reviewer.id)
    ecoId = eco.item.id
    const otherEco = await insertTestChangeOrder(testDb.db, null, reviewer.id)
    otherEcoId = otherEco.item.id
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  /**
   * A warning-level conflict of the shape detection produces for an item
   * co-modified by another ECO. Spread the result to vary one facet while
   * keeping the composite identity — that is how a "changed" conflict is
   * expressed below.
   */
  function buildConflict(overrides: Partial<ItemConflict> = {}): ItemConflict {
    return {
      itemMasterId: crypto.randomUUID(),
      itemNumber: 'PN-000123',
      itemName: 'Bracket',
      conflictType: 'cross_eco',
      severity: 'warning',

      ourBranchItemId: crypto.randomUUID(),
      ourItemId: crypto.randomUUID(),
      ourRevision: 'A',
      ourBranchId: crypto.randomUUID(),
      ourBranchName: 'This ECO',

      theirItemId: crypto.randomUUID(),
      baseItemId: crypto.randomUUID(),

      fieldConflicts: [weightConflict('2.6')],
      ...overrides,
    }
  }

  /** Every review row currently stored against the ECO under test. */
  async function storedReviews(changeOrderId: string = ecoId) {
    return testDb.db
      .select()
      .from(conflictReviews)
      .where(eq(conflictReviews.changeOrderId, changeOrderId))
  }

  describe('generateConflictSignature', () => {
    it('does not depend on the order detection emitted field conflicts in', () => {
      const identity = {
        itemMasterId: crypto.randomUUID(),
        theirItemId: crypto.randomUUID(),
        baseItemId: crypto.randomUUID(),
      }
      const weightFirst = buildConflict({
        ...identity,
        fieldConflicts: [weightConflict('2.6'), materialConflict],
      })
      const materialFirst = buildConflict({
        ...identity,
        fieldConflicts: [materialConflict, weightConflict('2.6')],
      })

      const signature =
        ConflictReviewService.generateConflictSignature(weightFirst)

      expect(
        ConflictReviewService.generateConflictSignature(materialFirst),
      ).toBe(signature)
      // conflict_signature is varchar(64); a wider digest would fail to insert.
      expect(signature).toHaveLength(64)
    })

    it('changes when any part of the conflict it acknowledges changes', () => {
      const base = buildConflict()
      const baseline = ConflictReviewService.generateConflictSignature(base)

      const mutations: Array<[string, ItemConflict]> = [
        ['itemMasterId', { ...base, itemMasterId: crypto.randomUUID() }],
        ['conflictType', { ...base, conflictType: 'concurrent_modification' }],
        ['theirEcoId', { ...base, theirEcoId: crypto.randomUUID() }],
        ['theirItemId', { ...base, theirItemId: crypto.randomUUID() }],
        ['baseItemId', { ...base, baseItemId: crypto.randomUUID() }],
        ['a field value', { ...base, fieldConflicts: [weightConflict('2.1')] }],
        [
          'an added field conflict',
          {
            ...base,
            fieldConflicts: [weightConflict('2.6'), materialConflict],
          },
        ],
      ]

      for (const [what, mutated] of mutations) {
        expect(
          ConflictReviewService.generateConflictSignature(mutated),
          `changing ${what} must change the signature`,
        ).not.toBe(baseline)
      }
    })
  })

  describe('markAsReviewed', () => {
    it('updates the existing acknowledgement instead of adding a second one', async () => {
      const conflict = buildConflict({ theirEcoId: otherEcoId })

      const first = await ConflictReviewService.markAsReviewed(
        ecoId,
        conflict,
        reviewer.id,
        'Coordinating with the other ECO owner',
      )

      // Backdate so the refresh is observable rather than same-millisecond.
      const backdated = new Date('2020-01-01T00:00:00.000Z')
      await testDb.db
        .update(conflictReviews)
        .set({ reviewedAt: backdated })
        .where(eq(conflictReviews.id, first.id))

      const changed = {
        ...conflict,
        fieldConflicts: [weightConflict('2.1')],
      }
      const second = await ConflictReviewService.markAsReviewed(
        ecoId,
        changed,
        secondReviewer.id,
        'Re-acknowledged after the other ECO moved',
      )

      expect(await storedReviews()).toHaveLength(1)
      expect(second.id).toBe(first.id)
      expect(second.conflictSignature).toBe(
        ConflictReviewService.generateConflictSignature(changed),
      )
      expect(second.conflictSignature).not.toBe(first.conflictSignature)
      expect(second.reviewedBy).toBe(secondReviewer.id)
      expect(second.notes).toBe('Re-acknowledged after the other ECO moved')
      expect(second.reviewedAt.getTime()).toBeGreaterThan(backdated.getTime())
    })

    it('updates rather than duplicating when theirEcoId is null', async () => {
      // Postgres treats NULLs as distinct, so conflict_reviews_unique cannot
      // catch a duplicate on this path — findExistingReview's isNull branch is
      // the only thing holding it. Were that branch an `eq(col, null)`, the
      // lookup would find nothing, the insert would succeed, and the ECO would
      // carry two acknowledgements of one conflict.
      const conflict = buildConflict()
      expect(conflict.theirEcoId).toBeUndefined()

      const first = await ConflictReviewService.markAsReviewed(
        ecoId,
        conflict,
        reviewer.id,
      )
      const second = await ConflictReviewService.markAsReviewed(
        ecoId,
        { ...conflict, fieldConflicts: [weightConflict('2.1')] },
        reviewer.id,
      )

      const rows = await storedReviews()
      expect(rows).toHaveLength(1)
      expect(takeFirst(rows).theirEcoId).toBeNull()
      expect(second.id).toBe(first.id)
      expect(second.conflictSignature).not.toBe(first.conflictSignature)
    })

    it('keeps acknowledgements of different conflicts on one item apart', async () => {
      const conflict = buildConflict()

      await ConflictReviewService.markAsReviewed(ecoId, conflict, reviewer.id)
      await ConflictReviewService.markAsReviewed(
        ecoId,
        { ...conflict, conflictType: 'concurrent_modification' },
        reviewer.id,
      )
      await ConflictReviewService.markAsReviewed(
        ecoId,
        { ...conflict, theirEcoId: otherEcoId },
        reviewer.id,
      )

      expect(await storedReviews()).toHaveLength(3)
    })
  })

  describe('enrichConflictsWithReviewStatus', () => {
    it('reports an unacknowledged conflict as neither reviewed nor stale', async () => {
      const enriched = takeFirst(
        await ConflictReviewService.enrichConflictsWithReviewStatus(ecoId, [
          buildConflict(),
        ]),
      )

      expect(enriched.isReviewed).toBe(false)
      expect(enriched.needsReReview).toBe(false)
      expect(enriched.review).toBeUndefined()
    })

    it('flags a conflict that changed under its acknowledgement as needing re-review', async () => {
      const conflict = buildConflict({ theirEcoId: otherEcoId })
      const review = await ConflictReviewService.markAsReviewed(
        ecoId,
        conflict,
        reviewer.id,
      )

      // Control: the acknowledgement covers the conflict as it stands.
      const asReviewed = takeFirst(
        await ConflictReviewService.enrichConflictsWithReviewStatus(ecoId, [
          conflict,
        ]),
      )
      expect(asReviewed.isReviewed).toBe(true)
      expect(asReviewed.needsReReview).toBe(false)
      expect(asReviewed.review?.id).toBe(review.id)

      // The other ECO moves the field on again. Same composite key, so the
      // acknowledgement still attaches — but it no longer covers what is there,
      // and the conflict must not go back to the user looking settled.
      const moved = { ...conflict, fieldConflicts: [weightConflict('2.1')] }
      const asStale = takeFirst(
        await ConflictReviewService.enrichConflictsWithReviewStatus(ecoId, [
          moved,
        ]),
      )
      expect(asStale.isReviewed).toBe(true)
      expect(asStale.needsReReview).toBe(true)
      expect(asStale.review?.id).toBe(review.id)
    })

    it('does not let one ECO acknowledgement settle another ECO conflict', async () => {
      const conflict = buildConflict()
      await ConflictReviewService.markAsReviewed(ecoId, conflict, reviewer.id)

      const enriched = takeFirst(
        await ConflictReviewService.enrichConflictsWithReviewStatus(
          otherEcoId,
          [conflict],
        ),
      )

      expect(enriched.isReviewed).toBe(false)
      expect(enriched.needsReReview).toBe(false)
    })
  })

  describe('unmarkReview', () => {
    it('will not clear a review through the wrong change order', async () => {
      const review = await ConflictReviewService.markAsReviewed(
        ecoId,
        buildConflict(),
        reviewer.id,
      )

      // A review id on its own is not authority over someone else's ECO.
      await ConflictReviewService.unmarkReview(review.id, otherEcoId)
      expect(await storedReviews()).toHaveLength(1)

      // …and the guard is scoping, not inertness: the owner can still clear it.
      await ConflictReviewService.unmarkReview(review.id, ecoId)
      expect(await storedReviews()).toHaveLength(0)
    })
  })
})
