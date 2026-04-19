import { z } from 'zod'

/**
 * Payload for thread cache cleanup job
 */
export const cacheCleanupPayloadSchema = z.object({
  /** Maximum age of entries in days (default: 7) */
  maxAgeDays: z.number().int().min(1).max(365).optional().default(7),

  /** Maximum age of invalidated entries in hours (default: 1) */
  maxInvalidatedAgeHours: z
    .number()
    .int()
    .min(1)
    .max(168)
    .optional()
    .default(1),
})

export type CacheCleanupPayload = z.infer<typeof cacheCleanupPayloadSchema>

/**
 * Result of thread cache cleanup job
 */
export const cacheCleanupResultSchema = z.object({
  /** Number of entries removed */
  removed: z.number().int().min(0),

  /** Stats before cleanup */
  statsBefore: z.object({
    totalEntries: z.number().int(),
    validEntries: z.number().int(),
    invalidatedEntries: z.number().int(),
    expiredEntries: z.number().int(),
  }),

  /** Stats after cleanup */
  statsAfter: z.object({
    totalEntries: z.number().int(),
    validEntries: z.number().int(),
    invalidatedEntries: z.number().int(),
    expiredEntries: z.number().int(),
  }),
})

export type CacheCleanupResult = z.infer<typeof cacheCleanupResultSchema>
