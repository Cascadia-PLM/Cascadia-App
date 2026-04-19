/**
 * API Test Helpers
 *
 * Utilities for testing API routes with mocked or real services.
 *
 * @example
 * ```typescript
 * import { ApiTestClient, createApiTestClient } from '@test/helpers/api'
 *
 * describe('Parts API', () => {
 *   const client = createApiTestClient()
 *
 *   test('GET /api/parts returns parts list', async () => {
 *     const response = await client.get('/api/parts', { auth: mockSession })
 *     expect(response.status).toBe(200)
 *
 *     const data = await response.json()
 *     expect(data.parts).toBeInstanceOf(Array)
 *   })
 * })
 * ```
 */

import { vi } from 'vitest'
import { createMockRequest, createMockSession } from './auth'
import type { MockAuthOptions, MockSessionValidationResult } from './auth'

/**
 * HTTP methods supported by the test client
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/**
 * Options for API test requests
 */
export interface ApiTestRequestOptions {
  /** Request body (will be JSON stringified) */
  body?: unknown
  /** Custom headers */
  headers?: Record<string, string>
  /** Auth options - either a session or options to create one */
  auth?: MockSessionValidationResult | MockAuthOptions
  /** Query parameters */
  query?: Record<string, string | number | boolean>
}

/**
 * Response wrapper with helper methods
 */
export interface ApiTestResponse extends Response {
  /** Parse response body as JSON (cached) */
  data: <T = unknown>() => Promise<T>
  /** Check if response is successful (2xx) */
  isOk: boolean
  /** Check if response is a client error (4xx) */
  isClientError: boolean
  /** Check if response is a server error (5xx) */
  isServerError: boolean
}

/**
 * Wrap a Response with helper methods
 */
function wrapResponse(response: Response): ApiTestResponse {
  let cachedData: unknown = undefined
  let dataParsed = false

  const wrapped = response as ApiTestResponse

  wrapped.data = async <T = unknown>(): Promise<T> => {
    if (!dataParsed) {
      try {
        cachedData = await response.clone().json()
      } catch {
        cachedData = null
      }
      dataParsed = true
    }
    return cachedData as T
  }

  Object.defineProperty(wrapped, 'isOk', {
    get: () => response.status >= 200 && response.status < 300,
  })

  Object.defineProperty(wrapped, 'isClientError', {
    get: () => response.status >= 400 && response.status < 500,
  })

  Object.defineProperty(wrapped, 'isServerError', {
    get: () => response.status >= 500,
  })

  return wrapped
}

/**
 * Build URL with query parameters
 */
function buildUrl(
  path: string,
  query?: Record<string, string | number | boolean>,
): string {
  const baseUrl = path.startsWith('http')
    ? path
    : `http://localhost:3000${path}`

  if (!query || Object.keys(query).length === 0) {
    return baseUrl
  }

  const url = new URL(baseUrl)
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, String(value))
  }

  return url.toString()
}

/**
 * API Test Client for making requests to API routes
 */
export class ApiTestClient {
  private baseHeaders: Record<string, string>

  constructor(options: { headers?: Record<string, string> } = {}) {
    this.baseHeaders = options.headers ?? {}
  }

