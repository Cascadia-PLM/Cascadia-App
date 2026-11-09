// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useEffect, useRef, useState } from 'react'
import {
  CheckCircle2,
  Clock,
  GitBranch,
  Loader2,
  PartyPopper,
  XCircle,
} from 'lucide-react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ErrorCode } from '@cascadia/commons/errors/codes'
import { getImportConfig, getValidRows } from '@cascadia/commons/import'
import type {
  BomImportResult,
  BomRelationship,
  ImportContext,
  ImportItemType,
  ValidatedRow,
} from '@cascadia/commons/import'
import type { JobStatusSnapshot } from '@/query'
import { Badge, Progress } from '@/components/ui'
import { ApiError, apiFetch } from '@/api/client'
import { jobStatusQuery } from '@/query'

interface ImportProgressStepProps {
  itemType?: ImportItemType
  context: ImportContext
  validatedRows: Array<ValidatedRow>
  bomRelationships: Array<BomRelationship>
  onComplete: (result: BomImportResult) => void
  /**
   * The import ended without completing: it could not be queued, or its job
   * failed or was cancelled. Called whenever that becomes true; the dialog
   * uses it to swap the spinner for a way out.
   */
  onFailed?: () => void
}

/**
 * How long a queued import may wait for a worker before the step says so.
 * A running jobs worker picks a high-priority job up within a second or two;
 * one still queued after this is most likely waiting for a worker that is not
 * running.
 */
const WORKER_WAIT_HINT_MS = 15_000

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])

/** What to say when the import could not even be queued. */
function submitErrorMessage(err: unknown): string {
  if (
    err instanceof ApiError &&
    err.code === ErrorCode.EXTERNAL_SERVICE_UNAVAILABLE
  ) {
    return (
      'Imports run on the background jobs worker, and its job queue cannot ' +
      'be reached right now. Ask an administrator to check that RabbitMQ ' +
      'and the jobs worker are running, then try again.'
    )
  }
  return err instanceof Error ? err.message : 'Import failed'
}

/** What to say when the queued import ended without completing. */
function stoppedJobMessage(job: JobStatusSnapshot<unknown>): string {
  const why =
    job.status === 'cancelled'
      ? 'The import was cancelled.'
      : (job.error ?? 'The import failed.')
  const where = job.progressMessage
    ? ` It had reached: ${job.progressMessage}.`
    : ''
  return `${why}${where} Anything created before it stopped was kept.`
}

/**
 * Step 5: Queue the import and follow it to the end.
 *
 * The rows are written by a background job on the server, not by the request
 * that sends them, so a sheet of any size imports the same way: the step
 * submits it, then watches the job's progress until it completes and its
 * result is the summary below.
 */
