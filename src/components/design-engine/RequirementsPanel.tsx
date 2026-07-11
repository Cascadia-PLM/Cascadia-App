/**
 * RequirementsPanel - Displays and edits RequirementDraft artifacts
 *
 * Each AI-proposed requirement carries a review status. The user accepts,
 * edits, or rejects each one; the confirm gate stays closed while any item
 * is still 'proposed' (with a force override).
 */

import { useState } from 'react'
import {
  Check,
  CheckCheck,
  Pencil,
  Plus,
  RotateCcw,
  Sparkles,
  User,
  X,
  XCircle,
} from 'lucide-react'
import { ArtifactDiffLegend } from './ArtifactDiffLegend'
import { DIFF_STATUS_STYLES } from './diff-styles'
import { ItemCommentThread } from './ItemCommentThread'
import type {
  DesignSessionStage,
  ItemComment,
  RequirementDraft,
  ReviewStatus,
} from '@/lib/design-engine/types'
import type {
  FieldChange,
  RequirementsDiff,
} from '@/lib/design-engine/artifact-diff'
import { effectiveReviewStatus } from '@/lib/design-engine/types'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Input } from '@/components/ui/Input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select'
import { cn } from '@/lib/utils'

function formatDiffValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '(empty)'
  if (typeof value === 'string') {
    return value.length > 60 ? `${value.slice(0, 57)}...` : value
  }
  return JSON.stringify(value)
}

export function FieldChangeList({
  changes,
}: {
  changes: Array<FieldChange>
}) {
  return (
    <div className="space-y-0.5">
      {changes.map((change) => (
        <div
          key={change.fieldName}
          className="text-[10px] text-slate-500 dark:text-slate-400"
        >
          <span className="font-medium">{change.fieldName}:</span>{' '}
          <span className="text-red-500 dark:text-red-400 line-through">
            {formatDiffValue(change.oldValue)}
          </span>{' '}
          → <span className="text-green-600 dark:text-green-400">
            {formatDiffValue(change.newValue)}
          </span>
        </div>
      ))}
    </div>
  )
}

export function DiffBadge({
  status,
  reparented,
}: {
  status: 'added' | 'modified' | 'removed'
  reparented?: boolean
}) {
  const style = DIFF_STATUS_STYLES[status]
  const Icon = style.Icon
  return (
    <span
      className={cn(
        'flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px] font-medium flex-shrink-0',
        style.badge,
      )}
    >
      {Icon && <Icon className="h-2 w-2" />}
      {reparented ? 'MOVED' : style.label}
    </span>
  )
}

export const REVIEW_STATUS_STYLES: Record<ReviewStatus, string> = {
  proposed:
    'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
  accepted:
    'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400',
  edited: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-400',
  rejected: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400',
}

export function ReviewStatusChip({ status }: { status: ReviewStatus }) {
  return (
    <span
      className={cn(
        'text-[9px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded flex-shrink-0',
        REVIEW_STATUS_STYLES[status],
      )}
    >
      {status}
    </span>
  )
}

const PRIORITY_OPTIONS: ReadonlyArray<RequirementDraft['priority']> = [
  'low',
  'medium',
  'high',
  'critical',
]

const TYPE_OPTIONS: ReadonlyArray<RequirementDraft['requirementType']> = [
  'Functional',
  'Performance',
  'Interface',
  'Constraint',
  'Other',
]

const PRIORITY_COLORS: Record<string, string> = {
  critical: 'destructive',
  high: 'warning',
  medium: 'default',
  low: 'secondary',
}

const TYPE_LABELS: Record<string, string> = {
  Functional: 'Func',
  Performance: 'Perf',
  Interface: 'Intf',
  Constraint: 'Cnst',
  Other: 'Other',
}

interface RequirementsPanelProps {
  requirements: Array<RequirementDraft>
  currentStage: DesignSessionStage
  isStreaming?: boolean
  onUpdate?: (tempId: string, data: Partial<RequirementDraft>) => void
  onAdd?: (data: Partial<RequirementDraft>) => void
  onSetReviewStatus?: (
    tempId: string,
    status: ReviewStatus,
    note?: string,
  ) => void
  onAcceptAll?: () => void
  onConfirm?: (options?: { force?: boolean }) => void
  /** Changes since the last confirmed requirements snapshot (reopen/re-run only) */
  diff?: RequirementsDiff | null
  comments?: Array<ItemComment>
  onAddComment?: (
    targetType: ItemComment['targetType'],
    targetTempId: string,
    text: string,
  ) => void
  onSetCommentResolved?: (commentId: string, resolved: boolean) => void
}

