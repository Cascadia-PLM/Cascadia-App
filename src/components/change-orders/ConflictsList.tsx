import { useEffect, useState } from 'react'
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Eye,
  GitMerge,
  Info,
  RotateCcw,
  Users,
  X,
} from 'lucide-react'
import { Link } from '@tanstack/react-router'
import { MergeConflictDialog } from './MergeConflictDialog'
import type {
  ExtendedMergeConflict,
  ResolvedConflict,
} from './MergeConflictDialog'
import type {
  ConflictDetectionResult,
  FieldConflict,
} from '@/lib/services/ConflictDetectionService'
import type { EnrichedItemConflict } from '@/lib/services/types/conflict-review'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui'
import { apiFetch } from '@/lib/api/client'

interface EnrichedConflictDetectionResult extends Omit<
  ConflictDetectionResult,
  'conflicts'
> {
  conflicts: Array<EnrichedItemConflict>
  summary: ConflictDetectionResult['summary'] & {
    reviewedWarnings: number
    unreviewedWarnings: number
  }
}

interface ConflictsListProps {
  ecoId: string
  ecoNumber?: string
  onResolve?: () => void
}

// Helper to format field names for display
function formatFieldName(fieldName: string): string {
  return fieldName
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (str) => str.toUpperCase())
    .trim()
}

// Helper to format values for display
function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '(empty)'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

// Conflict type icons
function getConflictIcon(conflictType: string, severity: string) {
  switch (conflictType) {
    case 'cross_eco':
      return <Users className="h-5 w-5 text-yellow-500" />
    case 'field_conflict':
    case 'concurrent_modification':
      if (severity === 'error') {
        return <AlertCircle className="h-5 w-5 text-red-500" />
      }
      return <AlertTriangle className="h-5 w-5 text-yellow-500" />
    case 'checkout':
      return <AlertCircle className="h-5 w-5 text-red-500" />
    default:
      return <Info className="h-5 w-5 text-blue-500" />
  }
}

