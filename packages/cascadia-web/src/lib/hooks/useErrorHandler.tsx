// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useCallback } from 'react'
import { useToast } from './useToast'
import { useAlertDialog } from './useAlertDialog'
import type { ErrorPresentation } from '@/lib/errors/severity'
import { ApiError } from '@/lib/api/client'
import { ErrorCode } from '@/lib/errors/codes'
import { getErrorStrategy } from '@/lib/errors/severity'

/**
 * The text to show for an error. A validation failure's `message` is the bare
 * string "Validation failed" — everything that identifies the problem is in
 * `fieldErrors`, which until now only a form rendering inline errors would
 * ever read. Fold it in, so a toast or dialog names the field instead of
 * asking the reader to open the network tab.
 */
function describeError(error: ApiError): string {
  const fields = error.fieldErrors ?? []
  if (fields.length === 0) return error.message
  const detail = fields
    .map((f) => (f.field ? `${f.field}: ${f.message}` : f.message))
    .join('; ')
  return `${error.message} — ${detail}`
}

interface ErrorHandlerOptions {
  /** Override the default presentation for this error */
  presentation?: ErrorPresentation
  /** Custom error title */
  title?: string
  /** Called after error is handled */
  onHandled?: () => void
  /** If true, rethrows error after handling (for error boundaries) */
  rethrow?: boolean
}

/**
 * Hook for handling errors in a consistent way across the application.
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const { handleError, showSuccess } = useErrorHandler()
 *
 *   const handleSubmit = async () => {
 *     try {
 *       await apiFetch('/api/v1/parts', { method: 'POST', body: data })
 *       showSuccess('Part created', 'Your new part has been saved.')
 *     } catch (error) {
 *       handleError(error)
 *     }
 *   }
 * }
 * ```
 */
export function useErrorHandler() {
  const { addToast } = useToast()
  const { alert } = useAlertDialog()

  const handleError = useCallback(
    (error: unknown, options: ErrorHandlerOptions = {}) => {
      // Normalize to ApiError or generic error
      const apiError =
        error instanceof ApiError
          ? error
          : new ApiError(
              ErrorCode.INTERNAL_ERROR,
              error instanceof Error
                ? error.message
                : 'An unexpected error occurred',
              500,
            )

      const strategy = getErrorStrategy(apiError.code)
      const presentation = options.presentation ?? strategy.presentation

      // Log all errors
      console.error('[ErrorHandler]', {
        code: apiError.code,
        message: apiError.message,
        requestId: apiError.requestId,
        fieldErrors: apiError.fieldErrors,
      })

      // Handle auth errors specially - redirect to login
      if (apiError.isAuthError) {
        const currentPath = encodeURIComponent(window.location.pathname)
        window.location.href = `/login?redirect=${currentPath}&reason=session_expired`
        return apiError
      }

      // Present error based on strategy
      switch (presentation) {
        case 'none':
          // Nothing to show — either the error is not worth interrupting for,
          // or the caller asked to present it itself and reads the ApiError
          // returned below.
          break

        case 'toast':
          addToast({
            title: options.title ?? 'Error',
            description: describeError(apiError),
            variant: 'destructive',
          })
          break

        case 'dialog':
          alert({
            title: options.title ?? 'Error',
            description: describeError(apiError),
            variant: 'destructive',
          })
          break
      }

      options.onHandled?.()

      if (options.rethrow) {
        throw error
      }

      return apiError
    },
    [addToast, alert],
  )

  /**
   * Show a success toast.
   */
  const showSuccess = useCallback(
    (title: string, description?: string) => {
      addToast({ title, description, variant: 'success' })
    },
    [addToast],
  )

  /**
   * Show an error toast for a failure with no `Error` to hand — a client-side
   * guard that stopped the request before it was made, say.
   *
   * The absence of this was why a dozen call sites reached past this hook for
   * `alert()` and put a blocking modal in front of "pick a relationship type
   * first": `showSuccess`/`showWarning`/`showInfo` existed and their opposite
   * did not. Anything with an actual error belongs in `handleError`, which
   * knows the code, the field errors and the auth redirect.
   */
  const showError = useCallback(
    (title: string, description?: string) => {
      addToast({ title, description, variant: 'destructive' })
    },
    [addToast],
  )

  /**
   * Show a warning toast.
   */
  const showWarning = useCallback(
    (title: string, description?: string) => {
      addToast({ title, description, variant: 'warning' })
    },
    [addToast],
  )

  /**
   * Show an info toast.
   */
  const showInfo = useCallback(
    (title: string, description?: string) => {
      addToast({ title, description, variant: 'default' })
    },
    [addToast],
  )

  return { handleError, showSuccess, showError, showWarning, showInfo }
}
