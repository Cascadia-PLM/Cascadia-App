// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Typecheck every project in the workspace.
 *
 * One `tsc` per project rather than a single program over everything: each app
 * generates its own `routeTree.gen.ts`, and those files augment the same
 * `@tanstack/react-router` interfaces. Compiled together they would collide.
 *
 * The apps are checked only when their route tree exists, since it is generated
 * by `vite build` and gitignored — the same reason the Build job in CI is where
 * this runs. Skipping is reported, never silent.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

/**
 * Heap for each `tsc`, in MB. Node's default is sized from physical memory —
 * about 2 GB on a GitHub-hosted runner — and core's program alone outgrew it
 * (2.1 GB, measured 2026-09-11). CI's Build job had been passing 4096 through
 * its own NODE_OPTIONS, so it stayed green while a caller without that setting
 * ran out of heap on the same code. The limit lives here so no caller lacks it.
 */
const TSC_HEAP_MB = 4096

/** `[project directory, tsconfig filename, file that must exist first]` */
const PROJECTS = [
  // Packages with route files use their `tsconfig.typecheck.json`, which
  // leaves those out — they are checked in the app projects, through the
  // generated tree that types them. See the comment in
  // packages/cascadia-web/tsconfig.typecheck.json.
  ['packages/cascadia-commons', 'tsconfig.json', null],
  ['packages/cascadia-api', 'tsconfig.json', null],
  ['packages/cascadia-web', 'tsconfig.typecheck.json', null],
  ['packages/advanced-auditing', 'tsconfig.json', null],
  ['packages/design-engine', 'tsconfig.typecheck.json', null],
  ['packages/odoo-integration', 'tsconfig.json', null],
  ['apps/cascadia', 'tsconfig.json', 'apps/cascadia/src/routeTree.gen.ts'],
  [
    'apps/cascadia-enterprise',
    'tsconfig.json',
    'apps/cascadia-enterprise/src/routeTree.gen.ts',
  ],
  ['.', 'tsconfig.json', null],
]

let failed = 0
const skipped = []

for (const [project, configName, requires] of PROJECTS) {
  const config = `${project}/${configName}`.replace('./', '')

  // A project that is not in this tree is a different edition, not a failure —
  // the core-only tree has no module packages by construction.
  if (!existsSync(config)) {
    skipped.push(`${project} (not present in this tree)`)
    continue
  }
  if (requires && !existsSync(requires)) {
    skipped.push(`${project} (no ${requires} — run the app build first)`)
    continue
  }
  process.stdout.write(`tsc ${project} ... `)
  try {
    // `node` rather than `npx`, so the heap flag lands on tsc itself.
    execFileSync(
      process.execPath,
      [
        `--max-old-space-size=${TSC_HEAP_MB}`,
        'node_modules/typescript/bin/tsc',
        '--noEmit',
        '-p',
        config,
      ],
      { stdio: 'pipe' },
    )
    console.log('ok')
  } catch (error) {
    console.log('FAILED')
    // tsc reports diagnostics on stdout; a crash lands on stderr. Print both,
    // because printing neither is how this failed silently the first time.
    for (const stream of [error.stdout, error.stderr]) {
      const text = String(stream ?? '').trim()
      if (text) console.error(text)
    }
    failed++
  }
}

if (skipped.length > 0) {
  console.log('\nSkipped:')
  for (const s of skipped) console.log(`  ${s}`)
}

if (failed > 0) {
  console.error(`\n✗ ${failed} project(s) failed typecheck.`)
  process.exit(1)
}
console.log('\n✅ All projects typecheck.')
