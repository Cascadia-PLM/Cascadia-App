// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { z } from 'zod'
import { jsonValueSchema } from '@/lib/items/types/base'

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
  /**
   * Custom attributes from unmapped columns, at the cell's own type. Mirrors
   * `baseItemSchema`, which takes any JSON document — this used to narrow to
   * strings and the mapper coerced to match, turning every unmapped numeric
   * and boolean column into text on the way in.
   */
  attributes: z.record(z.string(), jsonValueSchema).optional(),
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
