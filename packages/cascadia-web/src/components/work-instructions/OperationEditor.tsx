// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useState } from 'react'
import { ChevronDown, ChevronUp, Clock, FolderOpen, Trash2 } from 'lucide-react'
import { StepEditor } from './StepEditor'
import type {
  WorkInstructionOperation,
  WorkInstructionStep,
} from '@/lib/items/types/work-instruction'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  Input,
  Textarea,
} from '@/components/ui'

import { apiFetch } from '@/lib/api/client'
import { useInvalidateResources } from '@/lib/query'

interface OperationEditorProps {
  /**
   * Operations and steps as the query cache currently holds them. This
   * component owns no copy of either: its four operation writes invalidate
   * `work-instructions` and re-render from the refetch, so a caller cannot
   * forget to refresh and cannot hand it a list that has drifted from the
   * server.
   */
  operations: Array<WorkInstructionOperation>
  steps: Array<WorkInstructionStep>
  workInstructionId: string
  onAddStep: (step: Partial<WorkInstructionStep>) => Promise<void>
  onUpdateStep: (
    stepId: string,
    data: Partial<WorkInstructionStep>,
  ) => Promise<void>
  onDeleteStep: (stepId: string) => void | Promise<void>
  onReorderSteps: (
    steps: Array<{ id: string; orderIndex: number }>,
  ) => Promise<void>
  onError?: (error: Error) => void
  onSuccess?: (message: string) => void
  isLoading?: boolean
}

