import { errorCodeToHttpStatus } from './codes'
import type { ErrorCode } from './codes'

/**
 * Additional context information for an error.
 */
export interface ErrorContext {
  requestId?: string
  userId?: string
  resource?: string
  operation?: string
  field?: string
  [key: string]: unknown
}

/**
 * Represents a validation error for a specific field.
 */
export interface FieldError {
  field: string
  message: string
  code?: string
}

/**
 * Base error class for all application errors.
 * Provides consistent error structure with code, HTTP status, and context.
 */
export class AppError extends Error {
  public readonly code: ErrorCode
  public readonly httpStatus: number
  public readonly context: ErrorContext
  public readonly isOperational: boolean
  public readonly timestamp: Date
  public readonly fieldErrors?: Array<FieldError>

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      context?: ErrorContext
      cause?: Error
      fieldErrors?: Array<FieldError>
      isOperational?: boolean
    } = {},
  ) {
    super(message, { cause: options.cause })
    this.name = this.constructor.name
    this.code = code
    this.httpStatus = errorCodeToHttpStatus[code]
    this.context = options.context ?? {}
    this.fieldErrors = options.fieldErrors
    this.isOperational = options.isOperational ?? true
    this.timestamp = new Date()

    // Maintains proper stack trace for where error was thrown (only available on V8)
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, this.constructor)
    }
  }

  /**
   * Convert error to a JSON-serializable object.
   */
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      httpStatus: this.httpStatus,
      context: this.context,
      fieldErrors: this.fieldErrors,
      timestamp: this.timestamp.toISOString(),
    }
  }
}
