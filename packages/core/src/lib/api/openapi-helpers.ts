// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { z } from 'zod'
import { resolver } from 'hono-openapi'
import type { DescribeRouteOptions } from 'hono-openapi'

/**
 * Standard error envelope returned by `handleApiError`. Matches the shape
 * `createErrorResponse` (`src/lib/errors/api.ts`) actually writes, field for
 * field, so the spec stays honest.
 *
 * Two of these fields were wrong until the CSRF rejection was made to
 * validate against this schema. `fieldErrors` is a list of per-issue objects,
 * not a map of field name to messages — that is what `ValidationError` builds
 * from a `ZodError`, and it is what every 400 in the API has always returned.
 * And `requestId` was missing entirely, though it is the field a support
 * conversation starts from. `details` is a string and appears only in
 * development.
 */
export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    timestamp: z.string(),
    requestId: z.string().optional(),
    fieldErrors: z
      .array(
        z.object({
          field: z.string(),
          message: z.string(),
          code: z.string().optional(),
        }),
      )
      .optional(),
    details: z.string().optional(),
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
 * The error envelope and the five standard error responses, as reusable
 * OpenAPI components.
 *
 * These are merged into every annotated route, and inlining them was 92% of
 * the document: 2,205 copies of a 53-line schema across 441 operations, in a
 * file of 126,778 lines. Emitting them once and referencing them is what
 * OpenAPI components are for, and it is why the spec is now a readable
 * artefact rather than a 4 MB one.
 *
 * Mounted under `components` by `openAPIRouteHandler` in `server/index.ts`.
 */
export const ERROR_COMPONENTS = {
  schemas: {
    ErrorResponse: (() => {
      const schema = z.toJSONSchema(errorResponseSchema, {
        target: 'openapi-3.1',
      }) as Record<string, unknown>
      delete schema.$schema
      return schema
    })(),
  },
  responses: {
    ValidationError: errorResponseRef('Validation error'),
    Unauthorized: errorResponseRef('Authentication required'),
    Forbidden: errorResponseRef('Permission denied'),
    NotFound: errorResponseRef('Not found'),
    ServerError: errorResponseRef('Server error'),
  },
} as const

function errorResponseRef(description: string) {
  return {
    description,
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/ErrorResponse' },
      },
    },
  }
}

/**
 * Standard error responses merged into every annotated route. Authors only
 * declare 200/201 explicitly; auth, permission, validation, and server errors
 * are uniform across the API.
 *
 * References rather than inlines — see ERROR_COMPONENTS.
 */
export const STANDARD_ERROR_RESPONSES = {
  400: { $ref: '#/components/responses/ValidationError' },
  401: { $ref: '#/components/responses/Unauthorized' },
  403: { $ref: '#/components/responses/Forbidden' },
  404: { $ref: '#/components/responses/NotFound' },
  500: { $ref: '#/components/responses/ServerError' },
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
    body?: {
      schema: z.ZodType
      description?: string
      mediaType?: string
      /**
       * Defaults to true. Set false for a route that runs on defaults when
       * the body is absent — `POST /files/:id/convert` is the one such case.
       */
      required?: boolean
      /**
       * Keep this schema in the document instead of the one `body:` enforces.
       *
       * `documentBody` (`handler.ts`) otherwise overwrites the annotation with
       * the runtime schema, so a route cannot advertise a shape it does not
       * check. Set this only where the enforced envelope is *deliberately*
       * looser than the real contract — a union the route resolves per item
       * type, or a batch whose lines are rejected individually — and the
       * annotation is a documented superset of it: every body the annotation
       * describes must be one the envelope accepts.
       *
       * It buys documentation, not enforcement. Nothing compares the two
       * schemas, so the superset can drift from what the handler downstream of
       * the envelope actually takes; the route's `documented-not-enforced:`
       * comment has to say which check is the real one. Reach for it only
       * alongside that comment.
       */
      documentsSupersetOfEnforced?: true
    }
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
      required: meta.request.body.required ?? true,
      content: {
        [mediaType]: {
          // Converted here rather than handed to `resolver()`. hono-openapi
          // only awaits the resolver proxy for *responses* (`getSpec` calls
          // `resolveResponseSchemas` and nothing else on the `describeRoute`
          // path), so a resolver left in a body position serialises as the
          // literal `{ "vendor": "zod" }`. Every one of the 32 annotated
          // bodies in the snapshot said exactly that until this line
          // changed — the annotations were there, the schemas never reached
          // the document. Same reason as `zodObjectToParameters` below.
          schema: zodToJsonSchema(meta.request.body.schema, 'input'),
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
 * Convert a Zod schema to a real OpenAPI 3.1 JSON Schema, synchronously.
 *
 * Everything on the request side goes through here rather than through
 * hono-openapi's `resolver()`: that returns a vendor-tagged proxy which the
 * generator only awaits for responses, so anywhere else it survives into the
 * document as `{ "vendor": "zod" }`.
 *
 * `io` picks which side of a transform to describe. Request bodies, path and
 * query parameters are all *inputs*, so a field with `.default()` is optional
 * to the caller — `io: 'output'` would mark it required, which is the
 * opposite of the truth for someone writing the request.
 */
function zodToJsonSchema(
  schema: z.ZodType,
  io: 'input' | 'output',
): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema, {
    target: 'openapi-3.1',
    io,
    // A Zod date has no JSON Schema equivalent and the converter throws on
    // one by default. That throw would happen at module load, when routes are
    // defined — so a single `z.coerce.date()` in a documented body would take
    // down the whole server, not just its spec. Emit `any` for anything
    // unrepresentable, and let the override put the dates back as RFC 3339
    // strings, which is what they are on the wire.
    unrepresentable: 'any',
    override: (ctx) => {
      if (ctx.zodSchema._zod.def.type === 'date') {
        ctx.jsonSchema.type = 'string'
        ctx.jsonSchema.format = 'date-time'
      }
    },
  }) as Record<string, unknown>
  delete jsonSchema.$schema
  return jsonSchema
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
    out.push({
      in: location,
      name,
      required: location === 'path' ? true : !field.isOptional(),
      schema: zodToJsonSchema(field, 'input') as never,
    })
  }
  return out
}
