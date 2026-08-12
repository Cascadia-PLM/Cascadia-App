// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { uniqueSymbol } from 'hono-openapi'
import type { Context, Handler } from 'hono'
import type { OpenApiMetadata } from '@/lib/api/openapi-helpers'
import { metadataToSpec } from '@/lib/api/openapi-helpers'

type LegacyHandler<TParams = Record<string, string>> = (ctx: {
  params: TParams
  request: Request
}) => Promise<Response>

type AnnotatableHandler<TParams = Record<string, string>> =
  LegacyHandler<TParams> & { openapi?: OpenApiMetadata }

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
export function adapt<TParams = Record<string, string>>(
  handler: AnnotatableHandler<TParams>,
): Handler {
  const honoHandler: Handler = async (c: Context) => {
    // Hono only dispatches to a route once every `:name` segment in its path
    // pattern has been bound, so the runtime bag always carries the keys the
    // handler declares. That lets a handler name its own params -
    // `apiHandler<{ id: string }>` - and read `params.id` as `string` rather
    // than `string | undefined`, which is what `Record<string, string>` would
    // give under `noUncheckedIndexedAccess`. This cast is the single point
    // where that guarantee is asserted.
    const params = c.req.param() as TParams
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
  return <TParams = Record<string, string>>(
    handler: AnnotatableHandler<TParams>,
  ): Handler => {
    const existing = handler.openapi
    if (!existing) {
      handler.openapi = { tags: [tag] }
    } else if (!existing.tags || existing.tags.length === 0) {
      handler.openapi = { ...existing, tags: [tag] }
    }
    return adapt(handler)
  }
}
