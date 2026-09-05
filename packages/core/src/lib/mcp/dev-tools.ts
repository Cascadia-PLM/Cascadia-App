// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Dev/admin MCP tools.
 *
 * Tooling for self-hosters standing up, customizing, and operating a
 * Cascadia instance: instance introspection, configuration reference
 * (docs search/read), and database lifecycle commands (push/seed/reset).
 *
 * These tools run with the process's own credentials — direct database
 * access, no PLM user context — which is exactly the trust level of the
 * admin shell they replace. The dev server is therefore stdio-only and
 * must never be exposed over the network. End-use PLM tools live in
 * `./plm-server.ts` behind API-key auth instead.
 *
 * Database-touching tools import the db module lazily so the server can
 * start (and answer docs/config questions) before DATABASE_URL exists.
 */

import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { REPO_ROOT } from './repo-root'
import type { McpToolSpec } from './server-factory'

const execAsync = promisify(exec)

/** Root-level docs also exposed alongside the docs/ tree. */
const ROOT_DOCS = ['CLAUDE.md', 'README.md', 'cascadia-feature-list.md']

const MAX_DOC_BYTES = 512 * 1024
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000

/** Tail of combined output, keeping results bounded for the model. */
function tail(text: string, limit = 6000): string {
  return text.length > limit ? `…${text.slice(-limit)}` : text
}

async function runCommand(command: string): Promise<{
  command: string
  success: boolean
  output: string
}> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: REPO_ROOT,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    })
    return { command, success: true, output: tail(`${stdout}\n${stderr}`) }
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message?: string }
    return {
      command,
      success: false,
      output: tail(
        `${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message ?? ''}`.trim(),
      ),
    }
  }
}

/** Recursively list markdown files under docs/, plus the root docs. */
async function listDocFiles(): Promise<Array<string>> {
  const results: Array<string> = []

  for (const rootDoc of ROOT_DOCS) {
    try {
      await stat(path.join(REPO_ROOT, rootDoc))
      results.push(rootDoc)
    } catch {
      // Optional root doc not present in this checkout.
    }
  }

  async function walk(relDir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(path.join(REPO_ROOT, relDir), {
        withFileTypes: true,
      })
    } catch {
      return
    }
    for (const entry of entries) {
      const rel = path.posix.join(relDir, entry.name)
      if (entry.isDirectory()) {
        await walk(rel)
      } else if (entry.name.endsWith('.md')) {
        results.push(rel)
      }
    }
  }

  await walk('docs')
  return results
}

/** Validate a doc path from the model and resolve it inside the repo. */
function resolveDocPath(relPath: string): string {
  const normalized = path.posix.normalize(relPath.replaceAll('\\', '/'))
  const allowed =
    ROOT_DOCS.includes(normalized) ||
    (normalized.startsWith('docs/') && normalized.endsWith('.md'))
  if (!allowed || normalized.includes('..')) {
    throw new Error(
      `Path must be a markdown file under docs/ or one of: ${ROOT_DOCS.join(', ')}`,
    )
  }
  const resolved = path.resolve(REPO_ROOT, normalized)
  if (!resolved.startsWith(REPO_ROOT + path.sep)) {
    throw new Error('Path escapes the repository root')
  }
  return resolved
}

// ────────────────────────────────────────────────────────────────────────
// Tool implementations
// ────────────────────────────────────────────────────────────────────────

async function instanceStatus(): Promise<Record<string, unknown>> {
  const environment = {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    databaseUrlSet: !!process.env.DATABASE_URL,
    rabbitmqUrlSet: !!process.env.RABBITMQ_URL,
    cascadiaPackages: process.env.CASCADIA_PACKAGES ?? '(unset)',
    anthropicKeySet: !!process.env.ANTHROPIC_API_KEY,
    openaiKeySet: !!process.env.OPENAI_API_KEY,
    vaultRootSet: !!process.env.VAULT_ROOT,
  }

  const { PackageRegistry } = await import('@/lib/packages/registry')
  const packages = PackageRegistry.list().map((p) => ({
    id: p.id,
    name: p.name,
    enabled: p.enabled,
  }))

  let database: Record<string, unknown>
  try {
    const [{ db }, schema, { count }] = await Promise.all([
      import('@/lib/db'),
      import('@/lib/db/schema'),
      import('drizzle-orm'),
    ])
    const [userRows, itemRows, programRows, designRows] = await Promise.all([
      db.select({ value: count() }).from(schema.users),
      db.select({ value: count() }).from(schema.items),
      db.select({ value: count() }).from(schema.programs),
      db.select({ value: count() }).from(schema.designs),
    ])
    const users = userRows[0]?.value ?? 0
    const items = itemRows[0]?.value ?? 0
    const programs = programRows[0]?.value ?? 0
    const designs = designRows[0]?.value ?? 0
    database = {
      connected: true,
      counts: { users, items, programs, designs },
      seeded: users > 0,
    }
  } catch (error) {
    database = {
      connected: false,
      error: error instanceof Error ? error.message : String(error),
      hint: 'Check DATABASE_URL, then run `npm run db:push` and `npm run db:seed`.',
    }
  }

  return { environment, packages, database }
}

