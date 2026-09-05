// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Demo seed: TDJ-25 Robot Arm.
 *
 * Reads demo-data/robot-arm/manifest.json and creates a ROBOT-ARM program,
 * a TDJ-25 design, ~88 parts, ~101 BOM relationships, and ~79 GLB + thumbnail
 * vault file pairs. Optionally releases an ECO-001 baseline.
 *
 * The dataset is not in this repo — it lives in Cascadia-PLM/Demo-Data. Fetch it
 * with `npm run demo:fetch` on a host, or mount it at DEMO_DATA_DIR in a
 * container (docker-compose.demo.yml does this from the published image).
 *
 * Idempotent: skips entirely if a program with code 'ROBOT-ARM' already exists.
 *
 * Run with:
 *   npm run demo:fetch && npm run seed:demo
 *
 * Env:
 *   DEMO_DATA_DIR    root of demo data (default: ./demo-data inside container, ./demo-data on host)
 *   VAULT_ROOT       vault root for direct file copies (default: ./vault on host, /app/vault in container)
 *   DEMO_SKIP_ECO    set to 'true' to skip the Initial Release ECO step
 *   DEMO_SKIP_FILES  set to 'true' to skip vault file ingestion (DB rows + parts only)
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '../packages/core/src/lib/db/index.ts'
import { users } from '../packages/core/src/lib/db/schema/users.ts'
import {
  programMembers,
  programs,
} from '../packages/core/src/lib/db/schema/programs.ts'
import { designs } from '../packages/core/src/lib/db/schema/designs.ts'
import {
  branchItems,
  branches,
  commits,
  itemVersions,
} from '../packages/core/src/lib/db/schema/versioning.ts'
import {
  changeOrderAffectedItems,
  changeOrderDesigns,
  changeOrders,
  itemRelationships,
  items,
  parts,
} from '../packages/core/src/lib/db/schema/items.ts'
import { vaultFiles } from '../packages/core/src/lib/db/schema/vault.ts'
import {
  generateStoragePath,
  sanitizeFilename,
} from '../packages/core/src/lib/vault/utils/file-utils.ts'
import { takeFirst } from '../packages/core/src/lib/db/take-first'
import { DemoDataMissing } from './demo-seed-types.ts'
import type { DatasetResult } from './demo-seed-types.ts'

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

/**
 * Seed the TDJ-25 robot arm. Returns without seeding when it is already there,
 * so running the demo seed twice is a no-op rather than a duplicate.
 */
