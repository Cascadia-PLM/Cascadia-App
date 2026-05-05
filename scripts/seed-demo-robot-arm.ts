/**
 * Demo seed: TDJ-25 Robot Arm.
 *
 * Reads demo-data/robot-arm/manifest.json and creates a ROBOT-ARM program,
 * a TDJ-25 design, ~88 parts, ~101 BOM relationships, and ~79 GLB + thumbnail
 * vault file pairs. Optionally releases an ECO-001 baseline.
 *
 * Idempotent: skips entirely if a program with code 'ROBOT-ARM' already exists.
 *
 * Run with:
 *   tsx scripts/seed-demo-robot-arm.ts
 *
 * Env:
 *   DEMO_DATA_DIR    root of demo data (default: ./demo-data inside container, ./demo-data on host)
 *   VAULT_ROOT       vault root for direct file copies (default: ./vault on host, /app/vault in container)
 *   DEMO_SKIP_ECO    set to 'true' to skip the Initial Release ECO step
 *   DEMO_SKIP_FILES  set to 'true' to skip vault file ingestion (DB rows + parts only)
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '../src/lib/db/index.ts'
import { users } from '../src/lib/db/schema/users.ts'
import { programMembers, programs } from '../src/lib/db/schema/programs.ts'
import { designs } from '../src/lib/db/schema/designs.ts'
import { branches, commits } from '../src/lib/db/schema/versioning.ts'
import {
  changeOrderAffectedItems,
  changeOrders,
  itemRelationships,
  items,
  parts,
} from '../src/lib/db/schema/items.ts'
import { vaultFiles } from '../src/lib/db/schema/vault.ts'
import { generateStoragePath, sanitizeFilename } from '../src/lib/vault/utils/file-utils.ts'

// ============================================================================
// Config
// ============================================================================

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')

const DEMO_DATA_DIR = process.env.DEMO_DATA_DIR ?? join(REPO_ROOT, 'demo-data')
const ROBOT_ARM_DIR = join(DEMO_DATA_DIR, 'robot-arm')
const MANIFEST_PATH = join(ROBOT_ARM_DIR, 'manifest.json')
const STEP_DIR = join(ROBOT_ARM_DIR, 'step')
const GLB_DIR = join(ROBOT_ARM_DIR, 'glb')
const THUMB_DIR = join(ROBOT_ARM_DIR, 'thumbnails')

// In containers: VAULT_ROOT=/app/vault. On dev host: VAULT_ROOT=./vault.
const VAULT_ROOT = process.env.VAULT_ROOT ?? join(REPO_ROOT, 'vault')

const SKIP_ECO = process.env.DEMO_SKIP_ECO === 'true'
const SKIP_FILES = process.env.DEMO_SKIP_FILES === 'true'

// Deterministic UUIDs (RFC 4122 v4-shaped). 0x200 range avoids minimal-seed (0x000-0x020) and lifecycle (0x100+).
const IDS = {
  program: '00000000-0000-4000-8000-000000000200',
  design: '00000000-0000-4000-8000-000000000201',
  ecoItem: '00000000-0000-4000-8000-000000000202',
}

// ============================================================================
// Manifest types
// ============================================================================

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
  metadata: { name: string; designCode: string; programCode: string }
  parts: Array<ManifestPart>
  relationships: Array<ManifestRelationship>
}

// ============================================================================
// Helpers
// ============================================================================

function chunk<T>(arr: Array<T>, size: number): Array<Array<T>> {
  const out: Array<Array<T>> = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

function mimeTypeFor(ext: string): string {
  switch (ext.toLowerCase()) {
    case '.step':
    case '.stp':
      return 'application/step'
    case '.glb':
      return 'model/gltf-binary'
    case '.png':
      return 'image/png'
    default:
      return 'application/octet-stream'
  }
}

// ============================================================================
// Main
// ============================================================================

console.log('🤖 Seeding TDJ-25 Robot Arm demo...')
console.log(`   demo data: ${ROBOT_ARM_DIR}`)
console.log(`   vault:     ${VAULT_ROOT}`)

// ---- 1. Look up admin ------------------------------------------------------

const adminRows = await db
  .select()
  .from(users)
  .where(eq(users.email, 'admin@cascadia.local'))
  .limit(1)

const admin = adminRows.at(0)
if (!admin) {
  console.error('Admin user (admin@cascadia.local) not found. Run scripts/seed-minimal.ts first.')
  process.exit(1)
}

// ---- 2. Idempotency: skip if already seeded --------------------------------

const existingProgram = await db
  .select()
  .from(programs)
  .where(eq(programs.code, 'ROBOT-ARM'))
  .limit(1)

if (existingProgram.length > 0) {
  console.log('[demo] ROBOT-ARM program already exists — skipping demo seed')
  process.exit(0)
}

// ---- 3. Read manifest ------------------------------------------------------

if (!existsSync(MANIFEST_PATH)) {
  console.error(`Manifest not found at ${MANIFEST_PATH}.`)
  console.error('Run scripts/build-demo-manifest.ts first to generate it.')
  process.exit(1)
}

const manifest: Manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'))

console.log(`   parts: ${manifest.parts.length}, relationships: ${manifest.relationships.length}`)

// ---- 4. Create Program -----------------------------------------------------

await db
  .insert(programs)
  .values({
    id: IDS.program,
    name: 'Robot Arm Program',
    code: 'ROBOT-ARM',
    description: 'TDJ-25 6-DOF robot arm — sample dataset for the Cascadia demo.',
    status: 'Active',
    customer: 'Cascadia Demo',
    createdBy: admin.id,
  })
  .onConflictDoNothing()

await db
  .insert(programMembers)
  .values({
    programId: IDS.program,
    userId: admin.id,
    role: 'admin',
    canCreateEco: true,
    canApproveEco: true,
    canManageProducts: true,
  })
  .onConflictDoNothing()

console.log('✓ Program ROBOT-ARM')

// ---- 5. Create Design + main branch + initial commit -----------------------

await db.insert(designs).values({
  id: IDS.design,
  programId: IDS.program,
  name: manifest.metadata.name,
  code: manifest.metadata.designCode,
  description: 'TDJ-25 robot arm — 6-DOF demonstration assembly with ~88 parts.',
  designType: 'Engineering',
  createdBy: admin.id,
})

// Insert temp commit (branchId placeholder — will be patched after branch insert).
const [initialCommit] = await db
  .insert(commits)
  .values({
    designId: IDS.design,
    branchId: IDS.design, // placeholder; patched below
    message: 'Initial commit',
    createdBy: admin.id,
  })
  .returning()

const [mainBranch] = await db
  .insert(branches)
  .values({
    designId: IDS.design,
    name: 'main',
    branchType: 'main',
    headCommitId: initialCommit.id,
    baseCommitId: initialCommit.id,
    createdBy: admin.id,
  })
  .returning()

await db.update(commits).set({ branchId: mainBranch.id }).where(eq(commits.id, initialCommit.id))
await db.update(designs).set({ defaultBranchId: mainBranch.id }).where(eq(designs.id, IDS.design))

console.log(`✓ Design ${manifest.metadata.designCode} (main branch + initial commit)`)

// ---- 6. Bulk-insert items + parts -----------------------------------------

// Sort assemblies before parts so parents exist before children for any FK-style consumer.
const sortedParts = [...manifest.parts].sort((a, b) => {
  if (a.type !== b.type) return a.type === 'assembly' ? -1 : 1
  return a.itemNumber.localeCompare(b.itemNumber)
})

interface PreparedItem {
  itemRow: typeof items.$inferInsert
  partRow: typeof parts.$inferInsert
}

const itemIdByNumber = new Map<string, string>()
const masterIdByNumber = new Map<string, string>()
const prepared: Array<PreparedItem> = sortedParts.map((p) => {
  const id = randomUUID()
  itemIdByNumber.set(p.itemNumber, id)
  masterIdByNumber.set(p.itemNumber, id) // masterId = itemId for first revision
  return {
    itemRow: {
      id,
      masterId: id,
      designId: IDS.design,
      commitId: initialCommit.id,
      itemNumber: p.itemNumber,
      revision: 'A',
      itemType: 'Part',
      name: p.name,
      state: 'Draft',
      isCurrent: true,
      inDesignStructure: true,
      createdBy: admin.id,
      modifiedBy: admin.id,
    },
    partRow: {
      itemId: id,
      description: p.description,
      partType: p.partType,
      material: p.material,
    },
  }
})

for (const batch of chunk(prepared, 200)) {
  await db.insert(items).values(batch.map((p) => p.itemRow)).onConflictDoNothing()
  await db.insert(parts).values(batch.map((p) => p.partRow)).onConflictDoNothing()
}

console.log(`✓ Inserted ${prepared.length} parts`)

// ---- 7. BOM relationships -------------------------------------------------

// Dedupe in-memory by (parent, child) — itemRelationships has no unique constraint on the triple.
const relsSeen = new Set<string>()
const relRows: Array<typeof itemRelationships.$inferInsert> = []
let skippedRels = 0
for (const rel of manifest.relationships) {
  const parentId = itemIdByNumber.get(rel.parent)
  const childId = itemIdByNumber.get(rel.child)
  if (!parentId || !childId) {
    skippedRels++
    continue
  }
  const key = `${parentId}|${childId}|BOM`
  if (relsSeen.has(key)) continue
  relsSeen.add(key)
  relRows.push({
    sourceId: parentId,
    targetId: childId,
    relationshipType: 'BOM',
    quantity: String(rel.quantity),
    findNumber: rel.findNumber,
    createdBy: admin.id,
    modifiedBy: admin.id,
    isComposite: true,
    isDirected: true,
  })
}

for (const batch of chunk(relRows, 500)) {
  await db.insert(itemRelationships).values(batch)
}

console.log(`✓ Inserted ${relRows.length} BOM relationships${skippedRels ? ` (skipped ${skippedRels})` : ''}`)

// ---- 8. Vault files (GLB + thumbnail per part; STEP optional) ------------
//
// The shipped demo data contains GLB + thumbnails only — STEPs are build-time
// assets (input to the cad-converter, then dropped from the repo). The GLB is
// the primary model; users get a 3D viewer immediately. If a STEP file IS on
// disk (developer workflow), it's ingested as a secondary cad_model row.

let vaultComplete = 0     // GLB + thumbnail both present
let vaultGlbOnly = 0      // GLB but no thumbnail
let vaultMissing = 0      // no GLB at all

if (SKIP_FILES) {
  console.log('   DEMO_SKIP_FILES=true → skipping vault file ingestion')
} else {
  for (const part of sortedParts) {
    if (!part.cadFileBase) continue
    const masterId = masterIdByNumber.get(part.itemNumber)
    const itemId = itemIdByNumber.get(part.itemNumber)
    if (!masterId || !itemId) continue

    const stepSrc = join(STEP_DIR, `${part.cadFileBase}.step`)
    const glbSrc = join(GLB_DIR, `${part.cadFileBase}.glb`)
    const thumbSrc = join(THUMB_DIR, `${part.cadFileBase}.png`)

    const haveStep = existsSync(stepSrc)
    const haveGlb = existsSync(glbSrc)
    const haveThumb = existsSync(thumbSrc)

    if (!haveGlb) {
      vaultMissing++
      continue
    }

    const glbFileId = randomUUID()
    const stepFileId = haveStep ? randomUUID() : null
    const thumbFileId = haveThumb ? randomUUID() : null

    const ingest = async (
      fileId: string,
      src: string,
      origName: string,
      category: 'cad_model' | 'thumbnail',
      isPrimary: boolean,
      cadMeta: object | null = null,
    ): Promise<void> => {
      const buf = readFileSync(src)
      const hash = createHash('sha256').update(buf).digest('hex')
      const sanitized = sanitizeFilename(origName)
      const storagePath = generateStoragePath(masterId, 'A', fileId, 1, sanitized)
      const dst = join(VAULT_ROOT, storagePath)
      mkdirSync(dirname(dst), { recursive: true })
      copyFileSync(src, dst)

      const ext = origName.slice(origName.lastIndexOf('.'))
      await db.insert(vaultFiles).values({
        id: fileId,
        itemId,
        branchId: mainBranch.id,
        fileName: sanitized,
        originalFileName: origName,
        fileSize: statSync(src).size,
        mimeType: mimeTypeFor(ext),
        fileHash: hash,
        storageType: 'local',
        storagePath,
        fileVersion: 1,
        isLatestVersion: true,
        isCheckedOut: false,
        uploadedBy: admin.id,
        fileCategory: category,
        isPrimaryModel: isPrimary,
        ...(cadMeta ? { cadMetadata: cadMeta } : {}),
      })
    }

    // GLB is always the primary cad_model — that's what the 3D viewer renders.
    // hasColors=true tells the viewer to keep the embedded glTF materials
    // instead of overriding with its uniform gray preset.
    await ingest(glbFileId, glbSrc, `${part.cadFileBase}.glb`, 'cad_model', true, { units: 'mm', hasColors: true })
    // STEP secondary, only if developer kept it locally.
    if (stepFileId) {
      await ingest(stepFileId, stepSrc, `${part.cadFileBase}.step`, 'cad_model', false, { units: 'mm' })
    }
    if (thumbFileId) {
      await ingest(thumbFileId, thumbSrc, `${part.cadFileBase}.png`, 'thumbnail', false)
      const linkIds = [glbFileId, stepFileId].filter((x): x is string => x !== null)
      for (const id of linkIds) {
        await db
          .update(vaultFiles)
          .set({ thumbnailFileId: thumbFileId })
          .where(eq(vaultFiles.id, id))
      }
      vaultComplete++
    } else {
      vaultGlbOnly++
    }
  }

  console.log(
    `✓ Vault files: ${vaultComplete} complete (GLB + thumbnail)`
    + (vaultGlbOnly ? `, ${vaultGlbOnly} GLB-only` : '')
    + (vaultMissing ? `, ${vaultMissing} parts had no GLB on disk` : ''),
  )
}

// ---- 9. Initial Release ECO -----------------------------------------------

if (SKIP_ECO) {
  console.log('   DEMO_SKIP_ECO=true → skipping ECO release')
} else {
  // Insert ChangeOrder item. ChangeOrders are design-agnostic (no designId).
  await db.insert(items).values({
    id: IDS.ecoItem,
    masterId: IDS.ecoItem,
    designId: null,
    itemNumber: 'ECO-2026-001',
    revision: 'A',
    itemType: 'ChangeOrder',
    name: 'Initial Release - TDJ-25 Robot Arm',
    state: 'Approved',
    isCurrent: true,
    createdBy: admin.id,
    modifiedBy: admin.id,
  })

  await db.insert(changeOrders).values({
    itemId: IDS.ecoItem,
    changeType: 'ECO',
    priority: 'medium',
    reasonForChange:
      'Initial release of the TDJ-25 robot arm assembly to baseline the demo dataset.',
    impactDescription: 'Establishes the first released revision (A) for all parts.',
    submittedAt: new Date(),
    approvedAt: new Date(),
    approvedBy: admin.id,
    impactAssessmentStatus: 'complete',
  })

  // Affected items: every Part. Insert in chunks.
  const affectedRows = sortedParts.map((p) => ({
    changeOrderId: IDS.ecoItem,
    affectedItemId: itemIdByNumber.get(p.itemNumber)!,
    affectedItemMasterId: masterIdByNumber.get(p.itemNumber)!,
    changeAction: 'release',
    currentState: 'Draft',
    currentRevision: 'A',
    targetState: 'Released',
    targetRevision: 'A',
    isDirectlyAffected: true,
    createdBy: admin.id,
  }))

  for (const batch of chunk(affectedRows, 500)) {
    await db.insert(changeOrderAffectedItems).values(batch)
  }

  // Bulk-flip every part to Released state. Direct UPDATE bypasses the workflow engine —
  // for seed data this matches the post-merge end state without firing transition actions.
  const partIds = sortedParts.map((p) => itemIdByNumber.get(p.itemNumber)!)
  for (const batch of chunk(partIds, 500)) {
    // Drizzle doesn't have a clean inArray for Updates without an extra import; do per-id update for simplicity.
    for (const id of batch) {
      await db.update(items).set({ state: 'Released' }).where(eq(items.id, id))
    }
  }

  console.log(`✓ ECO-2026-001 released (${affectedRows.length} parts → Released)`)
}

// ---- Summary --------------------------------------------------------------

console.log()
console.log('Demo seed complete.')
console.log(`   Program:       ROBOT-ARM`)
console.log(`   Design:        ${manifest.metadata.designCode}`)
console.log(`   Parts:         ${prepared.length}`)
console.log(`   Relationships: ${relRows.length}`)
console.log(`   Vault GLB+thumb: ${vaultComplete}`)
console.log(`   Login:         admin@cascadia.local / Cascadia`)

process.exit(0)
