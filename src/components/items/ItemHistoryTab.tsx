import { useEffect, useState } from 'react'
import {
  ArrowUpCircle,
  ChevronDown,
  ChevronUp,
  Eye,
  GitCommit,
  Info,
  Loader2,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react'
import type { VersionContext } from '@/lib/hooks/useVersionContext'
import { useLifecyclePhases } from '@/lib/hooks/useLifecyclePhases'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui'
import { apiFetch } from '@/lib/api/client'

interface FieldChange {
  fieldName: string
  fieldPath?: string
  oldValue: unknown
  newValue: unknown
  fieldCategory: 'core' | 'type' | 'attribute' | 'relationship'
}

interface HistoryEntry {
  commit: {
    id: string
    message: string
    createdAt: string
    createdBy: string
    itemsAdded: number
    itemsChanged: number
    itemsDeleted: number
  }
  item: {
    id: string
    itemNumber: string
    revision: string
    name: string | null
  }
  changeType: 'added' | 'modified' | 'deleted'
  previousItem: {
    id: string
    itemNumber: string
    revision: string
  } | null
  author?: {
    id: string
    name: string
  }
  fieldChanges?: Array<FieldChange>
}

interface ItemHistoryTabProps {
  itemId: string
  designId: string | null
  versionContext: VersionContext
  onViewHistoricalState?: (context: VersionContext) => void
  /** Item type for phase resolution (e.g., 'Part', 'Document') */
  itemType?: string
}

// Helper to format field names for display
function formatFieldName(fieldName: string): string {
  return fieldName
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (str) => str.toUpperCase())
    .trim()
}

// Helper to format field values for display
function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '(empty)'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

// Helper to format a relationship change value in human-readable form
function formatRelationshipValue(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (!v.targetItemNumber) return null

  const parts: Array<string> = [String(v.targetItemNumber)]
  if (v.quantity != null) parts.push(`qty: ${v.quantity}`)
  if (v.findNumber != null) parts.push(`find#: ${v.findNumber}`)
  if (v.referenceDesignator != null) parts.push(`ref: ${v.referenceDesignator}`)
  return parts.join(', ')
}

// Render a single relationship field change with a human-readable description
function RelationshipChange({ change }: { change: FieldChange }) {
  const fieldName = change.fieldName

  // Determine the action type from the fieldName pattern
  if (fieldName.endsWith('_added')) {
    const label = formatRelationshipValue(change.newValue)
    return (
      <div className="flex items-start gap-2 text-sm">
        <span className="text-green-600 dark:text-green-400">
          + Added{' '}
          <span className="font-medium">
            {label || formatValue(change.newValue)}
          </span>
        </span>
      </div>
    )
  }

  if (fieldName.endsWith('_removed')) {
    const label = formatRelationshipValue(change.oldValue)
    return (
      <div className="flex items-start gap-2 text-sm">
        <span className="text-red-600 dark:text-red-400">
          − Removed{' '}
          <span className="font-medium">
            {label || formatValue(change.oldValue)}
          </span>
        </span>
      </div>
    )
  }

  if (fieldName.endsWith('_changed')) {
    // Property update (quantity, ref designator, find number changed)
    const oldVal = change.oldValue as Record<string, unknown> | null
    const newVal = change.newValue as Record<string, unknown> | null
    const targetLabel =
      newVal?.targetItemNumber || oldVal?.targetItemNumber || 'item'

    // Find the specific property that changed
    const changedProps: Array<string> = []
    if (oldVal && newVal) {
      for (const key of ['quantity', 'referenceDesignator', 'findNumber']) {
        if (key in oldVal || key in newVal) {
          const o = oldVal[key]
          const n = newVal[key]
          if (String(o) !== String(n)) {
            const label =
              key === 'referenceDesignator'
                ? 'ref designator'
                : key === 'findNumber'
                  ? 'find#'
                  : key
            changedProps.push(`${label}: ${o ?? '(empty)'} → ${n ?? '(empty)'}`)
          }
        }
      }
    }

    return (
      <div className="flex items-start gap-2 text-sm">
        <span className="text-blue-600 dark:text-blue-400">
          ✎ <span className="font-medium">{String(targetLabel)}</span>
          {changedProps.length > 0 ? ` — ${changedProps.join('; ')}` : ''}
        </span>
      </div>
    )
  }

  // Fallback: generic old → new display
  return (
    <div className="flex items-start gap-2 text-sm">
      <span className="font-medium text-slate-700 dark:text-slate-300 min-w-[120px]">
        {formatFieldName(change.fieldPath || change.fieldName)}:
      </span>
      <span className="text-red-600 dark:text-red-400 line-through">
        {formatValue(change.oldValue)}
      </span>
      <span className="text-slate-400 dark:text-slate-500">→</span>
      <span className="text-green-600 dark:text-green-400">
        {formatValue(change.newValue)}
      </span>
    </div>
  )
}