async function listItemTypes(): Promise<Record<string, unknown>> {
  await import('@/lib/items/registerItemTypes.server')
  const { ItemTypeRegistry } = await import('@/lib/items/registry')

  // Runtime (admin-configured) overrides live in the database; code
  // definitions alone still answer "what types exist" when it's down.
  let runtimeConfigLoaded = true
  try {
    await ItemTypeRegistry.initialize()
  } catch {
    runtimeConfigLoaded = false
  }

  const types = ItemTypeRegistry.getAllTypes().map((t) => ({
    name: t.name,
    label: t.label,
    pluralLabel: t.pluralLabel,
    table: t.table,
    lifecycleDefinitionId: t.lifecycleDefinitionId ?? null,
    relationshipCount: t.relationships.length,
  }))

  return { types, total: types.length, runtimeConfigLoaded }
}

async function listRoles(): Promise<Record<string, unknown>> {
  const { ROLE_DEFINITIONS } = await import('@/lib/auth/permissions')
  const builtIn = Object.values(ROLE_DEFINITIONS).map((role) => ({
    name: role.name,
    description: role.description,
    permissions: role.permissions,
  }))

  try {
    const [{ db }, { roles }] = await Promise.all([
      import('@/lib/db'),
      import('@/lib/db/schema/users'),
    ])
    const dbRoles = await db.select().from(roles)
    return {
      builtIn,
      database: dbRoles.map((r) => ({
        name: r.name,
        description: r.description,
        permissions: r.permissions,
      })),
    }
  } catch (error) {
    return {
      builtIn,
      database: null,
      databaseError: error instanceof Error ? error.message : String(error),
    }
  }
}

async function searchDocs(input: {
  query: string
  limit: number
}): Promise<Record<string, unknown>> {
  const files = await listDocFiles()
  const needle = input.query.toLowerCase()
  const matches: Array<{ path: string; line: number; text: string }> = []

  for (const file of files) {
    if (matches.length >= input.limit) break
    let content: string
    try {
      content = await readFile(path.join(REPO_ROOT, file), 'utf8')
    } catch {
      continue
    }
    const lines = content.split('\n')
    let perFile = 0
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line !== undefined && line.toLowerCase().includes(needle)) {
        matches.push({ path: file, line: i + 1, text: line.trim() })
        perFile++
        if (perFile >= 5 || matches.length >= input.limit) break
      }
    }
  }

  return { matches, filesSearched: files.length }
}

async function readDoc(input: {
  path: string
}): Promise<Record<string, unknown>> {
  const resolved = resolveDocPath(input.path)
  const info = await stat(resolved)
  if (info.size > MAX_DOC_BYTES) {
    throw new Error(`Document exceeds ${MAX_DOC_BYTES} bytes`)
  }
  const content = await readFile(resolved, 'utf8')
  return { path: input.path, content }
}

// ────────────────────────────────────────────────────────────────────────
// Tool specs
// ────────────────────────────────────────────────────────────────────────

