# MCP Servers

Cascadia ships two Model Context Protocol (MCP) servers with distinct audiences:

| Server         | Audience                              | Transport                  | Auth                       |
| -------------- | ------------------------------------- | -------------------------- | -------------------------- |
| `cascadia-plm` | End users' agents (PLM work)          | Streamable HTTP `/api/mcp` | API key (`Bearer csc_...`) |
| `cascadia-dev` | Self-hosting devs/admins (operations) | stdio, from a checkout     | None — local trust only    |

Both are thin protocol layers over existing infrastructure; neither invents its
own tool implementations, permission checks, or audit trails.

---

## `cascadia-plm` — PLM end-use server

Lets people drive their PLM workflows from agentic clients (Claude, IDE
assistants, custom integrations): find part data, walk BOMs, analyze change
impact, create ECOs, transition workflow states.

### One tool stack, two frontends

The server publishes the **PLM tool registry**
(`packages/core/src/lib/ai/tools/registry.ts`) — the same registry the in-app AI chatbot
consumes. Each registry entry pairs a TanStack AI tool definition (name,
description, Zod schemas) with a context-bound handler and declares which
surfaces expose it:

- `chat` — the in-app chatbot's full tool set
- `search` — the chat panel's lightweight search mode
- `mcp` — this server

Tool handlers run identically on every surface: permission checks through
`permissionService`, audit logging to `ai_usage_logs`, ECO-as-Branch
enforcement in the write paths. Adding a tool to the registry adds it to the
chatbot and the MCP server at once. UI-coupled tools (`offer_navigation`,
`initiate_collaborative_design`) are flagged `chat`/`search` only and never
appear over MCP.

### Endpoint and authentication

```
POST /api/mcp
Authorization: Bearer csc_...
```

- **API keys only.** Keys are minted per user (Settings → API Keys, or
  `POST /api/v1/auth/api-keys`) and sent as a bearer token. Session cookies
  are rejected even when valid: MCP clients are non-browser processes, and
  refusing ambient cookie credentials removes the endpoint's CSRF surface.
- **Scope narrowing.** A key may carry a permission scope (e.g.
  `{ "parts": ["read"] }`). Tool execution intersects the scope with the
  user's role permissions — a scoped key can only narrow access, never widen
  it, exactly as on REST routes.
- **Stateless transport.** Each request builds a fresh server bound to the
  caller's identity; no session affinity is needed for horizontal scaling.
- The endpoint speaks JSON-RPC per the MCP spec, not the REST envelope, so it
  lives at `/api/mcp` — outside the frozen `/api/v1` OpenAPI contract.

### Client configuration

Claude Code (`.mcp.json` or `claude mcp add`):

```json
{
  "mcpServers": {
    "cascadia-plm": {
      "type": "http",
      "url": "https://your-cascadia-host/api/mcp",
      "headers": { "Authorization": "Bearer csc_..." }
    }
  }
}
```

Clients that only speak stdio can bridge with
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote):

```json
{
  "mcpServers": {
    "cascadia-plm": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://your-cascadia-host/api/mcp",
        "--header",
        "Authorization: Bearer csc_..."
      ]
    }
  }
}
```

### Write-tool confirmation flow

Write tools (`create_item`, `update_item`, `create_relationship`,
`transition_item_state`, `create_change_order`, `create_program`) are
two-step: the first call returns `{ requiresConfirmation: true }` with a
human-readable summary; the mutation only happens when the call is repeated
with `"confirmed": true`. The server's instructions tell agents to show the
summary to their user before confirming. ECO-as-Branch rules apply
unchanged — released items in protected designs answer with
`suggestCreateEco` instead of mutating.

---

## `cascadia-dev` — development/administration server

Supports self-hosters standing up, customizing, and operating an instance.
It runs from a repository checkout over stdio with the operator's own shell
credentials (direct database access — the same trust level as the admin
shell it replaces). **It is unauthenticated by design and must never be
exposed over the network.**

```bash
npm run mcp:dev-server
```

Claude Code registration (`.mcp.json` in the checkout):

```json
{
  "mcpServers": {
    "cascadia-dev": {
      "command": "npx",
      "args": ["tsx", "packages/core/src/mcp-dev-server.ts"]
    }
  }
}
```

### Tools

