// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Cascadia Dev/Admin MCP Server — stdio entry point.
 *
 * Run from a repository checkout:
 *
 *   npm run mcp:dev-server
 *
 * Or register it with an MCP client (e.g. Claude Code's .mcp.json):
 *
 *   { "cascadia-dev": { "command": "npx", "args": ["tsx", "src/mcp-dev-server.ts"] } }
 *
 * See docs/features/mcp.md for details.
 */

// Stdout carries the MCP JSON-RPC stream — route all logging to stderr.
// Must be set before any module that constructs the pino logger loads,
// hence the dynamic imports below.
process.env.LOG_DESTINATION = 'stderr'

async function main(): Promise<void> {
  const [{ StdioServerTransport }, { createDevMcpServer, DEV_SERVER_NAME }] =
    await Promise.all([
      import('@modelcontextprotocol/sdk/server/stdio.js'),
      import('./lib/mcp/dev-server'),
    ])

  const server = createDevMcpServer()
  await server.connect(new StdioServerTransport())
  console.error(`${DEV_SERVER_NAME}: MCP server listening on stdio`)
}

main().catch((error: unknown) => {
  console.error('Failed to start MCP dev server:', error)
  process.exit(1)
})
