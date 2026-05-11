#!/usr/bin/env node
// Launches vite + tsx side-by-side with colored [client]/[api] prefixes.
// Replaces `concurrently` so we control SIGINT handling and stdout flushing
// on Windows, where the default behavior leaves trailing "exited with code N"
// lines after PowerShell has already drawn its next prompt.

import { spawn } from 'node:child_process'

const RESET = '\x1b[0m'
const procs = [
  { name: 'client', color: '\x1b[34m', cmd: 'vite', args: ['--port', '3000'] },
  { name: 'api', color: '\x1b[32m', cmd: 'tsx', args: ['src/server/dev.ts'] },
]

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

let shuttingDown = false
function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  for (const { child } of children) {
    if (child.exitCode === null) child.kill('SIGINT')
  }
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

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
