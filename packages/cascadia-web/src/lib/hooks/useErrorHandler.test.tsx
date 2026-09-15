// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * How a failed request reaches the user.
 *
 * This is a regression suite before it is a unit test. Every validation code
 * used to map to a presentation named `'inline'`, whose branch in
 * `handleError` did nothing but write to the console on the assumption that
 * "the form component renders this" — and no form component ever did. So a
 * rejected save changed nothing and said nothing, and the only way to find out
 * why was the network tab. The first test is the ratchet that keeps any code
 * from going quiet again; the rest pin the behaviour that replaced it.
 *
 * Run: npx vitest run packages/core/src/lib/hooks/useErrorHandler.test.tsx
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useErrorHandler } from './useErrorHandler'
import { ToastProvider, useToast } from './useToast'
import { AlertDialogProvider } from './useAlertDialog'
import type { ReactNode } from 'react'
import { ApiError } from '@/lib/api/client'
import { ErrorCode } from '@/lib/errors/codes'
import { getErrorStrategy } from '@/lib/errors/severity'

/** `useErrorHandler` reaches for both surfaces; nothing here needs a router. */
function wrapper({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <AlertDialogProvider>{children}</AlertDialogProvider>
    </ToastProvider>
  )
}

// `handleError` logs every error it presents, and this file hands it one of
// each. Swallow that so a green run stays readable.
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

function renderHandler() {
  return renderHook(
    () => ({ ...useErrorHandler(), toasts: useToast().toasts }),
    { wrapper },
  )
}

/**
 * A rate limit is retried on the user's behalf and is genuinely not worth an
 * interruption. Every other code has to reach them somehow, so adding to this
 * list is a decision to hide a class of failure — argue for it in review.
 */
const DELIBERATELY_SILENT: Array<ErrorCode> = [ErrorCode.RATE_LIMITED]

describe('every error code reaches the user', () => {
  // Deliberately driven through `handleError` rather than read off the
  // strategy table. Reading the table is what a weaker version of this test
  // did, and it passed throughout the bug: `'inline'` is not `'none'`, so the
  // table looked fine while the switch rendered nothing. The only question
  // worth asking is whether anything appeared.
  it.each(Object.values(ErrorCode))('%s is presented somewhere', (code) => {
    const { result } = renderHandler()
    const message = `${code} happened`

    act(() => {
      // 400 throughout: a 401 would take the auth branch and navigate away
      // instead of presenting, which is its own tested behaviour.
      result.current.handleError(new ApiError(code, message, 400))
    })

    const shown =
      result.current.toasts.length > 0 ||
      document.body.textContent.includes(message)

    if (DELIBERATELY_SILENT.includes(code)) {
      expect(shown, `${code} is meant to be silent`).toBe(false)
    } else {
      expect(shown, `${code} was presented nowhere`).toBe(true)
    }
  })

  it('presents an unrecognized code rather than dropping it', () => {
    // The fallback matters as much as the table: a code added to the enum and
    // forgotten here still reaches the user.
    expect(getErrorStrategy('SOMETHING_NEW' as ErrorCode).presentation).toBe(
      'toast',
    )
  })
})

describe('handleError', () => {
  it('shows a validation failure instead of swallowing it', () => {
    const { result } = renderHandler()

    act(() => {
      result.current.handleError(
        new ApiError(ErrorCode.VALIDATION_FAILED, 'Validation failed', 400, [
          { field: 'startDate', message: 'Invalid date' },
        ]),
        { title: 'Failed to update program' },
      )
    })

    expect(result.current.toasts).toHaveLength(1)
    expect(result.current.toasts[0]).toMatchObject({
      title: 'Failed to update program',
      variant: 'destructive',
    })
  })

  it('names the offending fields, which the bare message never does', () => {
    const { result } = renderHandler()

    act(() => {
      result.current.handleError(
        new ApiError(ErrorCode.VALIDATION_FAILED, 'Validation failed', 400, [
          { field: 'startDate', message: 'Invalid date' },
          { field: 'targetEndDate', message: 'Invalid date' },
        ]),
      )
    })

    const description = result.current.toasts[0]?.description ?? ''
    expect(description).toContain('startDate: Invalid date')
    expect(description).toContain('targetEndDate: Invalid date')
  })

  it('leaves a message without field errors alone', () => {
    const { result } = renderHandler()

    act(() => {
      result.current.handleError(
        new ApiError(ErrorCode.RESOURCE_LOCKED, 'Item is checked out', 409),
      )
    })

    expect(result.current.toasts[0]?.description).toBe('Item is checked out')
  })

  it('routes a critical failure to a dialog, not a toast', () => {
    // The strategy table still decides; making validation visible did not
    // flatten everything into the same surface.
    const { result } = renderHandler()

    act(() => {
      result.current.handleError(
        new ApiError(ErrorCode.INTERNAL_ERROR, 'An unexpected error', 500),
      )
    })

    expect(result.current.toasts).toHaveLength(0)
    expect(document.body.textContent).toContain('An unexpected error')
  })

  it('honours an explicit presentation override', () => {
    const { result } = renderHandler()

    act(() => {
      result.current.handleError(
        new ApiError(ErrorCode.INTERNAL_ERROR, 'An unexpected error', 500),
        { presentation: 'none' },
      )
    })

    expect(result.current.toasts).toHaveLength(0)
  })

  it('returns the error so a caller can render it itself', () => {
    const { result } = renderHandler()
    const fieldErrors = [{ field: 'code', message: 'Already exists' }]

    let returned: ApiError | undefined
    act(() => {
      returned = result.current.handleError(
        new ApiError(
          ErrorCode.VALIDATION_FAILED,
          'Validation failed',
          400,
          fieldErrors,
        ),
        { presentation: 'none' },
      )
    })

    expect(returned?.fieldErrors).toEqual(fieldErrors)
  })
})

describe('showError', () => {
  it('reports a client-side guard on the same surface as a server failure', () => {
    // Its absence is why a dozen call sites reached past this hook for a
    // blocking modal.
    const { result } = renderHandler()

    act(() => {
      result.current.showError('Please specify a relationship type')
    })

    expect(result.current.toasts[0]).toMatchObject({
      title: 'Please specify a relationship type',
      variant: 'destructive',
    })
  })
})
