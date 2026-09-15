// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The run lifecycle behind the traveler runner: start or resume a run of a
 * traveler line, persist field data and progress as the operator works, and
 * close it out by completing, pausing, or abandoning.
 *
 * It lives apart from the runner page because it is the part that can be wrong
 * in ways nobody sees. Every call here writes to an execution record that an
 * auditor may read later, so a request that fails has to be visible: the run
 * never opens for editing before the server has one, a failed close-out leaves
 * the operator on the page with their work intact, and a write that did not
 * land says so instead of being logged to a console nobody has open.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { InstructionExecution } from '@/lib/items/types/work-order'
import { ApiError, apiFetch } from '@/lib/api/client'
import { ErrorCode } from '@/lib/errors/codes'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'

/** A parametric block's value resolved against current part data. */
export interface ResolvedParametricValue {
  value: string | null
  available: boolean
}

export interface UseInstructionRunOptions {
  workOrderId: string
  instructionId: string
  /** Serial or lot label when the line is run per unit. */
  unitLabel?: string
  /** Whether the snapshot has parametric blocks worth resolving. */
  hasParametricBlocks: boolean
  /**
   * Leave the runner. Called only after a close-out the server accepted, so
   * the caller can invalidate and navigate without checking anything.
   */
  onExit: () => void | Promise<void>
}

export interface InstructionRun {
  /** Null until the server has a run; the runner is read-only until then. */
  executionId: string | null
  isStarting: boolean
  startError: ApiError | null
  retryStart: () => void

  currentStepIndex: number
  goToStep: (index: number) => void

  fieldValues: Record<string, unknown>
  setFieldValue: (blockId: string, value: unknown) => void
  /** True while there is no run to write to, or the last write failed. */
  fieldsDisabled: boolean
  hasUnsavedChanges: boolean

  resolvedValues: Record<string, ResolvedParametricValue>

  completing: boolean
  complete: () => Promise<void>
  pause: () => Promise<void>
  abandon: () => Promise<void>
}

const AUTOSAVE_DELAY_MS = 500

interface StartResponse {
  data: { execution: InstructionExecution; resumed: boolean }
}

/** apiFetch rejects with ApiError; anything else would be a bug in it. */
function asApiError(error: unknown): ApiError {
  return error instanceof ApiError
    ? error
    : new ApiError(
        ErrorCode.INTERNAL_ERROR,
        error instanceof Error ? error.message : 'An unexpected error occurred',
        500,
      )
}

