/**
 * Build the robot-arm demo manifest.
 *
 * One-time tooling: reads the archived assembly-structure.json, deduplicates
 * parts (collapsing _N instance suffixes), classifies Make/Buy via name patterns,
 * and writes demo-data/robot-arm/manifest.json. Also copies the corresponding
 * canonical STEP files into demo-data/robot-arm/step/ (skipping instance copies).
 *
 * Run with:
 *   ARCHIVE_DIR="C:/Users/tamak/repos/Cascadia/CascadiaApp-archive/test-data/robot-arm" \
 *   tsx scripts/build-demo-manifest.ts
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ============================================================================
// Types (mirror the archive's seed/scenarios/robot-arm/types.ts)
// ============================================================================

interface RawProduct {
  entityId: string
  name: string
  description: string
  type: 'assembly' | 'part'
  solidworksFiles: Array<string>
}

interface RawRelationship {
  parentId: string
  parentName: string
  childId: string
  childName: string
  quantity: number
}

interface AssemblyStructure {
  metadata: {
    sourceFile: string
    parsedAt: string
    totalProducts: number
    totalAssemblies: number
    totalParts: number
    totalRelationships: number
  }
  products: Array<RawProduct>
  flatRelationships: Array<RawRelationship>
}

interface ManifestPart {
  itemNumber: string
  name: string
  description: string
  type: 'assembly' | 'part'
  partType: 'Manufacture' | 'Purchase'
  material: string
  cadFileBase?: string
}

interface ManifestRelationship {
  parent: string
  child: string
  quantity: number
  findNumber: number
}

interface Manifest {
  metadata: {
    name: string
    designCode: string
    programCode: string
    generatedAt: string
    sourceFile: string
    totalParts: number
    totalAssemblies: number
    totalRelationships: number
    totalCadFiles: number
  }
  parts: Array<ManifestPart>
  relationships: Array<ManifestRelationship>
}

// ============================================================================
// Helpers (ported from archive's parse-assembly.ts)
// ============================================================================

function getCanonicalName(name: string): string {
  return name.replace(/_\d+$/, '')
}

function cleanDescription(desc: string): string {
  return desc.replace(/\s+v\d+$/, '').trim()
}

function classifyPartType(canonicalName: string): 'Manufacture' | 'Purchase' {
  const makePatterns = [
    /^TDJ-25-/i,
    /-SHAFT$/i,
    /-HEX$/i,
    /^CONFIGURATION\s/i,
    /^FALCON-MAX-PLANETARY-ASSY$/i,
  ]
  for (const pattern of makePatterns) {
    if (pattern.test(canonicalName)) return 'Manufacture'
  }
  if (canonicalName.toUpperCase().startsWith('EE')) return 'Manufacture'

  const buyPatterns = [
    /^WCP-/i, /^REV-/i, /^217-/i,
    /^HSBHCS\b/i, /^HSHCS\b/i, /^HMSN\b/i, /^DIN\b/i, /^BHS\b/i, /^CBHMSN\b/i,
    /^97431A/i, /^98398A/i, /^6627K/i, /^17HS/i,
    /^Pulley_HTD/i, /^Falcon/i, /^MAXPlanetary/i, /^Minion$/i, /^#10/i,
  ]
  for (const pattern of buyPatterns) {
    if (pattern.test(canonicalName)) return 'Purchase'
  }
  return 'Purchase'
}

function generateHumanName(canonicalName: string, description: string): string {
  if (canonicalName === 'TDJ-25-A-10000-BASE-ASSEMBLY') {
    return 'Base Assembly'
  }

  const tdjPartMatch = canonicalName.match(/^TDJ-25-[AP]M?-\d+-(.+)$/)
  if (tdjPartMatch) {
    return tdjPartMatch[1]
      .split('-')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ')
  }

  const cleaned = cleanDescription(description)
  if (cleaned.length < 80 && cleaned.length > canonicalName.length) {
    return cleaned
  }
  return canonicalName
}

// ============================================================================
// Main
// ============================================================================

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
const ARCHIVE_DIR = process.env.ARCHIVE_DIR
  ?? resolve(REPO_ROOT, '../CascadiaApp-archive/test-data/robot-arm')

const ASSEMBLY_JSON = join(ARCHIVE_DIR, 'assembly-structure.json')
const ARCHIVE_STEP_DIR = join(ARCHIVE_DIR, 'step-output')
const DEMO_DIR = join(REPO_ROOT, 'demo-data', 'robot-arm')
const DEMO_STEP_DIR = join(DEMO_DIR, 'step')
const MANIFEST_PATH = join(DEMO_DIR, 'manifest.json')

console.log(`[build-manifest] archive=${ARCHIVE_DIR}`)
console.log(`[build-manifest] output=${DEMO_DIR}`)

if (!existsSync(ASSEMBLY_JSON)) {
  console.error(`Archive assembly JSON not found at ${ASSEMBLY_JSON}`)
  process.exit(1)
}
if (!existsSync(ARCHIVE_STEP_DIR)) {
  console.error(`Archive step-output dir not found at ${ARCHIVE_STEP_DIR}`)
  process.exit(1)
}

const raw: AssemblyStructure = JSON.parse(readFileSync(ASSEMBLY_JSON, 'utf-8'))

// ----------------------------------------------------------------------------
// Step 1: Build entityId -> canonical name map; group products by canonical
// ----------------------------------------------------------------------------

const entityToCanonical = new Map<string, string>()
const canonicalToProducts = new Map<string, Array<RawProduct>>()

for (const product of raw.products) {
  const canonical = getCanonicalName(product.name)
  entityToCanonical.set(product.entityId, canonical)
  if (!canonicalToProducts.has(canonical)) {
    canonicalToProducts.set(canonical, [])
  }
  canonicalToProducts.get(canonical)!.push(product)
}

// ----------------------------------------------------------------------------
// Step 2: Rename "Configuration 1" -> "TDJ-25-A-10000-BASE-ASSEMBLY"
//   (the SolidWorks file is "Configuration 1.SLDASM.SLDASM" so the STEP
//   export is "Configuration 1.step" — we'll rename on copy.)
// ----------------------------------------------------------------------------

const RENAMED_BASE = 'TDJ-25-A-10000-BASE-ASSEMBLY'
const sourceCadBaseByCanonical = new Map<string, string>()
const config1 = canonicalToProducts.get('Configuration 1')
if (config1) {
  canonicalToProducts.delete('Configuration 1')
  canonicalToProducts.set(RENAMED_BASE, config1)
  for (const p of config1) entityToCanonical.set(p.entityId, RENAMED_BASE)
  sourceCadBaseByCanonical.set(RENAMED_BASE, 'Configuration 1')
}

// ----------------------------------------------------------------------------
// Step 3: Build deduplicated parts list
// ----------------------------------------------------------------------------

const parts: Array<ManifestPart> = []

for (const [canonical, products] of canonicalToProducts) {
  const base = products[0]
  const type = products.some((p) => p.type === 'assembly') ? 'assembly' : 'part'
  const partType = classifyPartType(canonical)
  const description = cleanDescription(base.description)
  const name = generateHumanName(canonical, description)
  const material = type === 'assembly' ? 'Assembly' : 'Various'

  // Map canonical name to the expected base filename in the archive's step-output.
  // Default: canonical name. Special case: renamed Configuration 1.
  const cadSource = sourceCadBaseByCanonical.get(canonical) ?? canonical
  const cadCandidate = join(ARCHIVE_STEP_DIR, `${cadSource}.step`)
  const cadFileBase = existsSync(cadCandidate) ? canonical : undefined

  parts.push({
    itemNumber: canonical,
    name,
    description,
    type,
    partType,
    material,
    ...(cadFileBase ? { cadFileBase } : {}),
  })
}

// ----------------------------------------------------------------------------
// Step 4: Collapse BOM relationships
// ----------------------------------------------------------------------------

const relMap = new Map<string, { parent: string; child: string; quantity: number }>()
for (const rel of raw.flatRelationships) {
  const parent = entityToCanonical.get(rel.parentId)
  const child = entityToCanonical.get(rel.childId)
  if (!parent || !child) continue
  if (parent === child) continue
  const key = `${parent}|${child}`
  const existing = relMap.get(key)
  if (existing) {
    existing.quantity += rel.quantity
  } else {
    relMap.set(key, { parent, child, quantity: rel.quantity })
  }
}

// ----------------------------------------------------------------------------
// Step 5: Assign sequential find numbers per parent (10, 20, 30, ...)
// ----------------------------------------------------------------------------

const childrenByParent = new Map<string, Array<{ child: string; quantity: number }>>()
for (const r of relMap.values()) {
  if (!childrenByParent.has(r.parent)) childrenByParent.set(r.parent, [])
  childrenByParent.get(r.parent)!.push({ child: r.child, quantity: r.quantity })
}

const relationships: Array<ManifestRelationship> = []
for (const [parent, children] of childrenByParent) {
  let findNumber = 10
  for (const c of children) {
    relationships.push({
      parent,
      child: c.child,
      quantity: c.quantity,
      findNumber,
    })
    findNumber += 10
  }
}

// ----------------------------------------------------------------------------
// Step 6: Sort parts (assemblies first, then alphabetic)
// ----------------------------------------------------------------------------

parts.sort((a, b) => {
  if (a.type !== b.type) return a.type === 'assembly' ? -1 : 1
  return a.itemNumber.localeCompare(b.itemNumber)
})

// ----------------------------------------------------------------------------
// Step 7: Copy canonical STEP files into demo-data/robot-arm/step/
// ----------------------------------------------------------------------------

mkdirSync(DEMO_STEP_DIR, { recursive: true })

let copied = 0
let missing = 0
for (const part of parts) {
  if (!part.cadFileBase) continue
  const sourceBase = sourceCadBaseByCanonical.get(part.itemNumber) ?? part.itemNumber
  const src = join(ARCHIVE_STEP_DIR, `${sourceBase}.step`)
  const dst = join(DEMO_STEP_DIR, `${part.cadFileBase}.step`)
  if (!existsSync(src)) {
    console.warn(`  [missing STEP] ${sourceBase}.step (for ${part.itemNumber})`)
    missing++
    continue
  }
  copyFileSync(src, dst)
  copied++
}

// ----------------------------------------------------------------------------
// Step 8: Write manifest.json
// ----------------------------------------------------------------------------

const manifest: Manifest = {
  metadata: {
    name: 'TDJ-25 Robot Arm',
    designCode: 'TDJ-25',
    programCode: 'ROBOT-ARM',
    generatedAt: new Date().toISOString(),
    sourceFile: raw.metadata.sourceFile,
    totalParts: parts.length,
    totalAssemblies: parts.filter((p) => p.type === 'assembly').length,
    totalRelationships: relationships.length,
    totalCadFiles: parts.filter((p) => p.cadFileBase).length,
  },
  parts,
  relationships,
}

mkdirSync(DEMO_DIR, { recursive: true })
writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf-8')

console.log()
console.log(`  Parts:         ${manifest.metadata.totalParts}`)
console.log(`    assemblies:  ${manifest.metadata.totalAssemblies}`)
console.log(`    components:  ${manifest.metadata.totalParts - manifest.metadata.totalAssemblies}`)
console.log(`  Relationships: ${manifest.metadata.totalRelationships}`)
console.log(`  CAD files:     ${manifest.metadata.totalCadFiles} (${copied} copied, ${missing} missing in archive)`)
console.log(`  Wrote:         ${MANIFEST_PATH}`)
