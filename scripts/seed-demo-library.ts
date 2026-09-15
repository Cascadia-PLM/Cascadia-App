// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Demo seed: Standard Parts Library components.
 *
 * Reads demo-data/standard-library/manifest.json and creates unreleased Part
 * items in the Standard Parts Library, each with its GLB and a thumbnail.
 *
 * ## Why this is its own dataset
 *
 * The other two datasets own their programs — `ROBOT-ARM` and `PUC`/`USV` —
 * and can therefore create everything they need, ids included. The Standard
 * Parts Library cannot be owned: `db:seed` creates it on every install as a
 * *global* design (no program) with a fixed id but a `gen_random_uuid()` main
 * branch and initial commit. Nothing baked or pre-numbered could reference
 * those, which is why the FreeCAD bundle — a database bake scoped to programs —
 * refuses it outright. So the library ships the way the robot arm does, as a
 * manifest plus models, and this seeder resolves the library on the target
 * before it writes anything.
 *
 * Item numbers are allocated here, not carried in the dataset, for the same
 * reason: a library part draws from the shared `Part` sequence, the very one a
 * user creating a library part by hand draws from. A dataset that pinned
 * `PN-000001` would collide with whatever that install had already made. The
 * manifest keys parts by model name instead, and the key is recorded on the
 * item so a re-run recognises its own work.
 *
 * The parts are deliberately left **unreleased** (revision A, Draft) and belong
 * to no BOM: the library is where a component sits while it is still a
 * candidate, and the demo needs that state to be visible.
 *
 * Idempotent: skips entirely if the library already holds these keys.
 *
 * Env:
 *   DEMO_DATA_DIR    root of demo data (default: ./demo-data)
 *   VAULT_ROOT       vault root for direct file copies (default: ./vault)
 *   DEMO_SKIP_FILES  'true' seeds rows only — no vault blobs, no 3D models
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@cascadia/api/lib/db'
import { users } from '@cascadia/api/lib/db/schema/users'
import { designs } from '@cascadia/api/lib/db/schema/designs'
import { branchItems, branches } from '@cascadia/api/lib/db/schema/versioning'
import { items, parts } from '@cascadia/api/lib/db/schema/items'
import { vaultFiles } from '@cascadia/api/lib/db/schema/vault'
import {
  generateStoragePath,
  sanitizeFilename,
} from '@cascadia/api/lib/vault/utils/file-utils'
import { takeFirst } from '@cascadia/api/lib/db/take-first'
import { DemoDataMissing } from './demo-seed-types.ts'
import type { DatasetResult } from './demo-seed-types.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')

const DEMO_DATA_DIR = process.env.DEMO_DATA_DIR ?? join(REPO_ROOT, 'demo-data')
const LIBRARY_DIR = join(DEMO_DATA_DIR, 'standard-library')
const MANIFEST_PATH = join(LIBRARY_DIR, 'manifest.json')
const GLB_DIR = join(LIBRARY_DIR, 'glb')
const THUMB_DIR = join(LIBRARY_DIR, 'thumbnails')

const VAULT_ROOT = process.env.VAULT_ROOT ?? join(REPO_ROOT, 'vault')
const SKIP_FILES = process.env.DEMO_SKIP_FILES === 'true'

/** The library design `db:seed` creates, matched by code rather than id. */
const LIBRARY_CODE = 'STD-LIB'

/** Where the key that makes a re-run recognise its own rows is recorded. */
const KEY_ATTRIBUTE = 'libraryKey'

interface ManifestPart {
  key: string
  name: string
  description: string
  partType: string
  material: string
  manufacturer?: string | null
  manufacturerPartNumber?: string | null
  weightKg?: number | null
  bboxMm?: Array<number> | null
  cadFileBase: string
}

interface Manifest {
  metadata?: Record<string, unknown>
  parts: Array<ManifestPart>
}

function mimeTypeFor(ext: string): string {
  const map: Record<string, string> = {
    '.glb': 'model/gltf-binary',
    '.png': 'image/png',
  }
  return map[ext.toLowerCase()] ?? 'application/octet-stream'
}

