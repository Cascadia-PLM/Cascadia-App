import { useEffect, useRef, useState } from 'react'
import {
  CheckCircle2,
  GitBranch,
  Loader2,
  PartyPopper,
  XCircle,
} from 'lucide-react'
import type {
  BomImportResult,
  BomRelationship,
  ImportContext,
  ImportItemType,
  ValidatedRow,
} from '@/lib/import'
import { Badge, Progress } from '@/components/ui'
import { apiFetch } from '@/lib/api/client'
import { getImportConfig, getValidRows } from '@/lib/import'

interface ImportProgressStepProps {
  itemType?: ImportItemType
  context: ImportContext
  validatedRows: Array<ValidatedRow>
  bomRelationships: Array<BomRelationship>
  onComplete: (result: BomImportResult) => void
}

type ImportStatus = 'idle' | 'importing' | 'complete' | 'error'

/**
 * Step 5: Execute import and show progress.
 */
export function ImportProgressStep({
  itemType = 'Part',
  context,
  validatedRows,
  bomRelationships,
  onComplete,
}: ImportProgressStepProps) {
  const config = getImportConfig(itemType)
  const [status, setStatus] = useState<ImportStatus>('idle')
  const [progress, setProgress] = useState(0)
  const [result, setResult] = useState<BomImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const hasStarted = useRef(false)

  const validRows = getValidRows(validatedRows)
  const hasBomRelationships = config.supportsBom && bomRelationships.length > 0

  useEffect(() => {
    const executeImport = async () => {
      // Prevent double execution in StrictMode
      if (hasStarted.current || validRows.length === 0) return
      hasStarted.current = true

      setStatus('importing')
      setProgress(10)

      try {
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
              | 'Manufacture'
              | 'Purchase'
              | 'Software'
              | 'Phantom'
              | undefined,
            material: row.mappedData.material as string | undefined,
            weight: row.mappedData.weight as string | undefined,
            weightUnit: row.mappedData.weightUnit as string | undefined,
            cost: row.mappedData.cost as string | undefined,
            costCurrency: row.mappedData.costCurrency as string | undefined,
            leadTimeDays: row.mappedData.leadTimeDays as number | undefined,
            attributes: row.mappedData.attributes as
              | Record<string, string>
              | undefined,
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
            branchId: context.branchId,
            rows,
            bypassBranchProtection: context.designPhase === 'pre-release',
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
              | Record<string, string>
              | undefined,
          }))

          requestBody = {
            designId: context.designId,
            branchId: context.branchId,
            rows,
            bypassBranchProtection: context.designPhase === 'pre-release',
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
              | Record<string, string>
              | undefined,
          }))

          requestBody = {
            programId: context.programId,
            rows,
          }
        }

        setProgress(30)

        // Make the API call using the appropriate endpoint
        const response = await apiFetch<{ data: { result: BomImportResult } }>(
          config.apiEndpoint,
          {
            method: 'POST',
            body: JSON.stringify(requestBody),
          },
        )

        setProgress(100)
        setResult(response.data.result)
        setStatus('complete')
        onComplete(response.data.result)
      } catch (err) {
        setStatus('error')
        setError(err instanceof Error ? err.message : 'Import failed')
      }
    }

    executeImport()
  }, [])

  // Render based on status
  if (status === 'idle' || status === 'importing') {
    const itemLabel =
      validRows.length === 1
        ? config.singularLabel.toLowerCase()
        : config.pluralLabel.toLowerCase()
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <Loader2 className="h-12 w-12 text-cyan-600 animate-spin mb-6" />
        <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-2">
          Importing {config.pluralLabel.toLowerCase()}...
        </h3>
        <p className="text-sm text-slate-600 dark:text-slate-400 mb-6">
          Creating {validRows.length} {itemLabel} in the system
          {hasBomRelationships && (
            <span>
              {' '}
              and {bomRelationships.length} BOM relationship
              {bomRelationships.length > 1 ? 's' : ''}
            </span>
          )}
        </p>
        <div className="w-64">
          <Progress value={progress} />
        </div>
        <p className="text-sm text-slate-500 mt-2">{progress}%</p>
      </div>
    )
  }

  if (status === 'error') {
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

  // Check if there are any errors (parts or relationships)
  const hasAnyErrors =
    result && (result.errorCount > 0 || result.relationshipsFailed > 0)
  const hasRelationshipResults =
    result &&
    (result.relationshipsCreated > 0 || result.relationshipsFailed > 0)

  // Complete state
  const successLabel =
    result?.successCount === 1
      ? config.singularLabel.toLowerCase()
      : config.pluralLabel.toLowerCase()
  return (
    <div className="flex flex-col items-center justify-center py-8">
      {result && !hasAnyErrors ? (
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
            Created {result?.successCount || 0} of {result?.totalRows || 0}{' '}
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
      {result && (
        <div className="w-full max-w-md space-y-4">
          {/* Success Summary */}
          <div className="p-4 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="h-5 w-5 text-green-600" />
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
                <XCircle className="h-5 w-5 text-red-600 mt-0.5" />
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
                <GitBranch className="h-5 w-5 text-blue-600" />
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
                <XCircle className="h-5 w-5 text-red-600 mt-0.5" />
                <div>
                  <p className="font-medium text-red-800 dark:text-red-200">
                    {result.relationshipsFailed} BOM relationship
                    {result.relationshipsFailed > 1 ? 's' : ''} failed
                  </p>
                  <div className="mt-2 max-h-32 overflow-y-auto">
                    <ul className="text-sm text-red-700 dark:text-red-300 space-y-1">
                      {result.failedRelationships
                        .slice(0, 5)
                        .map((failed, i) => (
                          <li key={i}>
                            {failed.parentItemNumber} → {failed.childItemNumber}
                            : {failed.error}
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
      )}
    </div>
  )
}
