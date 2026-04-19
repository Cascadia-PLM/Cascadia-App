import type { AppError, FieldError } from './AppError'
import type { ErrorCode } from './codes'

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

/**
 * Create a standardized error Response object from an AppError.
 */
export function createErrorResponse(
  error: AppError,
  requestId?: string,
): Response {
  const body: ErrorResponse = {
    error: {
      code: error.code,
      message: error.message,
      fieldErrors: error.fieldErrors,
      requestId: requestId ?? error.context.requestId,
      timestamp: error.timestamp.toISOString(),
    },
  }

  // Include details only in development
  if (process.env.NODE_ENV === 'development' && error.cause) {
    body.error.details =
      error.cause instanceof Error ? error.cause.message : String(error.cause)
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  // Add Retry-After header for rate-limited responses
  if (error.httpStatus === 429 && error.context.retryAfterSeconds) {
    headers['Retry-After'] = String(error.context.retryAfterSeconds)
  }

  return new Response(JSON.stringify(body), {
    status: error.httpStatus,
    headers,
  })
}

/**
 * Create a success response with data.
 */
export function createSuccessResponse<T>(
  data: T,
  status: number = 200,
): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
