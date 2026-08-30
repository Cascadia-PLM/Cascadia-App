// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Assert the invariant: **a test that overrides a shared config row puts it
 * back.**
 *
 *   npm run test:hygiene:check
 *
 * `item_type_configs` and `workflow_definitions` hold one row per item type
 * for the whole instance. A suite that overrides one in `beforeAll` writes
 * outside the per-test gate transaction, so the write is permanent: the row
 * survives the suite, the file, and the run. Six suites did exactly that and
 * never wrote the row back, so which lifecycle `Task` pointed at depended on
 * which suite had last touched the database — and a test that read it was
 * asserting on file order.
 *
 * `overrideItemTypeConfig` (in `__tests__/fixtures/lifecycles.ts`) captures the
 * row first and returns the undo. This gate says: if a test file writes one of
 * those tables with `onConflictDoUpdate`, it must be going through that helper.
 *
 * A file that genuinely does not need the helper — because its override lives
 * inside the gate transaction and is undone before the rollback — declares
 * that with a `test-config-hygiene:` comment giving the reason. There is
 * exactly one such file today.
 *
 * Deliberately a grep, not an analysis. It is the fast half — the authority is
 * the acceptance check that the config rows still point at their defaults after
 * a full run. A determined reformatting can slip past this; the point is to
 * catch the next copy-paste, which is how all six got there.
 */

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const SHARED_TABLES = ['itemTypeConfigs', 'workflowDefinitions']
const HELPER = 'overrideItemTypeConfig'
/** Visible, reviewable opt-out: `// test-config-hygiene: <why>`. */
const EXEMPTION = 'test-config-hygiene:'

/** Test files, from git so untracked scratch files are not scanned. */
function testFiles() {
  const out = execFileSync('git', ['ls-files', '*.test.ts', '*.test.tsx'], {
    encoding: 'utf8',
  })
  return out.split('\n').filter(Boolean)
}

/**
 * Does this file upsert a shared config table without the helper?
 *
 * Matches `.insert(<table>)` followed by `.onConflictDoUpdate` before the next
 * `.insert(` — the shape every offender had. `onConflictDoNothing` is fine:
 * first-writer-wins leaves whatever is there alone.
 */
function offendingTables(source) {
  const found = []
  for (const table of SHARED_TABLES) {
    const pattern = new RegExp(
      `\\.insert\\(${table}\\)(?:(?!\\.insert\\()[\\s\\S])*?\\.onConflictDoUpdate`,
      'g',
    )
    if (pattern.test(source)) found.push(table)
  }
  return found
}

const offenders = []
for (const file of testFiles()) {
  const source = readFileSync(file, 'utf8')
  const tables = offendingTables(source)
  if (tables.length === 0) continue
  if (source.includes(HELPER)) continue
  if (source.includes(EXEMPTION)) continue
  offenders.push({ file, tables })
}

if (offenders.length > 0) {
  console.error(
    '\n✗ Test files override a shared config row without restoring it:\n',
  )
  for (const { file, tables } of offenders) {
    console.error(`  ${file}`)
    console.error(`    upserts: ${tables.join(', ')}`)
  }
  console.error(
    [
      '',
      `Use ${HELPER}() from @/__tests__/fixtures/lifecycles and call the`,
      'restore it returns in afterAll, before testDb.teardown().',
      '',
      `If the override really is undone before the rollback, say so in a`,
      `\`// ${EXEMPTION} <why>\` comment and this gate will believe you.`,
      '',
      'These tables hold one row per item type for the whole instance, and a',
      'beforeAll write is outside the gate transaction — so it outlives the',
      'run and the next suite inherits it.',
      '',
    ].join('\n'),
  )
  process.exit(1)
}

console.log(
  `\n✅ No test file overrides a shared config row without restoring it. (${testFiles().length} test files scanned)\n`,
)
