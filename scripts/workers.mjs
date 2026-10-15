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
 * *converter* is core; the CAD *generator* and the *FreeCAD runner* are
 * proprietary and their directories are absent from the published tree — so a
 * script naming all of them would fail there with a compose build error about
 * a missing context.
 *
 * Presence on disk is the test rather than a flag, for the same reason the
 * edition itself is resolved by probing for its directory: a directory that
 * is not there cannot be misconfigured into being there.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { config as loadEnv } from 'dotenv'
import { appDir, appTsconfig, resolveApp } from './edition.mjs'

// `.env` is what compose reads too, so the check below sees the same values
// the containers will. A real environment variable still wins.
loadEnv({ path: resolve(import.meta.dirname, '..', '.env'), quiet: true })

const CAD_WORKERS = [
  ['cascadia-workers-cad', 'cad-converter-dev'],
  ['cascadia-workers-cad-generator', 'cad-generator-dev'],
  ['cascadia-workers-freecad-runner', 'freecad-runner-dev'],
]

const services = CAD_WORKERS.filter(([dir]) => existsSync(dir)).map(
  ([, service]) => service,
)

/**
 * Refuse to start containerized workers against a database other than the
 * app's.
 *
 * Compose builds the workers' connection string from POSTGRES_DB (falling back
 * to `cascadia`, docker-compose.yml's default), never from DATABASE_URL — so a
 * `.env` whose DATABASE_URL names some other database starts workers that
 * connect fine, find no job rows, and skip every job while the app's jobs sit
 * queued forever. That happened, and it was found by reading logs. Failing
 * here, before anything starts, names the two values that disagree.
 */
function assertComposeDatabaseMatches() {
  const url = process.env.DATABASE_URL
  if (!url) return
  let appDatabase
  try {
    appDatabase = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''))
  } catch {
    return
  }
  const composeDatabase = process.env.POSTGRES_DB ?? 'cascadia'
  if (!appDatabase || appDatabase === composeDatabase) return
  console.error(
    `DATABASE_URL names the database "${appDatabase}" but the containerized ` +
      `workers would use "${composeDatabase}" (POSTGRES_DB${process.env.POSTGRES_DB ? '' : ', unset, so the compose default'}).\n` +
      `Set POSTGRES_DB=${appDatabase} in .env so the workers see the app's jobs.`,
  )
  process.exit(1)
}

const command = process.argv[2]
const run = (args) =>
  execFileSync('docker', args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })

try {
  switch (command) {
    case 'dev': {
      assertComposeDatabaseMatches()
      run(['compose', 'up', '-d', 'rabbitmq'])
      if (services.length > 0) {
        run(['compose', '--profile', 'cad', 'up', '-d', ...services, '--build'])
      }
      execFileSync(
        'npx',
        [
          'tsx',
          '--tsconfig',
          appTsconfig(),
          `${appDir(resolveApp())}/src/jobs-worker.ts`,
        ],
        {
          stdio: 'inherit',
          shell: process.platform === 'win32',
        },
      )
      break
    }
    // The Node worker lives in the app, because it registers the same modules
    // the server does. Both of these named `src/jobs-worker.ts`, a path the
    // Phase 2 split moved and nothing noticed — they were broken in *this*
    // tree too, not only the published one.
    case 'jobs':
      execFileSync(
        'npx',
        [
          'tsx',
          '--tsconfig',
          appTsconfig(),
          `${appDir(resolveApp())}/src/jobs-worker.ts`,
        ],
        {
          stdio: 'inherit',
          shell: process.platform === 'win32',
        },
      )
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
