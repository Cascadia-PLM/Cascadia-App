import { z } from 'zod'
import type { ItemConflict } from '../ConflictDetectionService'

/**
 * A conflict review record from the database
 */
export interface ConflictReview {
  id: string
  changeOrderId: string
  itemMasterId: string
  conflictType: string
  theirEcoId: string | null
  conflictSignature: string
  reviewedBy: string
  reviewedAt: Date
  notes: string | null
  // Populated from join
  reviewerName?: string
}

/**
 * Request schema for marking a conflict as reviewed
 */
export const markConflictReviewedRequestSchema = z.object({
  itemMasterId: z.string().uuid(),
  conflictType: z.string(),
  theirEcoId: z.string().uuid().nullable().optional(),
  notes: z.string().optional(),
})

export type MarkConflictReviewedRequest = z.infer<
  typeof markConflictReviewedRequestSchema
>

/**
 * An ItemConflict enriched with review status
 */
export interface EnrichedItemConflict extends ItemConflict {
  /** Whether this conflict has been reviewed */
  isReviewed: boolean
  /** The review record if reviewed */
  review?: ConflictReview
  /** Whether the review is stale (conflict has changed since review) */
  needsReReview: boolean
}
