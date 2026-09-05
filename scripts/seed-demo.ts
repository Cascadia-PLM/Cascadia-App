// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Seed the demo data — both datasets, one command.
 *
 *   npm run db:seed && npm run demo:fetch && npm run seed:demo
 *
 * | Dataset     | Programs             | What it shows                        |
 * | ----------- | -------------------- | ------------------------------------ |
 * | `robot-arm` | `ROBOT-ARM`          | ~88 parts, BOM, 3D models            |
 * | `freecad`   | `PUC`, `USV`         | the whole PLM record — see the docs  |
 *
 * Both live in the same `Cascadia-PLM/Demo-Data` repository and ship in the
 * same demo image, so they are fetched together and seeded together.
 *
 * Each dataset is independently idempotent: it checks for its own programs and
 * does nothing if they are there. So this is safe to re-run, and safe to run
 * when only one of the two has been seeded before.
 *
 * Env:
 *   DEMO_DATA_DIR    root of the demo data (default: ./demo-data)
 *   VAULT_ROOT       vault root for direct file copies (default: ./vault)
 *   DEMO_SKIP_FILES  'true' seeds rows only — no vault blobs, no 3D models
 *   DEMO_SKIP_ECO    'true' skips the robot arm's Initial Release ECO
 *
 * Args:
 *   --only <robot-arm|freecad>   seed just that one
 *
 * ## On failure
 *
 * A missing or half-fetched dataset is reported and skipped rather than fatal,
 * and the other dataset still seeds — one absent bundle should not cost you the
 * one you do have. Anything else is a real fault and stops the run. The exit
 * code is non-zero if any dataset failed, so CI still notices.
 */

import { describeConnection } from '../packages/core/src/lib/db/index.ts'
import { DemoDataMissing } from './demo-seed-types.ts'
import { seedRobotArm } from './seed-demo-robot-arm.ts'
import { seedFreecadDemo } from './seed-freecad-demo.ts'
import type { DatasetResult } from './demo-seed-types.ts'

const DATASETS: Array<{
  key: string
  label: string
  seed: () => Promise<DatasetResult>
}> = [
  { key: 'robot-arm', label: 'TDJ-25 robot arm', seed: seedRobotArm },
  { key: 'freecad', label: 'FreeCAD/KiCad (PUC, USV)', seed: seedFreecadDemo },
]

const onlyIndex = process.argv.indexOf('--only')
const only = onlyIndex === -1 ? null : process.argv[onlyIndex + 1]

if (only && !DATASETS.some((d) => d.key === only)) {
  console.error(
    `--only takes one of: ${DATASETS.map((d) => d.key).join(', ')} (got "${only}")`,
  )
  process.exit(1)
}

const selected = only ? DATASETS.filter((d) => d.key === only) : DATASETS

console.log('Seeding demo data')
console.log(`   database: ${describeConnection()}`)
console.log(`   datasets: ${selected.map((d) => d.key).join(', ')}`)
console.log()

const summary: Array<string> = []
let failed = 0

for (const dataset of selected) {
  console.log(
    `── ${dataset.label} ${'─'.repeat(Math.max(0, 52 - dataset.label.length))}`,
  )
  try {
    const result = await dataset.seed()
    summary.push(
      `   ${result.seeded ? '✓' : '·'} ${dataset.key}: ${result.note}`,
    )
  } catch (error) {
    failed++
    if (error instanceof DemoDataMissing) {
      // Recoverable, and the user is the one who can recover it. Say how, keep
      // going, and let the other dataset seed.
      for (const line of error.lines) console.error(`   ${line}`)
      summary.push(`   ✗ ${dataset.key}: dataset not available — see above`)
    } else {
      throw error
    }
  }
  console.log()
}

console.log(
  failed === selected.length
    ? 'Demo seed did nothing.'
    : failed > 0
      ? 'Demo seed finished with problems.'
      : 'Demo seed complete.',
)
for (const line of summary) console.log(line)
// Only worth offering when there is something to log in and look at.
if (failed < selected.length) {
  console.log('   Login: admin@cascadia.local / Cascadia')
}

process.exit(failed > 0 ? 1 : 0)
