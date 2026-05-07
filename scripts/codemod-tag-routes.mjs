#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// One-shot codemod: in every route module under src/server/routes/, replace
// the `adapt` import with the tagged-factory pattern so all handlers in the
// file are auto-tagged for OpenAPI/Scalar grouping.
//
// Before:
//   import { adapt } from '../adapter'
// After:
//   import { tagged } from '../adapter'
//   const adapt = tagged('Parts')
//
// Idempotent — skips files already migrated.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const ROUTES_DIR = path.join(root, 'src', 'server', 'routes')

// Filename → display tag. Special-cased acronyms get explicit overrides.
const TAG_OVERRIDES = {
  ai: 'AI',
  mbom: 'MBOM',
  sysml: 'SysML',
  'enterprise-search': 'Enterprise Search',
  'design-engine': 'Design Engine',
}

function deriveTag(filename) {
  const base = filename.replace(/\.ts$/, '')
  if (TAG_OVERRIDES[base]) return TAG_OVERRIDES[base]
  return base
    .split('-')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ')
}

const files = readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.ts'))

let changed = 0
for (const file of files) {
  const abs = path.join(ROUTES_DIR, file)
  const src = readFileSync(abs, 'utf8')
  if (src.includes("from '../adapter'") && src.includes('tagged(')) {
    // Already migrated.
    continue
  }
  if (!src.includes("import { adapt } from '../adapter'")) {
    console.warn(`  ${file}: no adapt import — skipping`)
    continue
  }
  const tag = deriveTag(file)
  const replacement = `import { tagged } from '../adapter'\nconst adapt = tagged('${tag}')`
  const out = src.replace(
    /import \{ adapt \} from '\.\.\/adapter'/,
    replacement,
  )
  writeFileSync(abs, out)
  changed++
  console.log(`  ${file}: tagged → '${tag}'`)
}

console.log(`\nMigrated ${changed} of ${files.length} route modules.`)
