// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import {
  AlertTriangle,
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  LogOut,
  X,
} from 'lucide-react'
import type {
  InstructionSnapshot,
  WorkOrderInstruction,
} from '@/lib/items/types/work-order'
import type { StepContentBlock } from '@/lib/items/types/work-instruction'
import type { ResolvedParametricValue } from '@/components/work-orders/useInstructionRun'
import { Button } from '@/components/ui'
import { cn } from '@/lib/utils'
import { useInvalidateResources, workOrderInstructionQuery } from '@/lib/query'
import { useInstructionRun } from '@/components/work-orders/useInstructionRun'

type SnapshotOperation = InstructionSnapshot['operations'][number]
type SnapshotStep = InstructionSnapshot['steps'][number]

const searchSchema = z.object({
  unitLabel: z.string().optional(),
})

export const Route = createFileRoute('/work-orders/$id/run/$instructionId')({
  component: RunInstructionPage,
  validateSearch: searchSchema,
  loader: ({ context: { queryClient }, params }) =>
    queryClient.ensureQueryData(
      workOrderInstructionQuery(params.id, params.instructionId),
    ),
})

// Interactive data field renderer for execution mode
function ExecutionDataField({
  block,
  value,
  onChange,
  disabled,
}: {
  block: StepContentBlock
  value: unknown
  onChange: (value: unknown) => void
  /** True until the server has a run to record entries against. */
  disabled: boolean
}) {
  const fieldLabel = block.fieldLabel || 'Data Field'
  // The checkbox branch already had one; these are the same id, shared so the
  // numeric and text inputs get a real label association and the pass/fail
  // button pair gets a group name.
  const fieldId = `field-${block.id}`

  switch (block.fieldType) {
    case 'numeric': {
      const numVal = value as number | ''
      const isOutOfRange =
        numVal !== '' &&
        ((block.fieldValidation?.min != null &&
          numVal < block.fieldValidation.min) ||
          (block.fieldValidation?.max != null &&
            numVal > block.fieldValidation.max))

      return (
        <div className="space-y-1">
          <label
            htmlFor={fieldId}
            className="text-lg font-medium text-emerald-700 dark:text-emerald-300"
          >
            {fieldLabel}
            {block.fieldRequired && (
              <span className="text-red-500 ml-1">*</span>
            )}
          </label>
          <input
            id={fieldId}
            type="number"
            value={numVal}
            onChange={(e) =>
              onChange(e.target.value ? Number(e.target.value) : '')
            }
            disabled={disabled}
            min={block.fieldValidation?.min}
            max={block.fieldValidation?.max}
            className={cn(
              'w-full px-4 py-3 text-xl border rounded-lg bg-white dark:bg-slate-800 focus:ring-2 focus:ring-emerald-500 outline-none disabled:opacity-50',
              isOutOfRange
                ? 'border-red-500 focus:ring-red-500'
                : 'border-slate-300 dark:border-slate-600',
            )}
            placeholder={
              block.fieldValidation?.min != null &&
              block.fieldValidation.max != null
                ? `${block.fieldValidation.min} – ${block.fieldValidation.max}`
                : 'Enter value...'
            }
          />
          {block.fieldValidation?.min != null &&
            block.fieldValidation.max != null && (
              <p className="text-sm text-slate-500">
                Range: {block.fieldValidation.min} – {block.fieldValidation.max}
              </p>
            )}
          {isOutOfRange && (
            <p className="text-sm text-red-500 font-medium">
              Value is out of range
            </p>
          )}
        </div>
      )
    }
    case 'checkbox':
      return (
        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={!!value}
            onChange={(e) => onChange(e.target.checked)}
            disabled={disabled}
            className="h-6 w-6 rounded border-slate-300 dark:border-slate-700 text-emerald-600 dark:text-emerald-400 focus:ring-emerald-500 disabled:opacity-50"
            id={fieldId}
          />
          <label
            htmlFor={fieldId}
            className="text-lg font-medium text-emerald-700 dark:text-emerald-300"
          >
            {fieldLabel}
            {block.fieldRequired && (
              <span className="text-red-500 ml-1">*</span>
            )}
          </label>
        </div>
      )
    case 'passFail':
      return (
        <div className="space-y-2">
          {/* Two buttons, not a labelable control: `htmlFor` has nothing to
              point at, so the pair is a labelled group instead. */}
          <span
            id={fieldId}
            className="block text-lg font-medium text-emerald-700 dark:text-emerald-300"
          >
            {fieldLabel}
            {block.fieldRequired && (
              <span className="text-red-500 ml-1">*</span>
            )}
          </span>
          <div className="flex gap-3" role="group" aria-labelledby={fieldId}>
            <button
              type="button"
              onClick={() => onChange('pass')}
              disabled={disabled}
              className={cn(
                'disabled:opacity-50',
                'flex-1 py-3 px-6 rounded-lg text-lg font-semibold transition-colors',
                value === 'pass'
                  ? 'bg-green-500 text-white'
                  : 'bg-green-100 text-green-700 hover:bg-green-200 dark:hover:bg-green-900/50 dark:bg-green-900/30 dark:text-green-300',
              )}
            >
              Pass
            </button>
            <button
              type="button"
              onClick={() => onChange('fail')}
              disabled={disabled}
              className={cn(
                'disabled:opacity-50',
                'flex-1 py-3 px-6 rounded-lg text-lg font-semibold transition-colors',
                value === 'fail'
                  ? 'bg-red-500 text-white'
                  : 'bg-red-100 text-red-700 hover:bg-red-200 dark:hover:bg-red-900/50 dark:bg-red-900/30 dark:text-red-300',
              )}
            >
              Fail
            </button>
          </div>
        </div>
      )
    default:
      return (
        <div className="space-y-1">
          <label
            htmlFor={fieldId}
            className="text-lg font-medium text-emerald-700 dark:text-emerald-300"
          >
            {fieldLabel}
            {block.fieldRequired && (
              <span className="text-red-500 ml-1">*</span>
            )}
          </label>
          <input
            id={fieldId}
            type="text"
            value={(value as string) || ''}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            className="w-full px-4 py-3 text-xl border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 focus:ring-2 focus:ring-emerald-500 outline-none disabled:opacity-50"
            placeholder="Enter value..."
          />
        </div>
      )
  }
}

