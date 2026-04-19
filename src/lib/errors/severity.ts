import { ErrorCode } from './codes'

/**
 * Severity level of an error.
 */
export type ErrorSeverity = 'silent' | 'warning' | 'error' | 'critical'

/**
 * How an error should be presented to the user.
 */
export type ErrorPresentation = 'none' | 'inline' | 'toast' | 'dialog'

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

  // Warning - inline indicator, non-blocking
  [ErrorCode.VALIDATION_FAILED]: {
    severity: 'warning',
    presentation: 'inline',
  },
  [ErrorCode.VALIDATION_FIELD_REQUIRED]: {
    severity: 'warning',
    presentation: 'inline',
  },
  [ErrorCode.VALIDATION_FIELD_INVALID]: {
    severity: 'warning',
    presentation: 'inline',
  },
  [ErrorCode.VALIDATION_SCHEMA_MISMATCH]: {
    severity: 'warning',
    presentation: 'inline',
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
  [ErrorCode.AUTH_INVALID_CREDENTIALS]: {
    severity: 'warning',
    presentation: 'inline',
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
