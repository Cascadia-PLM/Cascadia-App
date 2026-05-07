#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// One-shot codemod: rewrite '/api/<resource>/...' → '/api/v1/<resource>/...' across
// the frontend, libraries, and tests. Idempotent (skips paths that already include /v1/).

import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')

// Collect candidate files via git ls-files (respects .gitignore).
const tracked = execSync('git ls-files', { cwd: root, encoding: 'utf8' })
  .trim()
  .split('\n')

const SKIP_DIRS = ['src/server/', 'docs/api/']
const SKIP_FILES = new Set([
  'src/lib/api/openapi-helpers.ts',
  'scripts/codemod-api-v1.mjs',
  'scripts/snapshot-openapi.ts',
  'CLAUDE.md',
])

const candidates = tracked.filter((f) => {
  if (!/\.(ts|tsx|md)$/.test(f)) return false
  if (SKIP_FILES.has(f)) return false
  if (SKIP_DIRS.some((d) => f.startsWith(d))) return false
  return true
})

// Match '/api/<not-v>' surrounded by ' " or ` (the only delimiters used for URLs in the
// codebase). Capture the trailing segment so we can preserve it.
const pattern = /(['"`])\/api\/(?!v\d+\/)([a-z][a-z0-9-]*)/g

let totalReplacements = 0
let changedFiles = 0

for (const rel of candidates) {
  const abs = path.join(root, rel)
  let src
  try {
    src = readFileSync(abs, 'utf8')
  } catch {
    continue
  }
  if (!src.includes('/api/')) continue
  let count = 0
  const out = src.replace(pattern, (_, quote, segment) => {
    count++
    return `${quote}/api/v1/${segment}`
  })
  if (count > 0) {
    writeFileSync(abs, out)
    totalReplacements += count
    changedFiles++
    console.log(`  ${rel}: ${count}`)
  }
}

console.log(
  `\nRewrote ${totalReplacements} occurrences across ${changedFiles} files.`,
)
