import { ErrorCode } from './codes'
import { AppError } from './AppError'
import type { ZodError } from 'zod'
import type { ErrorContext, FieldError } from './AppError'

// Re-export everything from codes and AppError
export * from './codes'
export * from './AppError'

// ============================================================================
// Authentication Errors
// ============================================================================

/**
 * Thrown when authentication is required but not provided.
 */
export class AuthenticationError extends AppError {
  constructor(
    message: string = 'Authentication required',
    context?: ErrorContext,
  ) {
    super(ErrorCode.AUTH_REQUIRED, message, { context })
  }
}

/**
 * Thrown when login credentials are invalid.
 */
export class InvalidCredentialsError extends AppError {
  constructor(context?: ErrorContext) {
    super(ErrorCode.AUTH_INVALID_CREDENTIALS, 'Invalid email or password', {
      context,
    })
  }
}

/**
 * Thrown when a session has expired.
 */
export class SessionExpiredError extends AppError {
  constructor(context?: ErrorContext) {
    super(
      ErrorCode.AUTH_SESSION_EXPIRED,
      'Your session has expired. Please sign in again.',
      { context },
    )
  }
}

/**
 * Thrown when an account is locked.
 */
export class AccountLockedError extends AppError {
  constructor(context?: ErrorContext) {
    super(
      ErrorCode.AUTH_ACCOUNT_LOCKED,
      'Your account has been locked. Please contact an administrator.',
      { context },
    )
  }
}

// ============================================================================
// Authorization Errors
// ============================================================================

/**
 * Thrown when a user lacks permission to perform an action.
 */
export class PermissionDeniedError extends AppError {
  constructor(resource: string, action: string, context?: ErrorContext) {
    super(
      ErrorCode.PERMISSION_DENIED,
      `You do not have permission to ${action} ${resource}`,
      { context: { ...context, resource, operation: action } },
    )
  }
}

/**
 * Thrown when a specific role is required.
 */
export class RoleRequiredError extends AppError {
  constructor(requiredRole: string, context?: ErrorContext) {
    super(
      ErrorCode.ROLE_REQUIRED,
      `This action requires the '${requiredRole}' role`,
      { context: { ...context, requiredRole } },
    )
  }
}

/**
 * Thrown when access to a resource is forbidden.
 */
export class ResourceForbiddenError extends AppError {
  constructor(resource: string, context?: ErrorContext) {
    super(ErrorCode.RESOURCE_FORBIDDEN, `Access to ${resource} is forbidden`, {
      context: { ...context, resource },
    })
  }
}

// ============================================================================
// Validation Errors
// ============================================================================

/**
 * Thrown when validation fails.
 */
export class ValidationError extends AppError {
  constructor(
    message: string = 'Validation failed',
    fieldErrors?: Array<FieldError>,
    context?: ErrorContext,
  ) {
    super(ErrorCode.VALIDATION_FAILED, message, { context, fieldErrors })
  }

  /**
   * Create a ValidationError from a Zod validation error.
   * Supports both Zod v3 (.errors) and Zod v4 (.issues) formats.
   */
  static fromZodError(
    zodError: ZodError,
    context?: ErrorContext,
  ): ValidationError {
    // Zod v4 uses .issues, Zod v3 uses .errors
    const issues = zodError.issues
    const fieldErrors: Array<FieldError> = issues.map((err: any) => ({
      field: err.path.join('.'),
      message: err.message,
      code: err.code,
    }))
    return new ValidationError('Validation failed', fieldErrors, context)
  }
}

/**
 * Thrown when a required field is missing.
 */
export class FieldRequiredError extends AppError {
  constructor(fieldName: string, context?: ErrorContext) {
    super(
      ErrorCode.VALIDATION_FIELD_REQUIRED,
      `The field '${fieldName}' is required`,
      { context: { ...context, field: fieldName } },
    )
  }
}

/**
 * Thrown when a field value is invalid.
 */
export class FieldInvalidError extends AppError {
  constructor(fieldName: string, reason: string, context?: ErrorContext) {
    super(
      ErrorCode.VALIDATION_FIELD_INVALID,
      `The field '${fieldName}' is invalid: ${reason}`,
      { context: { ...context, field: fieldName } },
    )
  }
}

// ============================================================================
// Resource Errors
// ============================================================================

