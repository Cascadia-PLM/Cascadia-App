// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * MCP (Model Context Protocol) endpoint — Streamable HTTP transport.
 *
 * External agents connect here to use the Cascadia PLM tools (see
 * `@/lib/mcp/plm-server`). Authentication is API-key only:
 *
 *   Authorization: Bearer csc_...
 *
 * Keys are minted per user under Settings → API Keys (or
 * POST /api/v1/auth/api-keys) and may carry a narrowed permission scope;
 * tool execution intersects that scope with the user's role permissions,
 * exactly like REST routes do. Session cookies are deliberately rejected:
 * MCP clients are non-browser processes, and refusing ambient cookie
 * credentials removes the endpoint's CSRF surface entirely.
 *
 * The transport is stateless: each request builds a fresh server bound to
 * the caller's identity, so the endpoint scales horizontally with no
 * session affinity. This endpoint speaks JSON-RPC per the MCP spec, not the
 * REST envelope — it is intentionally outside the frozen /api/v1 contract.
 */

import { Hono } from 'hono'
import { StreamableHTTPTransport } from '@hono/mcp'
import { resolveCredentials } from '@/lib/auth/credentials'
import { createPlmMcpServer } from '@/lib/mcp/plm-server'

const app = new Hono()

function unauthorized(message: string): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32001, message },
      id: null,
    }),
    {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        // Advertise the expected scheme per RFC 9110 / MCP authorization.
        'WWW-Authenticate': 'Bearer realm="Cascadia MCP"',
      },
    },
  )
}

app.all('/', async (c) => {
  const credentials = await resolveCredentials(c.req.raw)

  if (!credentials) {
    return unauthorized(
      'Authentication required. Send an API key as "Authorization: Bearer csc_...". Create one under Settings → API Keys.',
    )
  }

  if (credentials.authMethod !== 'api_key') {
    return unauthorized(
      'The MCP endpoint accepts API keys only, not browser sessions. Create a key under Settings → API Keys and send it as "Authorization: Bearer csc_...".',
    )
  }

  const server = createPlmMcpServer({
    userId: credentials.user.id,
    keyScope: credentials.scope,
  })

  // Stateless mode: no session id, one transport per request.
  const transport = new StreamableHTTPTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  await server.connect(transport)

  const response = await transport.handleRequest(c)
  return response ?? c.body(null, 202)
})

export default app
