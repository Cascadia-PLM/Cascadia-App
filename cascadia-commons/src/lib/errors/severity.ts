// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { ErrorCode } from './codes'

/**
 * Severity level of an error.
 */
export type ErrorSeverity = 'silent' | 'warning' | 'error' | 'critical'

/**
 * How an error should be presented to the user.
 *
 * `'none'` means `handleError` shows nothing — either because the error is
 * genuinely not worth interrupting for, or because the caller renders it
 * itself from the `ApiError` that `handleError` returns (its `fieldErrors`
 * carry the per-field detail a form needs).
 *
 * There used to be a fourth, `'inline'`, which every validation code mapped
 * to. It meant "the form component renders this" — and no form component ever
 * did, so `handleError`'s branch for it only wrote to the console and every
 * server-side validation failure in the app was silent: the save did nothing
 * and said nothing. It is gone rather than fixed, because `'none'` plus the
 * returned error already expresses "the caller presents this" without a
 * branch that looks handled and is not.
 */
export type ErrorPresentation = 'none' | 'toast' | 'dialog'

/**
 * Strategy for handling a specific error type.
 */
export interface ErrorHandlingStrategy {
  severity: ErrorSeverity
  presentation: ErrorPresentation
  retry?: boolean
  retryDelay?: number
  maxRetries?: number
}

/**
 * Default strategies for each error code.
 */
const defaultStrategies: Partial<Record<ErrorCode, ErrorHandlingStrategy>> = {
  // Silent - log only, no user notification, auto-retry
  [ErrorCode.RATE_LIMITED]: {
    severity: 'silent',
    presentation: 'none',
    retry: true,
    retryDelay: 1000,
    maxRetries: 3,
  },

  // Warning - non-blocking toast. `handleError` names the offending fields in
  // it, so "Validation failed" alone never reaches the user.
  [ErrorCode.VALIDATION_FAILED]: {
    severity: 'warning',
    presentation: 'toast',
  },
  [ErrorCode.VALIDATION_FIELD_REQUIRED]: {
    severity: 'warning',
    presentation: 'toast',
  },
  [ErrorCode.VALIDATION_FIELD_INVALID]: {
    severity: 'warning',
    presentation: 'toast',
  },
  [ErrorCode.VALIDATION_SCHEMA_MISMATCH]: {
    severity: 'warning',
    presentation: 'toast',
  },

  // Error - toast notification
  [ErrorCode.RESOURCE_NOT_FOUND]: {
    severity: 'error',
    presentation: 'toast',
  },
  [ErrorCode.RESOURCE_ALREADY_EXISTS]: {
    severity: 'error',
    presentation: 'toast',
  },
  [ErrorCode.RESOURCE_CONFLICT]: {
    severity: 'error',
    presentation: 'toast',
  },
  [ErrorCode.RESOURCE_LOCKED]: {
    severity: 'error',
    presentation: 'toast',
  },
  [ErrorCode.PERMISSION_DENIED]: {
    severity: 'error',
    presentation: 'toast',
  },
  [ErrorCode.ROLE_REQUIRED]: {
    severity: 'error',
    presentation: 'toast',
  },
  [ErrorCode.RESOURCE_FORBIDDEN]: {
    severity: 'error',
    presentation: 'toast',
  },
  [ErrorCode.WORKFLOW_INVALID_TRANSITION]: {
    severity: 'error',
    presentation: 'toast',
  },
  [ErrorCode.WORKFLOW_ACTION_NOT_ALLOWED]: {
    severity: 'error',
    presentation: 'toast',
  },
  [ErrorCode.ITEM_REVISION_CONFLICT]: {
    severity: 'error',
    presentation: 'toast',
  },
  [ErrorCode.ITEM_RELATIONSHIP_CYCLE]: {
    severity: 'error',
    presentation: 'toast',
  },
  [ErrorCode.FILE_TOO_LARGE]: {
    severity: 'error',
    presentation: 'toast',
  },
  [ErrorCode.FILE_TYPE_NOT_ALLOWED]: {
    severity: 'error',
    presentation: 'toast',
  },
  [ErrorCode.FILE_CHECKOUT_REQUIRED]: {
    severity: 'error',
    presentation: 'toast',
  },
  [ErrorCode.DB_CONSTRAINT_VIOLATION]: {
    severity: 'error',
    presentation: 'toast',
  },
  [ErrorCode.EXTERNAL_SERVICE_ERROR]: {
    severity: 'error',
    presentation: 'toast',
  },

  // Critical - blocking dialog
  [ErrorCode.AUTH_REQUIRED]: {
    severity: 'critical',
    presentation: 'dialog',
  },
  // The login form parses the response itself and renders the message under
  // the password field, never reaching `handleError`. This strategy is for
  // everywhere else a credential check can fail — re-authenticating to sign,
  // for one — where a toast is the whole of the report.
  [ErrorCode.AUTH_INVALID_CREDENTIALS]: {
    severity: 'warning',
    presentation: 'toast',
  },
  [ErrorCode.AUTH_SESSION_EXPIRED]: {
    severity: 'critical',
    presentation: 'dialog',
  },
  [ErrorCode.AUTH_ACCOUNT_LOCKED]: {
    severity: 'critical',
    presentation: 'dialog',
  },
  [ErrorCode.DB_CONNECTION_FAILED]: {
    severity: 'critical',
    presentation: 'dialog',
    retry: true,
    retryDelay: 5000,
    maxRetries: 3,
  },
  [ErrorCode.DB_QUERY_FAILED]: {
    severity: 'critical',
    presentation: 'dialog',
  },
  [ErrorCode.DB_TRANSACTION_FAILED]: {
    severity: 'critical',
    presentation: 'dialog',
  },
  [ErrorCode.EXTERNAL_SERVICE_UNAVAILABLE]: {
    severity: 'error',
    presentation: 'toast',
    retry: true,
    retryDelay: 2000,
    maxRetries: 3,
  },
  [ErrorCode.EXTERNAL_SERVICE_TIMEOUT]: {
    severity: 'error',
    presentation: 'toast',
    retry: true,
    retryDelay: 2000,
    maxRetries: 2,
  },
  [ErrorCode.INTERNAL_ERROR]: {
    severity: 'critical',
    presentation: 'dialog',
  },
  [ErrorCode.NOT_IMPLEMENTED]: {
    severity: 'error',
    presentation: 'toast',
  },
  // A stored secret that will not decrypt is a misconfiguration, not a
  // transient fault — retrying cannot help and an operator has to act.
  [ErrorCode.SECRET_DECRYPTION_FAILED]: {
    severity: 'critical',
    presentation: 'dialog',
  },
}

/**
 * Get the handling strategy for an error code.
 * Falls back to toast presentation for unknown error codes.
 */
export function getErrorStrategy(code: ErrorCode): ErrorHandlingStrategy {
  return (
    defaultStrategies[code] ?? {
      severity: 'error',
      presentation: 'toast',
    }
  )
}

/**
 * Check if an error should be presented to the user.
 */
export function shouldPresentError(code: ErrorCode): boolean {
  const strategy = getErrorStrategy(code)
  return strategy.presentation !== 'none'
}

/**
 * Check if an error should trigger a retry.
 */
export function shouldRetryError(code: ErrorCode): boolean {
  const strategy = getErrorStrategy(code)
  return strategy.retry === true
}
