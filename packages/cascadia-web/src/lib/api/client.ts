// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { ErrorCode } from '@cascadia/commons/lib/errors/codes'
import {
  defaultRetryConfig,
  getRetryDelay,
  isRetryableError,
  sleep,
} from '@cascadia/commons/lib/errors/retry'
import { ApiError } from '@cascadia/commons/lib/errors/api-error'
import type { RetryConfig } from '@cascadia/commons/lib/errors/retry'
import type { ErrorResponse } from '@cascadia/commons/lib/errors/api-types'

export { ApiError } from '@cascadia/commons/lib/errors/api-error'

/**
 * Options for the apiFetch function.
 */
interface FetchOptions extends RequestInit {
  /** Enable/disable retry or provide custom retry config */
  retry?: boolean | Partial<RetryConfig>
}

/**
 * Parse an error response from the API.
 */
async function parseErrorResponse(
  response: Response,
): Promise<ErrorResponse['error']> {
  try {
    const json = await response.json()
    if (json.error) {
      return json.error
    }
    // Legacy error format support
    return {
      code: ErrorCode.INTERNAL_ERROR,
      message: json.message ?? 'An unexpected error occurred',
      timestamp: new Date().toISOString(),
    }
  } catch {
    return {
      code: ErrorCode.INTERNAL_ERROR,
      message: 'An unexpected error occurred',
      timestamp: new Date().toISOString(),
    }
  }
}

/**
 * Fetch data from an API endpoint with automatic error handling and retry support.
 *
 * @example
 * ```typescript
 * // Simple GET request
 * const { data } = await apiFetch<{ data: Part[] }>('/api/v1/parts')
 *
 * // POST with body
 * const { data } = await apiFetch<{ data: Part }>('/api/v1/parts', {
 *   method: 'POST',
 *   body: JSON.stringify({ name: 'New Part' }),
 * })
 *
 * // Disable retry
 * const { data } = await apiFetch('/api/v1/parts', { retry: false })
 *
 * // Custom retry config
 * const { data } = await apiFetch('/api/v1/parts', {
 *   retry: { maxAttempts: 5, initialDelayMs: 2000 },
 * })
 * ```
 */
export async function apiFetch<T>(
  url: string,
  options: FetchOptions = {},
): Promise<T> {
  const { retry = true, ...fetchOptions } = options

  const config: RetryConfig = {
    ...defaultRetryConfig,
    ...(typeof retry === 'object' ? retry : {}),
  }

  const shouldRetry = retry !== false
  let lastError: ApiError | null = null

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      const response = await fetch(url, {
        ...fetchOptions,
        headers: {
          'Content-Type': 'application/json',
          ...fetchOptions.headers,
        },
      })

      if (!response.ok) {
        const errorData = await parseErrorResponse(response)
        const apiError = ApiError.fromResponse(errorData, response.status)

        // Check if we should retry
        if (
          shouldRetry &&
          attempt < config.maxAttempts &&
          isRetryableError(apiError.code)
        ) {
          lastError = apiError
          const delay = getRetryDelay(attempt, config)
          await sleep(delay)
          continue
        }

        throw apiError
      }

      // Handle empty responses (204 No Content)
      if (response.status === 204) {
        return undefined as T
      }

      return response.json()
    } catch (error) {
      // Re-throw ApiError (already handled above)
      if (error instanceof ApiError) {
        throw error
      }

      // Network error - may be retryable
      if (
        shouldRetry &&
        attempt < config.maxAttempts &&
        error instanceof TypeError
      ) {
        lastError = new ApiError(
          ErrorCode.EXTERNAL_SERVICE_UNAVAILABLE,
          'Network connection failed',
          503,
        )
        const delay = getRetryDelay(attempt, config)
        await sleep(delay)
        continue
      }

      // Unknown error
      throw new ApiError(
        ErrorCode.INTERNAL_ERROR,
        error instanceof Error ? error.message : 'An unexpected error occurred',
        500,
      )
    }
  }

  // All retries exhausted
  throw (
    lastError ??
    new ApiError(
      ErrorCode.INTERNAL_ERROR,
      'Request failed after multiple attempts',
      500,
    )
  )
}

/**
 * Convenience wrapper for GET requests.
 */
export function apiGet<T>(url: string, options?: FetchOptions): Promise<T> {
  return apiFetch<T>(url, { ...options, method: 'GET' })
}

/**
 * Convenience wrapper for POST requests.
 */
export function apiPost<T>(
  url: string,
  data: unknown,
  options?: FetchOptions,
): Promise<T> {
  return apiFetch<T>(url, {
    ...options,
    method: 'POST',
    body: JSON.stringify(data),
  })
}

/**
 * Convenience wrapper for PUT requests.
 */
export function apiPut<T>(
  url: string,
  data: unknown,
  options?: FetchOptions,
): Promise<T> {
  return apiFetch<T>(url, {
    ...options,
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

/**
 * Convenience wrapper for PATCH requests.
 */
export function apiPatch<T>(
  url: string,
  data: unknown,
  options?: FetchOptions,
): Promise<T> {
  return apiFetch<T>(url, {
    ...options,
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

/**
 * Convenience wrapper for DELETE requests.
 */
export function apiDelete<T>(url: string, options?: FetchOptions): Promise<T> {
  return apiFetch<T>(url, { ...options, method: 'DELETE' })
}
