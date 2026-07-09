/**
 * Fetch the TDJ-25 robot-arm demo dataset into ./demo-data/.
 *
 * The dataset (~199 MB of GLB + thumbnails) lives in Cascadia-PLM/Demo-Data
 * rather than this repo, so a clone of Cascadia-App stays small. This script
 * shallow-clones that repo at a pinned tag — no extra dependencies, and the tag
 * makes a seeded demo reproducible.
 *
 * Idempotent: re-running with the dataset already at the pinned tag is a no-op.
 *
 * Run with:
 *   npm run demo:fetch
 *
 * Env:
 *   DEMO_DATA_REF   git tag/branch to fetch (default: the pinned DEFAULT_REF)
 *   DEMO_DATA_REPO  clone URL (default: the public Demo-Data repo)
 *   DEMO_DATA_DIR   destination (default: ./demo-data)
 *   FORCE           set to 1 to re-clone even if the ref already matches
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')

// Bump this when the dataset changes. Pinning a tag rather than tracking main
// means `npm run demo:fetch` produces the same demo on every machine and in CI.
const DEFAULT_REF = 'v1.0.0'

const REF = process.env.DEMO_DATA_REF ?? DEFAULT_REF
const REPO = process.env.DEMO_DATA_REPO ?? 'https://github.com/Cascadia-PLM/Demo-Data.git'
const DEST = process.env.DEMO_DATA_DIR ?? join(REPO_ROOT, 'demo-data')
const FORCE = process.env.FORCE === '1'

const STAMP = join(DEST, '.fetched-ref')

function run(cmd: string, args: Array<string>): void {
  const result = spawnSync(cmd, args, { stdio: 'inherit' })
  if (result.status !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(' ')}`)
  }
}

// ----------------------------------------------------------------------------
// Skip if we already have exactly this ref
// ----------------------------------------------------------------------------

if (!FORCE && existsSync(STAMP) && existsSync(join(DEST, 'robot-arm', 'manifest.json'))) {
  const have = readFileSync(STAMP, 'utf-8').trim()
  if (have === REF) {
    console.log(`[demo:fetch] ${DEST} already at ${REF} — nothing to do`)
    process.exit(0)
  }
  console.log(`[demo:fetch] have ${have}, want ${REF} — refetching`)
}

// ----------------------------------------------------------------------------
// Clone
// ----------------------------------------------------------------------------

console.log(`[demo:fetch] cloning ${REPO} @ ${REF}`)
console.log(`[demo:fetch] into ${DEST}`)

// Clone to a scratch dir, then graft only robot-arm/ across. The Demo-Data repo
// also carries a Dockerfile, package.json, scripts/ and .github/ that this repo
// has no use for — and a nested package.json confuses lint and test globs.
//
// Deleting is scoped to what we own: demo-data/robot-arm and the stamp. Anything
// else a developer parked under demo-data/ survives.
const TMP = `${DEST}.tmp`

// Windows holds handles on a freshly-cloned tree long enough that renameSync and
// an immediate rmSync of .git both fail with EPERM/EBUSY. Copy across, and give
// the cleanup a few retries.
const rmDir = (p: string): void =>
  rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })

rmDir(TMP)
try {
  run('git', ['clone', '--quiet', '--depth', '1', '--branch', REF, REPO, TMP])

  const src = join(TMP, 'robot-arm')
  if (!existsSync(src)) {
    console.error(`[demo:fetch] ${REPO} @ ${REF} has no robot-arm/ directory.`)
    rmDir(TMP) // process.exit skips the finally below
    process.exit(1)
  }

  mkdirSync(DEST, { recursive: true })
  rmDir(join(DEST, 'robot-arm'))
  cpSync(src, join(DEST, 'robot-arm'), { recursive: true })
} finally {
  rmDir(TMP)
}

// ----------------------------------------------------------------------------
// Verify what we got matches what the seed expects
// ----------------------------------------------------------------------------

const manifestPath = join(DEST, 'robot-arm', 'manifest.json')
if (!existsSync(manifestPath)) {
  console.error(`[demo:fetch] clone succeeded but ${manifestPath} is missing.`)
  process.exit(1)
}

interface Manifest {
  parts: Array<{ cadFileBase?: string }>
}
const manifest: Manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
const expected = manifest.parts.filter((p) => p.cadFileBase).length

const missing = manifest.parts
  .filter((p) => p.cadFileBase)
  .filter((p) => !existsSync(join(DEST, 'robot-arm', 'glb', `${p.cadFileBase}.glb`)))

if (missing.length > 0) {
  console.error(`[demo:fetch] ${missing.length}/${expected} GLB files are missing from the clone.`)
  console.error(`[demo:fetch] first few: ${missing.slice(0, 3).map((p) => p.cadFileBase).join(', ')}`)
  process.exit(1)
}

writeFileSync(STAMP, `${REF}\n`, 'utf-8')

console.log(`[demo:fetch] ✓ ${expected} GLB files, ${REF}`)
console.log(`[demo:fetch] now run: npm run db:seed:demo`)
