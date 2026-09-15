// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * OpenAPI metadata translation — `metadataToSpec`.
 *
 * Complex-algorithm gate, of the silent-failure kind. Every one of the 32
 * annotated request bodies in the committed snapshot read
 * `{ "vendor": "zod" }` until this was fixed: `resolver()` returns a proxy
 * that hono-openapi only awaits for responses, so in a body position it
 * survived into the document verbatim. Nothing failed — the annotation was
 * present, the spec generated, the snapshot check passed. The tests below
 * assert the shape of the *output*, which is the only place that bug was
 * ever visible.
 *
 * Run: npx vitest run packages/core/src/lib/api/openapi-helpers.test.ts
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { metadataToSpec } from './openapi-helpers'

/** Pull the JSON Schema out of a generated `requestBody`. */
function bodySchema(
  spec: ReturnType<typeof metadataToSpec>,
  mediaType = 'application/json',
): Record<string, unknown> {
  const body = spec.requestBody
  if (!body || !('content' in body)) {
    throw new Error('no requestBody was generated')
  }
  const schema = body.content[mediaType]?.schema
  if (!schema) throw new Error(`no ${mediaType} schema was generated`)
  return schema as Record<string, unknown>
}

/** Every schema-shaped object anywhere in the generated spec. */
function everySchemaValue(spec: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (node && typeof node === 'object') {
      out.push(node as Record<string, unknown>)
      Object.values(node).forEach(walk)
    }
  }
  walk(spec)
  return out
}

describe('metadataToSpec', () => {
  it('emits a real JSON Schema for a request body, not a resolver proxy', () => {
    const spec = metadataToSpec({
      request: { body: { schema: z.object({ name: z.string().max(200) }) } },
    })

    expect(bodySchema(spec)).toEqual({
      type: 'object',
      properties: { name: { type: 'string', maxLength: 200 } },
      required: ['name'],
    })
  })

  it('leaves no vendor placeholder anywhere in the generated spec', () => {
    const spec = metadataToSpec({
      request: {
        body: { schema: z.object({ a: z.string() }) },
        params: z.object({ id: z.string().uuid() }),
        query: z.object({ limit: z.coerce.number().optional() }),
      },
      responses: { 200: { schema: z.object({ ok: z.boolean() }) } },
    })

    // Responses are resolved lazily by hono-openapi and legitimately still
    // hold a proxy here; everything on the request side must already be real.
    const requestSide = [spec.requestBody, spec.parameters]
    for (const node of everySchemaValue(requestSide)) {
      expect(node).not.toHaveProperty('vendor')
    }
  })

  it('describes the input side of the body, so a defaulted field is optional', () => {
    const spec = metadataToSpec({
      request: {
        body: {
          schema: z.object({
            meshQuality: z.enum(['preview', 'standard']).default('standard'),
            fileId: z.string(),
          }),
        },
      },
    })

    const schema = bodySchema(spec)
    // `io: 'output'` would list meshQuality here — true of the parsed value,
    // the opposite of the truth for someone writing the request.
    expect(schema.required).toEqual(['fileId'])
    expect(schema.properties).toMatchObject({
      meshQuality: { default: 'standard' },
    })
  })

  it('renders a date as an RFC 3339 string instead of throwing', () => {
    // z.toJSONSchema rejects dates by default, and this runs at module load —
    // one z.coerce.date() in a documented body would take the server down.
    const spec = metadataToSpec({
      request: { body: { schema: z.object({ startDate: z.coerce.date() }) } },
    })

    expect(bodySchema(spec).properties).toEqual({
      startDate: { type: 'string', format: 'date-time' },
    })
  })

  it('honours a non-JSON media type for the body', () => {
    const spec = metadataToSpec({
      request: {
        body: {
          schema: z.object({ file0: z.file().optional() }),
          mediaType: 'multipart/form-data',
        },
      },
    })

    expect(bodySchema(spec, 'multipart/form-data').properties).toMatchObject({
      file0: { type: 'string', format: 'binary' },
    })
  })

  it('marks the body optional only when the route says so', () => {
    const schema = z.object({ a: z.string().optional() })
    const required = metadataToSpec({ request: { body: { schema } } })
    const optional = metadataToSpec({
      request: { body: { schema, required: false } },
    })

    expect(required.requestBody).toMatchObject({ required: true })
    expect(optional.requestBody).toMatchObject({ required: false })
  })

  it('expands params and query into per-field parameters', () => {
    const spec = metadataToSpec({
      request: {
        params: z.object({ id: z.string().uuid() }),
        query: z.object({
          limit: z.coerce.number().int().optional().default(50),
        }),
      },
    })

    expect(spec.parameters).toEqual([
      {
        in: 'path',
        name: 'id',
        required: true,
        schema: expect.objectContaining({ type: 'string', format: 'uuid' }),
      },
      {
        in: 'query',
        name: 'limit',
        required: false,
        schema: expect.objectContaining({ type: 'integer', default: 50 }),
      },
    ])
  })

  it('merges the standard error responses into every annotated route', () => {
    const spec = metadataToSpec({ summary: 'anything' })

    expect(spec.responses).toMatchObject({
      400: { $ref: '#/components/responses/ValidationError' },
      401: { $ref: '#/components/responses/Unauthorized' },
      403: { $ref: '#/components/responses/Forbidden' },
      404: { $ref: '#/components/responses/NotFound' },
      500: { $ref: '#/components/responses/ServerError' },
    })
  })
})