// Field changes display component
function FieldChangesList({ changes }: { changes: Array<FieldChange> }) {
  if (changes.length === 0) return null

  // Group by category
  const grouped = changes.reduce(
    (acc, change) => {
      const category: string = change.fieldCategory
      if (!(category in acc)) acc[category] = []
      acc[category].push(change)
      return acc
    },
    {} as Record<string, Array<FieldChange>>,
  )

  const categoryLabels: Record<string, string> = {
    core: 'Core Fields',
    type: 'Type-Specific Fields',
    attribute: 'Custom Attributes',
    relationship: 'Relationships',
  }

  return (
    <div className="mt-3 pt-3 border-t border-slate-300 dark:border-slate-700 space-y-3">
      {Object.entries(grouped).map(([category, categoryChanges]) => (
        <div key={category}>
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
            {categoryLabels[category] || category}
          </div>
          <div className="space-y-1">
            {category === 'relationship'
              ? categoryChanges.map((change, idx) => (
                  <RelationshipChange key={idx} change={change} />
                ))
              : categoryChanges.map((change, idx) => (
                  <div key={idx} className="flex items-start gap-2 text-sm">
                    <span className="font-medium text-slate-700 dark:text-slate-300 min-w-[120px]">
                      {formatFieldName(change.fieldPath || change.fieldName)}:
                    </span>
                    <span className="text-red-600 dark:text-red-400 line-through">
                      {formatValue(change.oldValue)}
                    </span>
                    <span className="text-slate-400 dark:text-slate-500">
                      →
                    </span>
                    <span className="text-green-600 dark:text-green-400">
                      {formatValue(change.newValue)}
                    </span>
                  </div>
                ))}
          </div>
        </div>
      ))}
    </div>
  )
}