/**
 * Thrown when a resource is not found.
 */
export class NotFoundError extends AppError {
  constructor(resource: string, id?: string, context?: ErrorContext) {
    const message = id
      ? `${resource} with ID '${id}' was not found`
      : `${resource} was not found`
    super(ErrorCode.RESOURCE_NOT_FOUND, message, {
      context: { ...context, resource },
    })
  }
}

/**
 * Thrown when a resource already exists.
 */
export class AlreadyExistsError extends AppError {
  constructor(resource: string, identifier: string, context?: ErrorContext) {
    super(
      ErrorCode.RESOURCE_ALREADY_EXISTS,
      `${resource} '${identifier}' already exists`,
      { context: { ...context, resource } },
    )
  }
}

/**
 * Thrown when there's a conflict with the current state of a resource.
 */
export class ConflictError extends AppError {
  constructor(message: string, context?: ErrorContext) {
    super(ErrorCode.RESOURCE_CONFLICT, message, { context })
  }
}

/**
 * Thrown when a resource is locked and cannot be modified.
 */
export class ResourceLockedError extends AppError {
  constructor(resource: string, reason?: string, context?: ErrorContext) {
    const message = reason
      ? `${resource} is locked: ${reason}`
      : `${resource} is locked and cannot be modified`
    super(ErrorCode.RESOURCE_LOCKED, message, {
      context: { ...context, resource },
    })
  }
}

// ============================================================================
// Business Logic Errors
// ============================================================================

/**
 * Thrown when an invalid workflow transition is attempted.
 */
export class WorkflowTransitionError extends AppError {
  constructor(
    fromState: string,
    toState: string,
    reason?: string,
    context?: ErrorContext,
  ) {
    const message = reason
      ? `Cannot transition from '${fromState}' to '${toState}': ${reason}`
      : `Cannot transition from '${fromState}' to '${toState}'`
    super(ErrorCode.WORKFLOW_INVALID_TRANSITION, message, {
      context: { ...context, fromState, toState },
    })
  }
}

/**
 * Thrown when a workflow action is not allowed.
 */
export class WorkflowActionNotAllowedError extends AppError {
  constructor(action: string, state: string, context?: ErrorContext) {
    super(
      ErrorCode.WORKFLOW_ACTION_NOT_ALLOWED,
      `Action '${action}' is not allowed in state '${state}'`,
      { context: { ...context, action, state } },
    )
  }
}

/**
 * Thrown when there's a revision conflict.
 */
export class RevisionConflictError extends AppError {
  constructor(itemNumber: string, context?: ErrorContext) {
    super(
      ErrorCode.ITEM_REVISION_CONFLICT,
      `A newer revision of '${itemNumber}' already exists`,
      { context: { ...context, itemNumber } },
    )
  }
}

/**
 * Thrown when a relationship would create a cycle.
 */
export class RelationshipCycleError extends AppError {
  constructor(context?: ErrorContext) {
    super(
      ErrorCode.ITEM_RELATIONSHIP_CYCLE,
      'This relationship would create a circular reference',
      { context },
    )
  }
}

/**
 * Thrown when an ECO branch cannot be merged due to conflicts.
 * This is an operational error - expected when concurrent ECOs modify the same items.
 */
export class MergeConflictError extends AppError {
  constructor(message: string, context?: ErrorContext) {
    super(ErrorCode.MERGE_CONFLICT, message, { context })
  }
}

/**
 * Thrown when branch protection prevents an operation.
 * Used when main branch is protected (has released items) and direct editing is attempted.
 */
export class BranchProtectionError extends AppError {
  constructor(message: string, context?: ErrorContext) {
    super(ErrorCode.BRANCH_PROTECTED, message, { context })
  }
}

// ============================================================================
// File Errors
// ============================================================================

/**
 * Thrown when a file exceeds the maximum allowed size.
 */
export class FileTooLargeError extends AppError {
  constructor(maxSize: number, actualSize: number, context?: ErrorContext) {
    super(
      ErrorCode.FILE_TOO_LARGE,
      `File size (${formatBytes(actualSize)}) exceeds maximum allowed (${formatBytes(maxSize)})`,
      { context: { ...context, maxSize, actualSize } },
    )
  }
}

/**
 * Thrown when a file type is not allowed.
 */
