// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Which edition this tree contains.
 *
 * Root scripts that need a composed schema or a registered module set have to
 * name an app, and naming `cascadia-enterprise` outright breaks the core-only
 * tree — which is exactly what `npm run core:standalone` builds, and how this
 * was found. Resolving at runtime lets one script serve both editions:
 * enterprise when it is present, community otherwise.
 *
 * `CASCADIA_APP` overrides, for running community tooling against a full
 * checkout.
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const APPS = ['cascadia-enterprise', 'cascadia']

/** The app directory name this tree should use. */
export function resolveApp(repoRoot = process.cwd()) {
  const override = process.env.CASCADIA_APP
  if (override) {
    if (!existsSync(resolve(repoRoot, 'apps', override))) {
      throw new Error(`CASCADIA_APP names a missing app: apps/${override}`)
    }
    return override
  }
  for (const app of APPS) {
    if (existsSync(resolve(repoRoot, 'apps', app))) return app
  }
  throw new Error('No app found under apps/ — cannot resolve an edition.')
}