export function ItemHistoryTab({
  itemId,
  designId,
  versionContext,
  onViewHistoricalState,
  itemType,
}: ItemHistoryTabProps) {
  const { resolvePhase } = useLifecyclePhases(itemType)
  const [loading, setLoading] = useState(true)
  const [entries, setEntries] = useState<Array<HistoryEntry>>([])
  const [error, setError] = useState<string | null>(null)
  const [expandedCommits, setExpandedCommits] = useState<Set<string>>(new Set())

  // Toggle expanded state for a commit
  const toggleExpanded = (commitId: string) => {
    setExpandedCommits((prev) => {
      const next = new Set(prev)
      if (next.has(commitId)) {
        next.delete(commitId)
      } else {
        next.add(commitId)
      }
      return next
    })
  }

  // Fetch history based on version context
  useEffect(() => {
    async function fetchHistory() {
      if (!designId) {
        setLoading(false)
        return
      }

      setLoading(true)
      setError(null)
      try {
        // Build the API URL with version context parameters
        const params = new URLSearchParams()

        // Use the version context to determine which history to show
        if (versionContext.type === 'commit' && versionContext.commitId) {
          params.set('commitId', versionContext.commitId)
        } else if (versionContext.type === 'tag' && versionContext.tagId) {
          params.set('tagId', versionContext.tagId)
        } else if (
          versionContext.type === 'branch' &&
          versionContext.branchId
        ) {
          params.set('branchId', versionContext.branchId)
        } else if (versionContext.type === 'main') {
          // For main context, we need to fetch the main branch ID
          try {
            const branchesResponse = await apiFetch<{
              data: { branches: Array<{ id: string; branchType: string }> }
            }>(`/api/v1/designs/${designId}/branches`)
            const mainBranch = branchesResponse.data.branches.find(
              (b) => b.branchType === 'main',
            )
            if (mainBranch) {
              params.set('branchId', mainBranch.id)
            }
          } catch {
            // If we can't fetch branches, continue without branch filter
            console.warn('Could not fetch main branch ID for history filtering')
          }
        }

        const queryString = params.toString()
        const url = `/api/v1/items/${itemId}/history${queryString ? `?${queryString}` : ''}`

        const response = await apiFetch<{
          data: { history: Array<HistoryEntry> }
        }>(url)

        setEntries(response.data.history)
      } catch {
        setError('Failed to load history.')
        setEntries([])
      } finally {
        setLoading(false)
      }
    }

    fetchHistory()
  }, [itemId, designId, versionContext])

  // Get change type icon
  const getChangeIcon = (changeType: 'added' | 'modified' | 'deleted') => {
    switch (changeType) {
      case 'added':
        return <Plus className="h-4 w-4 text-green-500" />
      case 'modified':
        return <Pencil className="h-4 w-4 text-blue-500" />
      case 'deleted':
        return <Trash2 className="h-4 w-4 text-red-500" />
    }
  }

  // Get change type badge
  const getChangeBadge = (changeType: 'added' | 'modified' | 'deleted') => {
    switch (changeType) {
      case 'added':
        return <Badge variant="success">Added</Badge>
      case 'modified':
        return <Badge variant="default">Modified</Badge>
      case 'deleted':
        return <Badge variant="destructive">Deleted</Badge>
    }
  }

  // Handle view at commit
  const handleViewAtCommit = (commitId: string) => {
    if (onViewHistoricalState) {
      onViewHistoricalState({
        type: 'commit',
        commitId,
      })
    }
  }

  // No design assigned
  if (!designId) {
    return (
      <Card>
        <CardContent className="py-12">
          <div className="text-center space-y-3">
            <Info className="h-12 w-12 mx-auto text-slate-400" />
            <h3 className="text-lg font-medium text-slate-900 dark:text-white">
              No Version History Available
            </h3>
            <p className="text-sm text-slate-600 dark:text-slate-400 max-w-md mx-auto">
              This item is not associated with a design and does not have
              version history. Assign this item to a design to enable version
              tracking.
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Error message */}
      {error && (
        <Card className="border-amber-200 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-800">
          <CardContent className="py-4">
            <p className="text-amber-700 dark:text-amber-300">{error}</p>
          </CardContent>
        </Card>
      )}

      {/* Timeline */}
      <Card>
        <CardHeader>
          <CardTitle>Version History</CardTitle>
          <CardDescription>
            Timeline of changes to this item
            {versionContext.branchName && (
              <span className="ml-2 font-semibold">
                (on {versionContext.branchName})
              </span>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {entries.length > 0 ? (
            <div className="relative">
              {/* Timeline line */}
              <div className="absolute left-6 top-0 bottom-0 w-0.5 bg-slate-200 dark:bg-slate-700" />

              {/* Entries */}
              <div className="space-y-6">
                {entries.map((entry) => (
                  <div key={entry.commit.id} className="relative flex gap-4">
                    {/* Icon */}
                    <div className="relative z-10 flex items-center justify-center w-12 h-12 rounded-full bg-white dark:bg-slate-900 border-2 border-slate-300 dark:border-slate-700">
                      <GitCommit className="h-5 w-5 text-slate-500" />
                    </div>

                    {/* Content */}
                    <div className="flex-1 pt-1.5">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            {getChangeIcon(entry.changeType)}
                            <span className="font-medium text-slate-900 dark:text-white">
                              Revision {entry.item.revision}
                            </span>
                            {getChangeBadge(entry.changeType)}
                          </div>
                          <p className="text-slate-600 dark:text-slate-400 mt-1">
                            {entry.commit.message}
                          </p>
                          <div className="flex items-center gap-4 mt-2 text-sm text-slate-500">
                            <span>
                              {new Date(
                                entry.commit.createdAt,
                              ).toLocaleDateString()}
                            </span>
                            {entry.author && <span>{entry.author.name}</span>}
                            {entry.previousItem && (
                              <span className="text-xs">
                                from Rev {entry.previousItem.revision}
                              </span>
                            )}
                          </div>

                          {/* Phase transition indicator */}
                          {itemType &&
                            entry.fieldChanges?.some(
                              (fc) => fc.fieldName === 'state',
                            ) &&
                            (() => {
                              const stateChange = entry.fieldChanges.find(
                                (fc) => fc.fieldName === 'state',
                              )
                              if (!stateChange) return null
                              const oldPhase = resolvePhase(
                                String(stateChange.oldValue ?? ''),
                              )
                              const newPhase = resolvePhase(
                                String(stateChange.newValue ?? ''),
                              )
                              if (
                                !oldPhase ||
                                !newPhase ||
                                oldPhase.id === newPhase.id
                              )
                                return null
                              return (
                                <div className="mt-2 flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-sm">
                                  <ArrowUpCircle className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
                                  <span className="text-amber-800 dark:text-amber-300">
                                    Phase: {oldPhase.name} → {newPhase.name}
                                  </span>
                                </div>
                              )
                            })()}

                          {/* Field changes expand/collapse */}
                          {entry.fieldChanges &&
                            entry.fieldChanges.length > 0 && (
                              <>
                                <button
                                  onClick={() =>
                                    toggleExpanded(entry.commit.id)
                                  }
                                  className="flex items-center gap-1 mt-2 text-sm text-blue-600 dark:text-blue-400 hover:underline"
                                >
                                  {expandedCommits.has(entry.commit.id) ? (
                                    <ChevronUp className="h-4 w-4" />
                                  ) : (
                                    <ChevronDown className="h-4 w-4" />
                                  )}
                                  {entry.fieldChanges.length} field
                                  {entry.fieldChanges.length !== 1
                                    ? 's'
                                    : ''}{' '}
                                  changed
                                </button>

                                {expandedCommits.has(entry.commit.id) && (
                                  <FieldChangesList
                                    changes={entry.fieldChanges}
                                  />
                                )}
                              </>
                            )}
                        </div>

                        {/* Actions */}
                        {onViewHistoricalState && (
                          <div className="flex items-center gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                handleViewAtCommit(entry.commit.id)
                              }
                            >
                              <Eye className="h-3 w-3 mr-1" />
                              View
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            !error && (
              <div className="text-center py-8 text-slate-500 dark:text-slate-400">
                No version history found for this item.
              </div>
            )
          )}
        </CardContent>
      </Card>
    </div>
  )
}
