// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import {
  batchCreatePayloadSchema,
  batchCreateResultSchema,
  bomImportResultSchema,
  importDocumentsPayloadSchema,
  importIssuesPayloadSchema,
  importPartsPayloadSchema,
  importRequirementsPayloadSchema,
  importRequirementsResultSchema,
  importResultSchema,
} from './types'
import type { z } from 'zod'
import type {
  BomImportResult,
  ImportRequirementsResult,
  ImportResult,
} from '@cascadia/commons/import'
import type { JobTypeConfig } from '../../types'
import type {
  BatchCreatePayload,
  BatchCreateResult,
  ImportDocumentsPayload,
  ImportIssuesPayload,
  ImportPartsPayload,
  ImportRequirementsPayload,
} from './types'

/**
 * How long one bulk creation may run before the worker stops it.
 *
 * Not a row cap in disguise: the handlers check for cancellation between
 * rows, so a run that reaches this stops cleanly with the rows it has
 * created, and the job's log says how far it got. An hour is several tens of
 * thousands of rows. It is also how long a job whose worker died mid-run
 * reads as 'running' before the stale-running sweep fails it, which is why it
 * is not simply very large.
 */
const BULK_CREATE_TIMEOUT_MS = 60 * 60 * 1000

/**
 * Every bulk creation job shares one shape; only its type, label and schemas
 * differ.
 *
 * **One attempt, never a retry.** A run that fails part-way has already
 * created rows, and nothing makes a second run skip them: every row it had
 * written would fail again as a duplicate item number, and the result would
 * report that as the import's outcome. The caller sees the failure and the
 * rows that landed, and decides.
 *
 * **High priority**, because a person is watching the progress bar.
 */
function bulkCreateConfig<TPayload, TResult>(
  type: string,
  label: string,
  payloadSchema: z.ZodType<TPayload>,
  resultSchema: z.ZodType<TResult>,
): JobTypeConfig<TPayload, TResult> {
  return {
    type,
    label,
    routingKey: `jobs.${type}`,
    payloadSchema,
    resultSchema,
    timeout: BULK_CREATE_TIMEOUT_MS,
    maxAttempts: 1,
    retryDelays: [],
    priority: 'high',
  }
}

export const IMPORT_JOB_TYPES = {
  parts: 'import.parts',
  documents: 'import.documents',
  requirements: 'import.requirements',
  issues: 'import.issues',
} as const

export const BATCH_CREATE_JOB_TYPE = 'items.batch-create'

export const importPartsConfig = bulkCreateConfig<
  ImportPartsPayload,
  BomImportResult
>(
  IMPORT_JOB_TYPES.parts,
  'Import Parts',
  importPartsPayloadSchema,
  bomImportResultSchema,
)

export const importDocumentsConfig = bulkCreateConfig<
  ImportDocumentsPayload,
  ImportResult
>(
  IMPORT_JOB_TYPES.documents,
  'Import Documents',
  importDocumentsPayloadSchema,
  importResultSchema,
)

export const importRequirementsConfig = bulkCreateConfig<
  ImportRequirementsPayload,
  ImportRequirementsResult
>(
  IMPORT_JOB_TYPES.requirements,
  'Import Requirements',
  importRequirementsPayloadSchema,
  importRequirementsResultSchema,
)

export const importIssuesConfig = bulkCreateConfig<
  ImportIssuesPayload,
  ImportResult
>(
  IMPORT_JOB_TYPES.issues,
  'Import Issues',
  importIssuesPayloadSchema,
  importResultSchema,
)

export const batchCreateConfig = bulkCreateConfig<
  BatchCreatePayload,
  BatchCreateResult
>(
  BATCH_CREATE_JOB_TYPE,
  'Batch Create Items',
  batchCreatePayloadSchema,
  batchCreateResultSchema,
)
