/**
 * Stage AP214 (color-bearing) STEPs into demo-data/robot-arm/step/ ahead of
 * conversion. Pulls from the user-provided SolidWorks re-export at
 * $SOURCE_DIR (default: ~/Downloads/robot-arm-234.snapshot.8/stepexport).
 *
 * For each manifest cadFileBase entry it picks:
 *   - the merged self-contained AP214 STEP for assemblies, OR
 *   - the per-part AP214 STEP for parts.
 *
 * Wipes step/ / glb/ / thumbnails/ first so the next prepare-demo-cad run is
 * clean. Run with:
 *   tsx scripts/stage-demo-steps.ts
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
const DEMO_DIR = join(REPO_ROOT, 'demo-data', 'robot-arm')
const STEP_DIR = join(DEMO_DIR, 'step')
const GLB_DIR = join(DEMO_DIR, 'glb')
const THUMB_DIR = join(DEMO_DIR, 'thumbnails')
const MANIFEST_PATH = join(DEMO_DIR, 'manifest.json')

const SOURCE_DIR = process.env.SOURCE_DIR
  ?? 'C:\\Users\\tamak\\Downloads\\robot-arm-234.snapshot.8\\stepexport'

interface ManifestPart {
  itemNumber: string
  type: 'assembly' | 'part'
  cadFileBase?: string
}

interface Manifest {
  parts: Array<ManifestPart>
}

const manifest: Manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'))
const wanted = manifest.parts.filter((p) => p.cadFileBase)

console.log(`[stage] manifest entries needing CAD: ${wanted.length}`)
console.log(`[stage] source: ${SOURCE_DIR}`)
console.log(`[stage] dest:   ${STEP_DIR}`)

if (!existsSync(SOURCE_DIR)) {
  console.error(`[stage] source dir not found: ${SOURCE_DIR}`)
  process.exit(1)
}

// Build a case-insensitive index of files in the source.
const allFiles = readdirSync(SOURCE_DIR).filter((f) => /\.STEP$/i.test(f))
const stemToFile = new Map<string, string>()
for (const f of allFiles) {
  const stem = f.replace(/\.STEP$/i, '')
  stemToFile.set(stem.toLowerCase(), f)
}

// Special cases:
//   - "Configuration 1" SLDASM is renamed in the demo to TDJ-25-A-10000-BASE-ASSEMBLY.
const specialCadBaseToStem: Record<string, string> = {
  'TDJ-25-A-10000-BASE-ASSEMBLY': 'Configuration 1.SLDASM',
}

// SLDASM-suffix candidates (assemblies typically saved as "FOO.SLDASM.STEP").
function findSourceFor(cadFileBase: string): string | null {
  const lower = cadFileBase.toLowerCase()
  // explicit override
  const override = specialCadBaseToStem[cadFileBase]
  if (override) {
    const f = stemToFile.get(override.toLowerCase())
    if (f) return f
  }
  // exact stem
  if (stemToFile.has(lower)) return stemToFile.get(lower)!
  // .SLDASM suffix (typical for assemblies)
  if (stemToFile.has(lower + '.sldasm')) return stemToFile.get(lower + '.sldasm')!
  // _N variants (instance suffixes)
  for (let i = 0; i <= 5; i++) {
    if (stemToFile.has(`${lower}_${i}`)) return stemToFile.get(`${lower}_${i}`)!
  }
  // .SLDASM_N
  for (let i = 0; i <= 5; i++) {
    if (stemToFile.has(`${lower}.sldasm_${i}`)) return stemToFile.get(`${lower}.sldasm_${i}`)!
  }
  return null
}

// Wipe demo dirs.
for (const d of [STEP_DIR, GLB_DIR, THUMB_DIR]) {
  if (existsSync(d)) {
    console.log(`[stage] wiping ${d}`)
    rmSync(d, { recursive: true, force: true })
  }
  mkdirSync(d, { recursive: true })
}

// Copy each source into demo step/ under its cadFileBase name.
const matched: Array<[string, string, number]> = []
const unmatched: Array<string> = []

for (const part of wanted) {
  const cadBase = part.cadFileBase!
  const source = findSourceFor(cadBase)
  if (!source) {
    unmatched.push(cadBase)
    continue
  }
  const src = join(SOURCE_DIR, source)
  const dst = join(STEP_DIR, `${cadBase}.step`)
  copyFileSync(src, dst)
  // Stat for sanity check (assemblies should be multi-MB; tiny files = shells).
  const size = (readFileSync(src) as Buffer).length
  matched.push([cadBase, source, size])
}

console.log()
console.log(`[stage] matched: ${matched.length}/${wanted.length}`)
const tiny = matched.filter(([, , size]) => size < 100_000)
if (tiny.length > 0) {
  console.log(`[stage] WARNING: ${tiny.length} matched STEPs are <100 KB (possibly external-ref shells):`)
  for (const [base, src, size] of tiny) {
    console.log(`  ${base} <- ${src} (${size} B)`)
  }
}

if (unmatched.length > 0) {
  console.log()
  console.log(`[stage] UNMATCHED: ${unmatched.length}`)
  for (const u of unmatched) console.log(`  ${u}`)
  console.log(`[stage] These manifest entries will not get CAD attachments.`)
}

console.log()
console.log(`[stage] done. Next: tsx scripts/prepare-demo-cad.ts (FORCE=1 to overwrite any leftovers)`)
