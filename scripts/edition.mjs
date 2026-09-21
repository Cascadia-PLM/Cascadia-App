// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Which edition this tree contains.
 *
 * Root scripts that need a composed schema or a registered module set have to
 * name an app, and naming `cascadia-app-enterprise` outright breaks the core-only
 * tree — which is exactly what `npm run core:standalone` builds, and how this
 * was found. Resolving at runtime lets one script serve both editions:
 * enterprise when it is present, community otherwise.
 *
 * `CASCADIA_APP` overrides, for running community tooling against a full
 * checkout.
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const APPS = ['cascadia-app-enterprise', 'cascadia-app']

/** The app directory name (a top-level `cascadia-app*` workspace) this tree should use. */
export function resolveApp(repoRoot = process.cwd()) {
  const override = process.env.CASCADIA_APP
  if (override) {
    if (!existsSync(resolve(repoRoot, override))) {
      throw new Error(`CASCADIA_APP names a missing app: ${override}`)
    }
    return override
  }
  for (const app of APPS) {
    if (existsSync(resolve(repoRoot, app))) return app
  }
  throw new Error(
    'No cascadia-app* directory at the repo root — cannot resolve an edition.',
  )
}