| Tool              | Purpose                                                                                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `instance_status` | Env flag presence (never secret values), licensed packages, DB connectivity, row counts                                      |
| `list_item_types` | Registered item types with labels, tables, lifecycle state, runtime overrides                                                |
| `list_packages`   | Optional licensed packages and enabled state (`CASCADIA_PACKAGES`)                                                           |
| `list_roles`      | Built-in role definitions plus the roles present in the database                                                             |
| `search_docs`     | Full-text search across `docs/**/*.md`, `CLAUDE.md`, `cascadia-feature-list.md`                                              |
| `read_doc`        | Read one doc by repo-relative path (restricted to the doc tree)                                                              |
| `db_push`         | `npm run db:push` (dev/demo schema apply — released installs use `db:migrate`); `force=true` to auto-approve destructive ops |
| `db_seed`         | Run a seed script: `minimal`, `catalog`, `tools`, or `demo`                                                                  |
| `db_reset`        | **Destructive.** Truncate all tables; requires `confirm="RESET"`, optional reseed                                            |

The server starts without `DATABASE_URL` (database imports are lazy), so it
can answer docs/configuration questions while an instance is still being
stood up; `instance_status` reports the missing configuration instead of
failing.

The stdio protocol stream owns stdout, so the entry point sets
`LOG_DESTINATION=stderr`, which `packages/core/src/lib/logging/logger.ts` honors for all
pino output.

Paths — `docs/`, the root markdown files, and the `package.json` scripts the
`db_*` tools run — resolve against the workspace root, which
`packages/core/src/lib/mcp/repo-root.ts` finds by walking up to the manifest
declaring `workspaces`. The entry point loads that root's `.env` before any
tool reads the environment, so `instance_status` reports the same
configuration the database connection actually uses, whatever working
directory the MCP client chose.

---

## Architecture

```
packages/core/src/lib/ai/tools/registry.ts     Canonical PLM tool registry (defs + handlers + surfaces)
packages/core/src/lib/mcp/server-factory.ts    Shared protocol plumbing (tools/list, tools/call, errors)
packages/core/src/lib/mcp/plm-server.ts        cascadia-plm: registry -> MCP tools for one user context
packages/core/src/lib/mcp/dev-server.ts        cascadia-dev: server assembly
packages/core/src/lib/mcp/dev-tools.ts         cascadia-dev: tool implementations
packages/core/src/lib/mcp/repo-root.ts         Workspace root the docs and db_* tools resolve against
packages/core/src/server/routes/mcp.ts         /api/mcp HTTP endpoint (auth + Streamable HTTP transport)
packages/core/src/mcp-dev-server.ts            stdio entry point (npm run mcp:dev-server)
```

Design decisions worth knowing:

- **Protocol split.** The factory maps handler exceptions to MCP _tool_
  errors (`isError: true`) so agents can self-correct, and reserves protocol
  errors for unknown tools and schema-invalid arguments.
- **Schemas travel.** Tool input schemas are the Zod schemas from the
  definitions, converted with zod v4's native `z.toJSONSchema()` — MCP
  clients see the same descriptions, defaults, and constraints the chatbot's
  LLM sees, and arguments are re-validated with the same schema on the way in.
- **Item types auto-register.** `search_items` and `create_item` derive
  their item-type enums from `ITEM_TYPE_DEFINITIONS` at load time, so a new
  item type appears in both tool schemas (chatbot and MCP) with no tool
  changes. `create_item`'s permission check follows the requested type
  through the shared `ITEM_TYPE_RESOURCES` map (creating a Document checks
  `documents:create`, and so on); ChangeOrder is deliberately excluded in
  favor of `create_change_order`, which also sets up the ECO branch.
- **Field enums come from the schemas too.** `requirementType`, `partType`,
  task `priority` and `changeType` reuse the Zod enums exported by the item
  types that validate the write, so a tool cannot advertise a value the
  server rejects. Hand-copied enums did exactly that: `requirementType`
  offered three values the Requirement schema rejects while hiding four it
  accepts, and the failure surfaced as an opaque "Validation failed".
- **Write failures name the field.** Handler exceptions become tool errors,
  so the response text is the agent's only diagnostic. `ValidationError`'s
  `fieldErrors` are folded into that text (`Validation failed: designId:
Design is required`) so a rejected write is as actionable as the factory's
  own argument errors.
- **The chatbot rides the registry.** `createServerTools()` /
  `createSearchTools()` now bind registry entries instead of hand-wiring
  definitions to handlers, so the chatbot and MCP surfaces cannot drift. A
  future step could run the chat loop through an in-process MCP client so the
  protocol layer itself is exercised in-app, but the registry already
  guarantees behavioral parity where it matters (handlers, permissions,
  audit).

### Dev-server tests

`packages/core/src/lib/mcp/dev-tools.test.ts` pins the root resolution — that
`search_docs` finds files and `read_doc` reads one — because a wrong root
fails silently as an empty result set, and pins the traversal guard that keeps
`read_doc` inside the doc tree.

### Security-gate tests

`packages/core/src/server/routes/mcp.test.ts` pins the endpoint invariants: 401 for
missing/invalid/expired credentials, session cookies rejected, UI tools never
listed, scoped keys narrow but never widen access, and unconfirmed write
calls do not mutate.
