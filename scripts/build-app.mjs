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
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { assertBundleParses, cjsInteropBanner } from './build-shared.mjs'
import { resolveApp } from './edition.mjs'
import { render } from './generate-third-party-notices.mjs'

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

/**
 * Fail the build if the client bundle shipped Tailwind's preflight and no
 * utilities.
 *
 * Tailwind v4 detects sources automatically, rooted at the Vite root. The
 * Phase 2 split moved that root to `apps/<app>/` while every component stayed
 * in `packages/`, so detection quietly found nothing: ~19 KB of resets and
 * theme variables, not one `.bg-*` rule, in **both** editions. Everything
 * worked — routing, auth, the API — and the application rendered as unstyled
 * HTML. `packages/core/src/styles.css` now declares its sources explicitly.
 *
 * A missing stylesheet is loud. A stylesheet that builds, loads, and contains
 * no utilities is silent, which is why this asserts on content rather than
 * existence. Found by someone standing the artefact up and looking at it.
 */
function assertStyled(edition) {
  const dir = resolve(`dist/${edition}/assets`)
  const sheets = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith('.css'))
    : []
  const css = sheets.map((f) => readFileSync(resolve(dir, f), 'utf8')).join('')
  const utilities = new Set(
    css.match(/\.(?:bg|text|flex|grid|p|m)-[a-z0-9-]+/g),
  )
  if (utilities.size < 50) {
    console.error(
      `\n✗ The ${edition} client bundle contains ${utilities.size} utility ` +
        `class(es) across ${sheets.length} stylesheet(s).\n` +
        '  Tailwind found no source files to scan — the app will render ' +
        'unstyled.\n  Check the `@source` directives in ' +
        'packages/core/src/styles.css.',
    )
    process.exit(1)
  }
  console.log(`  ${utilities.size} utility classes emitted`)
}

// Client first — it generates routeTree.gen.ts, which the server bundle's
// type-level imports and the app's typecheck both depend on.
console.log(`\n▶ Client bundle (${app})`)
execFileSync(
  'npx',
  ['vite', 'build', '--config', `apps/${app}/vite.config.ts`],
  { stdio: 'inherit', shell: process.platform === 'win32' },
)

assertStyled(app)

console.log(`\n▶ API server (${app})`)
await bundle(`apps/${app}/src/server/prod.ts`, `${outBase}/server/index.mjs`)

console.log(`\n▶ Jobs worker (${app})`)
await bundle(
  `apps/${app}/src/jobs-worker.ts`,
  `${outBase}/server/jobs-worker.mjs`,
)

/**
 * Attribution for everything we redistribute.
 *
 * Written twice because the two images take different things: the app image
 * copies `dist/` and `.output/`, the jobs worker image copies only `.output/`.
 * One file in one place would credit our dependencies in whichever image
 * happened to get it.
 *
 * The `dist/` copy is also the served one — the static handler roots at
 * `dist/<app>/`, so it lands at `/THIRD-PARTY-NOTICES.txt` on a running
 * instance. That is the only copy a browser user can reach: the SPA bundle
 * itself is stripped of comments, so no licence text survives in it.
 *
 * Generated rather than committed. It is ~1.5 MB derived entirely from the
 * lockfile and the installed tree, and a checked-in copy would be one more
 * artefact to drift out of date with the dependency it credits.
 */
console.log(`\n▶ Third-party notices (${app})`)
const notices = render({ edition: app })
for (const dir of [`dist/${app}`, outBase]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const target = resolve(dir, 'THIRD-PARTY-NOTICES.txt')
  writeFileSync(target, `${notices}\n`, 'utf8')
  console.log(`  ${target}`)
}
