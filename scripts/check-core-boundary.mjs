// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Assert the invariant: **core never reaches proprietary code.**
 *
 *   npm run boundary:check
 *
 * Two greps have already lied about this. After seams 1-3 the plan recorded
 * `advanced-auditing` as fully seamed while `files.ts` still reached it through
 * `await import('@/lib/advanced-auditing/...')`; seam 5 hid a coupling behind a
 * component path rather than a lib path. Three reference forms have each been
 * missed exactly once — dynamic `import()`, component paths, and a package id
 * passed as a bare string.
 *
 * So this does not match patterns. It **resolves** every import specifier in
 * every core file to a real path and classifies that path through
 * `edition-manifest.mjs`. A component path and a lib path resolve alike; a
 * dynamic import and a static one are both specifiers. Renaming a directory
 * cannot quietly defeat it, because there is no pattern to fall out of date.
 *
 * String-literal package ids get a second, separate pass, since no amount of
 * import resolution will catch `usePackageEnabled('advanced-auditing')`.
 *
 * This is a stopgap with a known replacement. Phase 2 splits the workspace, at
 * which point CI can build and test `apps/cascadia` with the proprietary
 * packages *deleted from the tree* — which proves the same property by
 * construction rather than by analysis. Until then, this is the gate.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { editionOf, normalize } from './edition-manifest.mjs'

/** Entitlement ids that belong to a proprietary package. */
const PROPRIETARY_PACKAGE_IDS = ['advanced-auditing']

/** The module packages, in the order `@/` searches them after core. */
const MODULE_PACKAGES = ['advanced-auditing', 'design-engine', 'cad-generation']
const MODULE_SRC = MODULE_PACKAGES.map((p) => `packages/${p}/src`)

/**
 * Entry points, which are allowed to import a composition root.
 *
 * Since Phase 2 the app entry points live in `apps/`, and the enterprise app is
 * classified proprietary in its entirety — so they are no longer core files and
 * need no exemption. What remains is root-level tooling that operates on one
 * edition's composition.
 */
const ENTRY_POINTS = [
  // Edition tooling: assembles or describes a specific edition, so naming its
  // composition root is the job rather than a leak.
  'scripts/snapshot-openapi.ts',
  'scripts/truncate-all.ts',
]

/**
 * The ratchet: core files known to still reach a module, and what will fix it.
 *
 * Modelled on the lint-warning ratchet in `CLAUDE.md` — **this list may only
 * ever shrink.** A violation in a file listed here is reported and tolerated; a
 * violation anywhere else fails. Clearing a file's last violation also fails,
 * with instructions to delete the entry, so the list cannot rot into a
 * permanent amnesty.
 *
 * Every entry names an open item from Phase 1 of
 * `docs/architecture/loadable-modules-architecture.md`.
 */
const KNOWN_PENDING = new Map([
  // Empty as of 2026-08-10, when Phase 1 closed. Core reaches nothing
  // proprietary. An entry here is now a regression with a plan attached, not a
  // backlog — and the stale-entry check means one cannot be left behind after
  // the work that justified it lands.
])

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx']

function candidateFiles() {
  const out = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  return out
    .split('\n')
    .filter(Boolean)
    .map(normalize)
    .filter((f) => EXTENSIONS.some((e) => f.endsWith(e)))
}

/**
 * Every module specifier in `source`.
 *
 * Covers static imports, side-effect imports, `export ... from`, dynamic
 * `import()`, and `require()` — the forms that have actually appeared here.
 */
function specifiersIn(source) {
  const found = []
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    let match
    while ((match = pattern.exec(source)) !== null) found.push(match[1])
  }
  return found
}

/** First existing file for a base path, trying each extension. */
function tryExtensions(base) {
  const b = normalize(base)
  const candidates = [
    b,
    ...EXTENSIONS.map((e) => b + e),
    ...EXTENSIONS.map((e) => `${b}/index${e}`),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate) && !candidate.endsWith('/')) {
      return normalize(candidate)
    }
  }
  return null // unresolvable (a .css, a generated file, a type-only alias)
}