export async function seedLibrary(): Promise<DatasetResult> {
  if (!existsSync(MANIFEST_PATH)) {
    throw new DemoDataMissing([
      `No Standard Parts Library dataset at ${LIBRARY_DIR}.`,
      'Fetch it with:  npm run demo:fetch',
    ])
  }

  const manifest: Manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'))
  if (manifest.parts.length === 0) {
    return { seeded: false, note: 'manifest lists no parts' }
  }

  const admin = takeFirst(
    await db
      .select()
      .from(users)
      .where(eq(users.email, 'admin@cascadia.local')),
    'admin user',
  )

  const library = (
    await db.select().from(designs).where(eq(designs.code, LIBRARY_CODE))
  ).at(0)
  if (!library) {
    throw new DemoDataMissing([
      `No ${LIBRARY_CODE} design — the Standard Parts Library is created by the minimal seed.`,
      'Run:  npm run db:seed',
    ])
  }

  const mainBranch = (
    await db
      .select()
      .from(branches)
      .where(and(eq(branches.designId, library.id), eq(branches.name, 'main')))
  ).at(0)
  if (!mainBranch) {
    throw new DemoDataMissing([
      `${LIBRARY_CODE} has no main branch — re-run:  npm run db:seed`,
    ])
  }

  // Idempotency by key, not by item number: the numbers are allocated per
  // install, so they say nothing about whether this dataset has run.
  const keys = manifest.parts.map((p) => p.key)
  const present = (await db
    .select({ key: sql<string>`${items.attributes} ->> ${KEY_ATTRIBUTE}` })
    .from(items)
    .where(
      and(
        eq(items.designId, library.id),
        sql`${items.attributes} ->> ${KEY_ATTRIBUTE} = any(${sql.param(keys)})`,
      ),
    )) as Array<{ key: string }>

  if (present.length > 0) {
    return {
      seeded: false,
      note: `already present (${present.length}/${keys.length} components)`,
    }
  }

  const pendingCopies: Array<{ src: string; dst: string }> = []

  await db.transaction(async (tx) => {
    // Reserve the numbers in one statement so a concurrent create cannot take
    // one in between — the same sequence the app's own numbering uses.
    const bumped = (await tx.execute(
      sql`insert into number_sequences (item_type, scope_key, current_value)
          values ('Part', 'Part', ${manifest.parts.length})
          on conflict on constraint unique_sequence do update
          set current_value = number_sequences.current_value + ${manifest.parts.length}
          returning current_value`,
    )) as unknown as Array<{ current_value: number }>
    const nextAfter = Number(bumped[0]?.current_value ?? manifest.parts.length)
    let n = nextAfter - manifest.parts.length

    for (const p of manifest.parts) {
      n += 1
      const itemNumber = `PN-${String(n).padStart(6, '0')}`
      const id = randomUUID()

      await tx.insert(items).values({
        id,
        masterId: id, // first revision: the item is its own master
        designId: library.id,
        commitId: mainBranch.headCommitId,
        itemNumber,
        revision: 'A',
        itemType: 'Part',
        name: p.name,
        state: 'Draft', // unreleased, deliberately
        isCurrent: true,
        inDesignStructure: true,
        attributes: {
          [KEY_ATTRIBUTE]: p.key,
          source: 'FreeCAD 1.1 headless build',
          ...(p.manufacturer ? { manufacturer: p.manufacturer } : {}),
          ...(p.manufacturerPartNumber
            ? { manufacturerPartNumber: p.manufacturerPartNumber }
            : {}),
          ...(p.bboxMm ? { bboxMm: JSON.stringify(p.bboxMm) } : {}),
        },
        createdBy: admin.id,
        modifiedBy: admin.id,
      })

      await tx.insert(parts).values({
        itemId: id,
        description: p.description,
        partType: p.partType,
        material: p.material,
        ...(p.weightKg != null
          ? { weight: p.weightKg.toFixed(4), weightUnit: 'kg' }
          : {}),
      })

      // Track it on main, exactly as a released item would be — otherwise the
      // library leans on the isCurrent fallback that the first ECO release
      // anywhere in the install defeats.
      await tx.insert(branchItems).values({
        branchId: mainBranch.id,
        itemMasterId: id,
        currentItemId: id,
        baseItemId: id,
        changeType: null,
      })

      if (SKIP_FILES) continue

      const ingest = async (
        src: string,
        origName: string,
        category: 'cad_model' | 'thumbnail',
        isPrimary: boolean,
        isItemThumbnail: boolean,
      ): Promise<void> => {
        const fileId = randomUUID()
        const buf = readFileSync(src)
        const sanitized = sanitizeFilename(origName)
        const storagePath = generateStoragePath(id, 'A', fileId, 1, sanitized)
        // Queued, not copied: a filesystem write cannot roll back, so the
        // copies happen once the transaction has committed.
        pendingCopies.push({ src, dst: join(VAULT_ROOT, storagePath) })
        await tx.insert(vaultFiles).values({
          id: fileId,
          itemId: id,
          branchId: mainBranch.id,
          fileName: sanitized,
          originalFileName: origName,
          fileSize: statSync(src).size,
          mimeType: mimeTypeFor(origName.slice(origName.lastIndexOf('.'))),
          fileHash: createHash('sha256').update(buf).digest('hex'),
          storageType: 'local',
          storagePath,
          fileVersion: 1,
          isLatestVersion: true,
          isCheckedOut: false,
          uploadedBy: admin.id,
          fileCategory: category,
          isPrimaryModel: isPrimary,
          isItemThumbnail,
        })
      }

      const glb = join(GLB_DIR, `${p.cadFileBase}.glb`)
      if (!existsSync(glb)) {
        throw new DemoDataMissing([
          `standard-library is missing glb/${p.cadFileBase}.glb.`,
          'Re-fetch it with:  npm run demo:fetch',
        ])
      }
      await ingest(glb, `${p.cadFileBase}.glb`, 'cad_model', true, false)

      const thumb = join(THUMB_DIR, `${p.cadFileBase}.png`)
      if (existsSync(thumb)) {
        await ingest(thumb, `${p.cadFileBase}.png`, 'thumbnail', false, true)
      }
    }
  })

  for (const { src, dst } of pendingCopies) {
    mkdirSync(dirname(dst), { recursive: true })
    copyFileSync(src, dst)
  }

  const files = SKIP_FILES ? 'rows only' : `${pendingCopies.length} vault files`
  return {
    seeded: true,
    note: `${LIBRARY_CODE} — ${manifest.parts.length} unreleased components, ${files}`,
  }
}
