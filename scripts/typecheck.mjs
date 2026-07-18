/**
 * The CI typecheck gate: two error ceilings that may only ever move down.
 *
 * `tsc --noEmit` is not yet clean, so this ratchets instead of demanding zero.
 * It exists because nothing else in CI typechecks - vite build strips types
 * without checking them - which once let a lint autofix silently remove ~37
 * load-bearing type assertions with every gate green. Catching that meant
 * hand-diffing tsc output against a baseline; this automates exactly that.
 *
 *   CORE   (tsconfig.ci.json, noUncheckedIndexedAccess off)
 *          The substantive errors. Drive to zero first - they include real
 *          user-visible bugs. Hard ratchet in BOTH directions: fixing errors
 *          without lowering the ceiling fails, so the number cannot go stale.
 *
 *   STRICT (tsconfig.json, as the editor and ESLint see it)
 *          CORE plus the noUncheckedIndexedAccess artifacts. Blocks
 *          regressions, but only WARNS when it could be lowered: these
 *          shift under any refactor, and a hard lower bound would mean
 *          constant line-churn and conflicts between concurrent PRs for
 *          little gain. Lower it deliberately in cleanup PRs.
 *
 * Neither number may be raised to accommodate a new error - fix the error.
 * When CORE reaches 0, delete this script and tsconfig.ci.json and let CI run
 * `npm run typecheck:strict` directly, exactly like `eslint --max-warnings 0`.
 */

import { spawnSync } from 'node:child_process'

const CORE_MAX = 29
const STRICT_MAX = 1891

/** Runs tsc against one config and returns its error count plus raw output. */
function typecheck(project) {
  // tsc exits non-zero when it reports errors, which is the normal path here.
  const { stdout, stderr, error } = spawnSync(
    'npx',
    ['tsc', '--noEmit', '-p', project],
    { encoding: 'utf8', shell: process.platform === 'win32' },
  )
  if (error) throw error

  const output = `${stdout ?? ''}${stderr ?? ''}`
  // Every diagnostic line carries `error TS<code>:`. Summary lines ("Found N
  // errors") don't match the colon-suffixed form, so they aren't double counted.
  const count = (output.match(/error TS\d+:/g) ?? []).length
  return { count, output }
}

let failed = false

// --- CORE: hard ratchet, both directions -----------------------------------
const core = typecheck('tsconfig.ci.json')
console.log(core.output)
console.log(`CORE   ${core.count} error(s) (ceiling ${CORE_MAX})`)

if (core.count > CORE_MAX) {
  console.error(
    `\n✖ CORE rose to ${core.count}, ceiling is ${CORE_MAX} (+${core.count - CORE_MAX}).\n` +
      `  Fix the new type error(s) above. Do not raise CORE_MAX in scripts/typecheck.mjs.`,
  )
  failed = true
} else if (core.count < CORE_MAX) {
  console.error(
    `\n✖ CORE is down to ${core.count} but the ceiling is still ${CORE_MAX}.\n` +
      `  Nice - now lock it in: set CORE_MAX = ${core.count} in scripts/typecheck.mjs.`,
  )
  failed = true
}

// --- STRICT: blocks regressions, only warns when it can be lowered ----------
const strict = typecheck('tsconfig.json')
console.log(`STRICT ${strict.count} error(s) (ceiling ${STRICT_MAX})`)

if (strict.count > STRICT_MAX) {
  console.error(
    `\n✖ STRICT rose to ${strict.count}, ceiling is ${STRICT_MAX} (+${strict.count - STRICT_MAX}).\n` +
      `  Re-run locally with: npm run typecheck:strict\n` +
      `  Do not raise STRICT_MAX in scripts/typecheck.mjs.`,
  )
  failed = true
} else if (strict.count < STRICT_MAX) {
  console.log(
    `\nℹ STRICT can be lowered to ${strict.count} (currently ${STRICT_MAX}). Not required to pass.`,
  )
}

if (failed) process.exit(1)
console.log('\n✔ Typecheck ceilings held.')
