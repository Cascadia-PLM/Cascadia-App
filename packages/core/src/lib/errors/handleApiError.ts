// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { nanoid } from 'nanoid'
import { ZodError } from 'zod'
import { createErrorResponse } from './api'
import { ErrorLogService } from './ErrorLogService'
import { asPostgresError, constraintOf, isSqlStateCode, tableOf } from './pg'
import {
  AppError,
  DatabaseQueryError,
  ErrorCode,
  ValidationError,
} from './index'
import type { PostgresDriverError } from './pg'
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

  // Handle PostgreSQL/Drizzle errors. Drizzle wraps the driver error, so this
  // looks through the cause chain — matching only the outermost object left
  // every wrapped constraint violation classified as a 500 below.
  //
  // The `code` is narrowed to a SQLSTATE because that cause-walk matches
  // anything carrying a string `code`. An fs `ENOENT`, an undici
  // `ECONNREFUSED`, an `EAI_AGAIN` from DNS, an AMQP failure — every one of
  // them used to fall into `mapPostgresError`'s default branch and come back
  // as "Database operation failed", logged CRITICAL against a database that
  // was never touched.
  const pgError = asPostgresError(error)
  if (pgError && isSqlStateCode(pgError.code)) {
    const dbError = mapPostgresError(pgError, requestId)
    logError(dbError, request, requestId)
    return createErrorResponse(dbError, requestId)
  }

  // Unknown errors - wrap in AppError. A nested driver error does not land
  // here: asPostgresError above follows the cause chain, so a wrapped
  // constraint violation is already classified. What does land here is every
  // failure whose `code` is not a SQLSTATE, which now answers "An unexpected
  // error occurred" instead of naming a database it never reached.
  //
  // The residual is the one `isSqlStateCode` documents: a five-character
  // uppercase errno (EPIPE, EBUSY, EXDEV) has a SQLSTATE's shape and is still
  // classified above.
  const unknownError = new AppError(
    ErrorCode.INTERNAL_ERROR,
    'An unexpected error occurred',
    {
      cause: error instanceof Error ? error : new Error(String(error)),
      isOperational: false,
      context: { requestId },
    },
  )
  logError(unknownError, request, requestId)
  return createErrorResponse(unknownError, requestId)
}

/**
 * Map PostgreSQL error codes to AppError instances.
 */
function mapPostgresError(
  error: PostgresDriverError,
  requestId?: string,
): AppError {
  const constraint = constraintOf(error)
  switch (error.code) {
    case '23505': // unique_violation
      return new AppError(
        ErrorCode.RESOURCE_ALREADY_EXISTS,
        error.detail ?? 'A record with this value already exists',
        { context: { requestId, constraint } },
      )
    case '23503': // foreign_key_violation
      return new AppError(
        ErrorCode.DB_CONSTRAINT_VIOLATION,
        'Cannot perform this operation due to related records',
        { context: { requestId, constraint } },
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
      // PostgreSQL error properties, under whichever spelling the driver
      // used — these were read as `constraint`/`table`/`column` only, which
      // postgres.js never sets, so a constraint violation logged none of the
      // three fields you would want when reading the log.
      const pgCause = asPostgresError(cause)
      if (pgCause) {
        causeDetails.pgCode = pgCause.code
        if (pgCause.detail) causeDetails.pgDetail = pgCause.detail
        const constraint = constraintOf(pgCause)
        if (constraint) causeDetails.pgConstraint = constraint
        const table = tableOf(pgCause)
        if (table) causeDetails.pgTable = table
        const column = pgCause.column ?? pgCause.column_name
        if (column) causeDetails.pgColumn = column
      }
      // Check for nested cause
      const nested = cause as Error & { cause?: unknown }
      if (nested.cause) {
        causeDetails.nestedCause =
          nested.cause instanceof Error
            ? {
                message: nested.cause.message,
                ...(nested.cause as unknown as Record<string, unknown>),
              }
            : nested.cause
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