function ExecutionStepBlockRenderer({
  block,
  fieldValues,
  onFieldChange,
  resolvedValues,
  fieldsDisabled,
}: {
  block: StepContentBlock
  fieldValues: Record<string, unknown>
  onFieldChange: (blockId: string, value: unknown) => void
  resolvedValues: Record<string, ResolvedParametricValue>
  fieldsDisabled: boolean
}) {
  if (block.type === 'text') {
    return (
      <div className="max-w-none">
        <p className="text-xl leading-relaxed whitespace-pre-wrap text-slate-700 dark:text-white">
          {block.content}
        </p>
      </div>
    )
  }

  if (block.type === 'image') {
    return (
      <div className="flex flex-col items-center">
        {block.fileId ? (
          <>
            <img
              src={`/api/v1/files/${block.fileId}`}
              alt={block.alt || 'Step image'}
              className="max-w-full max-h-[50vh] rounded-lg shadow-lg"
            />
            {block.caption && (
              <p className="mt-4 text-lg text-slate-500 dark:text-slate-400">
                {block.caption}
              </p>
            )}
          </>
        ) : (
          <div className="flex items-center justify-center w-full h-64 bg-slate-100 dark:bg-slate-800 rounded-lg">
            <p className="text-slate-500">Image placeholder</p>
          </div>
        )}
      </div>
    )
  }

  if (block.type === 'parametric') {
    const key = `${block.partId}.${block.attributePath}`
    const resolved = resolvedValues[key]
    return (
      <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-sky-50 dark:bg-sky-900/30 border border-sky-200 dark:border-sky-700 rounded-md">
        {block.label && (
          <span className="text-sm font-medium text-sky-700 dark:text-sky-300">
            {block.label}:
          </span>
        )}
        <span className="text-lg font-semibold text-sky-900 dark:text-sky-100">
          {resolved?.available
            ? (resolved.value ?? block.fallbackValue ?? '—')
            : (block.fallbackValue ?? '—')}
        </span>
        {block.unit && resolved?.available && (
          <span className="text-sm text-sky-600 dark:text-sky-400">
            {block.unit}
          </span>
        )}
      </div>
    )
  }

  return (
    <div className="p-4 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-700 rounded-lg">
      <ExecutionDataField
        block={block}
        value={fieldValues[block.id]}
        onChange={(value) => onFieldChange(block.id, value)}
        disabled={fieldsDisabled}
      />
    </div>
  )
}

