#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

// Run a TypeScript entry with tsx under the composed app's tsconfig:
//
//   node scripts/app-tsx.mjs scripts/truncate-all.ts [args…]
//
// For the scripts that load an app's composition roots and so reach module
// code, which imports its own files through `@/`. The root tsconfig cannot
// resolve those — see `appTsconfig()` in scripts/edition.mjs — and tsx reads
// the tsconfig nearest the working directory unless told otherwise, so the
// npm script or compose command that starts such an entry starts it here.
// In a tree that composes only the community app this is the community
// tsconfig, which maps `@/` exactly as the root one does.

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appTsconfig } from './edition.mjs'

const [entry, ...args] = process.argv.slice(2)
if (!entry) {
  console.error('Usage: node scripts/app-tsx.mjs <entry.ts> [args…]')
  process.exit(2)
}

/**
 * Where tsx is. A checkout has it in node_modules, which node_modules/.bin
 * puts on the PATH under `npm run` but not under a bare `node scripts/…`, so
 * that case resolves the package's CLI by path and runs it with this same
 * node. The app image installs no devDependencies and keeps tsx on the PATH
 * instead (the Dockerfiles' admin-tools stage), so that case falls back to
 * the PATH lookup every compose command relies on. Never npx: npm exec does
 * not search the PATH for a package and would download a second tsx into
 * its cache — on an image, as a user with no cache to write.
 */
function tsxCommand() {
  try {
    const cli = fileURLToPath(import.meta.resolve('tsx/cli'))
    return { cmd: process.execPath, args: [cli], shell: false }
  } catch {
    return { cmd: 'tsx', args: [], shell: process.platform === 'win32' }
  }
}

// Absolute, because the path outlives this process. tsx hands `--tsconfig` to
// everything the entry spawns as TSX_TSCONFIG_PATH, and a child that runs
// tsx again resolves it against its own working directory: boot-migrate runs
// drizzle-kit from the app directory, which loads its config through tsx and
// looked for `cascadia-app/cascadia-app/tsconfig.json`, so every compose boot
// died at the migration step.
const tsx = tsxCommand()
const result = spawnSync(
  tsx.cmd,
  [...tsx.args, '--tsconfig', resolve(appTsconfig()), entry, ...args],
  { stdio: 'inherit', shell: tsx.shell },
)
if (result.error) {
  console.error(`Could not start tsx (${tsx.cmd}): ${result.error.message}`)
}
process.exit(result.status ?? 1)
