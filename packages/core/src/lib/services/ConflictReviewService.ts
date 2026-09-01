// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { createHash } from 'node:crypto'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db'
import { conflictReviews, users } from '../db/schema'
import type { ItemConflict } from './ConflictDetectionService'
import type {
  ConflictReview,
  EnrichedItemConflict,
} from './types/conflict-review'
import { takeFirst } from '@/lib/db/take-first'

/**
 * Service for managing conflict reviews on ECOs.
 * Allows users to mark warning-level conflicts as "reviewed" to acknowledge
 * they've been seen without necessarily resolving them.
 *
 * Acknowledgements accumulate: each markAsReviewed appends a row rather than
 * replacing the previous one, so every reviewer's note and timestamp survive.
 * The newest acknowledgement for a conflict key is the one that counts for
 * review status; older ones are exposed as history.
 */
export class ConflictReviewService {
  /**
   * Generate a deterministic signature for a conflict.
   * This is used to detect when a conflict has changed since it was reviewed.
   *
   * The signature includes:
   * - itemMasterId
   * - conflictType
   * - theirEcoId (if applicable)
   * - theirItemId (their working copy version)
   * - baseItemId (our base version)
   * - Field conflict details (sorted for consistency)
   */
  static generateConflictSignature(conflict: ItemConflict): string {
    const data = {
      itemMasterId: conflict.itemMasterId,
      conflictType: conflict.conflictType,
      theirEcoId: conflict.theirEcoId || null,
      theirItemId: conflict.theirItemId || null,
      baseItemId: conflict.baseItemId || null,
      // Sort field conflicts by field name for deterministic ordering
      fieldConflicts: [...conflict.fieldConflicts]
        .sort((a, b) => a.fieldName.localeCompare(b.fieldName))
        .map((fc) => ({
          fieldName: fc.fieldName,
          baseValue: fc.baseValue,
          ourValue: fc.ourValue,
          theirValue: fc.theirValue,
        })),
    }

    const hash = createHash('sha256')
    hash.update(JSON.stringify(data))
    return hash.digest('hex').substring(0, 64)
  }

  /**
   * Mark a conflict as reviewed.
   *
   * Always appends a new acknowledgement row — a re-acknowledgement never
   * replaces the previous reviewer's note; it stacks on top of it. Because
   * this is a single insert, two reviewers acknowledging the same conflict
   * concurrently both succeed and both acknowledgements are kept.
   *
   * @param changeOrderId - The ECO's item ID
   * @param conflict - The conflict being reviewed
   * @param userId - User marking the conflict as reviewed
   * @param notes - Optional notes about the review
   * @returns The created review record
   */
  static async markAsReviewed(
    changeOrderId: string,
    conflict: ItemConflict,
    userId: string,
    notes?: string,
  ): Promise<ConflictReview> {
    const signature = this.generateConflictSignature(conflict)

    return takeFirst(
      await db
        .insert(conflictReviews)
        .values({
          changeOrderId,
          itemMasterId: conflict.itemMasterId,
          conflictType: conflict.conflictType,
          theirEcoId: conflict.theirEcoId || null,
          conflictSignature: signature,
          reviewedBy: userId,
          notes: notes || null,
        })
        .returning(),
    )
  }

  /**
   * Remove a review (retract one acknowledgement).
   *
   * Deletes the single acknowledgement row named by id. If an earlier
   * acknowledgement of the same conflict exists, it becomes current again —
   * enrichConflictsWithReviewStatus recomputes status from what remains.
   *
   * @param reviewId - The review record ID to delete
   */
  static async unmarkReview(
    reviewId: string,
    changeOrderId?: string,
  ): Promise<void> {
    // Scoped to the owning ECO when the caller knows it - a review id alone
    // is not authority to clear another change order's review.
    await db
      .delete(conflictReviews)
      .where(
        changeOrderId
          ? and(
              eq(conflictReviews.id, reviewId),
              eq(conflictReviews.changeOrderId, changeOrderId),
            )
          : eq(conflictReviews.id, reviewId),
      )
  }

  /**
   * Get all conflict reviews for an ECO, newest first.
   *
   * A conflict that has been acknowledged more than once contributes one row
   * per acknowledgement; the id tiebreak keeps the order deterministic when
   * two acknowledgements share a timestamp.
   *
   * @param changeOrderId - The ECO's item ID
   * @returns Array of review records with reviewer names
   */
  static async getReviewsForEco(
    changeOrderId: string,
  ): Promise<Array<ConflictReview>> {
    const rows = await db
      .select({
        review: conflictReviews,
        reviewerName: users.name,
      })
      .from(conflictReviews)
      .leftJoin(users, eq(conflictReviews.reviewedBy, users.id))
      .where(eq(conflictReviews.changeOrderId, changeOrderId))
      .orderBy(desc(conflictReviews.reviewedAt), desc(conflictReviews.id))

    return rows.map((row) => ({
      ...row.review,
      reviewerName: row.reviewerName || undefined,
    }))
  }

  /**
   * Check if a review is still valid (conflict hasn't changed).
   *
   * @param review - The existing review record
   * @param currentConflict - The current state of the conflict
   * @returns true if the review is still valid, false if conflict has changed
   */
  static isReviewValid(
    review: ConflictReview,
    currentConflict: ItemConflict,
  ): boolean {
    const currentSignature = this.generateConflictSignature(currentConflict)
    return review.conflictSignature === currentSignature
  }

  /**
   * Enrich a list of conflicts with their review status.
   *
   * A conflict may carry several acknowledgements. The newest one decides
   * review status (and is the one checked for staleness); the full list rides
   * along as reviewHistory so earlier reviewers' notes stay visible.
   *
   * @param changeOrderId - The ECO's item ID
   * @param conflicts - Array of conflicts to enrich
   * @returns Conflicts with review status added
   */
  static async enrichConflictsWithReviewStatus(
    changeOrderId: string,
    conflicts: Array<ItemConflict>,
  ): Promise<Array<EnrichedItemConflict>> {
    // All reviews for this ECO, newest first
    const reviews = await this.getReviewsForEco(changeOrderId)

    // Group by composite key, preserving newest-first order within each group
    const reviewsByKey = new Map<string, Array<ConflictReview>>()
    for (const review of reviews) {
      const key = this.buildReviewKey(
        review.itemMasterId,
        review.conflictType,
        review.theirEcoId,
      )
      const group = reviewsByKey.get(key)
      if (group) {
        group.push(review)
      } else {
        reviewsByKey.set(key, [review])
      }
    }

    // Enrich each conflict
    return conflicts.map((conflict) => {
      const key = this.buildReviewKey(
        conflict.itemMasterId,
        conflict.conflictType,
        conflict.theirEcoId || null,
      )
      const history = reviewsByKey.get(key)
      const current = history?.at(0)

      if (!history || !current) {
        return {
          ...conflict,
          isReviewed: false,
          needsReReview: false,
        }
      }

      const isValid = this.isReviewValid(current, conflict)

      return {
        ...conflict,
        isReviewed: true,
        review: current,
        reviewHistory: history,
        needsReReview: !isValid,
      }
    })
  }

  /**
   * Build a composite key for review lookups.
   */
  private static buildReviewKey(
    itemMasterId: string,
    conflictType: string,
    theirEcoId: string | null,
  ): string {
    return `${itemMasterId}:${conflictType}:${theirEcoId || ''}`
  }
}
