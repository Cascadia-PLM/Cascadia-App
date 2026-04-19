import { z } from 'zod'

/**
 * Single issue row data for import
 */
export const importIssueRowSchema = z.object({
  itemNumber: z.string().max(100).optional(),
  name: z.string().min(1, 'Title is required').max(500),
  description: z.string().max(10000).optional(),
  severity: z.enum(['Critical', 'High', 'Medium', 'Low']).optional(),
  priority: z.enum(['Critical', 'High', 'Medium', 'Low']).optional(),
  category: z
    .enum(['Design', 'Manufacturing', 'Quality', 'Customer', 'Safety', 'Other'])
    .optional(),
  reportedDate: z.string().optional(),
  resolution: z.string().max(10000).optional(),
  rootCause: z.string().max(10000).optional(),
  /** Custom attributes from unmapped columns */
  attributes: z.record(z.string(), z.string()).optional(),
})

export type ImportIssueRow = z.infer<typeof importIssueRowSchema>

/**
 * API request schema for bulk issue import
 */
export const importIssuesRequestSchema = z.object({
  programId: z.string().uuid().optional(),
  rows: z
    .array(importIssueRowSchema)
    .min(1, 'At least one row is required')
    .max(500, 'Maximum 500 rows per import'),
})

export type ImportIssuesRequest = z.infer<typeof importIssuesRequestSchema>
