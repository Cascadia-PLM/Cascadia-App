// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The client's error class, built from the envelope every API route returns.
 * In commons rather than beside `apiFetch` because it is wire-level — the
 * server's own route tests build one from a real response to prove the
 * envelope round-trips.
 */

import { isRetryableError } from './retry'
import type { ErrorCode } from './codes'
import type { ErrorResponse } from './api-types'

/**
 * Client-side API error class.
 * Used for handling errors returned from API routes.
 */
export class ApiError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly httpStatus: number,
    public readonly fieldErrors?: Array<{ field: string; message: string }>,
    public readonly requestId?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }

  /**
   * Create an ApiError from an API error response.
   */
  static fromResponse(
    response: ErrorResponse['error'],
    status: number,
  ): ApiError {
    return new ApiError(
      response.code,
      response.message,
      status,
      response.fieldErrors,
      response.requestId,
    )
  }

  /**
   * Check if this is an authentication error (401).
   */
  get isAuthError(): boolean {
    return this.httpStatus === 401
  }

  /**
   * Check if this is a permission error (403).
   */
  get isPermissionError(): boolean {
    return this.httpStatus === 403
  }

  /**
   * Check if this is a validation error (400).
   */
  get isValidationError(): boolean {
    return this.httpStatus === 400
  }

  /**
   * Check if this is a not found error (404).
   */
  get isNotFoundError(): boolean {
    return this.httpStatus === 404
  }

  /**
   * Check if this is a server error (5xx).
   */
  get isServerError(): boolean {
    return this.httpStatus >= 500
  }

  /**
   * Check if this error is retryable.
   */
  get isRetryable(): boolean {
    return isRetryableError(this.code)
  }
}