export function OperationEditor({
  operations,
  steps,
  workInstructionId,
  onAddStep,
  onUpdateStep,
  onDeleteStep,
  onReorderSteps,
  onError,
  onSuccess,
  isLoading,
}: OperationEditorProps) {
  const invalidate = useInvalidateResources()

  // Disclosure state, not content: which operations are open and which one is
  // being renamed inline. Both key off operation ids, so they survive the
  // refetch that replaces the `operations` prop.
  const [expandedOps, setExpandedOps] = useState<Set<string>>(
    new Set(operations.map((o) => o.id)),
  )
  const [editingOpId, setEditingOpId] = useState<string | null>(null)

  const toggleExpand = (opId: string) => {
    setExpandedOps((prev) => {
      const next = new Set(prev)
      if (next.has(opId)) {
        next.delete(opId)
      } else {
        next.add(opId)
      }
      return next
    })
  }

  const handleAddOperation = async () => {
    try {
      const result = await apiFetch<{
        data: { operation: WorkInstructionOperation }
      }>(`/api/v1/work-instructions/${workInstructionId}/operations`, {
        method: 'POST',
        body: JSON.stringify({ title: 'New Operation' }),
      })
      await invalidate('work-instructions')
      // The id is the server's, so opening the card and dropping into its
      // title editor still land on the right operation once the refetch
      // replaces the list.
      setExpandedOps((prev) => new Set([...prev, result.data.operation.id]))
      setEditingOpId(result.data.operation.id)
    } catch (error) {
      onError?.(error as Error)
    }
  }

  const handleUpdateOperation = async (
    opId: string,
    data: Partial<WorkInstructionOperation>,
  ) => {
    try {
      await apiFetch(
        `/api/v1/work-instructions/${workInstructionId}/operations/${opId}`,
        {
          method: 'PUT',
          body: JSON.stringify(data),
        },
      )
      await invalidate('work-instructions')
    } catch (error) {
      onError?.(error as Error)
    }
  }

  const handleDeleteOperation = async (opId: string) => {
    try {
      await apiFetch(
        `/api/v1/work-instructions/${workInstructionId}/operations/${opId}`,
        { method: 'DELETE' },
      )
      // Steps with this operationId become unassigned (null via DB cascade),
      // so the refetch has to cover the step list too — invalidating
      // `work-instructions` reaches both the detail query that carries the
      // steps and the operations sub-query.
      await invalidate('work-instructions')
      onSuccess?.('Operation deleted')
    } catch (error) {
      onError?.(error as Error)
    }
  }

  const handleMoveOperation = async (
    currentIndex: number,
    direction: 'up' | 'down',
  ) => {
    const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1
    if (targetIndex < 0 || targetIndex >= sortedOps.length) return

    const newOps = [...sortedOps]
    const [moved] = newOps.splice(currentIndex, 1)
    if (!moved) return
    newOps.splice(targetIndex, 0, moved)

    const reordered = newOps.map((op, idx) => ({
      id: op.id,
      orderIndex: idx,
    }))

    try {
      await apiFetch(
        `/api/v1/work-instructions/${workInstructionId}/operations`,
        {
          method: 'PUT',
          body: JSON.stringify({ operations: reordered }),
        },
      )
      await invalidate('work-instructions')
    } catch (error) {
      onError?.(error as Error)
    }
  }

  const handleAssignStepToOperation = async (
    stepId: string,
    operationId: string | null,
  ) => {
    try {
      // The step write belongs to the caller — its handler invalidates
      // `work-instructions` on its own, which is what moves the step between
      // the cards here.
      await onUpdateStep(stepId, { operationId })
    } catch (error) {
      onError?.(error as Error)
    }
  }

  const sortedOps = [...operations].sort((a, b) => a.orderIndex - b.orderIndex)

  // Steps not assigned to any operation
  const unassignedSteps = steps.filter(
    (s) => !s.operationId || !operations.some((o) => o.id === s.operationId),
  )

  // Steps assigned to a specific operation
  const getStepsForOperation = (opId: string) =>
    steps
      .filter((s) => s.operationId === opId)
      .sort((a, b) => a.orderIndex - b.orderIndex)

  const formatTime = (minutes?: number) => {
    if (!minutes) return null
    if (minutes < 60) return `${minutes} min`
    const hours = Math.floor(minutes / 60)
    const mins = minutes % 60
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
          Operations & Steps
        </h3>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={handleAddOperation}>
            <FolderOpen className="h-4 w-4 mr-2" />
            Add Operation
          </Button>
        </div>
      </div>

      {/* Operations */}
      {sortedOps.map((operation, opIndex) => {
        const opSteps = getStepsForOperation(operation.id)
        const isExpanded = expandedOps.has(operation.id)
        const isEditing = editingOpId === operation.id

        return (
          <Card key={operation.id} className="border-l-4 border-l-sky-500">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-3">
                {/* Reorder controls */}
                <div className="flex flex-col gap-0.5">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5"
                    onClick={() => handleMoveOperation(opIndex, 'up')}
                    disabled={opIndex === 0}
                  >
                    <ChevronUp className="h-3 w-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5"
                    onClick={() => handleMoveOperation(opIndex, 'down')}
                    disabled={opIndex === sortedOps.length - 1}
                  >
                    <ChevronDown className="h-3 w-3" />
                  </Button>
                </div>

                {/* Operation title/info */}
                <div
                  className="flex-1 cursor-pointer"
                  onClick={() => toggleExpand(operation.id)}
                >
                  <div className="flex items-center gap-3">
                    <Badge variant="secondary" className="shrink-0">
                      Op {opIndex + 1}
                    </Badge>
                    {isEditing ? (
                      <OperationInlineEditor
                        operation={operation}
                        onSave={(data) => {
                          handleUpdateOperation(operation.id, data)
                          setEditingOpId(null)
                        }}
                        onCancel={() => setEditingOpId(null)}
                      />
                    ) : (
                      <div className="flex items-center gap-2 flex-1">
                        <span
                          className="font-medium text-slate-900 dark:text-white cursor-text"
                          onClick={(e) => {
                            e.stopPropagation()
                            setEditingOpId(operation.id)
                          }}
                        >
                          {operation.title}
                        </span>
                        {operation.estimatedTime && (
                          <span className="flex items-center gap-1 text-xs text-slate-500">
                            <Clock className="h-3 w-3" />
                            {formatTime(operation.estimatedTime)}
                          </span>
                        )}
                        <Badge variant="outline" className="ml-auto">
                          {opSteps.length} step
                          {opSteps.length !== 1 ? 's' : ''}
                        </Badge>
                      </div>
                    )}
                  </div>
                  {operation.description && !isEditing && (
                    <p className="text-sm text-slate-500 mt-1 ml-14">
                      {operation.description}
                    </p>
                  )}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => toggleExpand(operation.id)}
                  >
                    {isExpanded ? (
                      <ChevronUp className="h-4 w-4 text-slate-500" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-slate-500" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-red-500 hover:text-red-700 dark:hover:text-red-300"
                    onClick={() => handleDeleteOperation(operation.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </CardHeader>
            {isExpanded && (
              <CardContent>
                <StepEditor
                  steps={opSteps}
                  workInstructionId={workInstructionId}
                  onAddStep={async (stepData) => {
                    await onAddStep({
                      ...stepData,
                      operationId: operation.id,
                    })
                  }}
                  onUpdateStep={onUpdateStep}
                  onDeleteStep={onDeleteStep}
                  onReorderSteps={onReorderSteps}
                  onError={onError}
                  isLoading={isLoading}
                  operations={sortedOps}
                  onAssignToOperation={handleAssignStepToOperation}
                />
              </CardContent>
            )}
          </Card>
        )
      })}

      {/* Unassigned steps */}
      {unassignedSteps.length > 0 && (
        <Card className="border-l-4 border-l-slate-300 dark:border-l-slate-600">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-3">
              <Badge variant="outline">Unassigned Steps</Badge>
              <span className="text-sm text-slate-500">
                {unassignedSteps.length} step
                {unassignedSteps.length !== 1 ? 's' : ''} not assigned to any
                operation
              </span>
            </div>
          </CardHeader>
          <CardContent>
            <StepEditor
              steps={unassignedSteps}
              workInstructionId={workInstructionId}
              onAddStep={onAddStep}
              onUpdateStep={onUpdateStep}
              onDeleteStep={onDeleteStep}
              onReorderSteps={onReorderSteps}
              onError={onError}
              isLoading={isLoading}
              operations={sortedOps}
              onAssignToOperation={handleAssignStepToOperation}
            />
          </CardContent>
        </Card>
      )}

      {/* Empty state when no operations and no steps */}
      {sortedOps.length === 0 && unassignedSteps.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center">
            <FolderOpen className="h-12 w-12 mx-auto mb-4 text-slate-300" />
            <p className="text-slate-500 mb-4">
              No operations or steps yet. Add an operation to organize your
              steps, or add steps directly.
            </p>
            <div className="flex gap-2 justify-center">
              <Button variant="outline" onClick={handleAddOperation}>
                <FolderOpen className="h-4 w-4 mr-2" />
                Add Operation
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

// Inline editor for operation title/description/time
function OperationInlineEditor({
  operation,
  onSave,
  onCancel,
}: {
  operation: WorkInstructionOperation
  onSave: (data: Partial<WorkInstructionOperation>) => void
  onCancel: () => void
}) {
  const [title, setTitle] = useState(operation.title)
  const [description, setDescription] = useState(operation.description || '')
  const [estimatedTime, setEstimatedTime] = useState(
    operation.estimatedTime?.toString() || '',
  )

  return (
    <div className="flex-1 space-y-2" onClick={(e) => e.stopPropagation()}>
      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Operation title"
        className="font-medium"
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            onSave({
              title,
              description: description || undefined,
              estimatedTime: estimatedTime
                ? parseInt(estimatedTime)
                : undefined,
            })
          }
          if (e.key === 'Escape') onCancel()
        }}
      />
      <Textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description (optional)"
        rows={2}
      />
      <div className="flex items-center gap-2">
        <Input
          type="number"
          value={estimatedTime}
          onChange={(e) => setEstimatedTime(e.target.value)}
          placeholder="Est. time (min)"
          className="w-40"
        />
        <Button
          size="sm"
          onClick={() =>
            onSave({
              title,
              description: description || undefined,
              estimatedTime: estimatedTime
                ? parseInt(estimatedTime)
                : undefined,
            })
          }
        >
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
