// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Edition manifest — what is a module, and what (if anything) is proprietary.
 *
 * Two separate questions, answered in one place:
 *
 * 1. **Which workspaces are modules?** A module is a top-level `cascadia-*`
 *    npm workspace that is neither one of the four application packages nor an
 *    app (`cascadia-app*`). Modules register into core's extension points from
 *    a composition root and are never imported by core — that is the
 *    extension boundary `scripts/check-core-boundary.mjs` and
 *    `eslint.config.js` enforce. A module's licence does not change that:
 *    `cascadia-design-engine` is AGPL, ships in this tree, and core still
 *    never reaches into it.
 *
 * 2. **Which paths are proprietary?** A top-level `cascadia-*` workspace whose
 *    manifest declares `UNLICENSED`, plus one stale-checkout backstop. The
 *    classification is discovered, not written. Everything in this repository
 *    is AGPL, so nothing here is proprietary — which this file can assert
 *    about the tree it is in (`--assert-community`, below), and CI does. The
 *    machinery stays because a private fork could still add a licensed module
 *    on top, and because the assertion is what catches proprietary code
 *    copied in by mistake.
 *
 * Consumed by `scripts/license-headers.mjs` (stamps each file with its SPDX
 * header), `scripts/check-core-boundary.mjs` and `eslint.config.js` (what
 * core must not import), and whatever else needs to know what the tree
 * contains.
 *
 * Default-core is deliberate: a new file is AGPL unless it lives under a
 * proprietary root.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dirname, '..')

/**
 * Every workspace is a top-level `cascadia-<id>/` directory whose npm name is
 * `@cascadia/<id>`: `cascadia-api` is `@cascadia/api`, a module package
 * `cascadia-design-engine` is `@cascadia/design-engine`. These two helpers
 * are the only place that convention is spelled out.
 */
export const WORKSPACE_PREFIX = 'cascadia-'
export const workspaceDir = (id) => `${WORKSPACE_PREFIX}${id}`
export const workspaceId = (dir) =>
  dir.startsWith(WORKSPACE_PREFIX) ? dir.slice(WORKSPACE_PREFIX.length) : null

/** The `license` field of a top-level workspace's manifest, or undefined. */
function licenseOf(dir) {
  const manifest = join(ROOT, dir, 'package.json')
  if (!existsSync(manifest)) return undefined
  return JSON.parse(readFileSync(manifest, 'utf8')).license
}

/** Every top-level `cascadia-*` directory that is an npm workspace. */
const workspaces = readdirSync(ROOT)
  .filter(
    (dir) =>
      dir.startsWith(WORKSPACE_PREFIX) &&
      existsSync(join(ROOT, dir, 'package.json')),
  )
  .sort()

/** Top-level `cascadia-*` workspaces whose manifest declares UNLICENSED. */
const unlicensedWorkspaces = workspaces.filter(
  (dir) => licenseOf(dir) === 'UNLICENSED',
)

/**
 * Paths that are proprietary. Empty in this repository by construction.
 *
 * A pattern ending in `/**` matches that directory and everything under it.
 * Anything else is an exact repo-relative path. Deliberately not a glob
 * library: directory prefixes cover every case, and they stay greppable.
 */
export const PROPRIETARY = [
  // ── a licensed module package ────────────────────────────────────────────
  // Structural, not per-file: a licensed module lives in its own workspace,
  // and the workspace says so in its manifest.
  ...unlicensedWorkspaces.map((dir) => `${dir}/**`),

  // ── generated output that must never publish ─────────────────────────────
  // Each app's drizzle config emits migration SQL into the app's own
  // `drizzle/`. This covers the *old* shared location, so a stale checkout or
  // a hand-run drizzle-kit that recreates a repo-root `drizzle/` produces
  // something `--assert-community` refuses rather than an unreviewed journal.
  'drizzle/**',
]

/**
 * The application's own packages, by id — never a module, whatever the
 * manifest says. The app workspaces (`cascadia-app*`) are excluded by the
 * `app` prefix test below rather than listed.
 */
const APP_PACKAGES = new Set(['api', 'web', 'commons', 'workers-job'])

/**
 * The module packages, by id: every npm workspace that is not an application
 * package or an app. The Python workers (`cascadia-workers-*` without an npm
 * manifest) are not workspaces, so they never appear. One derivation,
 * consumed by the boundary check and eslint.config.js, so adding a module
 * package is the whole registration: nothing else to remember.
 */
