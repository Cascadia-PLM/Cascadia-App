import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import { CheckCircle, ChevronLeft, ChevronRight, LogOut, X } from 'lucide-react'
import type {
  StepContentBlock,
  WorkInstructionOperation,
  WorkInstructionWithSteps,
} from '@/lib/items/types/work-instruction'
import { Button } from '@/components/ui'
import { cn } from '@/lib/utils'
import { apiFetch } from '@/lib/api/client'

const searchSchema = z.object({
  workOrderId: z.string().optional(),
})

export const Route = createFileRoute('/work-instructions/$id/execute')({
  component: ExecutionModePage,
  validateSearch: searchSchema,
  loader: async ({ params }) => {
    const [wiResult, opsResult] = await Promise.all([
      apiFetch<{ data: { workInstruction: WorkInstructionWithSteps } }>(
        `/api/work-instructions/${params.id}`,
      ),
      apiFetch<{ data: { operations: Array<WorkInstructionOperation> } }>(
        `/api/work-instructions/${params.id}/operations`,
      ),
    ])
    return {
      workInstruction: {
        ...wiResult.data.workInstruction,
        operations: opsResult.data.operations,
      } as WorkInstructionWithSteps,
    }
  },
})

// Interactive data field renderer for execution mode
function ExecutionDataField({
  block,
  value,
  onChange,
}: {
  block: StepContentBlock
  value: unknown
  onChange: (value: unknown) => void
}) {
  const fieldLabel = block.fieldLabel || 'Data Field'

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
          <label className="text-lg font-medium text-emerald-700 dark:text-emerald-300">
            {fieldLabel}
            {block.fieldRequired && (
              <span className="text-red-500 ml-1">*</span>
            )}
          </label>
          <input
            type="number"
            value={numVal}
            onChange={(e) =>
              onChange(e.target.value ? Number(e.target.value) : '')
            }
            min={block.fieldValidation?.min}
            max={block.fieldValidation?.max}
            className={cn(
              'w-full px-4 py-3 text-xl border rounded-lg bg-white dark:bg-slate-800 focus:ring-2 focus:ring-emerald-500 outline-none',
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
            className="h-6 w-6 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
            id={`field-${block.id}`}
          />
          <label
            htmlFor={`field-${block.id}`}
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
          <label className="text-lg font-medium text-emerald-700 dark:text-emerald-300">
            {fieldLabel}
            {block.fieldRequired && (
              <span className="text-red-500 ml-1">*</span>
            )}
          </label>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => onChange('pass')}
              className={cn(
                'flex-1 py-3 px-6 rounded-lg text-lg font-semibold transition-colors',
                value === 'pass'
                  ? 'bg-green-500 text-white'
                  : 'bg-green-100 text-green-700 hover:bg-green-200 dark:bg-green-900/30 dark:text-green-300',
              )}
            >
              Pass
            </button>
            <button
              type="button"
              onClick={() => onChange('fail')}
              className={cn(
                'flex-1 py-3 px-6 rounded-lg text-lg font-semibold transition-colors',
                value === 'fail'
                  ? 'bg-red-500 text-white'
                  : 'bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-300',
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
          <label className="text-lg font-medium text-emerald-700 dark:text-emerald-300">
            {fieldLabel}
            {block.fieldRequired && (
              <span className="text-red-500 ml-1">*</span>
            )}
          </label>
          <input
            type="text"
            value={(value as string) || ''}
            onChange={(e) => onChange(e.target.value)}
            className="w-full px-4 py-3 text-xl border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 focus:ring-2 focus:ring-emerald-500 outline-none"
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
}: {
  block: StepContentBlock
  fieldValues: Record<string, unknown>
  onFieldChange: (blockId: string, value: unknown) => void
  resolvedValues: Record<string, { value: string | null; available: boolean }>
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
              src={`/api/files/${block.fileId}`}
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
      />
    </div>
  )
}

function ExecutionModePage() {
  const navigate = useNavigate()
  const { workInstruction } = Route.useLoaderData()
  const { workOrderId } = Route.useSearch()
  const [currentStepIndex, setCurrentStepIndex] = useState(0)
  const [executionId, setExecutionId] = useState<string | null>(null)
  const [fieldValues, setFieldValues] = useState<Record<string, unknown>>({})
  const [completing, setCompleting] = useState(false)
  const [showExitConfirm, setShowExitConfirm] = useState(false)
  const [resolvedValues, setResolvedValues] = useState<
    Record<string, { value: string | null; available: boolean }>
  >({})
  const saveTimeoutRef = useRef<NodeJS.Timeout | undefined>(undefined)

  const sortedSteps = [...(workInstruction.steps || [])].sort(
    (a, b) => a.orderIndex - b.orderIndex,
  )
  const operations = workInstruction.operations || []
  const sortedOps = [...operations].sort((a, b) => a.orderIndex - b.orderIndex)

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
          operation: WorkInstructionOperation
          stepCount: number
        }
      | { type: 'step'; step: (typeof sortedSteps)[0]; operationTitle?: string }
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
      (s) => !s.operationId || !operations.some((o) => o.id === s.operationId),
    )
    for (const step of unassigned) {
      stepItems.push({ type: 'step', step, operationTitle: undefined })
    }
    return stepItems
  }, [sortedSteps, sortedOps, operations])

  const stepItems = presentationSteps.filter((i) => i.type === 'step')
  const totalSteps = stepItems.length
  const currentItem = presentationSteps[currentStepIndex]

  // Start or resume execution on mount
  useEffect(() => {
    fetch(`/api/work-instructions/${workInstruction.id}/executions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workOrderId }),
    })
      .then((r) => r.json())
      .then((data) => {
        const exec = data.data?.execution
        if (exec) {
          setExecutionId(exec.id)
          if (data.data.resumed) {
            setCurrentStepIndex(exec.currentStepIndex || 0)
            // Restore field values from step data
            const restored: Record<string, unknown> = {}
            if (exec.stepData) {
              for (const [key, entry] of Object.entries(exec.stepData)) {
                restored[key] = (entry as { value: unknown }).value
              }
            }
            setFieldValues(restored)
          }
        }
      })
      .catch(console.error)
  }, [workInstruction.id, workOrderId])

  // Resolve parametric values
  useEffect(() => {
    const hasParametric = sortedSteps.some((step) =>
      step.content?.blocks?.some((b) => b.type === 'parametric'),
    )
    if (!hasParametric) return

    fetch(`/api/work-instructions/${workInstruction.id}/resolve-parametric`)
      .then((r) => r.json())
      .then((data) => {
        if (data.data?.resolved) {
          setResolvedValues(data.data.resolved)
        }
      })
      .catch(() => {})
  }, [workInstruction.id, sortedSteps])

  // Save field data (debounced)
  const saveFieldData = useCallback(
    (blockId: string, value: unknown) => {
      if (!executionId) return
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)
      saveTimeoutRef.current = setTimeout(() => {
        fetch(
          `/api/work-instructions/${workInstruction.id}/executions/${executionId}`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              stepData: { blockId, value },
            }),
          },
        ).catch(console.error)
      }, 500)
    },
    [executionId, workInstruction.id],
  )

  const handleFieldChange = (blockId: string, value: unknown) => {
    setFieldValues((prev) => ({ ...prev, [blockId]: value }))
    saveFieldData(blockId, value)
  }

  // Save progress when step changes
  useEffect(() => {
    if (!executionId) return
    fetch(
      `/api/work-instructions/${workInstruction.id}/executions/${executionId}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentStepIndex }),
      },
    ).catch(console.error)
  }, [currentStepIndex, executionId, workInstruction.id])

  const goToNextStep = useCallback(() => {
    if (currentStepIndex < presentationSteps.length - 1) {
      setCurrentStepIndex((prev) => prev + 1)
    }
  }, [currentStepIndex, presentationSteps.length])

  const goToPreviousStep = useCallback(() => {
    if (currentStepIndex > 0) {
      setCurrentStepIndex((prev) => prev - 1)
    }
  }, [currentStepIndex])

  const handleComplete = async () => {
    if (!executionId) return
    setCompleting(true)
    try {
      await fetch(
        `/api/work-instructions/${workInstruction.id}/executions/${executionId}/complete`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      )
      navigate({
        to: '/work-instructions/$id',
        params: { id: workInstruction.id ?? '' },
      })
    } catch {
      setCompleting(false)
    }
  }

  const handleExit = () => {
    setShowExitConfirm(true)
  }

  const confirmExit = async () => {
    if (executionId) {
      await fetch(
        `/api/work-instructions/${workInstruction.id}/executions/${executionId}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentStepIndex }),
        },
      ).catch(() => {})

      // Mark as incomplete
      try {
        const response = await fetch(
          `/api/work-instructions/${workInstruction.id}/executions/${executionId}/complete`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ notes: 'Exited early' }),
          },
        )
        // If it fails (due to status validation), we'll mark incomplete via a different approach
        if (!response.ok) {
          // Simply navigate away - the execution remains "In Progress" for resume
        }
      } catch {
        // Navigation will still happen
      }
    }
    navigate({
      to: '/work-instructions/$id',
      params: { id: workInstruction.id ?? '' },
    })
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

  if (totalSteps === 0) {
    return (
      <div className="fixed inset-0 z-50 bg-slate-900 flex items-center justify-center">
        <div className="text-center text-white">
          <h1 className="text-2xl font-bold mb-4">No Steps Available</h1>
          <p className="text-slate-400 mb-8">
            This work instruction has no steps to execute.
          </p>
          <Button
            onClick={() =>
              navigate({
                to: '/work-instructions/$id',
                params: { id: workInstruction.id ?? '' },
              })
            }
            variant="outline"
          >
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
                {workInstruction.itemNumber}
              </h1>
              <span className="text-xs px-2 py-0.5 rounded bg-emerald-100 text-emerald-700 dark:bg-emerald-800 dark:text-emerald-300 font-medium">
                EXECUTING
              </span>
            </div>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {workInstruction.name}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
          <span className="font-medium text-slate-900 dark:text-white">
            Step {currentStepNumber}
          </span>
          <span>of</span>
          <span>{totalSteps}</span>
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
                    {currentItem.step?.title || `Step ${currentStepNumber}`}
                  </h2>
                </div>
              </div>

              <div className="space-y-8">
                {currentItem.step?.content?.blocks.map(
                  (block: StepContentBlock, index: number) => (
                    <ExecutionStepBlockRenderer
                      key={block.id || index}
                      block={block}
                      fieldValues={fieldValues}
                      onFieldChange={handleFieldChange}
                      resolvedValues={resolvedValues}
                    />
                  ),
                )}
                {(!currentItem.step?.content?.blocks ||
                  currentItem.step.content.blocks.length === 0) && (
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
              onClick={() => setCurrentStepIndex(index)}
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
            onClick={handleComplete}
            disabled={completing}
            className="min-w-[150px] bg-emerald-600 hover:bg-emerald-700"
          >
            <CheckCircle className="h-5 w-5 mr-2" />
            {completing ? 'Completing...' : 'Complete'}
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
              Exit Execution?
            </h3>
            <p className="text-slate-600 dark:text-slate-400 mb-6">
              Your progress will be saved. You can resume this execution later.
            </p>
            <div className="flex justify-end gap-3">
              <Button
                variant="outline"
                onClick={() => setShowExitConfirm(false)}
              >
                Continue Executing
              </Button>
              <Button variant="destructive" onClick={confirmExit}>
                <LogOut className="h-4 w-4 mr-2" />
                Exit
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