export function ImportProgressStep({
  itemType = 'Part',
  context,
  validatedRows,
  bomRelationships,
  onComplete,
  onFailed,
}: ImportProgressStepProps) {
  const config = getImportConfig(itemType)
  const [jobId, setJobId] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [waitedLong, setWaitedLong] = useState(false)
  const hasStarted = useRef(false)
  const hasReported = useRef(false)

  const validRows = getValidRows(validatedRows)
  const hasBomRelationships = config.supportsBom && bomRelationships.length > 0

  // Queuing the import is the action, so it lives in a mutation; the effect
  // below fires it once when the step opens. What it answers is a job id.
  const submitImport = useMutation({
    mutationFn: async () => {
      // Prepare the import request based on item type
      let rows: Array<Record<string, unknown>>
      let requestBody: Record<string, unknown>

      if (itemType === 'Part') {
        rows = validRows.map((row) => ({
          itemNumber: row.mappedData.itemNumber as string | undefined,
          name: row.mappedData.name as string,
          revision: (row.mappedData.revision as string) || '-',
          description: row.mappedData.description as string | undefined,
          partType: row.mappedData.partType as
            'Manufacture' | 'Purchase' | 'Software' | 'Phantom' | undefined,
          material: row.mappedData.material as string | undefined,
          weight: row.mappedData.weight as string | undefined,
          weightUnit: row.mappedData.weightUnit as string | undefined,
          cost: row.mappedData.cost as string | undefined,
          costCurrency: row.mappedData.costCurrency as string | undefined,
          leadTimeDays: row.mappedData.leadTimeDays as number | undefined,
          attributes: row.mappedData.attributes as
            Record<string, unknown> | undefined,
        }))

        // Prepare BOM relationships for API
        const bomRelationshipsForApi = bomRelationships.map((rel) => ({
          parentItemNumber: rel.parentItemNumber,
          childItemNumber: rel.childItemNumber,
          quantity: rel.quantity,
          findNumber: rel.findNumber,
          referenceDesignator: rel.referenceDesignator,
        }))

        requestBody = {
          designId: context.designId,
          branchId: context.importAsReleased ? undefined : context.branchId,
          rows,
          bypassBranchProtection: context.designPhase === 'pre-release',
          importAsReleased: context.importAsReleased,
          bomRelationships:
            bomRelationshipsForApi.length > 0
              ? bomRelationshipsForApi
              : undefined,
        }
      } else if (itemType === 'Document') {
        rows = validRows.map((row) => ({
          itemNumber: row.mappedData.itemNumber as string | undefined,
          name: row.mappedData.name as string,
          revision: (row.mappedData.revision as string) || '-',
          description: row.mappedData.description as string | undefined,
          docType: row.mappedData.docType as string | undefined,
          fileName: row.mappedData.fileName as string | undefined,
          mimeType: row.mappedData.mimeType as string | undefined,
          attributes: row.mappedData.attributes as
            Record<string, unknown> | undefined,
        }))

        requestBody = {
          designId: context.designId,
          branchId: context.importAsReleased ? undefined : context.branchId,
          rows,
          bypassBranchProtection: context.designPhase === 'pre-release',
          importAsReleased: context.importAsReleased,
        }
      } else if (itemType === 'Requirement') {
        rows = validRows.map((row) => ({
          itemNumber: row.mappedData.itemNumber as string | undefined,
          name: row.mappedData.name as string,
          revision: (row.mappedData.revision as string) || '-',
          description: row.mappedData.description as string | undefined,
          type: row.mappedData.type as string | undefined,
          priority: row.mappedData.priority as string | undefined,
          category: row.mappedData.category as string | undefined,
          source: row.mappedData.source as string | undefined,
          acceptanceCriteria: row.mappedData.acceptanceCriteria as
            string | undefined,
          verificationMethod: row.mappedData.verificationMethod as
            string | undefined,
          parentItemNumber: row.mappedData.parentItemNumber as
            string | undefined,
          attributes: row.mappedData.attributes as
            Record<string, unknown> | undefined,
        }))

        requestBody = {
          designId: context.designId,
          branchId: context.importAsReleased ? undefined : context.branchId,
          rows,
          bypassBranchProtection: context.designPhase === 'pre-release',
          importAsReleased: context.importAsReleased,
        }
      } else {
        // Issue
        rows = validRows.map((row) => ({
          itemNumber: row.mappedData.itemNumber as string | undefined,
          name: row.mappedData.name as string,
          description: row.mappedData.description as string | undefined,
          severity: row.mappedData.severity as string | undefined,
          priority: row.mappedData.priority as string | undefined,
          category: row.mappedData.category as string | undefined,
          reportedDate: row.mappedData.reportedDate as string | undefined,
          resolution: row.mappedData.resolution as string | undefined,
          rootCause: row.mappedData.rootCause as string | undefined,
          attributes: row.mappedData.attributes as
            Record<string, unknown> | undefined,
        }))

        requestBody = {
          programId: context.programId,
          rows,
        }
      }

      const response = await apiFetch<{ data: { jobId: string } }>(
        config.apiEndpoint,
        {
          method: 'POST',
          body: JSON.stringify(requestBody),
        },
      )
      return response.data.jobId
    },
    onSuccess: (id) => setJobId(id),
    onError: (err: unknown) => setSubmitError(submitErrorMessage(err)),
  })

  // The job, polled until it reaches a terminal status.
  const { data: job } = useQuery({
    ...jobStatusQuery<BomImportResult>(jobId),
    refetchInterval: (query) =>
      TERMINAL_STATUSES.has(query.state.data?.status ?? '') ? false : 1000,
  })

  useEffect(() => {
    // Prevent double execution in StrictMode
    if (hasStarted.current || validRows.length === 0) return
    hasStarted.current = true
    // Fires exactly once when the step opens, guarded by the ref above.
    submitImport.mutate()
  }, [])

  // Still waiting for a worker to take it?
  const jobStatus = job?.status
  const isWaiting =
    jobId !== null &&
    (jobStatus === undefined ||
      jobStatus === 'pending' ||
      jobStatus === 'queued')
  useEffect(() => {
    if (!isWaiting) return
    const timer = setTimeout(() => setWaitedLong(true), WORKER_WAIT_HINT_MS)
    return () => clearTimeout(timer)
  }, [isWaiting])
  const showWorkerHint = isWaiting && waitedLong

  const result = job?.status === 'completed' ? job.result : null
  useEffect(() => {
    if (result && !hasReported.current) {
      hasReported.current = true
      onComplete(result)
    }
  }, [result, onComplete])

  const error =
    submitError ??
    (job && (job.status === 'failed' || job.status === 'cancelled')
      ? stoppedJobMessage(job)
      : null)
  const importStopped = error !== null
  useEffect(() => {
    if (importStopped) onFailed?.()
  }, [importStopped, onFailed])

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <XCircle className="h-12 w-12 text-red-500 mb-6" />
        <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-2">
          Import failed
        </h3>
        <p className="text-sm text-red-600 dark:text-red-400 max-w-md text-center">
          {error}
        </p>
      </div>
    )
  }

  if (!result) {
    const itemLabel =
      validRows.length === 1
        ? config.singularLabel.toLowerCase()
        : config.pluralLabel.toLowerCase()
    const progress = job?.progress ?? 0
    const progressMessage =
      job?.progressMessage ??
      (jobId ? 'Queued, waiting to start…' : 'Sending the sheet…')
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <Loader2 className="h-12 w-12 text-cyan-600 dark:text-cyan-400 animate-spin mb-6" />
        <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-2">
          Importing {config.pluralLabel.toLowerCase()}...
        </h3>
        <p className="text-sm text-slate-600 dark:text-slate-400 mb-6">
          Creating {validRows.length.toLocaleString()} {itemLabel} in the system
          {hasBomRelationships && (
            <span>
              {' '}
              and {bomRelationships.length.toLocaleString()} BOM relationship
              {bomRelationships.length > 1 ? 's' : ''}
            </span>
          )}
        </p>
        <div className="w-64">
          <Progress value={progress} />
        </div>
        <p className="text-sm text-slate-500 mt-2">
          {progress}% · {progressMessage}
        </p>
        {showWorkerHint ? (
          <p className="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-400 mt-6 max-w-md">
            <Clock className="h-4 w-4 mt-0.5 shrink-0" />
            <span>
              Still waiting for a jobs worker to start this import. If it does
              not start soon, ask an administrator to check that the jobs worker
              is running.
            </span>
          </p>
        ) : (
          jobId && (
            <p className="text-xs text-slate-500 mt-6 max-w-md text-center">
              The import runs on the server and keeps going if you close this
              window.
            </p>
          )
        )}
      </div>
    )
  }

  // Check if there are any errors (parts or relationships). Only a parts
  // import reports relationships; the others leave those counts undefined.
  const hasAnyErrors = result.errorCount > 0 || result.relationshipsFailed > 0
  const hasRelationshipResults =
    result.relationshipsCreated > 0 || result.relationshipsFailed > 0

  // Complete state
  const successLabel =
    result.successCount === 1
      ? config.singularLabel.toLowerCase()
      : config.pluralLabel.toLowerCase()
  return (
    <div className="flex flex-col items-center justify-center py-8">
      {!hasAnyErrors ? (
        <>
          <div className="relative mb-6">
            <CheckCircle2 className="h-16 w-16 text-green-500" />
            <PartyPopper className="h-6 w-6 text-amber-500 absolute -top-1 -right-1 animate-bounce" />
          </div>
          <h3 className="text-xl font-semibold text-slate-900 dark:text-slate-100 mb-2">
            Import complete!
          </h3>
          <p className="text-slate-600 dark:text-slate-400 mb-6">
            Successfully created {result.successCount} {successLabel}
            {result.relationshipsCreated > 0 && (
              <span>
                {' '}
                and {result.relationshipsCreated} BOM relationship
                {result.relationshipsCreated > 1 ? 's' : ''}
              </span>
            )}
          </p>
        </>
      ) : (
        <>
          <CheckCircle2 className="h-16 w-16 text-amber-500 mb-6" />
          <h3 className="text-xl font-semibold text-slate-900 dark:text-slate-100 mb-2">
            Import completed with some issues
          </h3>
          <p className="text-slate-600 dark:text-slate-400 mb-6">
            Created {result.successCount} of {result.totalRows}{' '}
            {config.pluralLabel.toLowerCase()}
            {hasRelationshipResults && (
              <span>
                , {result.relationshipsCreated} of{' '}
                {result.relationshipsCreated + result.relationshipsFailed}{' '}
                relationships
              </span>
            )}
          </p>
        </>
      )}

      {/* Results Summary */}
      <div className="w-full max-w-md space-y-4">
        {/* Success Summary */}
        <div className="p-4 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800">
          <div className="flex items-center gap-3">
            <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400" />
            <div>
              <p className="font-medium text-green-800 dark:text-green-200">
                {result.successCount}{' '}
                {result.successCount === 1
                  ? config.singularLabel.toLowerCase()
                  : config.pluralLabel.toLowerCase()}{' '}
                created
              </p>
              {result.createdItems.length > 0 && (
                <div className="mt-2 max-h-32 overflow-y-auto">
                  <div className="flex flex-wrap gap-1">
                    {result.createdItems.slice(0, 10).map((item) => (
                      <Badge
                        key={item.itemId}
                        variant="outline"
                        className="text-xs"
                      >
                        {item.itemNumber}
                      </Badge>
                    ))}
                    {result.createdItems.length > 10 && (
                      <Badge variant="outline" className="text-xs">
                        +{result.createdItems.length - 10} more
                      </Badge>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Error Summary */}
        {result.errorCount > 0 && (
          <div className="p-4 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
            <div className="flex items-start gap-3">
              <XCircle className="h-5 w-5 text-red-600 dark:text-red-400 mt-0.5" />
              <div>
                <p className="font-medium text-red-800 dark:text-red-200">
                  {result.errorCount} row{result.errorCount > 1 ? 's' : ''}{' '}
                  failed
                </p>
                <div className="mt-2 max-h-32 overflow-y-auto">
                  <ul className="text-sm text-red-700 dark:text-red-300 space-y-1">
                    {result.failedRows.slice(0, 5).map((failed) => (
                      <li key={failed.rowNumber}>
                        Row {failed.rowNumber}: {failed.errors.join(', ')}
                      </li>
                    ))}
                    {result.failedRows.length > 5 && (
                      <li>...and {result.failedRows.length - 5} more</li>
                    )}
                  </ul>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* BOM Relationship Success Summary */}
        {result.relationshipsCreated > 0 && (
          <div className="p-4 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
            <div className="flex items-center gap-3">
              <GitBranch className="h-5 w-5 text-blue-600 dark:text-blue-400" />
              <p className="font-medium text-blue-800 dark:text-blue-200">
                {result.relationshipsCreated} BOM relationship
                {result.relationshipsCreated > 1 ? 's' : ''} created
              </p>
            </div>
          </div>
        )}

        {/* BOM Relationship Error Summary */}
        {result.relationshipsFailed > 0 && (
          <div className="p-4 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
            <div className="flex items-start gap-3">
              <XCircle className="h-5 w-5 text-red-600 dark:text-red-400 mt-0.5" />
              <div>
                <p className="font-medium text-red-800 dark:text-red-200">
                  {result.relationshipsFailed} BOM relationship
                  {result.relationshipsFailed > 1 ? 's' : ''} failed
                </p>
                <div className="mt-2 max-h-32 overflow-y-auto">
                  <ul className="text-sm text-red-700 dark:text-red-300 space-y-1">
                    {result.failedRelationships.slice(0, 5).map((failed, i) => (
                      <li key={i}>
                        {failed.parentItemNumber} → {failed.childItemNumber}:{' '}
                        {failed.error}
                      </li>
                    ))}
                    {result.failedRelationships.length > 5 && (
                      <li>
                        ...and {result.failedRelationships.length - 5} more
                      </li>
                    )}
                  </ul>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