export const MODULE_PACKAGES = workspaces
  .map(workspaceId)
  .filter(
    (id) =>
      id !== null &&
      !APP_PACKAGES.has(id) &&
      !id.startsWith('app') &&
      !id.startsWith('workers-'),
  )

/**
 * The subset of `MODULE_PACKAGES` that is licensed separately — its manifest
 * says `UNLICENSED`. Empty here. Their ids are what `boundary:check` refuses
 * to see quoted in core, because a licensed module is gated by package id.
 */
export const PROPRIETARY_MODULE_PACKAGES = MODULE_PACKAGES.filter((id) =>
  unlicensedWorkspaces.includes(workspaceDir(id)),
)

export const HEADERS = {
  core: [
    '// SPDX-License-Identifier: AGPL-3.0-or-later',
    '// Copyright (c) 2026 Cascadia PLM LLC',
  ],
  proprietary: [
    '// SPDX-License-Identifier: LicenseRef-Cascadia-Proprietary',
    '// Copyright (c) 2026 Cascadia PLM LLC. All rights reserved.',
  ],
}

/** Normalize to forward slashes so Windows paths compare equal to patterns. */
export function normalize(p) {
  return p.replace(/\\/g, '/')
}

/** `'core' | 'proprietary'` for a repo-relative path. */
export function editionOf(path) {
  const p = normalize(path)
  for (const pattern of PROPRIETARY) {
    if (pattern.endsWith('/**')) {
      const prefix = pattern.slice(0, -2)
      if (p.startsWith(prefix)) return 'proprietary'
    } else if (p === pattern) {
      return 'proprietary'
    }
  }
  return 'core'
}

/**
 * `node scripts/edition-manifest.mjs --assert-community`
 *
 * Asserts the tree is the community edition: no workspace declares UNLICENSED,
 * no PROPRIETARY pattern matches a path that exists, and no tracked file
 * carries the proprietary SPDX identifier. Discovery is what makes this
 * necessary — a proprietary package that leaked into the public tree would
 * classify itself proprietary and pass `license:check` with its headers
 * intact, so the check that there is nothing to classify has to be its own.
 * CI runs it only where the repository is the public one.
 */
function assertCommunity() {
  const problems = []

  for (const dir of unlicensedWorkspaces) {
    problems.push(`${dir}/package.json declares an UNLICENSED workspace`)
  }
  for (const pattern of PROPRIETARY) {
    const path = pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern
    if (unlicensedWorkspaces.includes(path)) continue
    if (existsSync(join(ROOT, path))) {
      problems.push(
        `${path} exists, and the manifest classifies it proprietary`,
      )
    }
  }

  // The identifier itself, anywhere in a text file. This file is the one
  // place it may appear: it is the header `license-headers.mjs` stamps.
  const identifier = HEADERS.proprietary[0].split(': ')[1]
  const tracked = execFileSync('git', ['ls-files'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    cwd: ROOT,
  })
    .split('\n')
    .filter(Boolean)
    .map(normalize)
  for (const file of tracked) {
    if (file === 'scripts/edition-manifest.mjs') continue
    if (
      !/\.(ts|tsx|js|mjs|cjs|py|md|yml|yaml|json|sql|sh|toml|txt)$/i.test(file)
    )
      continue
    // Tracked but gone from disk — a deletion not yet committed — is not a
    // header; skip rather than crash on a tree mid-change.
    if (!existsSync(join(ROOT, file))) continue
    if (readFileSync(join(ROOT, file), 'utf8').includes(identifier)) {
      problems.push(`${file} carries the proprietary SPDX identifier`)
    }
  }

  if (problems.length === 0) {
    console.log(
      '✅ Community edition: no proprietary workspace, path or header in this tree.',
    )
    return
  }
  console.error(
    `✗ This tree is not the community edition — ${problems.length} problem(s):\n`,
  )
  for (const problem of problems) console.error(`   ${problem}`)
  console.error(
    '\nThe public repository holds nothing proprietary. Whatever reached it is\n' +
      'removed, not classified.',
  )
  process.exit(1)
}

if (
  import.meta.url === pathToFileURL(process.argv[1] ?? '').href &&
  process.argv.includes('--assert-community')
) {
  assertCommunity()
}
