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
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { addUpAxisRotation, parseGlb } from './fix-glb-up-axis.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')

// Bump this when the datasets change. Pinning a tag rather than tracking main
// means `npm run demo:fetch` produces the same demo on every machine and in CI.
// v1.1.0 added freecad-demo/ alongside robot-arm/.
// v1.2.0 rebaked both datasets with the Z-up -> Y-up root rotation glTF
// mandates, matching the converter fix. A checkout left on v1.1.0 seeds models
// that render lying on their back — the pin is what carries that correction, so
// bump it in the same change as any fix to the baked data.
// v1.3.0 added the cart's drop-in wall kit ECO, the one change in the dataset
// that alters the *top-level* geometry — without it PUC-0000 has the same GLB
// at every revision and the 3D comparison view has nothing to show.
// v1.3.1 gives that ECO's six GLBs the Z-up -> Y-up rotation they shipped
// without: the converter *image* on the machine that baked them predated the
// fix, so PUC-0000 rev D rendered on its back next to an upright rev C.
// v1.3.2 re-syncs the file_size those rewrites changed. It rides on the
// download as Content-Length, so v1.3.1 promised bytes it never sent and the
// viewer hung on "Loading GLB model..." for ever. Neither v1.3.0 nor v1.3.1 is
// usable: one renders the cart on its back, the other will not render it.
// v1.4.0 adds the third dataset, standard-library — unreleased components in
// STD-LIB. Optional in DATASETS, so an older pin still fetches cleanly and
// seed:demo just reports the library as absent.
// v1.5.0 rebakes every assembly GLB with a glTF node per leaf part, and adds
// robot-arm/nodes/ plus `nodes` on the FreeCAD bundle's vault_files rows, so
// the viewer can select a part and open the item it is. Unlike the v1.2.0
// up-axis bump this needs no guard: an older pin seeds models that are simply
// one solid, which is what they have always been, and `seed:demo` says so
// rather than leaving it to be noticed in the viewer.
const DEFAULT_REF = 'v1.5.0'

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
  { dir: 'standard-library', required: false },
]

const GLB_MAGIC = 0x46546c67

/**
 * Read a GLB's JSON chunk without pulling its vertex buffer into memory.
 *
 * The robot arm's models are ~199 MB between them and the FreeCAD bundle holds
 * 616 blobs of which only some are GLBs at all, so the orientation check below
 * reads the header, then exactly the JSON chunk it advertises — a few KB.
 *
 * @returns the parsed JSON chunk, or null if the file is not a GLB
 */
function readGlbJson(path: string): unknown {
  const fd = openSync(path, 'r')
  try {
    // 12-byte GLB header, then the first chunk's 8-byte length/type pair.
    const head = Buffer.alloc(20)
    if (readSync(fd, head, 0, 20, 0) < 20) return null
    if (head.readUInt32LE(0) !== GLB_MAGIC) return null

    const jsonLength = head.readUInt32LE(12)
    const buf = Buffer.alloc(20 + jsonLength)
    head.copy(buf)
    readSync(fd, buf, 20, jsonLength, 20)
    return parseGlb(buf).json
  } finally {
    closeSync(fd)
  }
}

/**
 * Fail the fetch when the datasets predate the up-axis correction.
 *
 * This is the one defect in the baked data that survives every structural
 * check: the files are all present, the hashes all match, and the models load
 * — lying on their back. A checkout pinned to a tag older than v1.2.0 seeds
 * that silently, and `seed:demo` then copies it into the vault under fresh
 * paths, so the symptom outlives any fix applied to the vault itself.
 *
 * `addUpAxisRotation` answers 'rewritten' for exactly the files the backfill
 * would have to touch — ours, and missing the rotation glTF mandates. It
 * mutates the JSON it is handed, which is why each one is parsed fresh here
 * and thrown away. Paths that are not GLBs at all are not counted.
 */
function requireUpright(label: string, paths: Array<string>): void {
  let models = 0
  let flat = 0
  for (const path of paths) {
    const json = readGlbJson(path)
    if (json === null) continue
    models++
    if (addUpAxisRotation(json) === 'rewritten') flat++
  }
  if (flat === 0) return

  console.error(
    `[demo:fetch] ${flat}/${models} ${label} models are Z-up: ` +
      `${REF} predates the up-axis correction.`,
  )
  console.error(`[demo:fetch] pin DEMO_DATA_REF to v1.2.0 or later.`)
  process.exit(1)
}

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

requireUpright(
  'robot-arm',
  manifest.parts
    .filter((p) => p.cadFileBase)
    .map((p) => join(DEST, 'robot-arm', 'glb', `${p.cadFileBase}.glb`)),
)

console.log(`[demo:fetch] ✓ ${expected} GLB files, ${REF}`)

// The library dataset is a flat directory of GLBs keyed by model name; it has
// no blob inventory of its own to count, so the orientation gate is the whole
// check. Absent is fine — a checkout pinned before the library existed.
const libraryGlbDir = join(DEST, 'standard-library', 'glb')
if (existsSync(libraryGlbDir)) {
  const libraryGlbs = readdirSync(libraryGlbDir)
    .filter((f) => f.toLowerCase().endsWith('.glb'))
    .map((f) => join(libraryGlbDir, f))
  requireUpright('standard-library', libraryGlbs)
  console.log(`[demo:fetch] ✓ ${libraryGlbs.length} standard-library models`)
}

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
  // Blobs are named by hash, not extension — readGlbJson sniffs the magic and
  // returns null for the STEP, PDF and image blobs sharing the directory.
  requireUpright(
    'FreeCAD demo',
    hashes.map((h) => join(DEST, 'freecad-demo', 'files', h)),
  )

  console.log(`[demo:fetch] ✓ ${hashes.length} FreeCAD demo blobs`)
}

writeFileSync(STAMP, `${REF}\n`, 'utf-8')

console.log(`[demo:fetch] now run: npm run seed:demo`)
