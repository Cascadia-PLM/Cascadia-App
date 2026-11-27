// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Stamp every source file with the AGPL SPDX header, and check that every
 * workspace declares the AGPL.
 *
 *   node scripts/license-headers.mjs           # apply
 *   node scripts/license-headers.mjs --check   # verify, exit 1 on drift
 *
 * Every source file gets `HEADER` from `scripts/workspaces.mjs`. `--check` is
 * the CI gate that keeps it that way, mirroring the `openapi:check` idiom; it
 * also refuses a workspace whose `package.json` declares any licence other
 * than `AGPL-3.0-or-later`, which is what catches code copied in from
 * somewhere else with its old licence still attached.
 *
 * Markdown is not stamped: an HTML comment at the top of a doc renders badly
 * and buys nothing.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import {
  HEADER,
  LICENSE,
  WORKSPACES,
  licenseOf,
  normalize,
} from './workspaces.mjs'

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
let scanned = 0

for (const file of candidateFiles()) {
  const prefix = COMMENT[extensionOf(file)]
  if (!prefix) continue
  scanned++

  const content = readFileSync(file, 'utf8')
  const next = restamp(content, HEADER, prefix)
  if (next === null) continue

  if (CHECK) {
    drift.push(file)
  } else {
    writeFileSync(file, next)
    stamped++
  }
}

console.log(`Scanned ${scanned} source file(s).`)

// A workspace manifest's licence is a declaration npm and license scanners
// read, so it has to agree with the headers. Not fixable by stamping — a
// different licence is a decision, never drift.
const wrongLicence = WORKSPACES.filter((dir) => licenseOf(dir) !== LICENSE)
if (wrongLicence.length > 0) {
  console.error(
    `\n✗ ${wrongLicence.length} workspace(s) do not declare ${LICENSE}:\n`,
  )
  for (const dir of wrongLicence) {
    console.error(`  ${dir}/package.json  (license: ${licenseOf(dir)})`)
  }
  process.exit(1)
}

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
  console.log(`✅ Every source file and workspace is ${LICENSE}.`)
} else {
  console.log(`✅ Stamped ${stamped} file(s).`)
}
