// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import type {
  StepContentBlock,
  WorkInstructionOperation,
  WorkInstructionWithSteps,
} from '@/lib/items/types/work-instruction'
import { Button } from '@/components/ui'
import { cn } from '@/lib/utils'
import {
  workInstructionDetailQuery,
  workInstructionOperationsQuery,
  workInstructionResolvedParametricsQuery,
} from '@/lib/query'

export const Route = createFileRoute('/work-instructions/$id/present')({
  component: PresentationModePage,
  loader: async ({ context: { queryClient }, params }) => {
    await Promise.all([
      queryClient.ensureQueryData(workInstructionDetailQuery(params.id)),
      queryClient.ensureQueryData(workInstructionOperationsQuery(params.id)),
    ])
  },
})

function StepBlockRenderer({ block }: { block: StepContentBlock }) {
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
    // Parametric blocks show fallback in presentation (resolved values loaded separately)
    return (
      <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-sky-50 dark:bg-sky-900/30 border border-sky-200 dark:border-sky-700 rounded-md">
        {block.label && (
          <span className="text-sm font-medium text-sky-700 dark:text-sky-300">
            {block.label}:
          </span>
        )}
        <span className="text-lg font-semibold text-sky-900 dark:text-sky-100">
          {block.fallbackValue || '—'}
        </span>
        {block.unit && (
          <span className="text-sm text-sky-600 dark:text-sky-400">
            {block.unit}
          </span>
        )}
      </div>
    )
  }

  const fieldLabel = block.fieldLabel || 'Data Field'
  const fieldType = block.fieldType || 'text'
  const typeLabels: Record<string, string> = {
    text: 'Text',
    numeric: 'Numeric',
    checkbox: 'Checkbox',
    passFail: 'Pass/Fail',
  }
  return (
    <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-emerald-50 dark:bg-emerald-900/30 border border-emerald-200 dark:border-emerald-700 rounded-md">
      <span className="text-sm font-medium text-emerald-700 dark:text-emerald-300">
        {fieldLabel}
      </span>
      <span className="text-xs px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-800 text-emerald-600 dark:text-emerald-300">
        {typeLabels[fieldType] || fieldType}
      </span>
      {block.fieldRequired && <span className="text-xs text-red-500">*</span>}
    </div>
  )
}

function PresentationModePage() {
  const { id } = Route.useParams()
  const { data: instruction } = useQuery(workInstructionDetailQuery(id))
  const { data: operations } = useQuery(workInstructionOperationsQuery(id))

  const workInstruction = useMemo(
    () =>
      instruction
        ? { ...instruction, operations: operations ?? [] }
        : undefined,
    [instruction, operations],
  )

  if (!workInstruction) return null

  return <PresentationView workInstruction={workInstruction} />
}

