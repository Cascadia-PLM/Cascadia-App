import { useState } from 'react'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  X,
} from 'lucide-react'
import type { MergeConflict } from '@/lib/services/ChangeOrderMergeService'
import type { FieldConflict } from '@/lib/services/ConflictDetectionService'
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui'

export type ConflictResolution = 'keep_ours' | 'keep_theirs' | 'skip'
export type FieldResolution = 'ours' | 'theirs'

export interface ResolvedConflict {
  itemId: string
  resolution: ConflictResolution
  fieldResolutions?: Record<string, FieldResolution> // fieldName -> resolution
}

// Extended conflict type that can include field-level details
export interface ExtendedMergeConflict extends Omit<
  MergeConflict,
  'conflictType'
> {
  fieldConflicts?: Array<FieldConflict>
  conflictType?:
    | 'checkout'
    | 'concurrent_modification'
    | 'field_conflict'
    | 'no_changes'
    | 'branch_not_found'
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

interface MergeConflictDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  conflicts: Array<ExtendedMergeConflict>
  changeOrderNumber: string
  onResolve: (resolutions: Array<ResolvedConflict>) => Promise<void>
  isResolving?: boolean
}

// Per-field resolution component
function FieldConflictResolver({
  conflict,
  fieldResolutions,
  onFieldResolutionChange,
  disabled,
}: {
  conflict: ExtendedMergeConflict
  fieldResolutions: Record<string, FieldResolution>
  onFieldResolutionChange: (
    fieldName: string,
    resolution: FieldResolution,
  ) => void
  disabled: boolean
}) {
  const [expanded, setExpanded] = useState(true)

  if (!conflict.fieldConflicts || conflict.fieldConflicts.length === 0) {
    return null
  }

  return (
    <div className="mt-3 border border-slate-300 dark:border-slate-700 rounded-lg overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-3 py-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
          {conflict.fieldConflicts.length} field conflict
          {conflict.fieldConflicts.length !== 1 ? 's' : ''}
        </span>
        {expanded ? (
          <ChevronUp className="h-4 w-4 text-slate-500 dark:text-slate-400" />
        ) : (
          <ChevronDown className="h-4 w-4 text-slate-500 dark:text-slate-400" />
        )}
      </button>

      {expanded && (
        <div className="divide-y divide-slate-200 dark:divide-slate-700">
          {conflict.fieldConflicts.map((fc, idx) => {
            const resolution = fieldResolutions[fc.fieldName]

            return (
              <div key={idx} className="p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-sm text-slate-700 dark:text-slate-200">
                    {formatFieldName(fc.fieldName)}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      className={`px-2 py-1 text-xs rounded ${
                        resolution === 'ours'
                          ? 'bg-blue-500 text-white'
                          : 'bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-300 dark:hover:bg-slate-600'
                      }`}
                      onClick={() =>
                        onFieldResolutionChange(fc.fieldName, 'ours')
                      }
                      disabled={disabled}
                    >
                      Ours
                    </button>
                    <button
                      className={`px-2 py-1 text-xs rounded ${
                        resolution === 'theirs'
                          ? 'bg-orange-500 text-white'
                          : 'bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-300 dark:hover:bg-slate-600'
                      }`}
                      onClick={() =>
                        onFieldResolutionChange(fc.fieldName, 'theirs')
                      }
                      disabled={disabled}
                    >
                      Theirs
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <span className="text-slate-500">Base:</span>
                    <p className="text-slate-600 dark:text-slate-400 truncate">
                      {formatValue(fc.baseValue)}
                    </p>
                  </div>
                  <div>
                    <span className="text-blue-500">Ours:</span>
                    <p
                      className={`truncate ${resolution === 'ours' ? 'font-bold text-blue-600' : 'text-blue-600/70'}`}
                    >
                      {formatValue(fc.ourValue)}
                    </p>
                  </div>
                  <div>
                    <span className="text-orange-500">Theirs:</span>
                    <p
                      className={`truncate ${resolution === 'theirs' ? 'font-bold text-orange-600' : 'text-orange-600/70'}`}
                    >
                      {formatValue(fc.theirValue)}
                    </p>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function MergeConflictDialog({
  open,
  onOpenChange,
  conflicts,
  changeOrderNumber,
  onResolve,
  isResolving = false,
}: MergeConflictDialogProps) {
  // Track item-level resolution for each conflict
  const [resolutions, setResolutions] = useState<
    Map<string, ConflictResolution>
  >(new Map())
  // Track field-level resolutions: itemId -> { fieldName -> resolution }
  const [fieldResolutions, setFieldResolutions] = useState<
    Map<string, Record<string, FieldResolution>>
  >(new Map())

  // Filter to resolvable conflicts (concurrent modification and field conflicts)
  const resolvableConflictTypes = ['concurrent_modification', 'field_conflict']
  const resolvableConflicts = conflicts.filter(
    (c) => c.conflictType && resolvableConflictTypes.includes(c.conflictType),
  )
  const otherConflicts = conflicts.filter(
    (c) => !c.conflictType || !resolvableConflictTypes.includes(c.conflictType),
  )

  const setResolution = (itemId: string, resolution: ConflictResolution) => {
    const newResolutions = new Map(resolutions)
    newResolutions.set(itemId, resolution)
    setResolutions(newResolutions)
  }

  const setFieldResolution = (
    itemId: string,
    fieldName: string,
    resolution: FieldResolution,
  ) => {
    const newFieldResolutions = new Map(fieldResolutions)
    const existing = newFieldResolutions.get(itemId) || {}
    newFieldResolutions.set(itemId, { ...existing, [fieldName]: resolution })
    setFieldResolutions(newFieldResolutions)
  }

  // Check if all conflicts are resolved
  // For conflicts with field-level details, we need either:
  // 1. An item-level resolution (keep_ours/keep_theirs/skip)
  // 2. OR all field conflicts resolved individually
  const allResolved = resolvableConflicts.every((c) => {
    const itemResolution = resolutions.get(c.itemId)
    if (itemResolution) return true

    // If there are field conflicts and no item-level resolution,
    // check if all fields are resolved
    if (c.fieldConflicts && c.fieldConflicts.length > 0) {
      const itemFieldRes = fieldResolutions.get(c.itemId) || {}
      return c.fieldConflicts.every((fc) =>
        fc.fieldName in itemFieldRes ? itemFieldRes[fc.fieldName] : false,
      )
    }

    return false
  })

  const handleResolve = async () => {
    const resolvedConflicts: Array<ResolvedConflict> = resolvableConflicts.map(
      (conflict) => {
        const itemResolution = resolutions.get(conflict.itemId)
        const itemFieldRes = fieldResolutions.get(conflict.itemId)

        return {
          itemId: conflict.itemId,
          resolution: itemResolution || 'keep_ours', // Default to keep_ours if using per-field resolution
          fieldResolutions: itemFieldRes,
        }
      },
    )
    await onResolve(resolvedConflicts)
  }

  const handleClose = () => {
    setResolutions(new Map())
    setFieldResolutions(new Map())
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto auto-hide-scroll">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-yellow-500" />
            Merge Conflicts Detected
          </DialogTitle>
          <DialogDescription>
            The following items have been modified on the main branch since{' '}
            {changeOrderNumber} was created. Choose how to resolve each conflict
            before releasing.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Other conflicts (checkout, no changes, etc.) - shown as blockers */}
          {otherConflicts.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-sm font-medium text-destructive">
                Blocking Issues
              </h4>
              {otherConflicts.map((conflict, index) => (
                <div
                  key={`other-${index}`}
                  className="flex items-center gap-2 p-3 rounded-md border border-destructive/50 bg-destructive/10"
                >
                  <X className="h-4 w-4 text-destructive" />
                  <span className="text-sm">
                    {conflict.itemNumber && (
                      <span className="font-mono font-medium">
                        {conflict.itemNumber}:{' '}
                      </span>
                    )}
                    {conflict.reason}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Resolvable conflicts */}
          {resolvableConflicts.length > 0 && (
            <div className="space-y-3">
              <h4 className="text-sm font-medium text-slate-700 dark:text-slate-200">
                Concurrent Modifications
              </h4>
              {resolvableConflicts.map((conflict) => {
                const currentResolution = resolutions.get(conflict.itemId)

                return (
                  <div
                    key={conflict.itemId}
                    className="p-4 rounded-md border border-slate-300 dark:border-slate-700 bg-muted/50 space-y-3"
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="font-mono font-medium text-slate-700 dark:text-slate-200">
                          {conflict.itemNumber}
                        </span>
                        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                          {conflict.reason}
                        </p>
                      </div>
                      {currentResolution && (
                        <Badge variant="outline" className="capitalize">
                          {currentResolution.replace('_', ' ')}
                        </Badge>
                      )}
                    </div>

                    {/* Item-level resolution buttons */}
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        variant={
                          currentResolution === 'keep_ours'
                            ? 'default'
                            : 'outline'
                        }
                        onClick={() =>
                          setResolution(conflict.itemId, 'keep_ours')
                        }
                        disabled={isResolving}
                      >
                        <Check className="h-4 w-4 mr-1" />
                        Keep ECO Changes
                      </Button>
                      <Button
                        size="sm"
                        variant={
                          currentResolution === 'keep_theirs'
                            ? 'default'
                            : 'outline'
                        }
                        onClick={() =>
                          setResolution(conflict.itemId, 'keep_theirs')
                        }
                        disabled={isResolving}
                      >
                        <RefreshCw className="h-4 w-4 mr-1" />
                        Keep Main Version
                      </Button>
                      <Button
                        size="sm"
                        variant={
                          currentResolution === 'skip' ? 'secondary' : 'ghost'
                        }
                        onClick={() => setResolution(conflict.itemId, 'skip')}
                        disabled={isResolving}
                      >
                        <X className="h-4 w-4 mr-1" />
                        Skip Item
                      </Button>
                    </div>

                    {/* Per-field resolution (when field conflicts exist and no item-level resolution) */}
                    {conflict.fieldConflicts &&
                      conflict.fieldConflicts.length > 0 &&
                      !currentResolution && (
                        <FieldConflictResolver
                          conflict={conflict}
                          fieldResolutions={
                            fieldResolutions.get(conflict.itemId) || {}
                          }
                          onFieldResolutionChange={(fieldName, resolution) =>
                            setFieldResolution(
                              conflict.itemId,
                              fieldName,
                              resolution,
                            )
                          }
                          disabled={isResolving}
                        />
                      )}
                  </div>
                )
              })}
            </div>
          )}

          {conflicts.length === 0 && (
            <p className="text-center text-muted-foreground py-4">
              No conflicts to resolve.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={handleClose}
            disabled={isResolving}
          >
            Cancel
          </Button>
          {resolvableConflicts.length > 0 && otherConflicts.length === 0 && (
            <Button
              onClick={handleResolve}
              disabled={!allResolved || isResolving}
            >
              {isResolving
                ? 'Resolving...'
                : `Resolve ${resolvableConflicts.length} Conflicts`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
