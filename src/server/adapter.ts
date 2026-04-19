import type { Context } from 'hono'

type LegacyHandler = (ctx: {
  params: Record<string, string>
  request: Request
}) => Promise<Response>

/**
 * Bridges a Hono route handler to the existing apiHandler() signature.
 *
 * apiHandler() returns `async ({ params, request }) => Response`.
 * Hono gives us `Context` with `c.req.param()` and `c.req.raw`.
 * This adapter connects the two.
 */
export function adapt(handler: LegacyHandler) {
  return async (c: Context) => {
    const params = c.req.param()
    const request = c.req.raw
    return await handler({ params, request })
  }
}
