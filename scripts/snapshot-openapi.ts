// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

//
// Generate or verify the committed OpenAPI v1 snapshot. The snapshot is the
// frozen contract for v1 of the Cascadia API; any drift surfaces in PR review.
//
// Usage:
//   npm run openapi:snapshot          # writes docs/api/openapi.v1.json
//   npm run openapi:check             # fails on a stale snapshot
//   tsx scripts/snapshot-openapi.ts --print | jq '.info'   # debug
//
// One committed snapshot, describing whichever edition this tree builds. This
// file ships to the published repository, where it means exactly the same
// thing — so it must not reference the publishing machinery. The check that
// the *derived* community contract matches a real community build lives in
// `publish/check-derived-openapi.mjs`, which is dropped from the artefact.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { resolveApp } from './edition.mjs'

// Silence the application's pino logger so it doesn't interleave with the
// generated JSON on stdout. Must precede the dynamic import below.
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent'

// Attach licensed modules before the app is imported, so their contributed
// routes appear in the spec. The order is load-bearing — route contributions
// mount while the routers are being built. See the note in `src/server/dev.ts`.
//
// This makes the snapshot edition-specific by construction: it describes what
// *this* build serves. The published core repo, having no modules to register,
// generates a spec without them, which is exactly right.
//
// The app is resolved at runtime rather than named: naming the enterprise one
// outright would break a core-only tree, where this must still describe the
// community edition. `--app <name>` overrides it, so this tree can also build
// the community spec for `--check-derived`. A flag rather than an env var:
// setting one cross-platform in an npm script needs a dependency.

/** The value after `name`, or undefined. Bind, then guard — see CLAUDE.md. */
function flagValue(name: string): string | undefined {
  const at = process.argv.indexOf(name)
  return at === -1 ? undefined : process.argv[at + 1]
}

const edition = flagValue('--app') ?? resolveApp()
const { registerModules } = (await import(
  `../apps/${edition}/src/modules.server`
)) as { registerModules: () => void }
registerModules()

const { default: app } = await import('../packages/core/src/server/index')

// `--out <path>` overrides the destination, for generating the community
// snapshot from this tree. Default is the canonical path, which is also what
// the published tree checks against.
const outPath = flagValue('--out')
const SNAPSHOT_PATH = outPath
  ? resolve(process.cwd(), outPath)
  : resolve(import.meta.dirname, '..', 'docs', 'api', 'openapi.v1.json')

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

const args = new Set(process.argv.slice(2))

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
  console.log('OpenAPI snapshot is up to date.')
  process.exit(0)
}

mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true })
writeFileSync(SNAPSHOT_PATH, generated)
console.log(`Wrote ${SNAPSHOT_PATH}`)
// Importing the server app leaves the event loop alive (db pool); exit
// explicitly like --check does or this hangs after a successful write.
process.exit(0)