  /**
   * Make a request to an API route
   */
  request(
    method: HttpMethod,
    path: string,
    options: ApiTestRequestOptions = {},
  ): Promise<ApiTestResponse> {
    const { body, headers = {}, auth, query } = options

    const url = buildUrl(path, query)

    // Merge headers
    const mergedHeaders: Record<string, string> = {
      ...this.baseHeaders,
      ...headers,
    }

    // Handle auth
    let sessionToken: string | undefined
    if (auth) {
      const session =
        'session' in auth && 'user' in auth ? auth : createMockSession(auth)

      sessionToken = session.session.id
    }

    // Create the request
    createMockRequest(url, {
      method,
      body,
      headers: mergedHeaders,
      sessionToken,
    })

    // For actual API testing, you would call the route handler here
    // This is a placeholder that returns the request for inspection
    // In real usage, you'd integrate with your route handlers

    // Return a mock response for now - actual implementation depends on how
    // Hono routes are invoked in tests
    const mockResponse = new Response(JSON.stringify({ _testRequest: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })

    return Promise.resolve(wrapResponse(mockResponse))
  }

  /**
   * Make a GET request
   */
  get(
    path: string,
    options?: Omit<ApiTestRequestOptions, 'body'>,
  ): Promise<ApiTestResponse> {
    return this.request('GET', path, options)
  }

  /**
   * Make a POST request
   */
  post(
    path: string,
    options?: ApiTestRequestOptions,
  ): Promise<ApiTestResponse> {
    return this.request('POST', path, options)
  }

  /**
   * Make a PUT request
   */
  put(path: string, options?: ApiTestRequestOptions): Promise<ApiTestResponse> {
    return this.request('PUT', path, options)
  }

  /**
   * Make a PATCH request
   */
  patch(
    path: string,
    options?: ApiTestRequestOptions,
  ): Promise<ApiTestResponse> {
    return this.request('PATCH', path, options)
  }

  /**
   * Make a DELETE request
   */
  delete(
    path: string,
    options?: Omit<ApiTestRequestOptions, 'body'>,
  ): Promise<ApiTestResponse> {
    return this.request('DELETE', path, options)
  }
}

/**
 * Create an API test client
 */
export function createApiTestClient(options?: {
  headers?: Record<string, string>
}): ApiTestClient {
  return new ApiTestClient(options)
}

/**
 * Response assertions for API tests
 */
export const apiAssertions = {
  /**
   * Assert response status code
   */
  status(response: Response, expectedStatus: number): void {
    if (response.status !== expectedStatus) {
      throw new Error(
        `Expected status ${expectedStatus}, got ${response.status}`,
      )
    }
  },

  /**
   * Assert response is successful (2xx)
   */
  ok(response: Response): void {
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Expected successful response, got ${response.status}`)
    }
  },

  /**
   * Assert response is created (201)
   */
  created(response: Response): void {
    apiAssertions.status(response, 201)
  },

  /**
   * Assert response is no content (204)
   */
  noContent(response: Response): void {
    apiAssertions.status(response, 204)
  },

  /**
   * Assert response is bad request (400)
   */
  badRequest(response: Response): void {
    apiAssertions.status(response, 400)
  },

  /**
   * Assert response is not found (404)
   */
  notFound(response: Response): void {
    apiAssertions.status(response, 404)
  },

  /**
   * Assert response is conflict (409)
   */
  conflict(response: Response): void {
    apiAssertions.status(response, 409)
  },

  /**
   * Assert response is validation error (422)
   */
  validationError(response: Response): void {
    apiAssertions.status(response, 422)
  },

  /**
   * Assert response contains specific JSON data
   */
  async containsJson(
    response: Response,
    expected: Record<string, unknown>,
  ): Promise<void> {
    const data = await response.json()

    for (const [key, value] of Object.entries(expected)) {
      if (JSON.stringify(data[key]) !== JSON.stringify(value)) {
        throw new Error(
          `Expected ${key} to be ${JSON.stringify(value)}, got ${JSON.stringify(data[key])}`,
        )
      }
    }
  },

  /**
   * Assert response has specific headers
   */
  headers(response: Response, expected: Record<string, string>): void {
    for (const [key, value] of Object.entries(expected)) {
      const actual = response.headers.get(key)
      if (actual !== value) {
        throw new Error(
          `Expected header ${key} to be "${value}", got "${actual}"`,
        )
      }
    }
  },
}

/**
 * Service mock utilities for isolating API tests from the database
 */
export function createServiceMocks() {
  return {
    itemService: {
      getById: vi.fn(),
      getAll: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      search: vi.fn(),
    },
    userService: {
      getById: vi.fn(),
      getByEmail: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      validatePassword: vi.fn(),
    },
    fileService: {
      upload: vi.fn(),
      download: vi.fn(),
      delete: vi.fn(),
      getMetadata: vi.fn(),
    },
    changeOrderService: {
      create: vi.fn(),
      submit: vi.fn(),
      approve: vi.fn(),
      reject: vi.fn(),
      implement: vi.fn(),
      close: vi.fn(),
    },

    /**
     * Reset all mocks
     */
    reset() {
      vi.clearAllMocks()
    },

    /**
     * Restore all mocks
     */
    restore() {
      vi.restoreAllMocks()
    },
  }
}

/**
 * Helper to test API error responses
 */
export async function expectApiError(
  response: Response,
  expectedCode: string,
  expectedStatus?: number,
): Promise<void> {
  if (expectedStatus && response.status !== expectedStatus) {
    throw new Error(`Expected status ${expectedStatus}, got ${response.status}`)
  }

  const data = await response.json()

  if (!data.error) {
    throw new Error('Expected error response but got success')
  }

  if (data.error.code !== expectedCode) {
    throw new Error(
      `Expected error code ${expectedCode}, got ${data.error.code}`,
    )
  }
}

/**
 * Helper to test validation errors
 */
export async function expectValidationErrors(
  response: Response,
  expectedFields: Array<string>,
): Promise<void> {
  apiAssertions.status(response, 400)

  const data = await response.json()

  if (!data.error?.validationErrors) {
    throw new Error('Expected validation errors in response')
  }

  const errorFields = Object.keys(data.error.validationErrors)

  for (const field of expectedFields) {
    if (!errorFields.includes(field)) {
      throw new Error(`Expected validation error for field "${field}"`)
    }
  }
}