export class FileTypeNotAllowedError extends AppError {
  constructor(
    fileType: string,
    allowedTypes: Array<string>,
    context?: ErrorContext,
  ) {
    super(
      ErrorCode.FILE_TYPE_NOT_ALLOWED,
      `File type '${fileType}' is not allowed. Allowed types: ${allowedTypes.join(', ')}`,
      { context: { ...context, fileType, allowedTypes } },
    )
  }
}

/**
 * Thrown when a file checkout is required before modification.
 */
export class FileCheckoutRequiredError extends AppError {
  constructor(fileName: string, context?: ErrorContext) {
    super(
      ErrorCode.FILE_CHECKOUT_REQUIRED,
      `File '${fileName}' must be checked out before modification`,
      { context: { ...context, fileName } },
    )
  }
}

// ============================================================================
// Database Errors
// ============================================================================

/**
 * Thrown when the database connection fails.
 */
export class DatabaseConnectionError extends AppError {
  constructor(cause?: Error, context?: ErrorContext) {
    super(ErrorCode.DB_CONNECTION_FAILED, 'Failed to connect to the database', {
      context,
      cause,
      isOperational: false,
    })
  }
}

/**
 * Thrown when a database query fails.
 */
export class DatabaseQueryError extends AppError {
  constructor(message: string, cause?: Error, context?: ErrorContext) {
    super(ErrorCode.DB_QUERY_FAILED, message, {
      context,
      cause,
      isOperational: false,
    })
  }
}

/**
 * Thrown when a database transaction fails.
 */
export class TransactionError extends AppError {
  constructor(message: string, cause?: Error, context?: ErrorContext) {
    super(ErrorCode.DB_TRANSACTION_FAILED, message, {
      context,
      cause,
      isOperational: false,
    })
  }
}

/**
 * Thrown when a database constraint is violated.
 */
export class ConstraintViolationError extends AppError {
  constructor(message: string, context?: ErrorContext) {
    super(ErrorCode.DB_CONSTRAINT_VIOLATION, message, { context })
  }
}

// ============================================================================
// External Service Errors
// ============================================================================

/**
 * Thrown when an external service is unavailable.
 */
export class ExternalServiceUnavailableError extends AppError {
  constructor(serviceName: string, context?: ErrorContext) {
    super(
      ErrorCode.EXTERNAL_SERVICE_UNAVAILABLE,
      `External service '${serviceName}' is currently unavailable`,
      { context: { ...context, serviceName } },
    )
  }
}

/**
 * Thrown when an external service times out.
 */
export class ExternalServiceTimeoutError extends AppError {
  constructor(serviceName: string, context?: ErrorContext) {
    super(
      ErrorCode.EXTERNAL_SERVICE_TIMEOUT,
      `Request to '${serviceName}' timed out`,
      { context: { ...context, serviceName } },
    )
  }
}

/**
 * Thrown when an external service returns an error.
 */
export class ExternalServiceError extends AppError {
  constructor(serviceName: string, message: string, context?: ErrorContext) {
    super(ErrorCode.EXTERNAL_SERVICE_ERROR, `${serviceName}: ${message}`, {
      context: { ...context, serviceName },
    })
  }
}

// ============================================================================
// System Errors
// ============================================================================

/**
 * Thrown for internal errors that shouldn't happen.
 */
export class InternalError extends AppError {
  constructor(message: string, cause?: Error, context?: ErrorContext) {
    super(ErrorCode.INTERNAL_ERROR, message, {
      context,
      cause,
      isOperational: false,
    })
  }
}

/**
 * Thrown when a feature is not yet implemented.
 */
export class NotImplementedError extends AppError {
  constructor(feature: string, context?: ErrorContext) {
    super(
      ErrorCode.NOT_IMPLEMENTED,
      `Feature '${feature}' is not implemented`,
      {
        context: { ...context, feature },
      },
    )
  }
}

/**
 * Thrown when rate limiting is triggered.
 */
export class RateLimitedError extends AppError {
  constructor(retryAfterSeconds?: number, context?: ErrorContext) {
    const message = retryAfterSeconds
      ? `Too many requests. Please try again in ${retryAfterSeconds} seconds.`
      : 'Too many requests. Please try again later.'
    super(ErrorCode.RATE_LIMITED, message, {
      context: { ...context, retryAfterSeconds },
    })
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Format bytes into a human-readable string.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
