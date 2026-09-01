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
 * Acknowledgements accumulate: markAsReviewed appends a row per call rather
 * than replacing the previous one, so a re-acknowledgement — including the
 * product's Mark Reviewed button, which sends no notes — can never destroy an
 * earlier reviewer's note. The newest acknowledgement per conflict key decides
 * review status; the rest ride along as reviewHistory.
 *
 * Data-integrity gate: the signature is what stops an acknowledgement from
 * masking a conflict it never covered, and accumulation is what stops a
 * re-acknowledgement from destroying the record of who accepted what and why.
 * Complex-algorithm gate: the signature is a hash over field conflicts that
 * arrive in whatever order detection produced them, so it must sort before
 * hashing or the same conflict hashes two ways and every review looks stale.
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

  /**
   * Backdate a review row. Every insert in one test shares the transaction's
   * now(), so without this "newest acknowledgement wins" would be decided by
   * the random-uuid id tiebreak rather than by time.
   */
  async function backdate(reviewId: string) {
    await testDb.db
      .update(conflictReviews)
      .set({ reviewedAt: new Date('2020-01-01T00:00:00.000Z') })
      .where(eq(conflictReviews.id, reviewId))
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
    it('appends a second acknowledgement and leaves the first note intact', async () => {
      // theirEcoId is non-null, so with the old conflict_reviews_unique
      // constraint still in place the second insert below would raise a
      // unique violation — this test also pins that the constraint is gone.
      const conflict = buildConflict({ theirEcoId: otherEcoId })

      const first = await ConflictReviewService.markAsReviewed(
        ecoId,
        conflict,
        reviewer.id,
        'Coordinating with the other ECO owner',
      )

      const changed = {
        ...conflict,
        fieldConflicts: [weightConflict('2.1')],
      }
      // No notes — the shape the product's Mark Reviewed button sends, and
      // the exact request that used to overwrite the first note with NULL.
      const second = await ConflictReviewService.markAsReviewed(
        ecoId,
        changed,
        secondReviewer.id,
      )

      const rows = await storedReviews()
      expect(rows).toHaveLength(2)
      expect(second.id).not.toBe(first.id)
      expect(second.reviewedBy).toBe(secondReviewer.id)
      expect(second.notes).toBeNull()
      expect(second.conflictSignature).toBe(
        ConflictReviewService.generateConflictSignature(changed),
      )

      const firstStored = rows.find((row) => row.id === first.id)
      expect(firstStored?.notes).toBe('Coordinating with the other ECO owner')
      expect(firstStored?.reviewedBy).toBe(reviewer.id)
      expect(firstStored?.conflictSignature).toBe(first.conflictSignature)
    })

    it('accumulates on the null-theirEcoId path the same way', async () => {
      // The null and non-null paths used to diverge (a hand-rolled upsert
      // with an isNull branch); accumulation must not reintroduce a split.
      const conflict = buildConflict()
      expect(conflict.theirEcoId).toBeUndefined()

      const first = await ConflictReviewService.markAsReviewed(
        ecoId,
        conflict,
        reviewer.id,
        'First look',
      )
      const second = await ConflictReviewService.markAsReviewed(
        ecoId,
        conflict,
        secondReviewer.id,
      )

      const rows = await storedReviews()
      expect(rows).toHaveLength(2)
      expect(rows.every((row) => row.theirEcoId === null)).toBe(true)
      expect(second.id).not.toBe(first.id)
      expect(rows.find((row) => row.id === first.id)?.notes).toBe('First look')
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

    it('surfaces the newest acknowledgement and keeps older ones as history', async () => {
      const conflict = buildConflict({ theirEcoId: otherEcoId })

      const first = await ConflictReviewService.markAsReviewed(
        ecoId,
        conflict,
        reviewer.id,
        'Original rationale',
      )
      await backdate(first.id)
      const second = await ConflictReviewService.markAsReviewed(
        ecoId,
        conflict,
        secondReviewer.id,
      )

      const enriched = takeFirst(
        await ConflictReviewService.enrichConflictsWithReviewStatus(ecoId, [
          conflict,
        ]),
      )

      expect(enriched.isReviewed).toBe(true)
      expect(enriched.review?.id).toBe(second.id)
      expect(enriched.needsReReview).toBe(false)
      // The first reviewer's note is still there, one entry down.
      expect(enriched.reviewHistory?.map((review) => review.id)).toEqual([
        second.id,
        first.id,
      ])
      expect(enriched.reviewHistory?.at(1)?.notes).toBe('Original rationale')
    })

    it('judges staleness against the newest acknowledgement only', async () => {
      const conflict = buildConflict({ theirEcoId: otherEcoId })

      // First acknowledgement covers the conflict as it originally stood…
      const first = await ConflictReviewService.markAsReviewed(
        ecoId,
        conflict,
        reviewer.id,
      )
      await backdate(first.id)

      // …then the conflict moves and someone re-acknowledges the moved form.
      const moved = { ...conflict, fieldConflicts: [weightConflict('2.1')] }
      await ConflictReviewService.markAsReviewed(
        ecoId,
        moved,
        secondReviewer.id,
      )

      // The stale first acknowledgement must not drag the conflict back to
      // needs-re-review while the newest one covers what is there.
      const enriched = takeFirst(
        await ConflictReviewService.enrichConflictsWithReviewStatus(ecoId, [
          moved,
        ]),
      )
      expect(enriched.isReviewed).toBe(true)
      expect(enriched.needsReReview).toBe(false)
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
    it('retracts one acknowledgement and lets the previous one stand again', async () => {
      const conflict = buildConflict({ theirEcoId: otherEcoId })

      const first = await ConflictReviewService.markAsReviewed(
        ecoId,
        conflict,
        reviewer.id,
        'Original rationale',
      )
      await backdate(first.id)
      const second = await ConflictReviewService.markAsReviewed(
        ecoId,
        conflict,
        secondReviewer.id,
      )

      await ConflictReviewService.unmarkReview(second.id, ecoId)

      const enriched = takeFirst(
        await ConflictReviewService.enrichConflictsWithReviewStatus(ecoId, [
          conflict,
        ]),
      )
      expect(enriched.isReviewed).toBe(true)
      expect(enriched.review?.id).toBe(first.id)
      expect(enriched.review?.notes).toBe('Original rationale')
      expect(enriched.reviewHistory).toHaveLength(1)
    })

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
