// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Which build the browser is actually running.
 *
 * Distinct from `APP_VERSION` in `@/lib/version`, and deliberately so.
 * `APP_VERSION` is the product version out of package.json — it answers "which
 * Cascadia release is this?" and moves only when upstream cuts one. It cannot
 * answer "which build of *our* tree is deployed?", because a fork's own commits
 * never touch package.json: every build between two upstream releases reports
 * the same 0.5.0.
 *
 * These constants are baked in by Vite at build time from `VITE_BUILD_*`, which
 * the image build passes through from `git describe` on the host. They are
 * client-only on purpose: `import.meta.env` is a Vite construct, and
 * `@/lib/version` is imported by the API server too, where esbuild would leave
 * `import.meta.env` undefined and the property read would throw at boot.
 *
 * `.git` is excluded from the Docker build context (see `.dockerignore`), so
 * the values genuinely cannot be derived inside the build — passing them in is
 * the mechanism, not a shortcut.
 */

/** Nearest tag, e.g. `v0.5.0`. `dev` outside a release build. */
export const BUILD_TAG: string = import.meta.env.VITE_BUILD_TAG || 'dev'

/** Short commit, e.g. `578399f`. Empty outside a release build. */
export const BUILD_SHA: string = import.meta.env.VITE_BUILD_SHA || ''

/** Set when the tree had uncommitted changes at build time. */
export const BUILD_DIRTY: boolean = import.meta.env.VITE_BUILD_DIRTY === 'true'

/**
 * One line for display: `v0.5.0 · 578399f`, with a `+` when the build came
 * from a dirty tree. Falls back to the tag alone when there is no commit to
 * show, which is what a plain `npm run dev` gets.
 */
export const BUILD_LABEL: string = [
  BUILD_TAG,
  BUILD_SHA && `${BUILD_SHA}${BUILD_DIRTY ? '+' : ''}`,
]
  .filter(Boolean)
  .join(' · ')