/** Resolve a specifier to a repo-relative path, or null if it is a package. */
function resolveSpecifier(specifier, fromFile) {
  let base
  if (specifier.startsWith('@/')) {
    // Mirrors the app tsconfigs: core first, then the module packages.
    for (const root of ['packages/core/src', ...MODULE_SRC]) {
      const hit = tryExtensions(join(root, specifier.slice(2)))
      if (hit) return hit
    }
    return null
  } else if (specifier.startsWith('@cascadia/core/')) {
    return tryExtensions(
      join('packages/core/src', specifier.slice('@cascadia/core/'.length)),
    )
  } else if (specifier.startsWith('@cascadia/')) {
    for (const name of MODULE_PACKAGES) {
      const prefix = `@cascadia/${name}/`
      if (specifier.startsWith(prefix)) {
        return tryExtensions(
          join('packages', name, 'src', specifier.slice(prefix.length)),
        )
      }
    }
    return null
  } else if (specifier.startsWith('.')) {
    base = normalize(resolve(dirname(fromFile), specifier)).slice(
      normalize(process.cwd()).length + 1,
    )
  } else {
    return null // bare specifier — node_modules, not ours
  }

  return tryExtensions(base)
}

/** file → list of human-readable violations */
const violations = new Map()
let coreFilesScanned = 0

function record(file, detail) {
  const existing = violations.get(file)
  if (existing) existing.push(detail)
  else violations.set(file, [detail])
}

for (const file of candidateFiles()) {
  if (editionOf(file) !== 'core') continue
  if (ENTRY_POINTS.includes(file)) continue
  coreFilesScanned++

  const source = readFileSync(file, 'utf8')

  for (const specifier of specifiersIn(source)) {
    const target = resolveSpecifier(specifier, file)
    if (target && editionOf(target) === 'proprietary') {
      record(file, `imports ${specifier}  →  ${target}`)
    }
  }

  for (const id of PROPRIETARY_PACKAGE_IDS) {
    if (source.includes(`'${id}'`) || source.includes(`"${id}"`)) {
      record(file, `names the package id '${id}'`)
    }
  }
}

const fresh = [...violations].filter(([file]) => !KNOWN_PENDING.has(file))
const pending = [...violations].filter(([file]) => KNOWN_PENDING.has(file))
const stale = [...KNOWN_PENDING.keys()].filter((file) => !violations.has(file))

console.log(`Checked ${coreFilesScanned} core files.`)

if (pending.length > 0) {
  console.log(`\n${pending.length} file(s) pending, per the Phase 1 checklist:`)
  for (const [file] of pending) {
    console.log(`   ${file} — ${KNOWN_PENDING.get(file)}`)
  }
}

if (fresh.length > 0) {
  console.error(
    `\n✗ ${fresh.length} core file(s) newly reach proprietary code:\n`,
  )
  for (const [file, details] of fresh) {
    console.error(`   ${file}`)
    for (const d of details) console.error(`      ${d}`)
    console.error('')
  }
  console.error(
    'Core must not reach a module. Invert the dependency through a registry —\n' +
      'see docs/architecture/loadable-modules-architecture.md, "Phase 1 — Seams".',
  )
  process.exit(1)
}

if (stale.length > 0) {
  console.error(
    `\n✗ ${stale.length} entr${stale.length === 1 ? 'y is' : 'ies are'} no longer needed in KNOWN_PENDING:\n`,
  )
  for (const file of stale) console.error(`   ${file}`)
  console.error(
    '\nThis file is clean now. Delete its entry from KNOWN_PENDING in\n' +
      'scripts/check-core-boundary.mjs — the list only ever shrinks.',
  )
  process.exit(1)
}

if (violations.size === 0) {
  console.log('\n✅ Core does not reach proprietary code, anywhere.')
} else {
  console.log('\n✅ No new boundary violations.')
}
process.exit(0)
