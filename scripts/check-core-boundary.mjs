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
 * import resolution will catch `usePackageEnabled(<a quoted module id>)`.
 * (Which is why this file spells no id in quotes — it scans itself.)
 *
 * The same resolver then answers two more questions. One package outward:
 * does any module package import *another* module package without declaring
 * it? See "Cross-module dependency honesty" below. And inward: does the
 * application's own layering hold — commons reaching nothing, the web never
 * reaching the api? See "Application layering" below.
 *
 * This is a stopgap with a known replacement. Phase 2 splits the workspace, at
 * which point CI can build and test `apps/cascadia` with the proprietary
 * packages *deleted from the tree* — which proves the same property by
 * construction rather than by analysis. Until then, this is the gate.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { MODULE_PACKAGES, editionOf, normalize } from './edition-manifest.mjs'

// Both lists derive from the edition manifest so a new module package is
// covered the day its packages/<name>/** pattern lands in PROPRIETARY.
// The old hardcoded copies here had already drifted: they omitted the
// odoo-integration package entirely, so a core import under it — or its
// quoted package id — passed this check silently. (No quoted ids in this
// file: since .mjs is scanned, the checker checks itself.)

/** Entitlement ids that belong to a proprietary package. */
const PROPRIETARY_PACKAGE_IDS = MODULE_PACKAGES

const MODULE_SRC = MODULE_PACKAGES.map((p) => `packages/${p}/src`)

/**
 * The application's own packages, by import name. `@/` inside one of them
 * means that package alone; the others are reached by name — and only the
 * names a package's tsconfig maps are meant to resolve at all.
 */
const APP_PACKAGES = {
  '@cascadia/commons': 'packages/cascadia-commons/src',
  '@cascadia/api': 'packages/cascadia-api/src',
  '@cascadia/web': 'packages/cascadia-web/src',
}
const APP_SRC = Object.values(APP_PACKAGES)

