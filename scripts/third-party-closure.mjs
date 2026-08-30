// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * What we actually redistribute, from the lockfile.
 *
 * One definition, because two would drift and the drift would be silent: the
 * licence gate would clear a set of packages while the notice generator
 * attributed a different set, and the gap between them is exactly the set of
 * packages we ship with neither permission nor credit. `edition-manifest.mjs`
 * is the same idea for core-vs-proprietary — the classification has one home.
 *
 * "Distributed" is the lockfile's `dev` flag inverted. It is the right line
 * because it is the line npm itself draws: `docker/app.Dockerfile` and
 * `workers/node/Dockerfile` both build their runtime layer with
 * `npm ci --omit=dev`, so this set is, package for package, what lands in the
 * images. Dev-only packages are build and test tooling that is never conveyed,
 * and neither licence obligations nor attribution follow them.
 *
 * Workspace roots are excluded: `@cascadia/*` is first-party, owned by
 * `edition-manifest.mjs` and stamped by `license-headers.mjs`, and crediting
 * ourselves in a third-party notice would be noise.
 *
 * Reads the lockfile rather than walking `node_modules`, so callers that only
 * need the *set* (the gate) work on a bare checkout with nothing installed.
 * Callers that need licence *text* (the notice generator) need the tree too,
 * and say so themselves.
 */

import { readFileSync } from 'node:fs'

/** Strip nesting: `node_modules/a/node_modules/b` is package `b`. */
function packageName(lockPath) {
  const marker = 'node_modules/'
  return lockPath.slice(lockPath.lastIndexOf(marker) + marker.length)
}

/**
 * Every third-party package in the distributed closure, sorted by name then
 * version so callers get a stable order without sorting again.
 *
 * A package can legitimately appear twice at different versions (`pako` is in
 * the tree at 1.0.11 and 2.2.0); both are shipped, so both are returned. The
 * `path` is where the tree puts it, which is what a caller reading licence
 * files needs.
 */
export function distributedPackages(lockfile = 'package-lock.json') {
  const lock = JSON.parse(readFileSync(lockfile, 'utf8'))
  const out = []

  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (!path.startsWith('node_modules/')) continue
    if (entry.link === true) continue
    if (entry.dev === true) continue

    const name = packageName(path)
    if (name.startsWith('@cascadia/')) continue

    out.push({
      name,
      version: entry.version ?? null,
      path,
      license: typeof entry.license === 'string' ? entry.license : null,
    })
  }

  return out.sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      (a.version ?? '').localeCompare(b.version ?? ''),
  )
}

/** How many packages the lockfile marks dev-only — reported, never judged. */
export function devOnlyCount(lockfile = 'package-lock.json') {
  const lock = JSON.parse(readFileSync(lockfile, 'utf8'))
  return Object.entries(lock.packages ?? {}).filter(
    ([path, entry]) => path.startsWith('node_modules/') && entry.dev === true,
  ).length
}
