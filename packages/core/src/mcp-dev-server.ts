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
 *   { "cascadia-dev": { "command": "npx", "args": ["tsx", "packages/core/src/mcp-dev-server.ts"] } }
 *
 * See docs/features/mcp.md for details.
 */

// Stdout carries the MCP JSON-RPC stream — route all logging to stderr.
// Must be set before any module that constructs the pino logger loads,
// hence the dynamic imports below.
process.env.LOG_DESTINATION = 'stderr'

async function main(): Promise<void> {
  // Load `.env` before anything reads it. `instance_status` reports which
  // settings are present, and reading them ahead of dotenv had it report
  // DATABASE_URL unset in the same breath as connecting with it. The path is
  // resolved from the repo root rather than `process.cwd()`: an MCP client
  // chooses the server's working directory and it need not be the checkout.
  // A variable already exported in the environment still wins — dotenv does
  // not overwrite what is set.
  const [{ REPO_ROOT }, { config: loadEnv }, { resolve }] = await Promise.all([
    import('./lib/mcp/repo-root'),
    import('dotenv'),
    import('node:path'),
  ])
  loadEnv({ path: resolve(REPO_ROOT, '.env'), quiet: true })

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
