// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

import { uniqueSymbol } from 'hono-openapi'
import type { Context, Handler } from 'hono'
import type { OpenApiMetadata } from '@/lib/api/openapi-helpers'
import { metadataToSpec } from '@/lib/api/openapi-helpers'

type LegacyHandler = (ctx: {
  params: Record<string, string>
  request: Request
}) => Promise<Response>

type AnnotatableHandler = LegacyHandler & { openapi?: OpenApiMetadata }

/**
 * Bridges a Hono route handler to the existing apiHandler() signature.
 *
 * apiHandler() returns `async ({ params, request }) => Response`.
 * Hono gives us `Context` with `c.req.param()` and `c.req.raw`.
 * This adapter connects the two.
 *
 * If the wrapped handler carries `openapi` metadata (set by
 * `apiHandler({ openapi: ... })`), we tag the returned handler with
 * `hono-openapi`'s unique symbol so the spec generator can pick up the
 * route description without a separate middleware mount. This keeps all
 * 300+ existing `app.METHOD(path, adapt(apiHandler(...)))` call sites
 * unchanged.
 */
export function adapt(handler: AnnotatableHandler): Handler {
  const honoHandler: Handler = async (c: Context) => {
    const params = c.req.param()
    const request = c.req.raw
    return await handler({ params, request })
  }
  if (handler.openapi) {
    Object.assign(honoHandler, {
      [uniqueSymbol]: { spec: metadataToSpec(handler.openapi) },
    })
  }
  return honoHandler
}

/**
 * Build a route adapter pre-configured with a default OpenAPI tag.
 *
 * Each route module shadows `adapt` with `const adapt = tagged('Parts')` at
 * the top of the file; every handler in that file is then auto-tagged for
 * Scalar grouping without per-handler boilerplate. Handlers that supply
 * their own `openapi.tags` via `apiHandler({ openapi: { tags: [...] } })`
 * keep precedence.
 */
export function tagged(tag: string): typeof adapt {
  return (handler: AnnotatableHandler): Handler => {
    const existing = handler.openapi
    if (!existing) {
      handler.openapi = { tags: [tag] }
    } else if (!existing.tags || existing.tags.length === 0) {
      handler.openapi = { ...existing, tags: [tag] }
    }
    return adapt(handler)
  }
}