function PresentationView({
  workInstruction,
}: {
  workInstruction: WorkInstructionWithSteps
}) {
  const navigate = useNavigate()
  const [currentStepIndex, setCurrentStepIndex] = useState(0)

  const sortedSteps = [...workInstruction.steps].sort(
    (a, b) => a.orderIndex - b.orderIndex,
  )
  const operations = workInstruction.operations || []
  const sortedOps = [...operations].sort((a, b) => a.orderIndex - b.orderIndex)

  // Build presentation structure: operations as section headers with their steps
  const presentationSteps = useMemo(() => {
    if (sortedOps.length === 0) {
      return sortedSteps.map((step) => ({
        type: 'step' as const,
        step,
        operationTitle: undefined as string | undefined,
      }))
    }

    const items: Array<
      | {
          type: 'operation'
          operation: WorkInstructionOperation
          stepCount: number
        }
      | { type: 'step'; step: (typeof sortedSteps)[0]; operationTitle?: string }
    > = []

    // Group steps by operation
    for (const op of sortedOps) {
      const opSteps = sortedSteps.filter((s) => s.operationId === op.id)
      if (opSteps.length > 0) {
        items.push({
          type: 'operation',
          operation: op,
          stepCount: opSteps.length,
        })
        for (const step of opSteps) {
          items.push({ type: 'step', step, operationTitle: op.title })
        }
      }
    }

    // Unassigned steps
    const unassigned = sortedSteps.filter(
      (s) =>
        !s.operationId ||
        !operations.some(
          (o: WorkInstructionOperation) => o.id === s.operationId,
        ),
    )
    for (const step of unassigned) {
      items.push({ type: 'step', step, operationTitle: undefined })
    }

    return items
  }, [sortedSteps, sortedOps, operations])

  // Only count actual steps for navigation (not operation headers)
  const stepItems = presentationSteps.filter((i) => i.type === 'step')
  const totalSteps = stepItems.length

  const currentItem = presentationSteps[currentStepIndex]

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

  const handleExit = () => {
    navigate({
      to: '/work-instructions/$id',
      params: { id: workInstruction.id ?? '' },
    })
  }

  // Parametric values, resolved against the parts the blocks reference. Only
  // requested when the template has such blocks; a failure leaves the map
  // empty and the blocks render their fallback values.
  const hasParametric = sortedSteps.some((step) =>
    step.content.blocks.some((b: StepContentBlock) => b.type === 'parametric'),
  )
  const { data: resolvedValues = {} } = useQuery(
    workInstructionResolvedParametricsQuery(
      workInstruction.id ?? '',
      hasParametric,
    ),
  )

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'Enter') {
        e.preventDefault()
        goToNextStep()
      } else if (e.key === 'ArrowLeft' || e.key === 'Backspace') {
        e.preventDefault()
        goToPreviousStep()
      } else if (e.key === 'Escape') {
        handleExit()
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
            This work instruction has no steps to present.
          </p>
          <Button onClick={handleExit} variant="outline">
            <X className="h-4 w-4 mr-2" />
            Exit
          </Button>
        </div>
      </div>
    )
  }

  // Count which step number we're on (excluding operation headers)
  const currentStepNumber = presentationSteps
    .slice(0, currentStepIndex + 1)
    .filter((i) => i.type === 'step').length

  // Progress based on step items only
  const progress = (currentStepNumber / totalSteps) * 100

  return (
    <div className="fixed inset-0 z-50 bg-white dark:bg-slate-900 flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b dark:border-slate-700 bg-slate-50 dark:bg-slate-800">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={handleExit}>
            <X className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="font-bold text-lg text-slate-900 dark:text-white">
              {workInstruction.itemNumber}
            </h1>
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
      <div className="h-1 bg-slate-200 dark:bg-slate-700">
        <div
          className="h-full bg-sky-500 transition-all duration-300"
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Main content */}
      <main className="flex-1 overflow-auto p-8 lg:p-16">
        <div className="max-w-4xl mx-auto">
          {currentItem?.type === 'operation' ? (
            // Operation header slide
            <div className="flex flex-col items-center justify-center min-h-[50vh]">
              <div className="text-center">
                <span className="text-sm font-medium text-sky-600 dark:text-sky-400 uppercase tracking-wider">
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
                <p className="text-sm text-slate-400 dark:text-slate-500 mt-6">
                  {currentItem.stepCount} step
                  {currentItem.stepCount !== 1 ? 's' : ''}
                  {currentItem.operation.estimatedTime &&
                    ` · ${currentItem.operation.estimatedTime} min`}
                </p>
              </div>
            </div>
          ) : currentItem?.type === 'step' ? (
            // Step content
            <>
              {/* Operation context */}
              {currentItem.operationTitle && (
                <div className="mb-4">
                  <span className="text-sm font-medium text-sky-600 dark:text-sky-400">
                    {currentItem.operationTitle}
                  </span>
                </div>
              )}

              {/* Step title */}
              <div className="mb-8">
                <div className="flex items-center gap-4 mb-4">
                  <span className="flex items-center justify-center h-12 w-12 rounded-full bg-sky-100 text-sky-700 font-bold text-xl dark:bg-sky-900 dark:text-sky-300">
                    {currentStepNumber}
                  </span>
                  <h2 className="text-3xl font-bold text-slate-900 dark:text-white">
                    {currentItem.step.title || `Step ${currentStepNumber}`}
                  </h2>
                </div>
              </div>

              {/* Step content */}
              <div className="space-y-8">
                {currentItem.step.content.blocks.map(
                  (block: StepContentBlock, index: number) => {
                    // For parametric blocks, override with resolved value
                    if (
                      block.type === 'parametric' &&
                      block.partId &&
                      block.attributePath
                    ) {
                      const key = `${block.partId}.${block.attributePath}`
                      const resolved = resolvedValues[key]
                      if (resolved) {
                        return (
                          <div
                            key={block.id || index}
                            className="inline-flex items-center gap-2 px-3 py-1.5 bg-sky-50 dark:bg-sky-900/30 border border-sky-200 dark:border-sky-700 rounded-md"
                          >
                            {block.label && (
                              <span className="text-sm font-medium text-sky-700 dark:text-sky-300">
                                {block.label}:
                              </span>
                            )}
                            <span className="text-lg font-semibold text-sky-900 dark:text-sky-100">
                              {resolved.available
                                ? (resolved.value ?? block.fallbackValue ?? '—')
                                : (block.fallbackValue ?? 'N/A')}
                            </span>
                            {block.unit && resolved.available && (
                              <span className="text-sm text-sky-600 dark:text-sky-400">
                                {block.unit}
                              </span>
                            )}
                          </div>
                        )
                      }
                    }
                    return (
                      <StepBlockRenderer
                        key={block.id || index}
                        block={block}
                      />
                    )
                  },
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

        {/* Step indicators */}
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
                  ? 'bg-sky-500'
                  : index < currentStepIndex
                    ? item.type === 'operation'
                      ? 'bg-sky-200 dark:bg-sky-800'
                      : 'bg-sky-300 dark:bg-sky-700'
                    : 'bg-slate-300 dark:bg-slate-600',
              )}
              aria-label={
                item.type === 'operation'
                  ? `Go to operation: ${item.operation.title}`
                  : `Go to step ${index + 1}`
              }
            />
          ))}
        </div>

        <Button
          variant={
            currentStepIndex === presentationSteps.length - 1
              ? 'default'
              : 'outline'
          }
          size="lg"
          onClick={
            currentStepIndex === presentationSteps.length - 1
              ? handleExit
              : goToNextStep
          }
          className="min-w-[150px]"
        >
          {currentStepIndex === presentationSteps.length - 1 ? (
            <>
              Complete
              <X className="h-5 w-5 ml-2" />
            </>
          ) : (
            <>
              Next
              <ChevronRight className="h-5 w-5 ml-2" />
            </>
          )}
        </Button>
      </footer>
    </div>
  )
}
