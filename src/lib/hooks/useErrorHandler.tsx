import { useCallback } from 'react'
import { useToast } from './useToast'
import { useAlertDialog } from './useAlertDialog'
import type { ErrorPresentation } from '@/lib/errors/severity'
import { ApiError } from '@/lib/api/client'
import { ErrorCode } from '@/lib/errors/codes'
import { getErrorStrategy } from '@/lib/errors/severity'

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
          // Silent - already logged above
          break

        case 'inline':
          // Inline errors are handled by the form component
          // Just return the error for the caller to handle
          break

        case 'toast':
          addToast({
            title: options.title ?? 'Error',
            description: apiError.message,
            variant: 'destructive',
          })
          break

        case 'dialog':
          alert({
            title: options.title ?? 'Error',
            description: apiError.message,
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

  return { handleError, showSuccess, showWarning, showInfo }
}
