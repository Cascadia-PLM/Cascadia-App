#!/usr/bin/env tsx
/**
 * E2E Test Setup Script
 *
 * Prepares the database and seeds test data for E2E tests.
 * This script:
 * 1. Resets the database (truncates all tables)
 * 2. Runs minimal seed (admin user, roles, lifecycles)
 * 3. Starts a temporary dev server
 * 4. Runs API-based seeding to create demo data
 * 5. Shuts down the temporary server
 *
 * Usage:
 *   npm run e2e:setup
 *   # or directly:
 *   tsx scripts/e2e-setup.ts
 */

import { execSync, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

const API_URL = process.env.API_URL || 'http://localhost:3000'
const VERBOSE = process.env.VERBOSE === 'true'

function log(message: string): void {
  console.log(`[e2e-setup] ${message}`)
}

function logVerbose(message: string): void {
  if (VERBOSE) {
    console.log(`[e2e-setup] ${message}`)
  }
}

function runCommand(command: string, description: string): void {
  log(`${description}...`)
  try {
    execSync(command, {
      stdio: VERBOSE ? 'inherit' : 'pipe',
      cwd: process.cwd(),
    })
    log(`${description} complete`)
  } catch (error) {
    console.error(`Failed: ${description}`)
    throw error
  }
}

async function waitForServer(
  url: string,
  maxAttempts: number = 30,
  intervalMs: number = 1000,
): Promise<void> {
  log(`Waiting for server at ${url}...`)

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url, { method: 'GET' })
      if (response.ok || response.status === 302 || response.status === 301) {
        log(`Server ready (attempt ${attempt}/${maxAttempts})`)
        return
      }
    } catch {
      // Server not ready yet
    }

    logVerbose(`Server not ready, attempt ${attempt}/${maxAttempts}`)
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  throw new Error(
    `Server at ${url} did not become ready after ${maxAttempts} attempts`,
  )
}

function startDevServer(): ChildProcess {
  log('Starting dev server...')

  const server = spawn('npm', ['run', 'dev'], {
    stdio: VERBOSE ? 'inherit' : 'pipe',
    shell: true,
    cwd: process.cwd(),
    detached: false,
  })

  server.on('error', (error) => {
    console.error('Failed to start dev server:', error)
  })

  return server
}

function stopServer(server: ChildProcess): void {
  log('Stopping dev server...')
  try {
    // On Windows, we need to kill the process tree
    if (process.platform === 'win32') {
      execSync(`taskkill /pid ${server.pid} /T /F`, { stdio: 'pipe' })
    } else {
      server.kill('SIGTERM')
    }
  } catch {
    // Process may have already exited
  }
}

async function main(): Promise<void> {
  console.log('')
  console.log(
    '╔══════════════════════════════════════════════════════════════════════╗',
  )
  console.log(
    '║                    E2E TEST SETUP                                    ║',
  )
  console.log(
    '╚══════════════════════════════════════════════════════════════════════╝',
  )
  console.log('')

  let server: ChildProcess | null = null

  try {
    // Step 1: Reset database and run minimal seed
    await runCommand(
      'npm run db:reset:seed',
      'Step 1/2: Reset database and minimal seed',
    )

    // Step 2: Start dev server
    server = await startDevServer()

    // Wait for server to be ready
    await waitForServer(API_URL)

    log('')
    log('Step 2/2: Setup complete!')
    log('')
    console.log(
      '╔══════════════════════════════════════════════════════════════════════╗',
    )
    console.log(
      '║                    ✅ E2E SETUP COMPLETE                             ║',
    )
    console.log(
      '║                                                                      ║',
    )
    console.log(
      '║  You can now run:                                                    ║',
    )
    console.log(
      '║    npm run test:e2e                                                  ║',
    )
    console.log(
      '║                                                                      ║',
    )
    console.log(
      '║  Or keep the server running and run tests manually:                  ║',
    )
    console.log(
      '║    npx playwright test                                               ║',
    )
    console.log(
      '╚══════════════════════════════════════════════════════════════════════╝',
    )
  } catch (error) {
    console.error('')
    console.error(
      '╔══════════════════════════════════════════════════════════════════════╗',
    )
    console.error(
      '║                    ❌ E2E SETUP FAILED                               ║',
    )
    console.error(
      '╚══════════════════════════════════════════════════════════════════════╝',
    )
    console.error('')
    console.error(error)
    process.exit(1)
  } finally {
    if (server) {
      stopServer(server)
    }
  }
}

main()
