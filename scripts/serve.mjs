// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Serve the built server for this tree's edition.
 *
 *   node scripts/serve.mjs
 *
 * The build output is per-app (`.output/<app>/server/index.mjs`), so this has
 * to resolve the same app `build-app.mjs` wrote. Hardcoding it pointed the
 * published `npm run serve` at an app that tree does not contain.
 */

import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { resolveApp } from './edition.mjs'

const app = resolveApp()
const entry = `.output/${app}/server/index.mjs`

if (!existsSync(entry)) {
  console.error(`${entry} does not exist — run \`npm run build\` first.`)
  process.exit(1)
}

// The server resolves its static root as `dist/$APP` — the client build is
// per-edition. Without this, `npm run serve` starts a working API in front of
// a 404 for every page.
const child = spawn(process.execPath, [entry], {
  stdio: 'inherit',
  env: { ...process.env, APP: app },
})
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
