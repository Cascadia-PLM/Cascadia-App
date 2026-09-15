// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * `useInstructionRun` — traveler run lifecycle.
 *
 * Data-integrity gate: this hook owns the writes behind an execution record,
 * which is the evidence that a build step was performed. Three ways it can be
 * quietly wrong, all of which it used to be:
 *
 *   - starting twice, so one operator's work is split across two runs;
 *   - opening the traveler for editing before a run exists, so entries are
 *     typed into a form that records nothing;
 *   - navigating away from a close-out the server rejected, so the operator
 *     believes a run was filed that never was.
 *
 * The invariants are about the requests and what follows them, not the markup.
 *
 * Run: npx vitest run packages/core/src/components/work-orders/useInstructionRun.test.tsx
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useInstructionRun } from './useInstructionRun'
import type { ReactNode } from 'react'
import type * as ApiClient from '@/lib/api/client'
import { ApiError } from '@/lib/api/client'
import { ErrorCode } from '@/lib/errors/codes'
import { ToastProvider } from '@/lib/hooks/useToast'
import { AlertDialogProvider } from '@/lib/hooks/useAlertDialog'

const apiFetch = vi.hoisted(() => vi.fn())
// Keep the real ApiError: both this suite and useErrorHandler test with
// `instanceof`, and a stubbed class would never match.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiFetch,
}))

const WORK_ORDER_ID = 'wo-1'
const INSTRUCTION_ID = 'wi-1'
const EXECUTION_ID = 'exec-1'

const START_URL = `/api/v1/work-orders/${WORK_ORDER_ID}/instructions/${INSTRUCTION_ID}/executions`
const COMPLETE_URL = `/api/v1/work-orders/${WORK_ORDER_ID}/executions/${EXECUTION_ID}/complete`

/** Every URL the hook asked for, in order, with its method. */
let requests: Array<{ url: string; method: string }>

function execution(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: EXECUTION_ID,
    workOrderInstructionId: INSTRUCTION_ID,
    executedBy: 'user-1',
    status: 'In Progress',
    startedAt: '2026-08-26T00:00:00.000Z',
    stepData: {},
    currentStepIndex: 0,
    ...over,
  }
}

/** useErrorHandler needs both; nothing here needs a router or a query client. */
function wrapper({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <AlertDialogProvider>{children}</AlertDialogProvider>
    </ToastProvider>
  )
}

/**
 * `reactStrictMode` is the point of this harness, not decoration: it makes the
 * mount effect run, clean up, and run again on the same fiber — the sequence
 * that produced two runs for one operator. (A hand-rolled `<React.StrictMode>`
 * wrapper does not: it double-renders but single-fires effects.)
 */
function renderRun(onExit = vi.fn()) {
  const rendered = renderHook(
    () =>
      useInstructionRun({
        workOrderId: WORK_ORDER_ID,
        instructionId: INSTRUCTION_ID,
        hasParametricBlocks: false,
        onExit,
      }),
    { wrapper, reactStrictMode: true },
  )
  return { ...rendered, onExit }
}

const validationFailure = () =>
  Promise.reject(
    new ApiError(
      ErrorCode.VALIDATION_FAILED,
      'Cannot complete execution in Complete status',
      400,
    ),
  )

beforeEach(() => {
  requests = []
  apiFetch.mockReset()
  apiFetch.mockImplementation((url: string, options?: RequestInit) => {
    requests.push({ url, method: options?.method ?? 'GET' })
    if (url === START_URL) {
      return Promise.resolve({
        data: { execution: execution(), resumed: false },
      })
    }
    return Promise.resolve({ data: { execution: execution() } })
  })
})

describe('useInstructionRun', () => {
  it('starts the run exactly once under a double effect invocation', async () => {
    const { result } = renderRun()

    await waitFor(() => expect(result.current.executionId).toBe(EXECUTION_ID))

    expect(requests.filter((r) => r.url === START_URL)).toHaveLength(1)
  })

  it('keeps fields read-only until the server has a run', async () => {
    const { result } = renderRun()

    expect(result.current.fieldsDisabled).toBe(true)

    // An edit made before the run exists updates the form but writes nothing —
    // which is the honest version of what the old code did silently.
    act(() => {
      result.current.setFieldValue('block-1', 42)
    })
    expect(result.current.fieldValues['block-1']).toBe(42)
    expect(requests.filter((r) => r.method === 'PUT')).toHaveLength(0)

    await waitFor(() => expect(result.current.fieldsDisabled).toBe(false))
  })

  it('restores step data and position when the server resumes a run', async () => {
    apiFetch.mockImplementation((url: string) => {
      requests.push({ url, method: 'POST' })
      return Promise.resolve({
        data: {
          execution: execution({
            currentStepIndex: 3,
            stepData: {
              'block-1': {
                value: 'torque ok',
                capturedAt: '2026-08-26T00:00:00.000Z',
                blockId: 'block-1',
              },
              'block-2': {
                value: 7,
                capturedAt: '2026-08-26T00:00:00.000Z',
                blockId: 'block-2',
              },
            },
          }),
          resumed: true,
        },
      })
    })

    const { result } = renderRun()

    await waitFor(() => expect(result.current.currentStepIndex).toBe(3))
    expect(result.current.fieldValues).toEqual({
      'block-1': 'torque ok',
      'block-2': 7,
    })
  })

  it('stays on a rejected completion, and exits once a retry succeeds', async () => {
    const { result, onExit } = renderRun()
    await waitFor(() => expect(result.current.executionId).toBe(EXECUTION_ID))

    apiFetch.mockImplementationOnce((url: string) => {
      requests.push({ url, method: 'POST' })
      return validationFailure()
    })

    await act(async () => {
      await result.current.complete()
    })

    expect(onExit).not.toHaveBeenCalled()
    expect(result.current.completing).toBe(false)
    expect(result.current.executionId).toBe(EXECUTION_ID)

    await act(async () => {
      await result.current.complete()
    })

    expect(onExit).toHaveBeenCalledTimes(1)
    expect(requests.filter((r) => r.url === COMPLETE_URL)).toHaveLength(2)
  })

  it('does not exit on a rejected pause or abandon', async () => {
    const { result, onExit } = renderRun()
    await waitFor(() => expect(result.current.executionId).toBe(EXECUTION_ID))

    apiFetch.mockImplementation(() => validationFailure())

    await act(async () => {
      await result.current.pause()
    })
    await act(async () => {
      await result.current.abandon()
    })

    expect(onExit).not.toHaveBeenCalled()
  })

  it('surfaces a failed start instead of opening an editable run', async () => {
    apiFetch.mockImplementationOnce((url: string) => {
      requests.push({ url, method: 'POST' })
      return Promise.reject(new ApiError(ErrorCode.INTERNAL_ERROR, 'boom', 500))
    })

    const { result } = renderRun()

    await waitFor(() => expect(result.current.startError).not.toBeNull())
    expect(result.current.executionId).toBeNull()
    expect(result.current.fieldsDisabled).toBe(true)

    act(() => {
      result.current.retryStart()
    })

    await waitFor(() => expect(result.current.executionId).toBe(EXECUTION_ID))
    expect(result.current.startError).toBeNull()
  })
})
