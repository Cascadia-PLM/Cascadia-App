import { z } from 'zod'

// =============================================================================
// Clone Design Job
// =============================================================================

/**
 * Payload for clone design job
 */
export const cloneDesignPayloadSchema = z.object({
  /** Source design to clone from */
  sourceDesignId: z.string().uuid(),

  /** Target design identity */
  targetCode: z.string().min(1).max(50),
  targetName: z.string().min(1).max(200),
  targetDescription: z.string().optional(),

  /** Optional: clone to different program */
  targetProgramId: z.string().uuid().optional(),

  /** User performing the clone */
  userId: z.string().uuid(),

  /** Whether to suffix cloned item numbers with the target design code */
  suffixItemNumbers: z.boolean().optional(),
})

export type CloneDesignPayload = z.infer<typeof cloneDesignPayloadSchema>

/**
 * Result of clone design job
 */
export const cloneDesignResultSchema = z.object({
  /** New design created */
  designId: z.string().uuid(),
  designCode: z.string(),

  /** Clone statistics */
  itemsCloned: z.number(),
  relationshipsCloned: z.number(),
  derivedFromCreated: z.number(),
  filesReferenced: z.number(),
  crossReferencesCopied: z.number().optional(),
})

export type CloneDesignResult = z.infer<typeof cloneDesignResultSchema>
