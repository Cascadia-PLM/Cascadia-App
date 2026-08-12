// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Start, stop, or tail the containerized workers present in this tree.
 *
 *   node scripts/workers.mjs dev    # RabbitMQ + CAD workers + the Node worker
 *   node scripts/workers.mjs stop
 *   node scripts/workers.mjs logs
 *
 * The set of workers is a property of the edition, not a constant. The CAD
 * *converter* is core; the CAD *generator* is proprietary and its directory is
 * absent from the published tree — so a script naming both would fail there
 * with a compose build error about a missing context.
 *
 * Presence on disk is the test rather than a flag, for the same reason
 * `core:standalone` deletes the packages instead of unimporting them: a
 * directory that is not there cannot be misconfigured into being there.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolveApp } from './edition.mjs'

const CAD_WORKERS = [
  ['workers/cad-converter', 'cad-converter-dev'],
  ['workers/cad-generator', 'cad-generator-dev'],
]

const services = CAD_WORKERS.filter(([dir]) => existsSync(dir)).map(
  ([, service]) => service,
)

const command = process.argv[2]
const run = (args) =>
  execFileSync('docker', args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })

try {
  switch (command) {
    case 'dev': {
      run(['compose', 'up', '-d', 'rabbitmq'])
      if (services.length > 0) {
        run(['compose', '--profile', 'cad', 'up', '-d', ...services, '--build'])
      }
      execFileSync('npx', ['tsx', `apps/${resolveApp()}/src/jobs-worker.ts`], {
        stdio: 'inherit',
        shell: process.platform === 'win32',
      })
      break
    }
    // The Node worker lives in the app, because it registers the same modules
    // the server does. Both of these named `src/jobs-worker.ts`, a path the
    // Phase 2 split moved and nothing noticed — they were broken in *this*
    // tree too, not only the published one.
    case 'jobs':
      execFileSync('npx', ['tsx', `apps/${resolveApp()}/src/jobs-worker.ts`], {
        stdio: 'inherit',
        shell: process.platform === 'win32',
      })
      break
    case 'jobs:built': {
      const entry = `.output/${resolveApp()}/server/jobs-worker.mjs`
      if (!existsSync(entry)) {
        console.error(`${entry} does not exist — run \`npm run build\` first.`)
        process.exit(1)
      }
      execFileSync(process.execPath, [entry], { stdio: 'inherit' })
      break
    }
    case 'stop':
      if (services.length > 0) {
        run(['compose', '--profile', 'cad', 'stop', ...services])
      }
      break
    case 'logs':
      if (services.length === 0) {
        console.error('No containerized CAD workers in this tree.')
        process.exit(1)
      }
      run(['compose', '--profile', 'cad', 'logs', '-f', ...services])
      break
    default:
      console.error(
        'usage: node scripts/workers.mjs <dev|jobs|jobs:built|stop|logs>',
      )
      process.exit(2)
  }
} catch (error) {
  process.exit(error.status ?? 1)
}
