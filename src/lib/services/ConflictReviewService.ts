import { createHash } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../db'
import { conflictReviews, users } from '../db/schema'
import type { ItemConflict } from './ConflictDetectionService'
import type {
  ConflictReview,
  EnrichedItemConflict,
} from './types/conflict-review'

/**
 * Service for managing conflict reviews on ECOs.
 * Allows users to mark warning-level conflicts as "reviewed" to acknowledge
 * they've been seen without necessarily resolving them.
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

    // Upsert: update if exists, insert if not
    const existing = await this.findExistingReview(
      changeOrderId,
      conflict.itemMasterId,
      conflict.conflictType,
      conflict.theirEcoId || null,
    )

    if (existing) {
      // Update existing review with new signature and timestamp
      const [updated] = await db
        .update(conflictReviews)
        .set({
          conflictSignature: signature,
          reviewedBy: userId,
          reviewedAt: new Date(),
          notes: notes || null,
        })
        .where(eq(conflictReviews.id, existing.id))
        .returning()

      return {
        ...updated,
        notes: updated.notes,
      }
    }

    // Insert new review
    const [review] = await db
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
      .returning()

    return {
      ...review,
      notes: review.notes,
    }
  }

  /**
   * Remove a review (unmark a conflict as reviewed).
   *
   * @param reviewId - The review record ID to delete
   */
  static async unmarkReview(reviewId: string): Promise<void> {
    await db.delete(conflictReviews).where(eq(conflictReviews.id, reviewId))
  }

  /**
   * Get all conflict reviews for an ECO.
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
   * @param changeOrderId - The ECO's item ID
   * @param conflicts - Array of conflicts to enrich
   * @returns Conflicts with review status added
   */
  static async enrichConflictsWithReviewStatus(
    changeOrderId: string,
    conflicts: Array<ItemConflict>,
  ): Promise<Array<EnrichedItemConflict>> {
    // Get all reviews for this ECO
    const reviews = await this.getReviewsForEco(changeOrderId)

    // Build a lookup map by composite key
    const reviewMap = new Map<string, ConflictReview>()
    for (const review of reviews) {
      const key = this.buildReviewKey(
        review.itemMasterId,
        review.conflictType,
        review.theirEcoId,
      )
      reviewMap.set(key, review)
    }

    // Enrich each conflict
    return conflicts.map((conflict) => {
      const key = this.buildReviewKey(
        conflict.itemMasterId,
        conflict.conflictType,
        conflict.theirEcoId || null,
      )
      const review = reviewMap.get(key)

      if (!review) {
        return {
          ...conflict,
          isReviewed: false,
          needsReReview: false,
        }
      }

      const isValid = this.isReviewValid(review, conflict)

      return {
        ...conflict,
        isReviewed: true,
        review,
        needsReReview: !isValid,
      }
    })
  }

  /**
   * Find an existing review by composite key.
   */
  private static async findExistingReview(
    changeOrderId: string,
    itemMasterId: string,
    conflictType: string,
    theirEcoId: string | null,
  ): Promise<ConflictReview | null> {
    const conditions = [
      eq(conflictReviews.changeOrderId, changeOrderId),
      eq(conflictReviews.itemMasterId, itemMasterId),
      eq(conflictReviews.conflictType, conflictType),
    ]

    // Handle null theirEcoId - need different query condition
    if (theirEcoId === null) {
      conditions.push(isNull(conflictReviews.theirEcoId))
    } else {
      conditions.push(eq(conflictReviews.theirEcoId, theirEcoId))
    }

    const rows = await db
      .select()
      .from(conflictReviews)
      .where(and(...conditions))
      .limit(1)

    return rows.at(0) || null
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
