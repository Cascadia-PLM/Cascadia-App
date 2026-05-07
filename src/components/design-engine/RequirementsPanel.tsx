/**
 * RequirementsPanel - Displays and edits RequirementDraft artifacts
 */

import { useState } from 'react'
import { Check, Pencil, Plus, Sparkles, Trash2, User, X } from 'lucide-react'
import type {
  DesignSessionStage,
  RequirementDraft,
} from '@/lib/design-engine/types'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Input } from '@/components/ui/Input'
import { cn } from '@/lib/utils'

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
  onUpdate?: (tempId: string, data: Partial<RequirementDraft>) => void
  onRemove?: (tempId: string) => void
  onAdd?: (data: Partial<RequirementDraft>) => void
  onConfirm?: () => void
}

export function RequirementsPanel({
  requirements,
  currentStage,
  onUpdate,
  onRemove,
  onAdd,
  onConfirm,
}: RequirementsPanelProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [addingNew, setAddingNew] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDescription, setNewDescription] = useState('')

  const canEdit =
    currentStage === 'requirements_review' ||
    currentStage === 'requirements_drafting'
  const canConfirm =
    currentStage === 'requirements_review' && requirements.length > 0

  const startEdit = (req: RequirementDraft) => {
    setEditingId(req.tempId)
    setEditName(req.name)
    setEditDescription(req.description)
  }

  const saveEdit = (tempId: string) => {
    onUpdate?.(tempId, { name: editName, description: editDescription })
    setEditingId(null)
  }

  const addNewRequirement = () => {
    if (newName.trim()) {
      onAdd?.({
        name: newName.trim(),
        description: newDescription.trim(),
        requirementType: 'Functional',
        priority: 'medium',
        verificationMethod: 'Analysis',
        source: 'user',
      })
      setNewName('')
      setNewDescription('')
      setAddingNew(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300">
          Requirements ({requirements.length})
        </h3>
        {canEdit && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setAddingNew(true)}
            className="h-7 text-xs gap-1"
          >
            <Plus className="h-3 w-3" />
            Add
          </Button>
        )}
      </div>

      {requirements.length === 0 && !addingNew && (
        <p className="text-xs text-slate-400 dark:text-slate-500 py-2">
          Requirements will appear here during the requirements stage
        </p>
      )}

      <div className="space-y-2">
        {requirements.map((req) => (
          <div
            key={req.tempId}
            className="border border-slate-200 dark:border-slate-700 rounded-lg p-3 space-y-2"
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
                      <span className="text-sm font-medium text-slate-800 dark:text-slate-200 truncate">
                        {req.name}
                      </span>
                      {req.source === 'ai' ? (
                        <Sparkles className="h-3 w-3 text-purple-500 flex-shrink-0" />
                      ) : (
                        <User className="h-3 w-3 text-cyan-500 flex-shrink-0" />
                      )}
                    </div>
                    {req.description && (
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 line-clamp-2">
                        {req.description}
                      </p>
                    )}
                  </div>
                  {canEdit && (
                    <div className="flex gap-1 flex-shrink-0">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => startEdit(req)}
                        className="h-6 w-6 p-0"
                      >
                        <Pencil className="h-3 w-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onRemove?.(req.tempId)}
                        className="h-6 w-6 p-0 text-red-500 hover:text-red-700"
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  )}
                </div>
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
        <Button variant="default" onClick={onConfirm} className="w-full">
          <Check className="h-4 w-4 mr-2" />
          Confirm Requirements ({requirements.length})
        </Button>
      )}
    </div>
  )
}
