// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Fetch the demo datasets into ./demo-data/.
 *
 * Two of them: the TDJ-25 robot arm (~199 MB of GLB + thumbnails) and the
 * baked FreeCAD/KiCad bundle, both seeded by `npm run seed:demo`. They live in
 * Cascadia-PLM/Demo-Data rather than this repo, so a clone stays small. This
 * script shallow-clones that repo at a pinned tag — no extra dependencies, and
 * the tag makes a seeded demo reproducible.
 *
 * Idempotent: re-running with the datasets already at the pinned tag is a no-op.
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
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')

// Bump this when the datasets change. Pinning a tag rather than tracking main
// means `npm run demo:fetch` produces the same demo on every machine and in CI.
// v1.1.0 added freecad-demo/ alongside robot-arm/.
const DEFAULT_REF = 'v1.1.0'

const REF = process.env.DEMO_DATA_REF ?? DEFAULT_REF
const REPO =
  process.env.DEMO_DATA_REPO ?? 'https://github.com/Cascadia-PLM/Demo-Data.git'
const DEST = process.env.DEMO_DATA_DIR ?? join(REPO_ROOT, 'demo-data')
const FORCE = process.env.FORCE === '1'

const STAMP = join(DEST, '.fetched-ref')

/**
 * Subdirectories of the Demo-Data repo this script grafts across.
 *
 * `freecad-demo` is optional so that a checkout pinned at a tag predating it
 * still fetches cleanly — `seed:demo` says what to do when the bundle is
 * absent, which is a better failure than making every `demo:fetch` fail.
 */
const DATASETS: Array<{ dir: string; required: boolean }> = [
  { dir: 'robot-arm', required: true },
  { dir: 'freecad-demo', required: false },
]

function run(cmd: string, args: Array<string>): void {
  const result = spawnSync(cmd, args, { stdio: 'inherit' })
  if (result.status !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(' ')}`)
  }
}

// ----------------------------------------------------------------------------
// Skip if we already have exactly this ref
// ----------------------------------------------------------------------------

if (
  !FORCE &&
  existsSync(STAMP) &&
  existsSync(join(DEST, 'robot-arm', 'manifest.json'))
) {
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

// Clone to a scratch dir, then graft only the dataset directories across. The
// Demo-Data repo also carries a Dockerfile, package.json, scripts/ and .github/
// that this repo has no use for — and a nested package.json confuses lint and
// test globs.
//
// Deleting is scoped to what we own: the dataset directories and the stamp.
// Anything else a developer parked under demo-data/ survives.
const TMP = `${DEST}.tmp`

// Windows holds handles on a freshly-cloned tree long enough that renameSync and
// an immediate rmSync of .git both fail with EPERM/EBUSY. Copy across, and give
// the cleanup a few retries.
const rmDir = (p: string): void =>
  rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })

rmDir(TMP)
try {
  run('git', ['clone', '--quiet', '--depth', '1', '--branch', REF, REPO, TMP])

  mkdirSync(DEST, { recursive: true })

  for (const { dir, required } of DATASETS) {
    const src = join(TMP, dir)
    if (!existsSync(src)) {
      if (required) {
        console.error(`[demo:fetch] ${REPO} @ ${REF} has no ${dir}/ directory.`)
        rmDir(TMP) // process.exit skips the finally below
        process.exit(1)
      }
      console.log(`[demo:fetch] ${REF} carries no ${dir}/ — skipping`)
      continue
    }
    rmDir(join(DEST, dir))
    cpSync(src, join(DEST, dir), { recursive: true })
    console.log(`[demo:fetch] ✓ ${dir}/`)
  }
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
  .filter(
    (p) => !existsSync(join(DEST, 'robot-arm', 'glb', `${p.cadFileBase}.glb`)),
  )

if (missing.length > 0) {
  console.error(
    `[demo:fetch] ${missing.length}/${expected} GLB files are missing from the clone.`,
  )
  console.error(
    `[demo:fetch] first few: ${missing
      .slice(0, 3)
      .map((p) => p.cadFileBase)
      .join(', ')}`,
  )
  process.exit(1)
}

console.log(`[demo:fetch] ✓ ${expected} GLB files, ${REF}`)

// The FreeCAD bundle keeps its own inventory: manifest.blobs maps a SHA-256 to
// a size, and files/ is named by that hash. Checking the count here means a
// half-fetched bundle fails now rather than seeding a demo with no 3D models.
const freecadManifest = join(DEST, 'freecad-demo', 'manifest.json')
if (existsSync(freecadManifest)) {
  interface FreecadManifest {
    blobs: Record<string, number>
  }
  const bundle: FreecadManifest = JSON.parse(
    readFileSync(freecadManifest, 'utf-8'),
  )
  const hashes = Object.keys(bundle.blobs)
  const absent = hashes.filter(
    (h) => !existsSync(join(DEST, 'freecad-demo', 'files', h)),
  )
  if (absent.length > 0) {
    console.error(
      `[demo:fetch] ${absent.length}/${hashes.length} FreeCAD demo blobs are missing from the clone.`,
    )
    process.exit(1)
  }
  console.log(`[demo:fetch] ✓ ${hashes.length} FreeCAD demo blobs`)
}

writeFileSync(STAMP, `${REF}\n`, 'utf-8')

console.log(`[demo:fetch] now run: npm run seed:demo`)