export function createDevToolSpecs(): Array<McpToolSpec> {
  return [
    {
      name: 'instance_status',
      description: `Report the health and configuration of this Cascadia instance:
environment flags (which settings are present — values of secrets are never returned),
licensed packages, database connectivity, row counts, and whether the database is seeded.
Start here when diagnosing a broken or freshly installed instance.`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
      execute: () => instanceStatus(),
    },
    {
      name: 'list_item_types',
      description: `List every registered PLM item type with its label, backing table,
default lifecycle state, and relationship count. Includes admin-configured runtime
overrides when the database is reachable. Use before customizing or adding item types.`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
      execute: () => listItemTypes(),
    },
    {
      name: 'list_packages',
      description: `List the optional, separately licensed Cascadia packages and whether
each is enabled on this instance (via the CASCADIA_PACKAGES environment variable).`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
      execute: async () => {
        const { PackageRegistry } = await import('@/lib/packages/registry')
        return { packages: PackageRegistry.list() }
      },
    },
    {
      name: 'list_roles',
      description: `List the built-in role definitions (name, description, resource
permissions) and, when the database is reachable, the roles actually present in it.
Use when planning access control or debugging permission denials.`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
      execute: () => listRoles(),
    },
    {
      name: 'search_docs',
      description: `Full-text search across the in-repo documentation (docs/**/*.md,
CLAUDE.md, cascadia-feature-list.md). Returns matching lines with file paths and line
numbers — follow up with read_doc for full context. The docs cover architecture,
service patterns, deployment/orchestration, configuration variables, and feature guides.`,
      inputSchema: z.object({
        query: z
          .string()
          .min(2)
          .describe('Text to search for (case-insensitive substring)'),
        limit: z
          .number()
          .min(1)
          .max(50)
          .default(20)
          .describe('Maximum number of matching lines to return'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      execute: (input) => searchDocs(input as { query: string; limit: number }),
    },
    {
      name: 'read_doc',
      description: `Read one documentation file by repo-relative path (e.g.
"docs/development/adding-item-types.md" or "CLAUDE.md"). Use search_docs to find
the right file first. Only markdown under docs/ and the root docs are readable.`,
      inputSchema: z.object({
        path: z
          .string()
          .describe('Repo-relative markdown path under docs/, or a root doc'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      execute: (input) => readDoc(input as { path: string }),
    },
    {
      name: 'db_push',
      description: `Push the Drizzle schema to the configured database (npm run db:push).
This is the pre-1.0 migration path used in dev, CI, and compose. Without force, the
command fails rather than apply destructive changes; set force=true to auto-approve
(may drop columns/data — review the output first).`,
      inputSchema: z.object({
        force: z
          .boolean()
          .default(false)
          .describe('Auto-approve destructive schema changes'),
      }),
      annotations: { destructiveHint: true, openWorldHint: false },
      // Through the npm script, never bare `npx drizzle-kit`: drizzle-kit
      // resolves its schema and `.env` from its own working directory, and
      // `scripts/drizzle.mjs` is what runs it from the edition's app dir with
      // the root `.env` loaded. Called directly from the repo root it fails
      // with "No schema files found".
      execute: (input) =>
        runCommand(
          (input as { force: boolean }).force
            ? 'npm run db:push -- --force'
            : 'npm run db:push',
        ),
    },
    {
      name: 'db_seed',
      description: `Run a database seed script. Kinds: "minimal" (admin user, roles,
standard library — the normal first seed), "catalog" (generic component
catalog: fasteners, raw stock), "tools" (standard tool library), "demo"
(full TDJ-25 robot-arm dataset; requires \`npm run demo:fetch\` to have been run).
Seeds are additive — reset first when reseeding to avoid unique-constraint conflicts.`,
      inputSchema: z.object({
        kind: z
          .enum(['minimal', 'catalog', 'tools', 'demo'])
          .default('minimal')
          .describe('Which seed script to run'),
      }),
      annotations: { openWorldHint: false },
      execute: (input) => {
        const scripts = {
          minimal: 'npm run db:seed',
          catalog: 'npm run db:seed:catalog',
          tools: 'npm run db:seed:tools',
          demo: 'npm run seed:demo',
        } as const
        return runCommand(
          scripts[(input as { kind: keyof typeof scripts }).kind],
        )
      },
    },
    {
      name: 'db_reset',
      description: `DESTRUCTIVE: truncate every table in the database (schema is kept,
all data is deleted). Requires confirm="RESET" — always ask the operator before
calling this. Set reseed=true to run the minimal seed immediately afterwards.`,
      inputSchema: z.object({
        confirm: z
          .literal('RESET')
          .describe('Must be exactly "RESET" to proceed'),
        reseed: z
          .boolean()
          .default(false)
          .describe('Run the minimal seed after truncating'),
      }),
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      execute: (input) =>
        runCommand(
          (input as { reseed: boolean }).reseed
            ? 'npm run db:reset:seed'
            : 'npm run db:reset',
        ),
    },
  ]
}
