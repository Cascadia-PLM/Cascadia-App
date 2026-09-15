// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { z } from 'zod'
import { jsonValueSchema } from '@/lib/items/types/base'

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
  /**
   * Custom attributes from unmapped columns, at the cell's own type. Mirrors
   * `baseItemSchema`, which takes any JSON document — this used to narrow to
   * strings and the mapper coerced to match, turning every unmapped numeric
   * and boolean column into text on the way in.
   */
  attributes: z.record(z.string(), jsonValueSchema).optional(),
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
  importAsReleased: z.boolean().optional().default(false),
})

export type ImportDocumentsRequest = z.infer<
  typeof importDocumentsRequestSchema
>
