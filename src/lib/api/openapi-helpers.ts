// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

import { z } from 'zod'
import { resolver } from 'hono-openapi'
import type { DescribeRouteOptions } from 'hono-openapi'

/**
 * Standard error envelope returned by `handleApiError`. Matches the shape
 * produced by `src/lib/errors/handleApiError.ts` so the spec stays honest.
 */
export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    timestamp: z.string(),
    fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
})

/**
 * Wrap a payload schema in the standard `{ data: ... }` envelope used by
 * `apiHandler()` for successful object returns (`handler.ts:343`).
 */
export function dataResponse<T extends z.ZodType>(
  schema: T,
): z.ZodObject<{ data: T }> {
  return z.object({ data: schema })
}

/**
 * Standard error responses merged into every annotated route. Authors only
 * declare 200/201 explicitly; auth, permission, validation, and server errors
 * are uniform across the API.
 */
export const STANDARD_ERROR_RESPONSES = {
  400: {
    description: 'Validation error',
    content: {
      'application/json': { schema: resolver(errorResponseSchema) },
    },
  },
  401: {
    description: 'Authentication required',
    content: {
      'application/json': { schema: resolver(errorResponseSchema) },
    },
  },
  403: {
    description: 'Permission denied',
    content: {
      'application/json': { schema: resolver(errorResponseSchema) },
    },
  },
  404: {
    description: 'Not found',
    content: {
      'application/json': { schema: resolver(errorResponseSchema) },
    },
  },
  500: {
    description: 'Server error',
    content: {
      'application/json': { schema: resolver(errorResponseSchema) },
    },
  },
} as const

/**
 * High-level metadata used by `apiHandler({ openapi: ... })`. We translate
 * this into `hono-openapi`'s `DescribeRouteOptions` inside `adapt()`.
 *
 * Authors describe inputs and the success response; standard errors are
 * merged automatically by `buildDescribeRoute`.
 */
export interface OpenApiMetadata {
  /** One-line summary shown in the docs UI. */
  summary?: string
  /** Long-form description. Markdown is rendered by Scalar. */
  description?: string
  /** Tag (resource) name used to group operations in Scalar. */
  tags?: Array<string>
  /** Mark deprecated endpoints; surfaced visually in Scalar. */
  deprecated?: boolean
  /** Override stable identifier for the operation; defaults to `${method}_${path}`. */
  operationId?: string
  request?: {
    body?: { schema: z.ZodType; description?: string; mediaType?: string }
    query?: z.ZodType
    params?: z.ZodType
  }
  /**
   * Success-side responses. Provide the *inner* payload schema; it is wrapped
   * in the `{ data: ... }` envelope automatically. For raw `Response` returns
   * (file streams, SSE, custom Set-Cookie), pass `raw: true` and supply
   * `mediaType` + `description` instead.
   */
  responses?: Record<
    number,
    | { schema: z.ZodType; description?: string }
    | { raw: true; mediaType: string; description?: string }
  >
}

/**
 * Translate our high-level `OpenApiMetadata` into a `DescribeRouteOptions`
 * object suitable for `hono-openapi`'s spec generator. Adds standard error
 * responses, wraps success payloads in the `{ data }` envelope, and binds
 * Zod schemas to request body/query/params.
 */
export function metadataToSpec(meta: OpenApiMetadata): DescribeRouteOptions {
  const spec: DescribeRouteOptions = {
    summary: meta.summary,
    description: meta.description,
    tags: meta.tags,
    deprecated: meta.deprecated,
    operationId: meta.operationId,
    responses: { ...STANDARD_ERROR_RESPONSES },
  }

  if (meta.request?.body) {
    const mediaType = meta.request.body.mediaType ?? 'application/json'
    spec.requestBody = {
      description: meta.request.body.description,
      required: true,
      content: {
        [mediaType]: {
          schema: resolver(meta.request.body.schema) as never,
        },
      },
    }
  }

  const parameters: NonNullable<DescribeRouteOptions['parameters']> = []
  if (meta.request?.params) {
    parameters.push(...zodObjectToParameters(meta.request.params, 'path'))
  }
  if (meta.request?.query) {
    parameters.push(...zodObjectToParameters(meta.request.query, 'query'))
  }
  if (parameters.length) spec.parameters = parameters

  if (meta.responses) {
    for (const [statusStr, resp] of Object.entries(meta.responses)) {
      const status = Number(statusStr)
      if ('raw' in resp) {
        spec.responses![status] = {
          description: resp.description ?? '',
          content: { [resp.mediaType]: {} },
        }
      } else {
        spec.responses![status] = {
          description: resp.description ?? 'Success',
          content: {
            'application/json': {
              schema: resolver(dataResponse(resp.schema)),
            },
          },
        }
      }
    }
  }

  return spec
}

/**
 * Expand a Zod object schema into per-field OpenAPI parameter entries. Each
 * key in the object becomes one `path` or `query` parameter; the field's
 * own optionality drives `required`.
 *
 * Non-object schemas are silently skipped — the route author is expected to
 * pass a Zod object for `request.params`/`request.query`.
 */
function zodObjectToParameters(
  schema: z.ZodType,
  location: 'path' | 'query',
): Array<NonNullable<DescribeRouteOptions['parameters']>[number]> {
  if (!(schema instanceof z.ZodObject)) return []
  const shape = schema.shape as Record<string, z.ZodType>
  const out: Array<NonNullable<DescribeRouteOptions['parameters']>[number]> = []
  for (const [name, field] of Object.entries(shape)) {
    // Convert each field to a real JSON Schema synchronously via Zod 4's
    // built-in converter. `resolver()` returns a vendor-tagged proxy that
    // hono-openapi only unwraps in body/response positions, so we'd otherwise
    // emit `{ vendor: "zod" }` placeholders for path/query params.
    const jsonSchema = z.toJSONSchema(field, {
      target: 'openapi-3.1',
    }) as Record<string, unknown>
    delete jsonSchema.$schema
    out.push({
      in: location,
      name,
      required: location === 'path' ? true : !field.isOptional(),
      schema: jsonSchema as never,
    })
  }
  return out
}
