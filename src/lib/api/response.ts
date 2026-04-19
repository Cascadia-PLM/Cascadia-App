/**
 * API Response Utilities
 *
 * Provides standardized response builders for the API.
 *
 * Format:
 *   Single: { data: { resourceName: value } } or { data: { ...value } }
 *   Collection: { data: { resourceName: [...], total } }
 *   Error: { error: { code, message, details } }
 */

import type { ErrorCode } from '@/lib/errors/codes'

/**
 * Pagination metadata for collection responses.
 */
export interface PaginationMeta {
  total: number
  limit: number
  offset: number
  hasMore?: boolean
}

/**
 * Create a successful single-resource response.
 *
 * @param data - The resource data
 * @param options - Response options
 * @returns Response object
 *
 * @example
 * ```typescript
 * return createSingleResponse(part, { resourceName: 'part' })
 * ```
 */
export function createSingleResponse<T>(
  data: T,
  options: {
    status?: number
    resourceName?: string
    requestId?: string
    additionalData?: Record<string, unknown>
  } = {},
): Response {
  const { status = 200, resourceName, additionalData } = options

  let body: unknown

  if (resourceName) {
    body = {
      data: {
        [resourceName]: data,
        ...additionalData,
      },
    }
  } else {
    body = {
      data: {
        ...data,
        ...additionalData,
      },
    }
  }

  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * Create a successful collection response with pagination.
 *
 * @param items - Array of items
 * @param pagination - Pagination metadata
 * @param options - Response options
 * @returns Response object
 *
 * @example
 * ```typescript
 * return createCollectionResponse(parts, { total: 100, limit: 20, offset: 0 }, {
 *   resourceName: 'parts'
 * })
 * ```
 */
export function createCollectionResponse<T>(
  items: Array<T>,
  pagination: PaginationMeta,
  options: {
    status?: number
    resourceName?: string
    requestId?: string
    additionalData?: Record<string, unknown>
  } = {},
): Response {
  const { status = 200, resourceName, additionalData } = options

  let body: unknown

  if (resourceName) {
    body = {
      data: {
        [resourceName]: items,
        total: pagination.total,
        ...additionalData,
      },
    }
  } else {
    body = {
      data: {
        items,
        total: pagination.total,
        ...additionalData,
      },
    }
  }

  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * Create an error response.
 *
 * @param code - Error code
 * @param message - Human-readable message
 * @param options - Error options
 * @returns Response object
 */
export function buildErrorResponse(
  code: ErrorCode | string,
  message: string,
  options: {
    status?: number
    details?: Record<string, unknown>
    fieldErrors?: Array<{ field: string; message: string }>
    requestId?: string
  } = {},
): Response {
  const { status = 400, details, fieldErrors } = options

  const body = {
    error: {
      code,
      message,
      ...(details && { details }),
      ...(fieldErrors && { fieldErrors }),
    },
  }

  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * Create a success response for actions/operations (no resource returned).
 */
export function createSuccessResponse(
  message: string,
  options: {
    status?: number
    additionalData?: Record<string, unknown>
    requestId?: string
  } = {},
): Response {
  const { status = 200, additionalData } = options

  const body = {
    data: {
      success: true,
      message,
      ...additionalData,
    },
  }

  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * Create a 201 Created response for resource creation.
 */
export function createCreatedResponse<T>(
  data: T,
  options: {
    resourceName?: string
    location?: string
    requestId?: string
    additionalData?: Record<string, unknown>
  } = {},
): Response {
  const response = createSingleResponse(data, {
    ...options,
    status: 201,
  })

  // Add Location header if provided
  if (options.location) {
    response.headers.set('Location', options.location)
  }

  return response
}

/**
 * Create a 204 No Content response.
 */
export function createNoContentResponse(): Response {
  return new Response(null, { status: 204 })
}
