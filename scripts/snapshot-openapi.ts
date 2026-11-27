// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

//
// Generate or verify the committed OpenAPI v1 snapshot,
// `docs/api/openapi.v1.json` — the frozen v1 contract, including the routes
// the app's modules contribute.
//
// Usage:
//   npm run openapi:snapshot                    # write the snapshot
//   npm run openapi:check                       # fail on a stale snapshot
//   node scripts/app-tsx.mjs scripts/snapshot-openapi.ts --print | jq '.info'
//   node scripts/app-tsx.mjs scripts/snapshot-openapi.ts --out <path> [--check]
//
// Runs under the app's tsconfig (scripts/app-tsx.mjs), which is what resolves
// `@/` inside the module packages the app composes.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { APP_DIR } from './app.mjs'

/** The value after `name`, or undefined. Bind, then guard — see CLAUDE.md. */
function flagValue(name: string): string | undefined {
  const at = process.argv.indexOf(name)
  return at === -1 ? undefined : process.argv[at + 1]
}

const args = new Set(process.argv.slice(2))
const REPO = resolve(import.meta.dirname, '..')

// Silence the application's pino logger so it doesn't interleave with the
// generated JSON on stdout. Must precede the dynamic import below.
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent'

// Attach the app's modules before the server is imported, so their contributed
// routes appear in the spec. The order is load-bearing — route contributions
// mount while the routers are being built. See the note in `src/server/dev.ts`.
const { registerModules } = (await import(
  `../${APP_DIR}/src/modules.server`
)) as { registerModules: () => void }
registerModules()

const { default: app } = await import('@cascadia/api/server')

const outPath = flagValue('--out')
const SNAPSHOT_PATH = outPath
  ? resolve(process.cwd(), outPath)
  : resolve(REPO, 'docs', 'api', 'openapi.v1.json')

/**
 * Recursively sort object keys so the serialized snapshot is order-stable
 * across runs (otherwise tiny hash-order changes appear as diff noise).
 */
function sortKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(sortKeys) as never
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key])
    }
    return out as T
  }
  return value
}

async function generate(): Promise<string> {
  const res = await app.fetch(new Request('http://local/openapi.json'))
  if (!res.ok) {
    throw new Error(`openapi.json returned ${res.status}: ${await res.text()}`)
  }
  const spec = await res.json()
  return JSON.stringify(sortKeys(spec), null, 2) + '\n'
}

const generated = await generate()

if (args.has('--print')) {
  process.stdout.write(generated)
  process.exit(0)
}

if (args.has('--check')) {
  if (!existsSync(SNAPSHOT_PATH)) {
    console.error(
      `OpenAPI snapshot missing at ${SNAPSHOT_PATH}. Run \`npm run openapi:snapshot\` and commit the result.`,
    )
    process.exit(1)
  }
  // Normalize CRLF: on Windows clones autocrlf smudges the snapshot to CRLF
  // on checkout, which must not read as contract drift.
  const committed = readFileSync(SNAPSHOT_PATH, 'utf8').replace(/\r\n/g, '\n')
  if (committed !== generated) {
    console.error(
      `OpenAPI snapshot is out of date. Run \`npm run openapi:snapshot\` and commit ${SNAPSHOT_PATH}.`,
    )
    process.exit(1)
  }
  console.log(`OpenAPI snapshot is up to date: ${SNAPSHOT_PATH}`)
  process.exit(0)
}

mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true })
writeFileSync(SNAPSHOT_PATH, generated)
console.log(`Wrote ${SNAPSHOT_PATH}`)
// Importing the server app leaves the event loop alive (db pool); exit
// explicitly like --check does or this hangs after a successful write.
process.exit(0)
