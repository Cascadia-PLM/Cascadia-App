import { z } from 'zod'

/**
 * Single document row data for import
 */
export const importDocumentRowSchema = z.object({
  itemNumber: z.string().max(100).optional(),
  name: z.string().min(1, 'Name is required').max(500),
  revision: z.string().min(1).max(10).default('-'),
  description: z.string().max(5000).optional(),
  docType: z
    .enum([
      'Specification',
      'Drawing',
      'Procedure',
      'Manual',
      'Report',
      'Other',
    ])
    .optional(),
  fileName: z.string().max(500).optional(),
  mimeType: z.string().max(100).optional(),
  /** Custom attributes from unmapped columns (converted to strings) */
  attributes: z.record(z.string(), z.string()).optional(),
})

export type ImportDocumentRow = z.infer<typeof importDocumentRowSchema>

/**
 * API request schema for bulk document import
 */
export const importDocumentsRequestSchema = z.object({
  designId: z.string().uuid({ message: 'Design ID is required' }),
  branchId: z.string().uuid().optional(),
  rows: z
    .array(importDocumentRowSchema)
    .min(1, 'At least one row is required')
    .max(500, 'Maximum 500 rows per import'),
  bypassBranchProtection: z.boolean().optional().default(false),
})

export type ImportDocumentsRequest = z.infer<
  typeof importDocumentsRequestSchema
>
