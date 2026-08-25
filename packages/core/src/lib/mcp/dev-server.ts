// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Cascadia Dev/Admin MCP Server
 *
 * MCP server for self-hosters standing up, customizing, and operating a
 * Cascadia instance. Runs over stdio from a repository checkout (see
 * `packages/core/src/mcp-dev-server.ts`), with the operator's own shell
 * credentials (direct database access — the same trust level as the admin
 * shell it replaces). It is not authenticated and must never be exposed
 * over the network.
 *
 * End-use PLM tooling (part search, ECO creation, BOM queries) lives in
 * the separate `cascadia-plm` server behind API-key auth: `./plm-server`.
 */

import { buildMcpServer } from './server-factory'
import { createDevToolSpecs } from './dev-tools'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'

export const DEV_SERVER_NAME = 'cascadia-dev'
export const DEV_SERVER_VERSION = '1.0.0'

const SERVER_INSTRUCTIONS = `Cascadia PLM — development and administration tools.

This server operates a self-hosted Cascadia instance from a repository
checkout. Typical flows:

- Stand up an instance: instance_status → db_push → db_seed → instance_status.
- Customize: search_docs / read_doc for the development guides
  (adding item types, API routes, background jobs, packages), plus
  list_item_types, list_roles, and list_packages to inspect current state.
- Operate: instance_status for health; db_reset (destructive, requires
  confirm="RESET" — always ask the operator first) to wipe data.

Documentation is the authority for customization work: start at CLAUDE.md
and docs/README.md.`

export function createDevMcpServer(): Server {
  return buildMcpServer({
    name: DEV_SERVER_NAME,
    version: DEV_SERVER_VERSION,
    instructions: SERVER_INSTRUCTIONS,
    tools: createDevToolSpecs(),
  })
}
