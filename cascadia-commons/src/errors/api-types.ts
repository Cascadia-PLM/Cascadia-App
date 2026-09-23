// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The error envelope every API route returns, and the per-field entry it can
 * carry. Declared apart from `AppError` and the response builder so the
 * client's `apiFetch` can type what it parses; both re-export.
 */

import type { ErrorCode } from './codes'

/**
 * Represents a validation error for a specific field.
 */
export interface FieldError {
  field: string
  message: string
  code?: string
}

/**
 * Standard error response format for API routes.
 */
export interface ErrorResponse {
  error: {
    code: ErrorCode
    message: string
    details?: string
    fieldErrors?: Array<FieldError>
    requestId?: string
    timestamp: string
  }
}
