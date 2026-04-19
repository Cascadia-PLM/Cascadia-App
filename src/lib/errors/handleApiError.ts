import { nanoid } from 'nanoid'
import { ZodError } from 'zod'
import { createErrorResponse } from './api'
import { ErrorLogService } from './ErrorLogService'
import {
  AppError,
  DatabaseQueryError,
  ErrorCode,
  ValidationError,
} from './index'
import { apiLogger } from '@/lib/logging/logger'

/**
 * Generate or extract a request ID from a request.
 */
export function getRequestId(request: Request): string {
  return request.headers.get('x-request-id') ?? nanoid(12)
}

/**
 * Handle any error in an API route and return a proper Response.
 * This is the main error handler that should be used in all API routes.
 *
 * Note: API routes wrapped with `apiHandler()` (see `src/lib/api/handler.ts`)
 * invoke this automatically — direct calls are only needed for handlers that
 * bypass that wrapper.
 */
export function handleApiError(
  error: unknown,
  request?: Request,
  requestId?: string,
): Response {
  // Re-throw Response objects (from requireAuth/requirePermission)
  if (error instanceof Response) {
    return error
  }

  // Handle our custom errors
  if (error instanceof AppError) {
    logError(error, request, requestId)
    return createErrorResponse(error, requestId)
  }

  // Handle Zod validation errors
  if (error instanceof ZodError) {
    const validationError = ValidationError.fromZodError(error, {
      requestId,
    })
    logError(validationError, request, requestId)
    return createErrorResponse(validationError, requestId)
  }

  // Handle PostgreSQL/Drizzle errors
  if (isPostgresError(error)) {
    const dbError = mapPostgresError(error, requestId)
    logError(dbError, request, requestId)
    return createErrorResponse(dbError, requestId)
  }

  // Unknown errors - wrap in AppError
  // Try to extract more details from the error
  let errorMessage = 'An unexpected error occurred'
  if (error instanceof Error) {
    // Check for nested PostgreSQL error details
    const pgError = error as Error & {
      cause?: { code?: string; detail?: string; constraint?: string }
    }
    if (pgError.cause?.code) {
      errorMessage = `Database error: ${pgError.cause.detail || pgError.cause.code}`
    }
  }

  const unknownError = new AppError(ErrorCode.INTERNAL_ERROR, errorMessage, {
    cause: error instanceof Error ? error : new Error(String(error)),
    isOperational: false,
    context: { requestId },
  })
  logError(unknownError, request, requestId)
  return createErrorResponse(unknownError, requestId)
}

/**
 * Check if an error is a PostgreSQL error.
 */
function isPostgresError(error: unknown): error is {
  code: string
  detail?: string
  constraint?: string
  column?: string
  table?: string
} {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as Record<string, unknown>).code === 'string'
  )
}

/**
 * Map PostgreSQL error codes to AppError instances.
 */
function mapPostgresError(
  error: { code: string; detail?: string; constraint?: string },
  requestId?: string,
): AppError {
  switch (error.code) {
    case '23505': // unique_violation
      return new AppError(
        ErrorCode.RESOURCE_ALREADY_EXISTS,
        error.detail ?? 'A record with this value already exists',
        { context: { requestId, constraint: error.constraint } },
      )
    case '23503': // foreign_key_violation
      return new AppError(
        ErrorCode.DB_CONSTRAINT_VIOLATION,
        'Cannot perform this operation due to related records',
        { context: { requestId, constraint: error.constraint } },
      )
    case '23502': // not_null_violation
      return new AppError(
        ErrorCode.VALIDATION_FIELD_REQUIRED,
        'A required field is missing',
        { context: { requestId } },
      )
    case '08006': // connection_failure
    case '08003': // connection_does_not_exist
    case '08001': // sqlclient_unable_to_establish_sqlconnection
      return new AppError(
        ErrorCode.DB_CONNECTION_FAILED,
        'Database connection failed',
        {
          context: { requestId },
          isOperational: false,
        },
      )
    case '40001': // serialization_failure
    case '40P01': // deadlock_detected
      return new AppError(
        ErrorCode.DB_TRANSACTION_FAILED,
        'Transaction failed due to a conflict. Please try again.',
        { context: { requestId } },
      )
    default:
      return new DatabaseQueryError(
        'Database operation failed',
        new Error(error.code),
        {
          requestId,
        },
      )
  }
}

/**
 * Log an error to the console and database.
 */
function logError(
  error: AppError,
  request?: Request,
  requestId?: string,
): void {
  // Console logging (structured JSON)
  const logData: Record<string, unknown> = {
    requestId,
    code: error.code,
    message: error.message,
    context: error.context,
    isOperational: error.isOperational,
  }

  // Include cause details for debugging unexpected errors
  if (error.cause) {
    const cause = error.cause
    if (cause instanceof Error) {
      // Extract all properties from the error for debugging
      const causeDetails: Record<string, unknown> = {
        message: cause.message,
        stack: cause.stack,
      }
      // Check for PostgreSQL error properties
      const pgCause = cause as Error & {
        code?: string
        detail?: string
        constraint?: string
        table?: string
        column?: string
        cause?: unknown
      }
      if (pgCause.code) causeDetails.pgCode = pgCause.code
      if (pgCause.detail) causeDetails.pgDetail = pgCause.detail
      if (pgCause.constraint) causeDetails.pgConstraint = pgCause.constraint
      if (pgCause.table) causeDetails.pgTable = pgCause.table
      if (pgCause.column) causeDetails.pgColumn = pgCause.column
      // Check for nested cause
      if (pgCause.cause) {
        causeDetails.nestedCause =
          pgCause.cause instanceof Error
            ? {
                message: pgCause.cause.message,
                ...(pgCause.cause as Record<string, unknown>),
              }
            : pgCause.cause
      }
      logData.cause = causeDetails
    } else {
      logData.cause = String(cause)
    }
  }

  if (error.isOperational) {
    apiLogger.warn(logData, 'AppError')
  } else {
    apiLogger.error(logData, 'CRITICAL')
  }

  // Database logging (async, fire-and-forget)
  // Only log if we're in a server environment
  if (typeof process !== 'undefined') {
    ErrorLogService.log({
      error,
      requestId,
      userId: error.context.userId,
      method: request?.method,
      path: request ? new URL(request.url).pathname : undefined,
      userAgent: request?.headers.get('user-agent') ?? undefined,
    }).catch(() => {
      // Silently ignore logging failures
    })
  }
}