function RunInstructionPage() {
  const { id: workOrderId, instructionId } = Route.useParams()
  const { data: instruction } = useQuery(
    workOrderInstructionQuery(workOrderId, instructionId),
  )

  if (!instruction) return null

  return (
    <InstructionRunner instruction={instruction} workOrderId={workOrderId} />
  )
}

function InstructionRunner({
  instruction,
  workOrderId,
}: {
  instruction: WorkOrderInstruction
  workOrderId: string
}) {
  const navigate = useNavigate()
  const invalidate = useInvalidateResources()
  const { unitLabel } = Route.useSearch()
  const [showExitConfirm, setShowExitConfirm] = useState(false)

  const snapshot = instruction.snapshot

  const sortedSteps = useMemo(
    () => [...snapshot.steps].sort((a, b) => a.orderIndex - b.orderIndex),
    [snapshot.steps],
  )
  const sortedOps = useMemo(
    () => [...snapshot.operations].sort((a, b) => a.orderIndex - b.orderIndex),
    [snapshot.operations],
  )

  // Build presentation structure
  const presentationSteps = useMemo(() => {
    if (sortedOps.length === 0) {
      return sortedSteps.map((step) => ({
        type: 'step' as const,
        step,
        operationTitle: undefined as string | undefined,
      }))
    }
    const stepItems: Array<
      | {
          type: 'operation'
          operation: SnapshotOperation
          stepCount: number
        }
      | { type: 'step'; step: SnapshotStep; operationTitle?: string }
    > = []
    for (const op of sortedOps) {
      const opSteps = sortedSteps.filter((s) => s.operationId === op.id)
      if (opSteps.length > 0) {
        stepItems.push({
          type: 'operation',
          operation: op,
          stepCount: opSteps.length,
        })
        for (const step of opSteps) {
          stepItems.push({ type: 'step', step, operationTitle: op.title })
        }
      }
    }
    const unassigned = sortedSteps.filter(
      (s) => !s.operationId || !sortedOps.some((o) => o.id === s.operationId),
    )
    for (const step of unassigned) {
      stepItems.push({ type: 'step', step, operationTitle: undefined })
    }
    return stepItems
  }, [sortedSteps, sortedOps])

  const stepItems = presentationSteps.filter((i) => i.type === 'step')
  const totalSteps = stepItems.length

  const hasParametricBlocks = useMemo(
    () =>
      sortedSteps.some((step) =>
        step.content.blocks.some(
          (b: StepContentBlock) => b.type === 'parametric',
        ),
      ),
    [sortedSteps],
  )

  const exitToWorkOrder = useCallback(async () => {
    await invalidate('work-orders')
    navigate({
      to: '/work-orders/$id',
      params: { id: workOrderId },
      search: { tab: 'instructions' },
    })
  }, [invalidate, navigate, workOrderId])

  const run = useInstructionRun({
    workOrderId,
    instructionId: instruction.id,
    unitLabel,
    hasParametricBlocks,
    onExit: exitToWorkOrder,
  })

  const { currentStepIndex, goToStep } = run
  const currentItem = presentationSteps[currentStepIndex]

  const goToNextStep = useCallback(() => {
    if (currentStepIndex < presentationSteps.length - 1) {
      goToStep(currentStepIndex + 1)
    }
  }, [currentStepIndex, goToStep, presentationSteps.length])

  const goToPreviousStep = useCallback(() => {
    if (currentStepIndex > 0) {
      goToStep(currentStepIndex - 1)
    }
  }, [currentStepIndex, goToStep])

  const handleExit = () => {
    setShowExitConfirm(true)
  }

  // Keyboard navigation (no space/enter to prevent conflicts with inputs)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      const isInput =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT'

      if (e.key === 'Escape') {
        handleExit()
      }
      if (isInput) return

      if (e.key === 'ArrowRight') {
        e.preventDefault()
        goToNextStep()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        goToPreviousStep()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [goToNextStep, goToPreviousStep])

  // A run that never started records nothing. Say so and offer a retry rather
  // than rendering an editable traveler whose entries go nowhere.
  if (run.startError) {
    return (
      <div className="fixed inset-0 z-50 bg-slate-900 flex items-center justify-center">
        <div className="max-w-md text-center text-white px-6">
          <AlertTriangle className="h-10 w-10 mx-auto mb-4 text-amber-400" />
          <h1 className="text-2xl font-bold mb-2">Could not start this run</h1>
          <p className="text-slate-400 mb-2">{run.startError.message}</p>
          <p className="text-slate-500 text-sm mb-8">
            Nothing you enter would be recorded until the run starts.
          </p>
          <div className="flex justify-center gap-3">
            <Button onClick={run.retryStart} disabled={run.isStarting}>
              {run.isStarting ? 'Retrying...' : 'Retry'}
            </Button>
            <Button onClick={() => void exitToWorkOrder()} variant="outline">
              <X className="h-4 w-4 mr-2" />
              Exit
            </Button>
          </div>
        </div>
      </div>
    )
  }

  if (totalSteps === 0) {
    return (
      <div className="fixed inset-0 z-50 bg-slate-900 flex items-center justify-center">
        <div className="text-center text-white">
          <h1 className="text-2xl font-bold mb-4">No Steps Available</h1>
          <p className="text-slate-400 mb-8">
            This instruction's snapshot has no steps to execute.
          </p>
          <Button onClick={() => void exitToWorkOrder()} variant="outline">
            <X className="h-4 w-4 mr-2" />
            Exit
          </Button>
        </div>
      </div>
    )
  }

  const currentStepNumber = presentationSteps
    .slice(0, currentStepIndex + 1)
    .filter((i) => i.type === 'step').length

  const progress = (currentStepNumber / totalSteps) * 100
  const isLastStep = currentStepIndex === presentationSteps.length - 1

  return (
    <div className="fixed inset-0 z-50 bg-white dark:bg-slate-900 flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b dark:border-slate-700 bg-emerald-50 dark:bg-emerald-900/20">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={handleExit}>
            <X className="h-5 w-5" />
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="font-bold text-lg text-slate-900 dark:text-white">
                {instruction.title}
              </h1>
              <span className="text-xs px-2 py-0.5 rounded bg-emerald-100 text-emerald-700 dark:bg-emerald-800 dark:text-emerald-300 font-medium">
                EXECUTING
              </span>
              {unitLabel && (
                <span className="text-xs px-2 py-0.5 rounded bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-300 font-mono">
                  {unitLabel}
                </span>
              )}
            </div>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {instruction.instructionNumber}
              {instruction.part && ` · ${instruction.part.itemNumber}`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-4 text-sm text-slate-500 dark:text-slate-400">
          {run.hasUnsavedChanges && (
            <span
              role="status"
              className="flex items-center gap-1.5 px-2 py-1 rounded bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 font-medium"
            >
              <AlertTriangle className="h-4 w-4" />
              Changes not saved
            </span>
          )}
          <div className="flex items-center gap-2">
            <span className="font-medium text-slate-900 dark:text-white">
              Step {currentStepNumber}
            </span>
            <span>of</span>
            <span>{totalSteps}</span>
          </div>
        </div>
      </header>

      {/* Progress bar */}
      <div className="h-1.5 bg-slate-200 dark:bg-slate-700">
        <div
          className="h-full bg-emerald-500 transition-all duration-300"
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Main content */}
      <main className="flex-1 overflow-auto p-8 lg:p-16">
        <div className="max-w-4xl mx-auto">
          {currentItem?.type === 'operation' ? (
            <div className="flex flex-col items-center justify-center min-h-[50vh]">
              <div className="text-center">
                <span className="text-sm font-medium text-emerald-600 dark:text-emerald-400 uppercase tracking-wider">
                  Operation {sortedOps.indexOf(currentItem.operation) + 1}
                </span>
                <h2 className="text-4xl font-bold text-slate-900 dark:text-white mt-2">
                  {currentItem.operation.title}
                </h2>
                {currentItem.operation.description && (
                  <p className="text-xl text-slate-500 dark:text-slate-400 mt-4 max-w-xl">
                    {currentItem.operation.description}
                  </p>
                )}
              </div>
            </div>
          ) : currentItem?.type === 'step' ? (
            <>
              {currentItem.operationTitle && (
                <div className="mb-4">
                  <span className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
                    {currentItem.operationTitle}
                  </span>
                </div>
              )}

              <div className="mb-8">
                <div className="flex items-center gap-4 mb-4">
                  <span className="flex items-center justify-center h-12 w-12 rounded-full bg-emerald-100 text-emerald-700 font-bold text-xl dark:bg-emerald-900 dark:text-emerald-300">
                    {currentStepNumber}
                  </span>
                  <h2 className="text-3xl font-bold text-slate-900 dark:text-white">
                    {currentItem.step.title || `Step ${currentStepNumber}`}
                  </h2>
                </div>
              </div>

              <div className="space-y-8">
                {currentItem.step.content.blocks.map(
                  (block: StepContentBlock, index: number) => (
                    <ExecutionStepBlockRenderer
                      key={block.id || index}
                      block={block}
                      fieldValues={run.fieldValues}
                      onFieldChange={run.setFieldValue}
                      resolvedValues={run.resolvedValues}
                      fieldsDisabled={run.fieldsDisabled}
                    />
                  ),
                )}
                {currentItem.step.content.blocks.length === 0 && (
                  <p className="text-xl text-slate-500 dark:text-slate-400 text-center py-8">
                    No content for this step.
                  </p>
                )}
              </div>
            </>
          ) : null}
        </div>
      </main>

      {/* Footer navigation */}
      <footer className="flex items-center justify-between px-6 py-4 border-t dark:border-slate-700 bg-slate-50 dark:bg-slate-800">
        <Button
          variant="outline"
          size="lg"
          onClick={goToPreviousStep}
          disabled={currentStepIndex === 0}
          className="min-w-[150px]"
        >
          <ChevronLeft className="h-5 w-5 mr-2" />
          Previous
        </Button>

        <div className="hidden md:flex items-center gap-2">
          {presentationSteps.map((item, index) => (
            <button
              key={index}
              onClick={() => goToStep(index)}
              className={cn(
                'transition-colors',
                item.type === 'operation'
                  ? 'w-1.5 h-5 rounded-sm'
                  : 'w-3 h-3 rounded-full',
                index === currentStepIndex
                  ? 'bg-emerald-500'
                  : index < currentStepIndex
                    ? 'bg-emerald-300 dark:bg-emerald-700'
                    : 'bg-slate-300 dark:bg-slate-600',
              )}
            />
          ))}
        </div>

        {isLastStep ? (
          <Button
            size="lg"
            onClick={() => void run.complete()}
            disabled={run.completing || run.fieldsDisabled}
            className="min-w-[150px] bg-emerald-600 hover:bg-emerald-700"
          >
            <CheckCircle className="h-5 w-5 mr-2" />
            {run.completing ? 'Completing...' : 'Complete'}
          </Button>
        ) : (
          <Button
            variant="outline"
            size="lg"
            onClick={goToNextStep}
            className="min-w-[150px]"
          >
            Next
            <ChevronRight className="h-5 w-5 ml-2" />
          </Button>
        )}
      </footer>

      {/* Exit confirmation overlay */}
      {showExitConfirm && (
        <div className="fixed inset-0 z-60 bg-black/50 flex items-center justify-center">
          <div className="bg-white dark:bg-slate-800 rounded-lg p-6 max-w-md mx-4 shadow-xl">
            <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-2">
              Exit Run?
            </h3>
            <p className="text-slate-600 dark:text-slate-400 mb-6">
              Pause keeps this run in progress so you can resume it later.
              Abandon closes it out as an incomplete record.
            </p>
            <div className="flex justify-end gap-3">
              <Button
                variant="outline"
                onClick={() => setShowExitConfirm(false)}
              >
                Keep Working
              </Button>
              <Button variant="outline" onClick={() => void run.pause()}>
                <LogOut className="h-4 w-4 mr-2" />
                Pause
              </Button>
              <Button variant="destructive" onClick={() => void run.abandon()}>
                <X className="h-4 w-4 mr-2" />
                Abandon
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
