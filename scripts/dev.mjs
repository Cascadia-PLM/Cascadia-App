#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

// Launches vite + tsx side-by-side with colored [client]/[api] prefixes.
// Replaces `concurrently` so we control SIGINT handling and stdout flushing
// on Windows, where the default behavior leaves trailing "exited with code N"
// lines after PowerShell has already drawn its next prompt.

import { spawn, spawnSync } from 'node:child_process'
import { resolveApp } from './edition.mjs'

// Which app to run is resolved, never named. The published tree has no
// `cascadia-enterprise`, and a hardcoded path here made `npm run dev` a broken
// script in a fresh clone of the public repository. See scripts/edition.mjs.
const APP = resolveApp()

// `--client` / `--api` run one half, for the npm scripts of the same name.
const only = process.argv.includes('--client')
  ? 'client'
  : process.argv.includes('--api')
    ? 'api'
    : null

const RESET = '\x1b[0m'
const procs = [
  {
    name: 'client',
    color: '\x1b[34m',
    cmd: 'vite',
    args: ['--port', '3000', '--config', `apps/${APP}/vite.config.ts`],
  },
  // `watch` so edits to server/lib files auto-reload the API (matches Vite HMR
  // on the client side); without it the API serves stale code until restarted.
  {
    name: 'api',
    color: '\x1b[32m',
    cmd: 'tsx',
    args: ['watch', `apps/${APP}/src/server/dev.ts`],
  },
].filter((p) => only === null || p.name === only)

const labelWidth = Math.max(...procs.map((p) => p.name.length))

function prefixStream(stream, out, color, name) {
  const label = `${color}[${name.padEnd(labelWidth)}]${RESET} `
  let buf = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    buf += chunk
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) out.write(label + line + '\n')
  })
  stream.on('end', () => {
    if (buf.length > 0) out.write(label + buf + '\n')
  })
}

const children = procs.map((p) => {
  const child = spawn(p.cmd, p.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  })
  prefixStream(child.stdout, process.stdout, p.color, p.name)
  prefixStream(child.stderr, process.stderr, p.color, p.name)
  return { ...p, child }
})

// `shell: true` wraps each command in cmd.exe on Windows, and a signal sent to
// that wrapper does not reach the node process underneath: it survives as an
// orphan still holding port 3000 or 3001. Kill the whole tree by pid instead.
function killTree(child) {
  if (child.exitCode !== null || child.pid === undefined) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
    })
  } else {
    child.kill('SIGINT')
  }
}

let shuttingDown = false
function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  for (const { child } of children) killTree(child)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// If either half dies, take the other down with it. A lone survivor is how
// strays accumulate: the API exits (EADDRINUSE, a crash, a bad edit) while its
// Vite keeps running, so the next `npm run dev` finds 3000 taken — and lands
// its Vite on 3001 instead, in front of the API.
for (const { child } of children) child.on('exit', shutdown)

Promise.all(
  children.map(
    ({ child }) =>
      new Promise((resolve) => {
        if (child.exitCode !== null) resolve()
        else child.on('exit', resolve)
      }),
  ),
).then(() => {
  // Flush stdio before yielding back to the shell so PowerShell doesn't
  // race with any in-flight output.
  const done = () => process.exit(0)
  let pending = 2
  const tick = () => {
    if (--pending === 0) done()
  }
  if (!process.stdout.write('')) process.stdout.once('drain', tick)
  else tick()
  if (!process.stderr.write('')) process.stderr.once('drain', tick)
  else tick()
})
