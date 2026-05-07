import { useCallback, useEffect, useRef, useState } from 'react'
import { useErrorHandler } from './useErrorHandler'
import { ApiError, apiFetch } from '@/lib/api/client'
import { isRetryableError } from '@/lib/errors/retry'

interface UseRetryableFetchOptions<T> extends RequestInit {
  /** If true, fetch immediately on mount */
  immediate?: boolean
  /** Called when fetch succeeds */
  onSuccess?: (data: T) => void
  /** Called when fetch fails (after all retries) */
  onError?: (error: ApiError) => void
}

interface UseRetryableFetchResult<T> {
  /** The fetched data */
  data: T | null
  /** The error if fetch failed */
  error: ApiError | null
  /** True while fetching */
  loading: boolean
  /** True while retrying after exhausted auto-retries */
  retrying: boolean
  /** True when auto-retries are exhausted but error is retryable */
  canRetry: boolean
  /** Manually retry the request */
  retry: () => Promise<void>
  /** Execute the fetch */
  execute: () => Promise<T | null>
  /** Reset the state */
  reset: () => void
}

/**
 * Hook for fetching data with automatic retry support and error handling.
 *
 * @example
 * ```tsx
 * function PartsList() {
 *   const { data, loading, error, canRetry, retry } = useRetryableFetch<Part[]>(
 *     '/api/v1/parts',
 *     { immediate: true }
 *   )
 *
 *   if (loading) return <Spinner />
 *   if (error && canRetry) return <RetryPrompt message={error.message} onRetry={retry} />
 *   if (error) return <ErrorMessage message={error.message} />
 *   if (!data) return null
 *
 *   return <PartTable parts={data} />
 * }
 * ```
 */
export function useRetryableFetch<T>(
  url: string,
  options: UseRetryableFetchOptions<T> = {},
): UseRetryableFetchResult<T> {
  const { immediate = false, onSuccess, onError, ...fetchOptions } = options

  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [loading, setLoading] = useState(false)
  const [retrying, setRetrying] = useState(false)

  const { handleError } = useErrorHandler()

  // Track if the component is mounted
  const isMounted = useRef(true)
  useEffect(() => {
    isMounted.current = true
    return () => {
      isMounted.current = false
    }
  }, [])

  const execute = useCallback(async (): Promise<T | null> => {
    setLoading(true)
    setError(null)

    try {
      const result = await apiFetch<T>(url, fetchOptions)

      if (isMounted.current) {
        setData(result)
        onSuccess?.(result)
      }

      return result
    } catch (err) {
      const apiError =
        err instanceof ApiError
          ? err
          : new ApiError(
              'INTERNAL_ERROR' as never,
              err instanceof Error ? err.message : 'Unknown error',
              500,
            )

      if (isMounted.current) {
        setError(apiError)
        onError?.(apiError)

        // Show toast for non-retryable errors
        if (!isRetryableError(apiError.code)) {
          handleError(apiError, { presentation: 'toast' })
        }
      }

      return null
    } finally {
      if (isMounted.current) {
        setLoading(false)
      }
    }
  }, [url, fetchOptions, onSuccess, onError, handleError])

  const retry = useCallback(async () => {
    setRetrying(true)
    try {
      await execute()
    } finally {
      if (isMounted.current) {
        setRetrying(false)
      }
    }
  }, [execute])

  const reset = useCallback(() => {
    setData(null)
    setError(null)
    setLoading(false)
    setRetrying(false)
  }, [])

  // Execute immediately if requested
  useEffect(() => {
    if (immediate) {
      execute()
    }
  }, [immediate, execute])

  // Check if we can retry (error is retryable)
  const canRetry = error !== null && isRetryableError(error.code)

  return {
    data,
    error,
    loading,
    retrying,
    canRetry,
    retry,
    execute,
    reset,
  }
}
