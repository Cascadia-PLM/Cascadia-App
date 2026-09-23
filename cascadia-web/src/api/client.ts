// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { ErrorCode } from '@cascadia/commons/errors/codes'
import {
  defaultRetryConfig,
  getRetryDelay,
  isRetryableError,
  sleep,
} from '@cascadia/commons/errors/retry'
import { ApiError } from '@cascadia/commons/errors/api-error'
import type { RetryConfig } from '@cascadia/commons/errors/retry'
import type { ErrorResponse } from '@cascadia/commons/errors/api-types'

export { ApiError } from '@cascadia/commons/errors/api-error'

/**
 * Options for the apiFetch function.
 */
interface FetchOptions extends RequestInit {
  /** Enable/disable retry or provide custom retry config */
  retry?: boolean | Partial<RetryConfig>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function errorCode(value: unknown): ErrorCode {
  // Codes this build does not know pass through: getErrorStrategy() and
  // isRetryableError() already have fallbacks for them. Keeping the server's
  // value also preserves the useful code in logs and diagnostics.
  return (
    (nonEmptyString(value) as ErrorCode | undefined) ?? ErrorCode.INTERNAL_ERROR
  )
}

function fieldErrors(value: unknown): ErrorResponse['error']['fieldErrors'] {
  if (!Array.isArray(value)) return undefined
  const parsed = value.flatMap((entry) => {
    if (!isRecord(entry)) return []
    const message = nonEmptyString(entry.message)
    if (!message) return []
    // Object-level validation rules have no field path. Keep their message;
    // describeError() renders an empty field without a prefix.
    const field = typeof entry.field === 'string' ? entry.field : ''
    return [{ field, message }]
  })
  return parsed.length > 0 ? parsed : undefined
}

/**
 * Parse an error response from the API.
 */
async function parseErrorResponse(
  response: Response,
  fallbackMessage: string = 'An unexpected error occurred',
): Promise<ErrorResponse['error']> {
  try {
    const json: unknown = await response.json()
    if (isRecord(json)) {
      const nested = json.error
      if (isRecord(nested)) {
        return {
          code: errorCode(nested.code),
          message: nonEmptyString(nested.message) ?? fallbackMessage,
          fieldErrors: fieldErrors(nested.fieldErrors),
          requestId: nonEmptyString(nested.requestId),
          timestamp:
            nonEmptyString(nested.timestamp) ?? new Date().toISOString(),
        }
      }

      // Legacy endpoints used one of these top-level string fields. Objects
      // are deliberately ignored: coercing them is how "[object Object]"
      // reached dialogs and toasts.
      const message =
        nonEmptyString(json.message) ??
        nonEmptyString(json.details) ??
        nonEmptyString(json.error) ??
        fallbackMessage
      return {
        code: errorCode(json.code),
        message,
        timestamp: new Date().toISOString(),
      }
    }
  } catch {
    // Non-JSON responses use the caller's operation-specific fallback.
  }
  return {
    code: ErrorCode.INTERNAL_ERROR,
    message: fallbackMessage,
    timestamp: new Date().toISOString(),
  }
}

/**
 * Convert a failed raw `fetch` response into the same typed error `apiFetch`
 * throws. Use this for multipart uploads and binary downloads, where the
 * browser must control headers or the success body is not JSON.
 */
export async function apiErrorFromResponse(
  response: Response,
  fallbackMessage: string = 'An unexpected error occurred',
): Promise<ApiError> {
  return ApiError.fromResponse(
    await parseErrorResponse(response, fallbackMessage),
    response.status,
  )
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
        const apiError = await apiErrorFromResponse(response)

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
