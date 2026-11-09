// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { ImportService } from '@cascadia/api/import/ImportService'
import { BatchCreateService } from '@cascadia/api/items/services/BatchCreateService'
import {
  BATCH_CREATE_JOB_TYPE,
  IMPORT_JOB_TYPES,
} from '@cascadia/api/jobs/definitions/import/config'
import type {
  BomImportResult,
  ImportRequirementsResult,
  ImportResult,
} from '@cascadia/commons/import'
import type { BulkRunOptions } from '@cascadia/api/import/bulk-run'
import type {
  BatchCreatePayload,
  BatchCreateResult,
  ImportDocumentsPayload,
  ImportIssuesPayload,
  ImportPartsPayload,
  ImportRequirementsPayload,
} from '@cascadia/api/jobs/definitions/import/types'
import type { JobContext, JobHandler } from '@cascadia/api/jobs/types'

/**
 * A change of percentage is written at most this often. A small sheet changes
 * percentage on every row, and a write per row is a write per row.
 */
const MIN_PROGRESS_INTERVAL_MS = 500

/**
 * …and something is written at least this often, even when the percentage
 * has not moved. A progress write is also the cancellation poll (see
 * `createJobContext`), so on a very large run this is the bound on how long a
 * cancel waits to be noticed.
 */
const MAX_PROGRESS_INTERVAL_MS = 5000

/**
 * The run options a bulk creation job hands its service: the job's own
 * cancellation signal, and a progress reporter that throttles the service's
 * per-row reports down to what is worth a database write.
 *
 * The message travels with every write, so the last one before a timeout or a
 * cancel is the record of how far the run got — the job's `progressMessage`
 * still reads "Processed 12,345 of 50,000 rows" after it has failed.
 */
export function bulkRunOptions(context: JobContext): BulkRunOptions {
  let lastPercent = -1
  let lastWriteAt = 0

  return {
    signal: context.signal,
    onProgress: async ({ done, total, message }) => {
      const percent = total > 0 ? Math.floor((done / total) * 100) : 100
      const sinceLast = Date.now() - lastWriteAt
      const finished = done >= total
      const moved =
        percent !== lastPercent && sinceLast >= MIN_PROGRESS_INTERVAL_MS
      if (!finished && !moved && sinceLast < MAX_PROGRESS_INTERVAL_MS) return

      lastPercent = percent
      lastWriteAt = Date.now()
      await context.updateProgress(percent, message)
    },
  }
}

/** Log the run's start and its outcome around the service call. */
async function logged<TResult extends ImportResult>(
  context: JobContext,
  what: string,
  rows: number,
  run: () => Promise<TResult>,
): Promise<TResult> {
  await context.log.info(`Starting ${what}`, { rows })
  const result = await run()
  await context.log.info(
    `Created ${result.successCount} of ${result.totalRows}; ${result.errorCount} failed`,
    { successCount: result.successCount, errorCount: result.errorCount },
  )
  return result
}

export const importPartsHandler: JobHandler<
  ImportPartsPayload,
  BomImportResult
> = {
  type: IMPORT_JOB_TYPES.parts,
  execute: (payload, context) =>
    logged(context, 'part import', payload.request.rows.length, () =>
      ImportService.importParts(
        payload.request,
        payload.userId,
        bulkRunOptions(context),
      ),
    ),
}

export const importDocumentsHandler: JobHandler<
  ImportDocumentsPayload,
  ImportResult
> = {
  type: IMPORT_JOB_TYPES.documents,
  execute: (payload, context) =>
    logged(context, 'document import', payload.request.rows.length, () =>
      ImportService.importDocuments(
        payload.request,
        payload.userId,
        bulkRunOptions(context),
      ),
    ),
}

export const importRequirementsHandler: JobHandler<
  ImportRequirementsPayload,
  ImportRequirementsResult
> = {
  type: IMPORT_JOB_TYPES.requirements,
  execute: (payload, context) =>
    logged(context, 'requirement import', payload.request.rows.length, () =>
      ImportService.importRequirements(
        payload.request,
        payload.userId,
        bulkRunOptions(context),
      ),
    ),
}

export const importIssuesHandler: JobHandler<
  ImportIssuesPayload,
  ImportResult
> = {
  type: IMPORT_JOB_TYPES.issues,
  execute: (payload, context) =>
    logged(context, 'issue import', payload.request.rows.length, () =>
      ImportService.importIssues(
        payload.request,
        payload.userId,
        bulkRunOptions(context),
      ),
    ),
}

export const batchCreateHandler: JobHandler<
  BatchCreatePayload,
  BatchCreateResult
> = {
  type: BATCH_CREATE_JOB_TYPE,
  async execute(payload, context) {
    const total = payload.request.items.length
    await context.log.info('Starting batch create', { items: total })
    const result = await BatchCreateService.run(
      payload.request,
      payload.userId,
      bulkRunOptions(context),
    )
    await context.log.info(
      `Created ${result.created.length} of ${total}; ${result.errors.length} failed`,
      { created: result.created.length, failed: result.errors.length },
    )
    return result
  },
}