export function useInstructionRun({
  workOrderId,
  instructionId,
  unitLabel,
  hasParametricBlocks,
  onExit,
}: UseInstructionRunOptions): InstructionRun {
  const { handleError } = useErrorHandler()

  const [executionId, setExecutionId] = useState<string | null>(null)
  const [isStarting, setIsStarting] = useState(true)
  const [startError, setStartError] = useState<ApiError | null>(null)
  const [startAttempt, setStartAttempt] = useState(0)
  const [currentStepIndex, setCurrentStepIndex] = useState(0)
  const [fieldValues, setFieldValues] = useState<Record<string, unknown>>({})
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)
  const [resolvedValues, setResolvedValues] = useState<
    Record<string, ResolvedParametricValue>
  >({})
  const [completing, setCompleting] = useState(false)

  /**
   * Which line and unit we have already asked the server to start.
   *
   * React preserves refs across StrictMode's development double-invoke, so
   * this is what keeps the mount effect to one POST. The effect deliberately
   * does not cancel its in-flight request on cleanup: under the double-invoke
   * the first pass owns the only request, and discarding its result would
   * leave the runner permanently unstarted.
   */
  const startedForRef = useRef<string | null>(null)

  // Start or resume a run of this traveler line on mount.
  useEffect(() => {
    const runKey = `${instructionId}|${unitLabel ?? ''}`
    if (startedForRef.current === runKey) return
    startedForRef.current = runKey

    setIsStarting(true)
    setStartError(null)

    apiFetch<StartResponse>(
      `/api/v1/work-orders/${workOrderId}/instructions/${instructionId}/executions`,
      {
        method: 'POST',
        body: JSON.stringify(unitLabel ? { unitLabel } : {}),
      },
    )
      .then(({ data: { execution, resumed } }) => {
        setExecutionId(execution.id)
        if (resumed) {
          setCurrentStepIndex(execution.currentStepIndex)
          setFieldValues(
            Object.fromEntries(
              Object.entries(execution.stepData).map(([key, entry]) => [
                key,
                entry.value,
              ]),
            ),
          )
        }
        setIsStarting(false)
      })
      .catch((error: unknown) => {
        // Clear the guard so retryStart can ask again.
        startedForRef.current = null
        setStartError(asApiError(error))
        setIsStarting(false)
      })
  }, [workOrderId, instructionId, unitLabel, startAttempt])

  const retryStart = useCallback(() => {
    startedForRef.current = null
    setStartAttempt((attempt) => attempt + 1)
  }, [])

  // Resolve parametric values from the snapshot against current part data.
  useEffect(() => {
    if (!hasParametricBlocks) return
    let cancelled = false

    apiFetch<{ data: { resolved: Record<string, ResolvedParametricValue> } }>(
      `/api/v1/work-orders/${workOrderId}/instructions/${instructionId}/resolve-parametric`,
    )
      .then(({ data }) => {
        if (!cancelled) setResolvedValues(data.resolved)
      })
      .catch(() => {
        // Non-fatal by design: an unresolved block renders its authored
        // fallback value, which is why the snapshot carries one.
      })

    return () => {
      cancelled = true
    }
  }, [workOrderId, instructionId, hasParametricBlocks])

  // Field edits are debounced, but every edited block is still sent. A single
  // timer that also dropped the pending value lost the earlier field whenever
  // an operator moved between two fields inside the debounce window.
  const pendingFieldsRef = useRef(new Map<string, unknown>())
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  )

  useEffect(
    () => () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    },
    [],
  )

  const setFieldValue = useCallback(
    (blockId: string, value: unknown) => {
      setFieldValues((prev) => ({ ...prev, [blockId]: value }))
      if (!executionId) return

      pendingFieldsRef.current.set(blockId, value)
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(() => {
        const pending = [...pendingFieldsRef.current.entries()]
        pendingFieldsRef.current.clear()
        void Promise.all(
          pending.map(([pendingBlockId, pendingValue]) =>
            apiFetch(
              `/api/v1/work-orders/${workOrderId}/executions/${executionId}`,
              {
                method: 'PUT',
                body: JSON.stringify({
                  stepData: { blockId: pendingBlockId, value: pendingValue },
                }),
              },
            ),
          ),
        ).then(
          () => setHasUnsavedChanges(false),
          // Quiet and persistent: an autosave that fails every keystroke must
          // not become a wall of toasts, but the operator has to know their
          // entries are not being recorded.
          () => setHasUnsavedChanges(true),
        )
      }, AUTOSAVE_DELAY_MS)
    },
    [executionId, workOrderId],
  )

  // Save progress when the step changes.
  useEffect(() => {
    if (!executionId) return
    apiFetch(`/api/v1/work-orders/${workOrderId}/executions/${executionId}`, {
      method: 'PUT',
      body: JSON.stringify({ currentStepIndex }),
    }).then(
      () => setHasUnsavedChanges(false),
      () => setHasUnsavedChanges(true),
    )
  }, [currentStepIndex, executionId, workOrderId])

  const goToStep = useCallback((index: number) => {
    setCurrentStepIndex(index)
  }, [])

  /**
   * Close the run out, and leave only if the server agreed.
   *
   * Navigating regardless was the old shape, and it turned every rejected
   * close-out — "Cannot complete execution in Complete status", a dropped
   * connection — into a run the operator believed was filed.
   */
  const closeOut = useCallback(
    async (request: () => Promise<unknown>, title: string) => {
      try {
        await request()
      } catch (error) {
        handleError(error, { presentation: 'toast', title })
        return false
      }
      await onExit()
      return true
    },
    [handleError, onExit],
  )

  const complete = useCallback(async () => {
    if (!executionId) return
    setCompleting(true)
    const exited = await closeOut(
      () =>
        apiFetch(
          `/api/v1/work-orders/${workOrderId}/executions/${executionId}/complete`,
          { method: 'POST', body: JSON.stringify({}) },
        ),
      'Could not complete this run',
    )
    if (!exited) setCompleting(false)
  }, [closeOut, executionId, workOrderId])

  // Pause: progress stays saved and the run stays In Progress for resume.
  const pause = useCallback(async () => {
    if (!executionId) {
      await onExit()
      return
    }
    await closeOut(
      () =>
        apiFetch(
          `/api/v1/work-orders/${workOrderId}/executions/${executionId}`,
          { method: 'PUT', body: JSON.stringify({ currentStepIndex }) },
        ),
      'Could not save your progress',
    )
  }, [closeOut, currentStepIndex, executionId, onExit, workOrderId])

  // Abandon: the run is closed out as an Incomplete record.
  const abandon = useCallback(async () => {
    if (!executionId) {
      await onExit()
      return
    }
    await closeOut(
      () =>
        apiFetch(
          `/api/v1/work-orders/${workOrderId}/executions/${executionId}/abandon`,
          {
            method: 'POST',
            body: JSON.stringify({ notes: 'Abandoned from runner' }),
          },
        ),
      'Could not abandon this run',
    )
  }, [closeOut, executionId, onExit, workOrderId])

  return {
    executionId,
    isStarting,
    startError,
    retryStart,
    currentStepIndex,
    goToStep,
    fieldValues,
    setFieldValue,
    fieldsDisabled: executionId === null,
    hasUnsavedChanges,
    resolvedValues,
    completing,
    complete,
    pause,
    abandon,
  }
}
