// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Serve the built server.
 *
 *   node scripts/serve.mjs
 *
 * Runs what `npm run build` wrote to `.output/cascadia/server/index.mjs`.
 */

import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { APP } from './app.mjs'

const entry = `.output/${APP}/server/index.mjs`

if (!existsSync(entry)) {
  console.error(`${entry} does not exist — run \`npm run build\` first.`)
  process.exit(1)
}

const child = spawn(process.execPath, [entry], { stdio: 'inherit' })
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
