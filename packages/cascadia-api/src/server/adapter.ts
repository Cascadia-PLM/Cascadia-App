// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { uniqueSymbol } from 'hono-openapi'
import { getConnInfo } from '@hono/node-server/conninfo'
import type { Context, Handler } from 'hono'
import type { OpenApiMetadata } from '@/lib/api/openapi-helpers'
import { metadataToSpec } from '@/lib/api/openapi-helpers'
import { recordSocketAddress } from '@/lib/api/client-ip'

type LegacyHandler<TParams = Record<string, string>> = (ctx: {
  params: TParams
  request: Request
}) => Promise<Response>

type AnnotatableHandler<TParams = Record<string, string>> =
  LegacyHandler<TParams> & { openapi?: OpenApiMetadata }

/**
 * Note the peer address for this request, if the runtime has one to give.
 *
 * This is the only place it is available: `apiHandler` is handed a fetch
 * `Request`, which carries headers and nothing about the connection that
 * delivered them, so without this step the only answer to "who sent this" is
 * whatever the sender wrote in `X-Forwarded-For`. See `lib/api/client-ip`.
 *
 * `getConnInfo` reads the address off the Node `IncomingMessage` behind the
 * request, which exists only when @hono/node-server is serving — both editions
 * do (each app's `src/server/prod.ts`), but a Hono `app.request()` in a test
 * does not, and it throws there. That is not a failure worth reporting: an
 * unrecorded request resolves to `'unknown'`, which is exactly what the
 * header-only predecessor produced for a request with no headers.
 */
function recordPeerAddress(c: Context, request: Request): void {
  try {
    recordSocketAddress(request, getConnInfo(c).remote.address)
  } catch {
    // No connection info in this runtime — leave the request unrecorded.
  }
}

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
    recordPeerAddress(c, request)
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
