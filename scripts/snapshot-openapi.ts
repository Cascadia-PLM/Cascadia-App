// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors
//
// Generate or verify the committed OpenAPI v1 snapshot. The snapshot is the
// frozen contract for v1 of the Cascadia API; any drift surfaces in PR review.
//
// Usage:
//   npm run openapi:snapshot          # writes docs/api/openapi.v1.json
//   npm run openapi:check             # exits non-zero if the file is stale
//   tsx scripts/snapshot-openapi.ts --print | jq '.info'   # debug

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

// Silence the application's pino logger so it doesn't interleave with the
// generated JSON on stdout. Must precede the dynamic import below.
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent'
const { default: app } = await import('../src/server/index')

const SNAPSHOT_PATH = resolve(
  import.meta.dirname,
  '..',
  'docs',
  'api',
  'openapi.v1.json',
)

/**
 * Recursively sort object keys so the serialized snapshot is order-stable
 * across runs (otherwise tiny hash-order changes appear as diff noise).
 */
function sortKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(sortKeys) as never
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key])
    }
    return out as T
  }
  return value
}

async function generate(): Promise<string> {
  const res = await app.fetch(new Request('http://local/openapi.json'))
  if (!res.ok) {
    throw new Error(
      `openapi.json returned ${res.status}: ${await res.text()}`,
    )
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
  const committed = readFileSync(SNAPSHOT_PATH, 'utf8')
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