export async function seedRobotArm(): Promise<DatasetResult> {
  // ---- 1. Look up admin ------------------------------------------------------

  const adminRows = await db
    .select()
    .from(users)
    .where(eq(users.email, 'admin@cascadia.local'))
    .limit(1)

  const admin = adminRows.at(0)
  if (!admin) {
    throw new Error(
      'No admin@cascadia.local user in this database. Run: npm run db:seed',
    )
  }

  // ---- 2. Idempotency: skip if already seeded --------------------------------

  const existingProgram = await db
    .select()
    .from(programs)
    .where(eq(programs.code, 'ROBOT-ARM'))
    .limit(1)

  if (existingProgram.length > 0) {
    return { seeded: false, note: 'ROBOT-ARM already present' }
  }

  // ---- 3. Read manifest ------------------------------------------------------

  if (!existsSync(MANIFEST_PATH)) {
    throw new DemoDataMissing([
      `Manifest not found at ${MANIFEST_PATH}.`,
      'The demo dataset lives in Cascadia-PLM/Demo-Data, not this repo.',
      'Fetch it with:  npm run demo:fetch',
    ])
  }

  const manifest: Manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'))

  console.log(
    `   parts: ${manifest.parts.length}, relationships: ${manifest.relationships.length}`,
  )

  // A half-fetched dataset used to seed "successfully" with zero vault files: every
  // part fell through the !haveGlb branch below and the demo came up with no 3D
  // models. Fail here instead, while the cause is still obvious.
  if (!SKIP_FILES) {
    const expectedGlb = manifest.parts.filter((p) => p.cadFileBase).length
    const actualGlb = existsSync(GLB_DIR)
      ? readdirSync(GLB_DIR).filter((f) => f.toLowerCase().endsWith('.glb'))
          .length
      : -1

    if (actualGlb === -1) {
      throw new DemoDataMissing([
        `Manifest is present but ${GLB_DIR} is missing.`,
        'The dataset is incomplete. Re-fetch it with:  npm run demo:fetch',
      ])
    }
    if (actualGlb < expectedGlb) {
      throw new DemoDataMissing([
        `Dataset is incomplete: manifest expects ${expectedGlb} GLB files, found ${actualGlb} in ${GLB_DIR}.`,
        'Re-fetch it with:  npm run demo:fetch',
        'To seed database rows without any CAD files, set DEMO_SKIP_FILES=true.',
      ])
    }
  }

  // Everything below writes, and it writes as one transaction.
  //
  // A half-applied demo seed is worse than none: the program row goes in first,
  // and the idempotency check above keys on exactly that, so a run that died
  // partway used to leave a database that could never be re-seeded — every retry
  // saw ROBOT-ARM and exited 0 having done nothing.

  let partCount = 0
  let relCount = 0
  let vaultComplete = 0 // GLB + thumbnail both present
  let vaultGlbOnly = 0 // GLB but no thumbnail
  let vaultMissing = 0 // no GLB at all

  /** Vault blobs to copy once the rows referencing them are committed. */
  const pendingCopies: Array<{ src: string; dst: string }> = []

  await db.transaction(async (tx) => {
    // ---- 4. Create Program -----------------------------------------------------

    await tx
      .insert(programs)
      .values({
        id: IDS.program,
        name: 'Robot Arm Program',
        code: 'ROBOT-ARM',
        description:
          'TDJ-25 6-DOF robot arm — sample dataset for the Cascadia demo.',
        status: 'Active',
        customer: 'Cascadia Demo',
        createdBy: admin.id,
      })
      .onConflictDoNothing()

    await tx
      .insert(programMembers)
      .values({
        programId: IDS.program,
        userId: admin.id,
        role: 'admin',
        canCreateEco: true,
        canApproveEco: true,
        canManageDesigns: true,
      })
      .onConflictDoNothing()

    console.log('✓ Program ROBOT-ARM')

    // ---- 5. Create Design + main branch + initial commit -----------------------

    await tx.insert(designs).values({
      id: IDS.design,
      programId: IDS.program,
      name: manifest.metadata.name,
      code: manifest.metadata.designCode,
      description:
        'TDJ-25 robot arm — 6-DOF demonstration assembly with ~88 parts.',
      designType: 'Engineering',
      createdBy: admin.id,
    })

    // Branch first, commit second.
    //
    // `branches` and `commits` point at each other, so one insert has to go in
    // incomplete — the question is which. It has to be the branch: its
    // `head_commit_id` and `base_commit_id` are nullable, while `commits.branch_id`
    // is NOT NULL behind a validated, non-deferrable foreign key. An earlier
    // version inserted the commit first with the design's id as a placeholder
    // `branchId`, meaning to patch it once the branch existed; Postgres rejects
    // that on the spot, so `db:seed:demo` died here having already committed the
    // program row — and the idempotency check above then made every retry a no-op.
    const mainBranch = takeFirst(
      await tx
        .insert(branches)
        .values({
          designId: IDS.design,
          name: 'main',
          branchType: 'main',
          createdBy: admin.id,
        })
        .returning(),
    )

    const initialCommit = takeFirst(
      await tx
        .insert(commits)
        .values({
          designId: IDS.design,
          branchId: mainBranch.id,
          message: 'Initial commit',
          createdBy: admin.id,
        })
        .returning(),
    )

    await tx
      .update(branches)
      .set({ headCommitId: initialCommit.id, baseCommitId: initialCommit.id })
      .where(eq(branches.id, mainBranch.id))
    await tx
      .update(designs)
      .set({ defaultBranchId: mainBranch.id })
      .where(eq(designs.id, IDS.design))

    console.log(
      `✓ Design ${manifest.metadata.designCode} (main branch + initial commit)`,
    )

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
      await tx
        .insert(items)
        .values(batch.map((p) => p.itemRow))
        .onConflictDoNothing()
      await tx
        .insert(parts)
        .values(batch.map((p) => p.partRow))
        .onConflictDoNothing()
    }

    partCount = prepared.length
    console.log(`✓ Inserted ${prepared.length} parts`)

    // ---- 6b. Track every part on the main branch ------------------------------
    //
    // A real ECO merge leaves every released item tracked in branch_items on main
    // (currentItemId = the item, changeType = null). The seed must do the same.
    // Otherwise main's branch_items starts empty and the app leans on its
    // isCurrent fallback — which the first real ECO release defeats: the merge
    // partially populates branch_items with only the ECO's items, flipping every
    // "released baseline" resolver out of the fallback and collapsing the Design
    // Structure to just those items.
    const branchItemRows: Array<typeof branchItems.$inferInsert> =
      sortedParts.map((p) => ({
        branchId: mainBranch.id,
        itemMasterId: masterIdByNumber.get(p.itemNumber)!,
        currentItemId: itemIdByNumber.get(p.itemNumber)!,
        baseItemId: itemIdByNumber.get(p.itemNumber)!,
        changeType: null,
      }))
    for (const batch of chunk(branchItemRows, 500)) {
      await tx.insert(branchItems).values(batch).onConflictDoNothing()
    }
    console.log(`✓ Tracked ${branchItemRows.length} parts on main branch`)

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

    relCount = relRows.length
    for (const batch of chunk(relRows, 500)) {
      await tx.insert(itemRelationships).values(batch)
    }

    console.log(
      `✓ Inserted ${relRows.length} BOM relationships${skippedRels ? ` (skipped ${skippedRels})` : ''}`,
    )

    // ---- 8. Vault files (GLB + thumbnail per part; STEP optional) ------------
    //
    // The shipped demo data contains GLB + thumbnails only — STEPs are build-time
    // assets (input to the cad-converter, then dropped from the repo). The GLB is
    // the primary model; users get a 3D viewer immediately. If a STEP file IS on
    // disk (developer workflow), it's ingested as a secondary cad_model row.

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
          const storagePath = generateStoragePath(
            masterId,
            'A',
            fileId,
            1,
            sanitized,
          )
          // Queued, not copied: a filesystem write cannot roll back, so the
          // copies happen once the transaction has committed.
          pendingCopies.push({ src, dst: join(VAULT_ROOT, storagePath) })

          const ext = origName.slice(origName.lastIndexOf('.'))
          await tx.insert(vaultFiles).values({
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
        await ingest(
          glbFileId,
          glbSrc,
          `${part.cadFileBase}.glb`,
          'cad_model',
          true,
          { units: 'mm', hasColors: true },
        )
        // STEP secondary, only if developer kept it locally.
        if (stepFileId) {
          await ingest(
            stepFileId,
            stepSrc,
            `${part.cadFileBase}.step`,
            'cad_model',
            false,
            { units: 'mm' },
          )
        }
        if (thumbFileId) {
          await ingest(
            thumbFileId,
            thumbSrc,
            `${part.cadFileBase}.png`,
            'thumbnail',
            false,
          )
          const linkIds = [glbFileId, stepFileId].filter(
            (x): x is NonNullable<typeof x> => x !== null,
          )
          for (const id of linkIds) {
            await tx
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
        `✓ Vault files: ${vaultComplete} complete (GLB + thumbnail)` +
          (vaultGlbOnly ? `, ${vaultGlbOnly} GLB-only` : '') +
          (vaultMissing ? `, ${vaultMissing} parts had no GLB on disk` : ''),
      )
    }

    // ---- 9. Initial Release ECO -----------------------------------------------

    if (SKIP_ECO) {
      console.log('   DEMO_SKIP_ECO=true → skipping ECO release')
    } else {
      // Insert ChangeOrder item. A change order carries no `designId` of its own —
      // it spans designs, and the link rows below are what say which. They are not
      // optional: a change order linked to no design sits outside every program,
      // which is what places it inside one for access control.
      await tx.insert(items).values({
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

      await tx.insert(changeOrders).values({
        itemId: IDS.ecoItem,
        changeType: 'ECO',
        priority: 'medium',
        reasonForChange:
          'Initial release of the TDJ-25 robot arm assembly to baseline the demo dataset.',
        impactDescription:
          'Establishes the first released revision (A) for all parts.',
        submittedAt: new Date(),
        approvedAt: new Date(),
        approvedBy: admin.id,
        impactAssessmentStatus: 'complete',
      })

      await tx.insert(changeOrderDesigns).values({
        changeOrderId: IDS.ecoItem,
        designId: IDS.design,
        branchId: mainBranch.id,
        mergeStatus: 'merged',
        mergedAt: new Date(),
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
        await tx.insert(changeOrderAffectedItems).values(batch)
      }

      const partIds = sortedParts.map((p) => itemIdByNumber.get(p.itemNumber)!)

      // Record the release in the version substrate exactly as a real ECO merge
      // would: a release commit on main carrying one itemVersion per part, with
      // main HEAD advanced to it. Commit-ancestry resolution (VersionResolver) walks
      // itemVersions; without these rows the released baseline is invisible to every
      // path that walks the commit graph, and — like the missing branch_items — a
      // later ECO release collapses the design view to only the ECO's items.
      const releaseCommit = takeFirst(
        await tx
          .insert(commits)
          .values({
            designId: IDS.design,
            branchId: mainBranch.id,
            parentId: initialCommit.id,
            message: `Released via ECO: ECO-2026-001`,
            changeOrderItemId: IDS.ecoItem,
            revisionsAssigned: Object.fromEntries(
              sortedParts.map((p) => [p.itemNumber, 'A']),
            ),
            itemsAdded: sortedParts.length,
            createdBy: admin.id,
          })
          .returning(),
      )

      await tx
        .update(branches)
        .set({ headCommitId: releaseCommit.id })
        .where(eq(branches.id, mainBranch.id))

      const versionRows: Array<typeof itemVersions.$inferInsert> = partIds.map(
        (id) => ({
          commitId: releaseCommit.id,
          itemId: id,
          changeType: 'added',
        }),
      )
      for (const batch of chunk(versionRows, 500)) {
        await tx.insert(itemVersions).values(batch).onConflictDoNothing()
      }

      // Flip every part to Released. Direct UPDATE bypasses the workflow engine —
      // for seed data this matches the post-merge end state without firing
      // transition actions. branch_items already points at these rows (§6b), so the
      // release advances state only, not the current-version pointer.
      for (const batch of chunk(partIds, 500)) {
        // Drizzle doesn't have a clean inArray for Updates without an extra import; do per-id update for simplicity.
        for (const id of batch) {
          await tx
            .update(items)
            .set({ state: 'Released' })
            .where(eq(items.id, id))
        }
      }

      console.log(
        `✓ ECO-2026-001 released (${affectedRows.length} parts → Released, commit ${releaseCommit.id.slice(0, 8)})`,
      )
    }
  })

  // Now that the rows are committed, put the blobs where they say they are.
  for (const { src, dst } of pendingCopies) {
    mkdirSync(dirname(dst), { recursive: true })
    copyFileSync(src, dst)
  }

  // ---- Summary --------------------------------------------------------------

  return {
    seeded: true,
    note:
      `ROBOT-ARM / ${manifest.metadata.designCode} — ${partCount} parts, ` +
      `${relCount} BOM edges, ${vaultComplete} GLB+thumbnail pairs`,
  }
}
