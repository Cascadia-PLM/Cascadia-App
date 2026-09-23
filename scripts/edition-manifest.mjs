// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Edition manifest — the single source of truth for core vs proprietary.
 *
 * This is the AGPL edition, so the answer is always core. The file exists
 * because `scripts/license-headers.mjs` and `scripts/check-core-boundary.mjs`
 * import it and both run in CI; keeping the interface means those scripts are
 * the same file here as upstream.
 *
 * `PROPRIETARY` being empty is not a stub. It is the invariant this repository
 * exists to hold: everything here is published under AGPL-3.0-or-later, and
 * `boundary:check` asserting that nothing reaches proprietary code is a
 * statement that stays true rather than a check waiting to be filled in.
 */

/**
 * Paths belonging to a proprietary module.
 *
 * Empty in the AGPL edition. A pattern ending in `/**` would match that
 * directory and everything under it; anything else is an exact repo-relative
 * path.
 */
export const PROPRIETARY = []

/**
 * Every workspace is a top-level `cascadia-<id>/` directory whose npm name is
 * `@cascadia/<id>`: `cascadia-api` is `@cascadia/api`, a module package
 * `cascadia-design-engine` would be `@cascadia/design-engine`. These two
 * helpers are the only place that convention is spelled out.
 */
export const WORKSPACE_PREFIX = 'cascadia-'
export const workspaceDir = (id) => `${WORKSPACE_PREFIX}${id}`
export const workspaceId = (dir) =>
  dir.startsWith(WORKSPACE_PREFIX) ? dir.slice(WORKSPACE_PREFIX.length) : null

/**
 * The application's own packages, by id — never a module, whatever the
 * manifest says. The app workspaces (`cascadia-app*`) are excluded by the
 * `app` prefix test below rather than listed, since an edition adds its own.
 */
const APP_PACKAGES = new Set(['api', 'web', 'commons', 'workers-job'])

/**
 * The proprietary module packages, by id, derived from PROPRIETARY's
 * `cascadia-<id>/**` patterns. Derived rather than written as `[]` so this
 * says the same thing as the private manifest does: the list follows from the
 * classification. PROPRIETARY is empty here, so this is too — `boundary:check`
 * imports it and runs in CI.
 */
export const MODULE_PACKAGES = [
  ...new Set(
    PROPRIETARY.map((p) => workspaceId(/^([^/]+)\//.exec(p)?.[1] ?? '')).filter(
      (id) =>
        id !== null &&
        id !== '' &&
        !APP_PACKAGES.has(id) &&
        !id.startsWith('app'),
    ),
  ),
]

export const HEADERS = {
  core: [
    '// SPDX-License-Identifier: AGPL-3.0-or-later',
    '// Copyright (c) 2026 Cascadia PLM LLC',
  ],
}

/** Normalize to forward slashes so Windows paths compare equal to patterns. */
export function normalize(p) {
  return p.replace(/\\/g, '/')
}

/** `'core'` for every path in this edition. */
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