/** Import name of the application package a file belongs to, or null. */
const appPackageOf = (file) =>
  Object.entries(APP_PACKAGES).find(([, src]) =>
    file.startsWith(`${src}/`),
  )?.[0] ?? null

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

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs']

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
    // `@/` is the importing file's own package. Inside an application package
    // that is exactly one root; inside a module package the tsconfigs search
    // the module's own root (a module has no `@/` reach into the application
    // packages — it names them).
    const own = appPackageOf(fromFile)
    const roots = own ? [APP_PACKAGES[own]] : MODULE_SRC
    for (const root of roots) {
      const hit = tryExtensions(join(root, specifier.slice(2)))
      if (hit) return hit
    }
    return null
  } else if (specifier.startsWith('@test/')) {
    return tryExtensions(
      join(APP_PACKAGES['@cascadia/api'], '__tests__', specifier.slice(6)),
    )
  } else if (
    Object.keys(APP_PACKAGES).some((name) => specifier.startsWith(`${name}/`))
  ) {
    const name = Object.keys(APP_PACKAGES).find((n) =>
      specifier.startsWith(`${n}/`),
    )
    return tryExtensions(
      join(APP_PACKAGES[name], specifier.slice(name.length + 1)),
    )
  } else if (specifier.startsWith('@cascadia/')) {
    for (const name of MODULE_PACKAGES) {
      // The root specifier, with no subpath. It resolves to nothing at
      // runtime — no module package declares a '.' export — but a core file
      // still named a module, and the subpath test below reads straight past
      // it: only a trailing slash matched, so this fell through to null and
      // was never classified. Point it at the package manifest, a real file
      // under packages/<name>/ that the edition manifest calls proprietary.
      // The core package needs no equivalent: a core target records nothing.
      if (specifier === `@cascadia/${name}`) {
        return tryExtensions(join('packages', name, 'package.json'))
      }
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

const allFiles = candidateFiles()

for (const file of allFiles) {
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

  // A template literal is the third way to write a string, and the pass knew
  // only two — so a quoted id survived by being written in backticks. It is
  // matched against code lines only: every comment in this repository names an
  // identifier in Markdown backticks, so scanning prose for one would fail
  // three honest sentences and teach the next author to stop naming the module
  // they are explaining. In code a backtick opens a string; in a comment it is
  // punctuation. The single- and double-quoted forms keep scanning everything,
  // because a quoted id reads as code wherever it appears.
  const code = source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join('\n')

  for (const id of PROPRIETARY_PACKAGE_IDS) {
    if (
      source.includes(`'${id}'`) ||
      source.includes(`"${id}"`) ||
      code.includes(`\`${id}\``)
    ) {
      record(file, `names the package id '${id}'`)
    }
  }
}

// ── Alias-root collisions ────────────────────────────────────────────────
//
// The `@/` alias in an app's Vite build resolves the web package first, then
// the module packages, and modules deliberately contribute files in
// application-owned namespaces (server/routes, lib/jobs/definitions, ...).
// That ordering means an application file later created at the same
// relative path silently SHADOWS the module file everywhere it is imported —
// no error, the module's contribution just stops loading. So the same
// relative path may exist under at most one alias root. The three application
// packages count as roots too: they preserve core's layout, and a module file
// at `lib/x.ts` collides with any of them.
//
// Comparison is extension- and index-stripped, because both resolvers try
// the extension candidates: core lib/x.ts shadows module lib/x.tsx too.
//
// The composition-root filenames are the one structural exception: every
// module package has them by convention, and they are only ever imported
// root-pinned as `@cascadia/<pkg>/register.*`, never through `@/`. This
// allowlist stays closed — a new structural filename needs a deliberate
// entry here, which is the point.
const COLLISION_ALLOWLIST = new Set(['register.server', 'register.client'])

const ALIAS_ROOTS = [...APP_SRC, ...MODULE_SRC]
const byRelativePath = new Map()
for (const file of allFiles) {
  const root = ALIAS_ROOTS.find((r) => file.startsWith(`${r}/`))
  if (!root) continue
  let rel = file.slice(root.length + 1)
  const ext = EXTENSIONS.find((e) => rel.endsWith(e))
  if (ext) rel = rel.slice(0, -ext.length)
  if (rel.endsWith('/index')) rel = rel.slice(0, -'/index'.length)
  if (COLLISION_ALLOWLIST.has(rel)) continue
  if (!byRelativePath.has(rel)) byRelativePath.set(rel, new Set())
  byRelativePath.get(rel).add(root)
}
const collisions = [...byRelativePath].filter(([, roots]) => roots.size > 1)

// ── Cross-module dependency honesty ──────────────────────────────────────
//
// A module package may import core. It may import itself. It may import
// another module package **only if it says so in its own package.json.**
//
// This exists because `cad-generation` and `design-engine` imported each other
// at runtime for months while neither declared the other — the `@/` alias
// searches every module root, so an undeclared cross-module import resolves
// and runs, and nothing notices until someone tries to publish, delete, or
// license one of them independently. BND-4 merged those two rather than
// declaring the edge; this pass is what stops the next pair drifting into the
// same state.
//
// A declared edge is fine — it is a fact recorded where npm and a human can
// both see it. What is refused is an *undeclared* one.
const moduleOf = (file) =>
  MODULE_PACKAGES.find((name) => file.startsWith(`packages/${name}/`)) ?? null

/** Module package → the module packages its package.json admits to needing. */
const declaredDeps = new Map(
  MODULE_PACKAGES.map((name) => {
    const manifestPath = `packages/${name}/package.json`
    const manifest = existsSync(manifestPath)
      ? JSON.parse(readFileSync(manifestPath, 'utf8'))
      : {}
    const all = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
    }
    return [
      name,
      new Set(
        MODULE_PACKAGES.filter((other) =>
          Object.hasOwn(all, `@cascadia/${other}`),
        ),
      ),
    ]
  }),
)

/** file → list of undeclared cross-module imports */
const undeclared = new Map()

for (const file of allFiles) {
  const from = moduleOf(file)
  if (!from) continue

  const source = readFileSync(file, 'utf8')
  for (const specifier of specifiersIn(source)) {
    const target = resolveSpecifier(specifier, file)
    if (!target) continue
    const to = moduleOf(target)
    if (!to || to === from) continue
    if (declaredDeps.get(from)?.has(to)) continue

    const existing = undeclared.get(file)
    const detail = `imports ${specifier}  →  ${target}  (${to}, undeclared)`
    if (existing) existing.push(detail)
    else undeclared.set(file, [detail])
  }
}

// ── Application layering ─────────────────────────────────────────────────
//
// Commons imports commons. The web imports web and commons. The api imports
// api and commons. Nothing else — in particular the web never reaches the api,
// which is the property the package split exists to hold: the client bundle
// cannot pull `postgres` in through a type import that happened to sit beside
// a service.
//
// The tsconfigs and the Vite alias plugin already refuse to *resolve* an
// import that crosses the wrong way, so a violation here normally fails
// typecheck and the build first. This pass is what makes it a stated rule
// rather than an accident of which `paths` entries exist: it reads the
// resolved target, so a relative `../../cascadia-api/src/...` is caught the
// same as a named one.
//
// Test files are exempt in one direction only: a web or commons test may use
// the api's database helpers (`@test/...`), because that is where the fixtures
// live. Source files never.
const LAYERS_MAY_REACH = {
  '@cascadia/commons': new Set(['@cascadia/commons']),
  '@cascadia/web': new Set(['@cascadia/web', '@cascadia/commons']),
  '@cascadia/api': new Set(['@cascadia/api', '@cascadia/commons']),
}
const isTestFile = (file) =>
  /\.test\.tsx?$/.test(file) || file.includes('/__tests__/')

/** file → list of imports that cross the layering the wrong way */
const layering = new Map()

for (const file of allFiles) {
  const from = appPackageOf(file)
  if (!from) continue
  const source = readFileSync(file, 'utf8')
  for (const specifier of specifiersIn(source)) {
    const target = resolveSpecifier(specifier, file)
    if (!target) continue
    const to = appPackageOf(target)
    if (!to || LAYERS_MAY_REACH[from].has(to)) continue
    if (isTestFile(file) && target.includes('/__tests__/')) continue
    const existing = layering.get(file)
    const detail = `imports ${specifier}  →  ${target}  (${to})`
    if (existing) existing.push(detail)
    else layering.set(file, [detail])
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

if (collisions.length > 0) {
  console.error(
    `\n✗ ${collisions.length} relative path(s) exist under more than one @/ alias root:\n`,
  )
  for (const [rel, roots] of collisions) {
    console.error(`   ${rel}`)
    for (const root of roots) console.error(`      ${root}/${rel}.*`)
    console.error('')
  }
  console.error(
    'The @/ alias resolves core first, then the modules — whichever file\n' +
      'loses the ordering is silently shadowed everywhere it is imported.\n' +
      'Rename one side (or, for a new structural convention imported only\n' +
      'root-pinned via @cascadia/<pkg>/..., add a deliberate\n' +
      'COLLISION_ALLOWLIST entry in scripts/check-core-boundary.mjs).',
  )
  process.exit(1)
}

if (undeclared.size > 0) {
  console.error(
    `\n✗ ${undeclared.size} file(s) import another module package without declaring it:\n`,
  )
  for (const [file, details] of undeclared) {
    console.error(`   ${file}`)
    for (const d of details) console.error(`      ${d}`)
    console.error('')
  }
  console.error(
    'The @/ alias searches every module root, so an undeclared cross-module\n' +
      'import resolves and runs — and nothing notices until someone tries to\n' +
      'publish, delete, or license one of those packages on its own.\n' +
      'Either add the dependency to the importing package.json (and accept\n' +
      'that the two now ship together), or invert it through a registry.',
  )
  process.exit(1)
}

if (layering.size > 0) {
  console.error(
    `\n✗ ${layering.size} file(s) import across the application layering:\n`,
  )
  for (const [file, details] of layering) {
    console.error(`   ${file}`)
    for (const d of details) console.error(`      ${d}`)
    console.error('')
  }
  console.error(
    'commons reaches only commons; web reaches web and commons; api reaches\n' +
      'api and commons. A type the web needs from a service belongs in\n' +
      '@cascadia/commons — declare it there and re-export it from the service.',
  )
  process.exit(1)
}

if (violations.size === 0) {
  console.log('\n✅ Core does not reach proprietary code, anywhere.')
} else {
  console.log('\n✅ No new boundary violations.')
}
process.exit(0)
