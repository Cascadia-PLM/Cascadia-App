// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { z } from 'zod'
import {
  importDocumentsRequestSchema,
  importIssuesRequestSchema,
  importPartsWithBomRequestSchema,
  importRequirementsRequestSchema,
} from '@cascadia/commons/import'
import { batchCreateRequestSchema } from '../../../api/schemas'
import type {
  BomImportResult,
  ImportRequirementsResult,
  ImportResult,
} from '@cascadia/commons/import'
import type { BaseItem } from '@cascadia/commons/items/types/base'

// =============================================================================
// Bulk creation jobs — the four sheet imports and item batch-create
// =============================================================================
//
// Each payload is the request body the route already validated and
// authorized, plus the user it was authorized for. The route is the only
// gate: the worker writes as `userId` and re-checks nothing, the same trust
// `design.clone` places in its payload. Nesting the body under `request`
// keeps it byte-for-byte what the caller sent, so no request key can ever
// collide with the job's own.

const userIdSchema = z.string().uuid()

export const importPartsPayloadSchema = z.object({
  userId: userIdSchema,
  request: importPartsWithBomRequestSchema,
})
export type ImportPartsPayload = z.infer<typeof importPartsPayloadSchema>

export const importDocumentsPayloadSchema = z.object({
  userId: userIdSchema,
  request: importDocumentsRequestSchema,
})
export type ImportDocumentsPayload = z.infer<
  typeof importDocumentsPayloadSchema
>

export const importRequirementsPayloadSchema = z.object({
  userId: userIdSchema,
  request: importRequirementsRequestSchema,
})
export type ImportRequirementsPayload = z.infer<
  typeof importRequirementsPayloadSchema
>

export const importIssuesPayloadSchema = z.object({
  userId: userIdSchema,
  request: importIssuesRequestSchema,
})
export type ImportIssuesPayload = z.infer<typeof importIssuesPayloadSchema>

export const batchCreatePayloadSchema = z.object({
  userId: userIdSchema,
  request: batchCreateRequestSchema,
})
export type BatchCreatePayload = z.infer<typeof batchCreatePayloadSchema>

// -----------------------------------------------------------------------------
// Results — exactly the bodies these routes answered with when they ran inline
// -----------------------------------------------------------------------------

export const importResultSchema = z.object({
  totalRows: z.number(),
  successCount: z.number(),
  errorCount: z.number(),
  createdItems: z.array(
    z.object({
      rowNumber: z.number(),
      itemId: z.string(),
      itemNumber: z.string(),
    }),
  ),
  failedRows: z.array(
    z.object({
      rowNumber: z.number(),
      errors: z.array(z.string()),
    }),
  ),
}) satisfies z.ZodType<ImportResult>

export const bomImportResultSchema = importResultSchema.extend({
  relationshipsCreated: z.number(),
  relationshipsFailed: z.number(),
  failedRelationships: z.array(
    z.object({
      parentItemNumber: z.string(),
      childItemNumber: z.string(),
      error: z.string(),
    }),
  ),
}) satisfies z.ZodType<BomImportResult>

export const importRequirementsResultSchema = importResultSchema.extend({
  parentsLinked: z.number(),
}) satisfies z.ZodType<ImportRequirementsResult>

/** What `POST /api/v1/items/batch-create` reports, row by row. */
export interface BatchCreateResult {
  created: Array<BaseItem>
  errors: Array<{
    itemNumber: string
    error: string
    details?: string
  }>
}

export const batchCreateResultSchema = z.object({
  created: z.array(
    z.custom<BaseItem>((value) => typeof value === 'object' && value !== null),
  ),
  errors: z.array(
    z.object({
      itemNumber: z.string(),
      error: z.string(),
      details: z.string().optional(),
    }),
  ),
}) satisfies z.ZodType<BatchCreateResult>
