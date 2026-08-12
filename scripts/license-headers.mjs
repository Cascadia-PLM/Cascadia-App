// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Stamp every source file with the SPDX header its edition requires.
 *
 *   node scripts/license-headers.mjs           # apply
 *   node scripts/license-headers.mjs --check   # verify, exit 1 on drift
 *
 * Every file gets `AGPL-3.0-or-later`, per `scripts/edition-manifest.mjs`.
 *
 * Markdown is classified by the manifest but not stamped: an HTML comment at
 * the top of a doc renders badly and buys nothing. Phase 3 reads the manifest
 * directly for those.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { HEADERS, editionOf, normalize } from './edition-manifest.mjs'

const CHECK = process.argv.includes('--check')

/** Comment prefix per extension. Extensions absent here are not stamped. */
const COMMENT = {
  '.ts': '//',
  '.tsx': '//',
  '.js': '//',
  '.mjs': '//',
  '.cjs': '//',
  '.py': '#',
}

function extensionOf(path) {
  const i = path.lastIndexOf('.')
  return i === -1 ? '' : path.slice(i)
}

/**
 * Every file git would keep: tracked, plus untracked ones that are not ignored.
 *
 * `--others --exclude-standard` is what makes this useful before a commit. With
 * tracked files alone a brand-new file is invisible here, so `--check` passes
 * locally and only fails in CI once the file is committed — which is exactly
 * when the feedback is least useful. Ignored paths stay out, so node_modules
 * and build output are excluded by construction.
 */
function candidateFiles() {
  const out = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  return out.split('\n').filter(Boolean).map(normalize)
}

/**
 * Return `content` with the correct header, or null if it is already correct.
 *
 * Replaces an existing SPDX block (and the Copyright lines trailing it) rather
 * than stacking a second one, so the script is idempotent and safe to re-run.
 */
function restamp(content, header, prefix) {
  const want = header.map((line) =>
    prefix === '//' ? line : line.replace(/^\/\//, prefix),
  )

  const lines = content.split('\n')
  let at = 0

  // Preserve a shebang — it must stay on line 1 to remain executable.
  if (lines[0]?.startsWith('#!')) at = 1

  // Drop an existing header block: one SPDX line plus any Copyright lines
  // directly beneath it. Anchoring on SPDX avoids eating an unrelated
  // `// Copyright` comment that happens to sit at the top of a file.
  let end = at
  if (lines[at]?.startsWith(`${prefix} SPDX-License-Identifier:`)) {
    end = at + 1
    while (lines[end]?.startsWith(`${prefix} Copyright`)) end++
  }

  const existing = lines.slice(at, end)
  if (
    existing.length === want.length &&
    existing.every((l, i) => l === want[i])
  ) {
    return null
  }

  const rest = lines.slice(end)
  // Exactly one blank line between header and body, unless the file is empty.
  while (rest[0] === '') rest.shift()
  const body = rest.length > 0 ? ['', ...rest] : rest

  return [...lines.slice(0, at), ...want, ...body].join('\n')
}

const drift = []
let stamped = 0
let core = 0
let proprietary = 0

for (const file of candidateFiles()) {
  const prefix = COMMENT[extensionOf(file)]
  if (!prefix) continue

  const edition = editionOf(file)
  if (edition === 'core') core++
  else proprietary++

  const content = readFileSync(file, 'utf8')
  const next = restamp(content, HEADERS[edition], prefix)
  if (next === null) continue

  if (CHECK) {
    drift.push(`${file}  (expected ${edition})`)
  } else {
    writeFileSync(file, next)
    stamped++
  }
}

console.log(`Classified ${core} core, ${proprietary} proprietary.`)

if (CHECK) {
  if (drift.length > 0) {
    console.error(
      `\n✗ ${drift.length} file(s) carry the wrong license header:\n`,
    )
    for (const line of drift.slice(0, 40)) console.error(`  ${line}`)
    if (drift.length > 40) console.error(`  … and ${drift.length - 40} more`)
    console.error('\nRun: npm run license:fix')
    process.exit(1)
  }
  console.log('✅ All license headers match the edition manifest.')
} else {
  console.log(`✅ Stamped ${stamped} file(s).`)
}
