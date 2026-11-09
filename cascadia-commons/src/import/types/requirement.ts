// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { z } from 'zod'
import { jsonValueSchema } from '../../items/types/base'
import {
  requirementPrioritySchema,
  requirementTypeSchema,
  verificationMethodSchema,
} from '../../items/types/requirement'
import type { ImportResult } from '../types'

/**
 * A sheet writes an enum the way a person does — `Must Have`, `must-have`,
 * `non functional` — and the column stores it the way the schema spells it.
 * Letters alone decide the match, so every spelling of one value lands on
 * it and an unknown value still fails the schema with its own message.
 */
function spelledAs(options: ReadonlyArray<string>) {
  const lettersOf = (value: string) =>
    value.toLowerCase().replace(/[^a-z]/g, '')
  const byLetters = new Map(
    options.map((option) => [lettersOf(option), option]),
  )
  return (value: unknown): unknown =>
    typeof value === 'string'
      ? (byLetters.get(lettersOf(value)) ?? value)
      : value
}

/**
 * Single requirement row data for import
 */
export const importRequirementRowSchema = z.object({
  itemNumber: z.string().max(100).optional(),
  name: z.string().min(1, 'Title is required').max(500),
  revision: z.string().min(1).max(10).default('-'),
  description: z.string().max(10000).optional(),
  type: z.preprocess(
    spelledAs(requirementTypeSchema.options),
    requirementTypeSchema.optional(),
  ),
  priority: z.preprocess(
    spelledAs(requirementPrioritySchema.options),
    requirementPrioritySchema.optional(),
  ),
  category: z.string().max(100).optional(),
  source: z.string().max(200).optional(),
  acceptanceCriteria: z.string().max(10000).optional(),
  verificationMethod: z.preprocess(
    spelledAs(verificationMethodSchema.options),
    verificationMethodSchema.optional(),
  ),
  /**
   * The item number of this requirement's parent: another row of the same
   * sheet, or a requirement the design already holds. Resolved by number on
   * the server, so a hierarchy imports in one sheet in any row order.
   */
  parentItemNumber: z.string().max(100).optional(),
  /**
   * Custom attributes from unmapped columns, at the cell's own type. Mirrors
   * `baseItemSchema`, which takes any JSON document.
   */
  attributes: z.record(z.string(), jsonValueSchema).optional(),
})

export type ImportRequirementRow = z.infer<typeof importRequirementRowSchema>

/**
 * API request schema for bulk requirement import
 */
export const importRequirementsRequestSchema = z.object({
  designId: z.string().uuid({ message: 'Design ID is required' }),
  branchId: z.string().uuid().optional(),
  rows: z
    .array(importRequirementRowSchema)
    .min(1, 'At least one row is required'),
  bypassBranchProtection: z.boolean().optional().default(false),
  importAsReleased: z.boolean().optional().default(false),
})

export type ImportRequirementsRequest = z.infer<
  typeof importRequirementsRequestSchema
>

/** The import result, with the parent links the hierarchy produced. */
export interface ImportRequirementsResult extends ImportResult {
  /** Rows created with a parent, in the sheet or already in the design. */
  parentsLinked: number
}

/**
 * One row of a requirements export: the import fields as the sheet writes
 * them, every value a string (an absent one empty), so the sheet imports
 * back without a mapping step.
 */
export interface RequirementSheetRow {
  itemNumber: string
  name: string
  description: string
  type: string
  priority: string
  category: string
  source: string
  acceptanceCriteria: string
  verificationMethod: string
  parentItemNumber: string
}
