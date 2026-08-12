// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Run drizzle-kit against this tree's edition.
 *
 *   node scripts/drizzle.mjs push [--force]
 *   node scripts/drizzle.mjs studio
 *
 * The drizzle config lives in the app, because the schema is composed there —
 * `modules.schema.ts` is a re-export, and drizzle-kit reads it statically. So
 * every `db:*` script has to name an app, and naming `cascadia-enterprise`
 * outright is what made `npm run db:push` a broken script in the published
 * tree: the app it points at is not in that tree at all.
 *
 * Resolving instead means one script serves both editions. Same reasoning as
 * `truncate-all.ts` and `snapshot-openapi.ts`, which already do this.
 *
 * **Runs from the app directory.** The config's `schema: './src/modules.schema.ts'`
 * and `out: '../../drizzle'` are relative to the config, and drizzle-kit
 * resolves them against the working directory instead. Invoked from the repo
 * root it therefore looked for `<root>/src/modules.schema.ts` and failed with
 * "No schema files found" — which is what `npm run db:push` has done in *both*
 * editions since the Phase 2 split moved the config under `apps/`. It went
 * unnoticed because every existing database had already been pushed; the
 * published tree, having no database at all, is where it finally surfaced.
 */

import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { config as loadEnv } from 'dotenv'
import { resolveApp } from './edition.mjs'

// drizzle-kit loads `.env` from its *working directory*, and this script runs
// it from the app directory (see above). There is no `.env` there — the only
// one is at the repo root — so running from `apps/` traded "No schema files
// found" for "DATABASE_URL is not set", and `db:push` stayed broken in both
// editions. Load the root file here instead; the child inherits `process.env`.
//
// A real environment variable still wins: dotenv does not overwrite what is
// already set, which is what lets CI and `verify-oss.mjs` pass a scratch
// database without a file on disk.
loadEnv({ path: resolve(import.meta.dirname, '..', '.env'), quiet: true })

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('usage: node scripts/drizzle.mjs <command> [drizzle-kit args]')
  process.exit(2)
}

const appDir = resolve(process.cwd(), 'apps', resolveApp())

try {
  execFileSync(
    'npx',
    ['drizzle-kit', ...args, '--config', 'drizzle.config.ts'],
    { cwd: appDir, stdio: 'inherit', shell: process.platform === 'win32' },
  )
} catch (error) {
  process.exit(error.status ?? 1)
}
