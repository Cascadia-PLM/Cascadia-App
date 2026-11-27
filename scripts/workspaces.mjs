// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The workspaces this repository holds, and which of them are modules.
 *
 * Every workspace is a top-level `cascadia-<id>/` directory whose npm name is
 * `@cascadia/<id>`: `cascadia-api` is `@cascadia/api`, the module package
 * `cascadia-design-engine` is `@cascadia/design-engine`. The helpers below are
 * the only place that convention is spelled out.
 *
 * A **module** is any workspace that is neither one of the four application
 * packages nor the app (`cascadia-app`). Modules register into core's
 * extension points from the app's composition root and are never imported by
 * core — the extension boundary that `scripts/check-core-boundary.mjs` and
 * `eslint.config.js` enforce. The list is discovered, not written, so a new
 * module package is covered the day it exists.
 *
 * Everything in the repository is AGPL-3.0-or-later. `scripts/license-headers.mjs`
 * stamps `HEADER` on every source file and checks every workspace manifest
 * declares `LICENSE`.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

export const WORKSPACE_PREFIX = 'cascadia-'
export const workspaceDir = (id) => `${WORKSPACE_PREFIX}${id}`
export const workspaceId = (dir) =>
  dir.startsWith(WORKSPACE_PREFIX) ? dir.slice(WORKSPACE_PREFIX.length) : null

/** Every top-level `cascadia-*` directory that is an npm workspace. */
export const WORKSPACES = readdirSync(ROOT)
  .filter(
    (dir) =>
      dir.startsWith(WORKSPACE_PREFIX) &&
      existsSync(join(ROOT, dir, 'package.json')),
  )
  .sort()

/** The application's own packages, by id — never a module. */
export const APP_PACKAGES = new Set(['api', 'web', 'commons', 'workers-job'])

/**
 * The module packages, by id: every workspace that is not an application
 * package or the app. The Python workers (`cascadia-workers-*` without an npm
 * manifest) are not workspaces, so they never appear.
 */
export const MODULE_PACKAGES = WORKSPACES.map(workspaceId).filter(
  (id) =>
    id !== null &&
    !APP_PACKAGES.has(id) &&
    !id.startsWith('app') &&
    !id.startsWith('workers-'),
)

/** The licence every workspace manifest declares. */
export const LICENSE = 'AGPL-3.0-or-later'

/** The SPDX header every source file carries, in `//` comment form. */
export const HEADER = [
  `// SPDX-License-Identifier: ${LICENSE}`,
  '// Copyright (c) 2026 Cascadia PLM LLC',
]

/** The `license` field of a workspace's manifest, or undefined. */
export function licenseOf(dir) {
  return JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8'))
    .license
}

/** Normalize to forward slashes so Windows paths compare equal to patterns. */
export function normalize(p) {
  return p.replace(/\\/g, '/')
}