// Field conflicts display component
function FieldConflictsTable({
  conflicts,
}: {
  conflicts: Array<FieldConflict>
}) {
  if (conflicts.length === 0) return null

  return (
    <div className="mt-3 border rounded-lg overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-slate-100 dark:bg-slate-800">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Field</th>
            <th className="px-3 py-2 text-left font-medium">Base</th>
            <th className="px-3 py-2 text-left font-medium">Ours</th>
            <th className="px-3 py-2 text-left font-medium">Theirs</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
          {conflicts.map((fc, idx) => (
            <tr key={idx}>
              <td className="px-3 py-2 font-medium">
                {formatFieldName(fc.fieldPath || fc.fieldName)}
              </td>
              <td className="px-3 py-2 text-slate-500 dark:text-slate-400">
                {formatValue(fc.baseValue)}
              </td>
              <td className="px-3 py-2 text-blue-600 dark:text-blue-400">
                {formatValue(fc.ourValue)}
              </td>
              <td className="px-3 py-2 text-orange-600 dark:text-orange-400">
                {formatValue(fc.theirValue)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// Individual conflict card
function ConflictCard({
  conflict,
  ecoId,
  onResolve,
}: {
  conflict: EnrichedItemConflict
  ecoId: string
  onResolve?: () => void
}) {
  // Determine if reviewed and valid upfront for initial collapse state
  const isReviewedAndValid = conflict.isReviewed && !conflict.needsReReview

  // Card is collapsed by default for reviewed conflicts
  const [collapsed, setCollapsed] = useState(isReviewedAndValid)
  const [fieldExpanded, setFieldExpanded] = useState(false)
  const [resolving, setResolving] = useState(false)
  const [markingReviewed, setMarkingReviewed] = useState(false)

  const handlePullFromMain = async () => {
    if (!conflict.theirItemId || !conflict.ourBranchItemId) return

    setResolving(true)
    try {
      await apiFetch(
        `/api/v1/branch-items/${conflict.ourBranchItemId}/pull-from-main`,
        {
          method: 'POST',
          body: JSON.stringify({
            mainItemId: conflict.theirItemId,
          }),
        },
      )

      onResolve?.()
    } catch {
      // Pull failed silently
    } finally {
      setResolving(false)
    }
  }

  const handleMarkReviewed = async () => {
    setMarkingReviewed(true)
    try {
      await apiFetch(`/api/v1/change-orders/${ecoId}/conflict-reviews`, {
        method: 'POST',
        body: JSON.stringify({
          itemMasterId: conflict.itemMasterId,
          conflictType: conflict.conflictType,
          theirEcoId: conflict.theirEcoId || null,
        }),
      })
      onResolve?.()
    } catch {
      // Failed silently
    } finally {
      setMarkingReviewed(false)
    }
  }

  const handleUnmarkReviewed = async () => {
    if (!conflict.review?.id) return

    setMarkingReviewed(true)
    try {
      await apiFetch(
        `/api/v1/change-orders/${ecoId}/conflict-reviews?reviewId=${conflict.review.id}`,
        {
          method: 'DELETE',
        },
      )
      onResolve?.()
    } catch {
      // Failed silently
    } finally {
      setMarkingReviewed(false)
    }
  }

  // Determine card styling based on review status
  const cardClassName =
    conflict.severity === 'error'
      ? 'border-red-200 dark:border-red-800'
      : isReviewedAndValid
        ? 'border-slate-300 dark:border-slate-700 opacity-75'
        : ''

  return (
    <Card className={cardClassName}>
      <CardHeader
        className={`pb-2 cursor-pointer select-none ${collapsed ? 'pb-4' : ''}`}
        onClick={() => setCollapsed(!collapsed)}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {collapsed ? (
              <ChevronDown className="h-4 w-4 text-slate-400" />
            ) : (
              <ChevronUp className="h-4 w-4 text-slate-400" />
            )}
            {getConflictIcon(conflict.conflictType, conflict.severity)}
            <div>
              <CardTitle className="text-base">{conflict.itemNumber}</CardTitle>
              <p className="text-sm text-slate-500 dark:text-slate-400">
                {conflict.itemName}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge
              variant={
                conflict.severity === 'error' ? 'destructive' : 'warning'
              }
            >
              {conflict.conflictType.replace(/_/g, ' ')}
            </Badge>
            {conflict.severity === 'error' && (
              <Badge variant="outline" className="border-red-500 text-red-500">
                Blocking
              </Badge>
            )}
            {/* Review status badges */}
            {isReviewedAndValid && (
              <Badge
                variant="outline"
                className="border-green-500 text-green-600 dark:text-green-400"
              >
                <CheckCircle2 className="h-3 w-3 mr-1" />
                Reviewed
              </Badge>
            )}
            {conflict.needsReReview && (
              <Badge
                variant="outline"
                className="border-orange-500 text-orange-600 dark:text-orange-400"
              >
                <RotateCcw className="h-3 w-3 mr-1" />
                Needs Re-Review
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      {!collapsed && (
        <CardContent>
          <p className="text-sm text-slate-600 dark:text-slate-400 mb-3">
            {conflict.resolutionNotes}
          </p>

          {/* Reviewer info for reviewed conflicts */}
          {conflict.isReviewed && conflict.review && (
            <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
              Reviewed by {conflict.review.reviewerName || 'Unknown'} on{' '}
              {new Date(conflict.review.reviewedAt).toLocaleDateString()}
              {conflict.review.notes && (
                <span className="italic"> - "{conflict.review.notes}"</span>
              )}
            </p>
          )}

          {/* Version comparison */}
          <div className="grid grid-cols-3 gap-4 text-sm mb-3 bg-slate-50 dark:bg-slate-800/50 rounded-lg p-3">
            {conflict.baseRevision && (
              <div>
                <p className="text-slate-500 text-xs uppercase">Base</p>
                <p className="font-medium">Rev {conflict.baseRevision}</p>
              </div>
            )}
            <div>
              <p className="text-slate-500 text-xs uppercase">
                Ours ({conflict.ourBranchName})
              </p>
              <p className="font-medium text-blue-600 dark:text-blue-400">
                Rev {conflict.ourRevision}
              </p>
            </div>
            {conflict.theirRevision && (
              <div>
                <p className="text-slate-500 text-xs uppercase">
                  Theirs ({conflict.theirBranchName})
                </p>
                <p className="font-medium text-orange-600 dark:text-orange-400">
                  Rev {conflict.theirRevision}
                </p>
              </div>
            )}
          </div>

          {/* Field conflicts expand/collapse */}
          {conflict.fieldConflicts.length > 0 && (
            <>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setFieldExpanded(!fieldExpanded)
                }}
                className="flex items-center gap-1 text-sm text-blue-600 dark:text-blue-400 hover:underline"
              >
                {fieldExpanded ? (
                  <ChevronUp className="h-4 w-4" />
                ) : (
                  <ChevronDown className="h-4 w-4" />
                )}
                {conflict.fieldConflicts.length} field conflict
                {conflict.fieldConflicts.length !== 1 ? 's' : ''}
              </button>

              {fieldExpanded && (
                <FieldConflictsTable conflicts={conflict.fieldConflicts} />
              )}
            </>
          )}

          {/* Actions */}
          <div className="flex gap-2 mt-4" onClick={(e) => e.stopPropagation()}>
            {conflict.suggestedResolution === 'rebase' &&
              conflict.theirItemId &&
              conflict.ourBranchItemId && (
                <Button
                  size="sm"
                  onClick={handlePullFromMain}
                  disabled={resolving}
                >
                  <GitMerge className="h-4 w-4 mr-1" />
                  {resolving ? 'Pulling...' : 'Pull latest changes from Main'}
                </Button>
              )}
            {conflict.theirEcoNumber && conflict.theirEcoId && (
              <Link
                to="/change-orders/$id"
                params={{ id: conflict.theirEcoId }}
              >
                <Button size="sm" variant="outline">
                  <ExternalLink className="h-4 w-4 mr-1" />
                  View {conflict.theirEcoNumber}
                </Button>
              </Link>
            )}
            {/* Mark as Reviewed button for warning conflicts */}
            {conflict.severity === 'warning' && !isReviewedAndValid && (
              <Button
                size="sm"
                variant="outline"
                onClick={handleMarkReviewed}
                disabled={markingReviewed}
              >
                <Eye className="h-4 w-4 mr-1" />
                {markingReviewed ? 'Marking...' : 'Mark as Reviewed'}
              </Button>
            )}
            {/* Unmark reviewed button */}
            {isReviewedAndValid && conflict.review?.id && (
              <Button
                size="sm"
                variant="ghost"
                onClick={handleUnmarkReviewed}
                disabled={markingReviewed}
                className="text-slate-500 hover:text-slate-700"
              >
                <X className="h-4 w-4 mr-1" />
                {markingReviewed ? 'Removing...' : 'Remove Review'}
              </Button>
            )}
          </div>
        </CardContent>
      )}
    </Card>
  )
}

// Transform EnrichedItemConflict to ExtendedMergeConflict for the dialog
function transformToMergeConflict(
  conflict: EnrichedItemConflict,
): ExtendedMergeConflict {
  return {
    itemId: conflict.itemMasterId, // API expects itemMasterId
    itemNumber: conflict.itemNumber,
    reason:
      conflict.resolutionNotes ||
      `${conflict.conflictType.replace(/_/g, ' ')} detected`,
    mainVersion: conflict.theirRevision,
    branchBase: conflict.baseRevision,
    conflictType: conflict.conflictType as
      | 'checkout'
      | 'concurrent_modification'
      | 'no_changes'
      | 'branch_not_found',
    fieldConflicts: conflict.fieldConflicts,
  }
}

export function ConflictsList({
  ecoId,
  ecoNumber,
  onResolve,
}: ConflictsListProps) {
  const [result, setResult] = useState<EnrichedConflictDetectionResult | null>(
    null,
  )
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [isResolving, setIsResolving] = useState(false)

  const checkConflicts = async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await apiFetch<{
        data: EnrichedConflictDetectionResult
      }>(`/api/v1/change-orders/${ecoId}/conflicts`)
      setResult(response.data)
    } catch {
      setError('Failed to check for conflicts')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    checkConflicts()
  }, [ecoId])

  const handleResolve = () => {
    checkConflicts()
    onResolve?.()
  }

  // Handle conflict resolution submission
  const handleResolveConflicts = async (
    resolutions: Array<ResolvedConflict>,
  ) => {
    setIsResolving(true)
    try {
      await apiFetch(`/api/v1/change-orders/${ecoId}/resolve-conflicts`, {
        method: 'POST',
        body: JSON.stringify({
          resolutions: resolutions.map((r) => ({
            itemId: r.itemId,
            resolution: r.resolution,
          })),
        }),
      })
      setDialogOpen(false)
      handleResolve()
    } finally {
      setIsResolving(false)
    }
  }

  // Get blocking conflicts that can be resolved via the dialog
  const blockingConflicts =
    result?.conflicts.filter(
      (c) =>
        c.severity === 'error' &&
        (c.conflictType === 'concurrent_modification' ||
          c.conflictType === 'field_conflict'),
    ) ?? []

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        <span className="ml-3 text-slate-500">Checking for conflicts...</span>
      </div>
    )
  }

  if (error) {
    return (
      <Card className="border-red-200 dark:border-red-800">
        <CardContent className="py-4">
          <div className="flex items-center gap-2 text-red-600 dark:text-red-400">
            <AlertCircle className="h-5 w-5" />
            {error}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={checkConflicts}
          >
            Retry
          </Button>
        </CardContent>
      </Card>
    )
  }

  if (!result || !result.hasConflicts) {
    return (
      <Card className="border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20">
        <CardContent className="py-6">
          <div className="flex items-center gap-3 text-green-600 dark:text-green-400">
            <Info className="h-6 w-6" />
            <div>
              <p className="font-medium">No conflicts detected</p>
              <p className="text-sm text-green-600/80 dark:text-green-400/80">
                This ECO is ready to be released.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      {/* Summary */}
      <Card
        className={
          result.hasBlockingConflicts
            ? 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20'
            : 'border-yellow-200 dark:border-yellow-800 bg-yellow-50 dark:bg-yellow-900/20'
        }
      >
        <CardContent className="py-4">
          <div className="flex items-center gap-4">
            {result.hasBlockingConflicts ? (
              <AlertCircle className="h-6 w-6 text-red-500" />
            ) : (
              <AlertTriangle className="h-6 w-6 text-yellow-500" />
            )}
            <div className="flex-1">
              <p className="font-medium">
                {result.summary.total} conflict
                {result.summary.total !== 1 ? 's' : ''} detected
              </p>
              <p className="text-sm text-slate-600 dark:text-slate-400">
                {result.summary.errors > 0 &&
                  `${result.summary.errors} blocking`}
                {result.summary.errors > 0 &&
                  result.summary.warnings > 0 &&
                  ', '}
                {result.summary.warnings > 0 && (
                  <>
                    {result.summary.warnings} warning
                    {result.summary.warnings !== 1 ? 's' : ''}
                    {result.summary.reviewedWarnings > 0 && (
                      <span className="text-green-600 dark:text-green-400">
                        {' '}
                        ({result.summary.reviewedWarnings} reviewed)
                      </span>
                    )}
                  </>
                )}
              </p>
            </div>
            {result.hasBlockingConflicts && blockingConflicts.length > 0 && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setDialogOpen(true)}
              >
                Resolve before releasing
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Conflicts List */}
      <div className="space-y-3">
        {result.conflicts.map((conflict, index) => (
          <ConflictCard
            key={index}
            conflict={conflict}
            ecoId={ecoId}
            onResolve={handleResolve}
          />
        ))}
      </div>

      {/* Refresh button */}
      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={checkConflicts}>
          Refresh
        </Button>
      </div>

      {/* Merge Conflict Resolution Dialog */}
      <MergeConflictDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        conflicts={blockingConflicts.map(transformToMergeConflict)}
        changeOrderNumber={ecoNumber || 'this ECO'}
        onResolve={handleResolveConflicts}
        isResolving={isResolving}
      />
    </div>
  )
}