export function RequirementsPanel({
  requirements,
  currentStage,
  isStreaming,
  onUpdate,
  onAdd,
  onSetReviewStatus,
  onAcceptAll,
  onConfirm,
  diff,
  comments,
  onAddComment,
  onSetCommentResolved,
}: RequirementsPanelProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editPriority, setEditPriority] =
    useState<RequirementDraft['priority']>('medium')
  const [editType, setEditType] =
    useState<RequirementDraft['requirementType']>('Functional')
  const [addingNew, setAddingNew] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [newPriority, setNewPriority] =
    useState<RequirementDraft['priority']>('medium')
  const [newType, setNewType] =
    useState<RequirementDraft['requirementType']>('Functional')
  const [rejectingId, setRejectingId] = useState<string | null>(null)
  const [rejectReason, setRejectReason] = useState('')

  const inEditableStage =
    currentStage === 'requirements_review' ||
    currentStage === 'requirements_drafting'
  const canEdit = inEditableStage && !isStreaming
  const canConfirm =
    currentStage === 'requirements_review' && requirements.length > 0

  const unresolvedCount = requirements.filter(
    (r) => effectiveReviewStatus(r) === 'proposed',
  ).length

  const submitReject = (tempId: string) => {
    onSetReviewStatus?.(tempId, 'rejected', rejectReason.trim() || undefined)
    setRejectingId(null)
    setRejectReason('')
  }

  const startEdit = (req: RequirementDraft) => {
    setEditingId(req.tempId)
    setEditName(req.name)
    setEditDescription(req.description)
    setEditPriority(req.priority)
    setEditType(req.requirementType)
  }

  const saveEdit = (tempId: string) => {
    onUpdate?.(tempId, {
      name: editName,
      description: editDescription,
      priority: editPriority,
      requirementType: editType,
    })
    setEditingId(null)
  }

  const addNewRequirement = () => {
    if (newName.trim()) {
      onAdd?.({
        name: newName.trim(),
        description: newDescription.trim(),
        requirementType: newType,
        priority: newPriority,
        verificationMethod: 'Analysis',
        source: 'user',
      })
      setNewName('')
      setNewDescription('')
      setNewPriority('medium')
      setNewType('Functional')
      setAddingNew(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300">
          Requirements ({requirements.length})
        </h3>
        <div className="flex gap-1.5">
          {canEdit && unresolvedCount > 0 && onAcceptAll && (
            <Button
              variant="outline"
              size="sm"
              onClick={onAcceptAll}
              className="h-7 text-xs gap-1"
              title="Accept all unreviewed requirements"
            >
              <CheckCheck className="h-3 w-3" />
              Accept all
            </Button>
          )}
          {canEdit && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAddingNew(true)}
              className="h-7 text-xs gap-1"
            >
              <Plus className="h-3 w-3" />
              Add
            </Button>
          )}
        </div>
      </div>

      {inEditableStage && requirements.length > 0 && (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {canEdit
            ? 'Accept, edit, or reject each proposal. Rejections (with reasons) are remembered by the AI.'
            : 'Pause the AI to review requirements.'}
        </p>
      )}

      {requirements.length === 0 && !addingNew && (
        <p className="text-xs text-slate-400 dark:text-slate-500 py-2">
          Requirements will appear here during the requirements stage
        </p>
      )}

      {diff?.hasChanges && <ArtifactDiffLegend />}

      <div className="space-y-2">
        {requirements.map((req) => (
          <div
            key={req.tempId}
            className={cn(
              'border border-slate-200 dark:border-slate-700 rounded-lg p-3 space-y-2',
              effectiveReviewStatus(req) === 'rejected' && 'opacity-60',
              diff &&
                DIFF_STATUS_STYLES[
                  diff.byTempId.get(req.tempId)?.status ?? 'unchanged'
                ].row,
            )}
          >
            {editingId === req.tempId ? (
              // Edit mode
              <div className="space-y-2">
                <Input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="text-sm h-8"
                  placeholder="Requirement name"
                />
                <Input
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  className="text-sm h-8"
                  placeholder="Description"
                />
                <div className="grid grid-cols-2 gap-2">
                  <Select
                    value={editPriority}
                    onValueChange={(v) =>
                      setEditPriority(v as RequirementDraft['priority'])
                    }
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PRIORITY_OPTIONS.map((p) => (
                        <SelectItem key={p} value={p} className="text-xs">
                          {p}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={editType}
                    onValueChange={(v) =>
                      setEditType(v as RequirementDraft['requirementType'])
                    }
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TYPE_OPTIONS.map((t) => (
                        <SelectItem key={t} value={t} className="text-xs">
                          {t}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => saveEdit(req.tempId)}
                    className="h-6 px-2"
                  >
                    <Check className="h-3 w-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditingId(null)}
                    className="h-6 px-2"
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            ) : (
              // Display mode
              <>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          'text-sm font-medium text-slate-800 dark:text-slate-200 truncate',
                          effectiveReviewStatus(req) === 'rejected' &&
                            'line-through',
                        )}
                      >
                        {req.name}
                      </span>
                      {req.source === 'ai' ? (
                        <Sparkles className="h-3 w-3 text-purple-500 flex-shrink-0" />
                      ) : (
                        <User className="h-3 w-3 text-cyan-500 flex-shrink-0" />
                      )}
                      <ReviewStatusChip status={effectiveReviewStatus(req)} />
                      {(() => {
                        const itemDiff = diff?.byTempId.get(req.tempId)
                        return itemDiff && itemDiff.status !== 'unchanged' ? (
                          <DiffBadge status={itemDiff.status} />
                        ) : null
                      })()}
                    </div>
                    {req.description && (
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 line-clamp-2">
                        {req.description}
                      </p>
                    )}
                    {effectiveReviewStatus(req) === 'rejected' &&
                      req.reviewNote && (
                        <p className="text-xs text-red-500 dark:text-red-400 mt-0.5">
                          Reason: {req.reviewNote}
                        </p>
                      )}
                    {(() => {
                      const itemDiff = diff?.byTempId.get(req.tempId)
                      return itemDiff && itemDiff.fieldChanges.length > 0 ? (
                        <div className="mt-1">
                          <FieldChangeList changes={itemDiff.fieldChanges} />
                        </div>
                      ) : null
                    })()}
                    <ItemCommentThread
                      targetType="requirement"
                      targetTempId={req.tempId}
                      comments={comments ?? []}
                      canComment={!!canEdit}
                      onAddComment={inEditableStage ? onAddComment : undefined}
                      onSetResolved={onSetCommentResolved}
                      className="mt-1"
                    />
                  </div>
                  {inEditableStage && (
                    <div className="flex gap-1.5 flex-shrink-0">
                      {effectiveReviewStatus(req) === 'rejected' ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            onSetReviewStatus?.(req.tempId, 'proposed')
                          }
                          disabled={!canEdit}
                          className="h-7 px-2 text-xs gap-1"
                          title="Restore this requirement for review"
                        >
                          <RotateCcw className="h-3 w-3" />
                          Restore
                        </Button>
                      ) : (
                        <>
                          {effectiveReviewStatus(req) === 'proposed' && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                onSetReviewStatus?.(req.tempId, 'accepted')
                              }
                              disabled={!canEdit}
                              className="h-7 px-2 text-xs gap-1 text-green-600 border-green-200 hover:bg-green-50 hover:text-green-700 dark:text-green-400 dark:border-green-900 dark:hover:bg-green-950"
                              title={
                                canEdit
                                  ? 'Accept this requirement'
                                  : 'Pause the AI to review'
                              }
                            >
                              <Check className="h-3 w-3" />
                              Accept
                            </Button>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => startEdit(req)}
                            disabled={!canEdit}
                            className="h-7 px-2 text-xs gap-1"
                            title={
                              canEdit
                                ? 'Edit requirement'
                                : 'Pause the AI to edit'
                            }
                          >
                            <Pencil className="h-3 w-3" />
                            Edit
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setRejectingId(req.tempId)
                              setRejectReason('')
                            }}
                            disabled={!canEdit}
                            className="h-7 px-2 text-xs gap-1 text-red-600 border-red-200 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:border-red-900 dark:hover:bg-red-950"
                            title={
                              canEdit
                                ? 'Reject this requirement'
                                : 'Pause the AI to reject'
                            }
                          >
                            <XCircle className="h-3 w-3" />
                            Reject
                          </Button>
                        </>
                      )}
                    </div>
                  )}
                </div>
                {rejectingId === req.tempId && (
                  <div className="flex gap-1.5 items-center">
                    <Input
                      value={rejectReason}
                      onChange={(e) => setRejectReason(e.target.value)}
                      className="text-xs h-7 flex-1"
                      placeholder="Why is this rejected? (optional — the AI learns from it)"
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') submitReject(req.tempId)
                        if (e.key === 'Escape') setRejectingId(null)
                      }}
                    />
                    <Button
                      variant="default"
                      size="sm"
                      onClick={() => submitReject(req.tempId)}
                      className="h-7 text-xs"
                    >
                      Reject
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setRejectingId(null)}
                      className="h-7 w-7 p-0"
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                )}
                <div className="flex items-center gap-1.5">
                  <Badge
                    variant={
                      (PRIORITY_COLORS[req.priority] ?? 'default') as
                        | 'default'
                        | 'destructive'
                        | 'warning'
                        | 'secondary'
                    }
                    className="text-[10px] px-1.5 py-0"
                  >
                    {req.priority}
                  </Badge>
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                    {TYPE_LABELS[req.requirementType] ?? req.requirementType}
                  </Badge>
                  <div
                    className={cn(
                      'h-1.5 w-8 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden',
                    )}
                  >
                    <div
                      className="h-full rounded-full bg-cyan-500"
                      style={{ width: `${req.confidence * 100}%` }}
                    />
                  </div>
                </div>
              </>
            )}
          </div>
        ))}

        {/* Requirements deleted since the last confirmed snapshot */}
        {diff && diff.removed.length > 0 && (
          <div className="space-y-1">
            {diff.removed.map((req) => (
              <div
                key={req.tempId}
                className={cn(
                  'border border-slate-200 dark:border-slate-700 rounded-lg p-2',
                  DIFF_STATUS_STYLES.removed.row,
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-500 dark:text-slate-400 line-through truncate">
                    {req.name}
                  </span>
                  <DiffBadge status="removed" />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Add new requirement form */}
        {addingNew && (
          <div className="border border-dashed border-cyan-300 dark:border-cyan-700 rounded-lg p-3 space-y-2">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="text-sm h-8"
              placeholder="Requirement name"
              autoFocus
            />
            <Input
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              className="text-sm h-8"
              placeholder="Description (optional)"
            />
            <div className="grid grid-cols-2 gap-2">
              <Select
                value={newPriority}
                onValueChange={(v) =>
                  setNewPriority(v as RequirementDraft['priority'])
                }
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITY_OPTIONS.map((p) => (
                    <SelectItem key={p} value={p} className="text-xs">
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={newType}
                onValueChange={(v) =>
                  setNewType(v as RequirementDraft['requirementType'])
                }
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TYPE_OPTIONS.map((t) => (
                    <SelectItem key={t} value={t} className="text-xs">
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-1">
              <Button
                variant="default"
                size="sm"
                onClick={addNewRequirement}
                className="h-7 text-xs"
                disabled={!newName.trim()}
              >
                Add Requirement
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setAddingNew(false)
                  setNewName('')
                  setNewDescription('')
                  setNewPriority('medium')
                  setNewType('Functional')
                }}
                className="h-7 text-xs"
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Confirm button */}
      {canConfirm && (
        <div className="space-y-1.5">
          <Button
            variant="default"
            onClick={() => onConfirm?.()}
            className="w-full"
            disabled={unresolvedCount > 0}
            title={
              unresolvedCount > 0
                ? 'Accept, edit, or reject every proposal to confirm'
                : undefined
            }
          >
            <Check className="h-4 w-4 mr-2" />
            {unresolvedCount > 0
              ? `Confirm Requirements (${unresolvedCount} unreviewed)`
              : `Confirm Requirements (${requirements.length})`}
          </Button>
          {unresolvedCount > 0 && (
            <Button
              variant="ghost"
              onClick={() => onConfirm?.({ force: true })}
              className="w-full text-xs text-slate-500 dark:text-slate-400"
            >
              Confirm anyway — skip per-item review
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
