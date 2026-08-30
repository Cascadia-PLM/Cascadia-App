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

/** `[project directory, tsconfig filename, file that must exist first]` */
const PROJECTS = [
  // The packages use their `tsconfig.typecheck.json`, which leaves out route
  // files — those are checked in the app projects, through the generated tree
  // that types them. See the comment in packages/core/tsconfig.typecheck.json.
  ['packages/core', 'tsconfig.typecheck.json', null],
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
    execFileSync('npx', ['tsc', '--noEmit', '-p', config], {
      stdio: 'pipe',
      shell: process.platform === 'win32',
    })
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
