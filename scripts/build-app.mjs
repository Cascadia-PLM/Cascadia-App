// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Build one edition end to end: client bundle, API server, jobs worker.
 *
 *   node scripts/build-app.mjs cascadia-enterprise
 *   node scripts/build-app.mjs cascadia
 *
 * Replaces the old `build:server` / `build:jobs-worker` pair, which hardcoded
 * a single entry point back when there was only one app. Output is namespaced
 * per app so building one edition cannot overwrite the other's artifacts.
 */

import * as esbuild from 'esbuild'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { assertBundleParses, cjsInteropBanner } from './build-shared.mjs'
import { resolveApp } from './edition.mjs'

// No argument means "whichever edition this tree is", so `npm run build` works
// in both without naming an app that one of them does not have.
const app = process.argv[2] ?? resolveApp()

const appDir = resolve(process.cwd(), 'apps', app)
if (!existsSync(appDir)) {
  console.error(`No such app: apps/${app}`)
  process.exit(1)
}

const outBase = `.output/${app}`

// Packages that must be loaded from node_modules at runtime
// (native bindings, dynamic requires, or pulled in by admin scripts only).
const external = [
  // Native modules
  'pg-native',
  '@node-rs/argon2',
  'better-sqlite3',
  'sharp',
  // AWS SDK — large, lazy-loaded by vault storage adapters
  '@aws-sdk/*',
  // Dynamic require()s that break ESM bundling
  'dotenv',
  'dotenv/*',
]

async function bundle(entry, outfile) {
  const outDir = dirname(outfile)
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })

  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    outfile,
    banner: { js: cjsInteropBanner },
    external,
    sourcemap: true,
    minify: process.env.NODE_ENV === 'production',
    define: {
      'process.env.NODE_ENV': JSON.stringify(
        process.env.NODE_ENV || 'production',
      ),
    },
    loader: { '.node': 'copy' },
    // esbuild reads `paths` from the app's tsconfig, which is what makes
    // `@/`, `@cascadia/core/` and `@cascadia/enterprise/` resolve here exactly
    // as they do for tsc and Vite.
    tsconfig: `apps/${app}/tsconfig.json`,
    logLevel: 'info',
  })

  await assertBundleParses(outfile)
  console.log(`✅ Built: ${outfile}`)
}

// Client first — it generates routeTree.gen.ts, which the server bundle's
// type-level imports and the app's typecheck both depend on.
console.log(`\n▶ Client bundle (${app})`)
execFileSync(
  'npx',
  ['vite', 'build', '--config', `apps/${app}/vite.config.ts`],
  { stdio: 'inherit', shell: process.platform === 'win32' },
)

console.log(`\n▶ API server (${app})`)
await bundle(`apps/${app}/src/server/prod.ts`, `${outBase}/server/index.mjs`)

console.log(`\n▶ Jobs worker (${app})`)
await bundle(
  `apps/${app}/src/jobs-worker.ts`,
  `${outBase}/server/jobs-worker.mjs`,
)
