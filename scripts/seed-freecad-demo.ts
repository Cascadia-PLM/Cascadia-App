// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Demo seed: the FreeCAD/KiCad datasets (PUC powered utility cart, USV survey
 * catamaran).
 *
 * Replays the baked bundle from Cascadia-PLM/Demo-Data - the whole demo, not
 * just its CAD: parts and assemblies with BOM and AML, requirements and V&V,
 * ECO history, KiCad boards and Software items, MES travelers, work orders and
 * serialized units with genealogy, harnesses and drawings.
 *
 * Where the Python pipeline that authored this needs FreeCAD 1.1, KiCad 10,
 * Docker CAD workers, a live server and 1-2 hours, this needs a database.
 *
 *   npm run demo:fetch && npm run seed:demo
 *
 * Idempotent: skips entirely if the first baked program already exists.
 *
 * Env:
 *   DEMO_DATA_DIR    root of the demo data (default: ./demo-data)
 *   VAULT_ROOT       vault root for direct file copies (default: ./vault)
 *   DEMO_SKIP_FILES  set to 'true' to seed rows only, no vault blobs
 *
 * ## Why it can insert rows blind
 *
 * The bundle carries a topological `insertOrder` and, for the FK cycles that
 * order cannot express, the `deferred` columns to leave null on the way in and
 * patch afterwards. So this script needs no schema knowledge of its own; it
 * walks the order it was given.
 *
 * Rows go in through `json_populate_recordset(null::<table>, $1::json)`, which
 * hands Postgres the JSON and lets it parse each value into the column's own
 * type. That is what keeps timestamps, JSONB payloads, arrays and enums working
 * without this script carrying a type table - and, as a bonus, it ignores keys
 * that are not columns, which is how `vault_files.content_sha256` (the bake's
 * pointer at a blob) rides along without needing to be stripped.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sql } from 'drizzle-orm'
import { db } from '../packages/core/src/lib/db/index.ts'
import { generateStoragePath } from '../packages/core/src/lib/vault/utils/file-utils.ts'
import { DemoDataMissing } from './demo-seed-types.ts'
import type { DatasetResult } from './demo-seed-types.ts'

// ============================================================================
// Config
// ============================================================================

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')

const DEMO_DATA_DIR = process.env.DEMO_DATA_DIR ?? join(REPO_ROOT, 'demo-data')
const BUNDLE_DIR = join(DEMO_DATA_DIR, 'freecad-demo')
const MANIFEST_PATH = join(BUNDLE_DIR, 'manifest.json')
const BUNDLE_FILES_DIR = join(BUNDLE_DIR, 'files')

const VAULT_ROOT = process.env.VAULT_ROOT ?? join(REPO_ROOT, 'vault')
const SKIP_FILES = process.env.DEMO_SKIP_FILES === 'true'

/** Must match `FORMAT_VERSION` in the bake script. */
const SUPPORTED_FORMAT = 1

const MAX_ROWS = 250
const MAX_BYTES = 4 * 1024 * 1024

// ============================================================================
// Bundle types
// ============================================================================

type Row = Record<string, unknown>

interface Manifest {
  formatVersion: number
  generatedAt: string
  idNamespace: string
  source: { database: string; programs: Array<string> }
  insertOrder: Array<string>
  deferred: Record<string, Array<string>>
  /** Table -> the single column the deferred patch matches rows on. */
  deferredKeys: Record<string, string>
  /** Item type -> the lifecycle it was on when the bundle was baked. */
  itemTypeLifecycles: Record<string, string | null>
  counts: Record<string, number>
  blobs: Record<string, number>
  sequences: Array<{ itemType: string; scopeKey: string; currentValue: number }>
}

/**
 * Batch rows for one statement, capped on both count and serialized size.
 *
 * Row count alone is the wrong unit here. Most tables are small and uniform,
 * but `software_blobs` carries whole source files inline, so a flat 250 rows
 * would build a single multi-megabyte statement out of the firmware tree. Cap
 * the payload too, and let a row larger than the cap through on its own rather
 * than looping forever trying to fit it.
 */
function batches(rows: Array<Row>): Array<Array<Row>> {
  const out: Array<Array<Row>> = []
  let current: Array<Row> = []
  let bytes = 0
  for (const row of rows) {
    const size = JSON.stringify(row).length
    if (
      current.length > 0 &&
      (current.length >= MAX_ROWS || bytes + size > MAX_BYTES)
    ) {
      out.push(current)
      current = []
      bytes = 0
    }
    current.push(row)
    bytes += size
  }
  if (current.length > 0) out.push(current)
  return out
}

function readTable(table: string): Array<Row> {
  const path = join(BUNDLE_DIR, 'tables', `${table}.json`)
  if (!existsSync(path)) return []
  return JSON.parse(readFileSync(path, 'utf-8')) as Array<Row>
}

// ============================================================================
// Preflight
// ============================================================================

/**
 * Seed the FreeCAD/KiCad datasets. Returns without seeding when they are already
 * there, so running the demo seed twice is a no-op rather than a duplicate.
 */
export async function seedFreecadDemo(): Promise<DatasetResult> {
  if (!existsSync(MANIFEST_PATH)) {
    throw new DemoDataMissing([
      `No bundle at ${MANIFEST_PATH}.`,
      'The dataset lives in Cascadia-PLM/Demo-Data, not this repo.',
      'Fetch it with:  npm run demo:fetch',
    ])
  }

  const manifest: Manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'))

  if (manifest.formatVersion !== SUPPORTED_FORMAT) {
    throw new DemoDataMissing([
      `Bundle is format ${manifest.formatVersion}; this seed speaks ${SUPPORTED_FORMAT}.`,
      'Re-fetch the dataset:  npm run demo:fetch',
    ])
  }

  // ---- Admin user ------------------------------------------------------------
  //
  // Every baked row carries the source database's `created_by`, which the bake
  // deliberately did not remap - the seed target is expected to have the same
  // admin from `npm run db:seed`. If it does not, the very first insert fails on
  // a foreign key with nothing to say about why.

  const adminRows = (await db.execute(
    sql`select id from users where email = 'admin@cascadia.local' limit 1`,
  )) as unknown as Array<{ id: string }>

  if (adminRows.length === 0) {
    throw new Error(
      'No admin@cascadia.local user in this database. Run: npm run db:seed',
    )
  }

  // ---- Idempotency -----------------------------------------------------------

  // Not `= any(${array}::text[])`: Drizzle expands a JS array into one bound
  // parameter per element, so a single-program bundle would arrive as a bare
  // scalar and Postgres would reject it as a malformed array literal.
  const existing = (await db.execute(
    sql`select code from programs
        where code in (select jsonb_array_elements_text(${JSON.stringify(manifest.source.programs)}::jsonb))`,
  )) as unknown as Array<{ code: string }>

  if (existing.length > 0) {
    return {
      seeded: false,
      note: `${existing.map((r) => r.code).join(', ')} already present`,
    }
  }

  // ---- Lifecycles ------------------------------------------------------------
  //
  // Baked rows carry literal `state` strings, which only mean anything against
  // the lifecycle the item type was on when the bundle was baked. `db:seed`
  // installs the shipped ones and the demo does not touch them, so this normally
  // matches exactly — but if an operator has re-linked an item type, the seeded
  // items land in states their lifecycle has never heard of. Warn rather than
  // refuse: the rest of the demo is still worth having, and only the affected
  // types misbehave.

  const targetLifecycles = (await db.execute(
    sql`select item_type, config->>'lifecycleDefinitionId' as lifecycle_id
        from item_type_configs`,
  )) as unknown as Array<{ item_type: string; lifecycle_id: string | null }>

  const targetByType = new Map(
    targetLifecycles.map((r) => [r.item_type, r.lifecycle_id]),
  )
  const lifecycleDrift = Object.entries(manifest.itemTypeLifecycles).filter(
    ([type, baked]) =>
      targetByType.has(type) && targetByType.get(type) !== baked,
  )

  if (lifecycleDrift.length > 0) {
    console.warn(
      `[warn] ${lifecycleDrift.length} item type(s) are on a different lifecycle here than when this bundle was baked:`,
    )
    for (const [type] of lifecycleDrift.slice(0, 5)) {
      console.warn(`[warn]   ${type}`)
    }
    console.warn(
      '[warn] Seeded items of those types may sit in states their lifecycle does not define.',
    )
  }

  // ---- Bundle completeness ---------------------------------------------------

  if (!SKIP_FILES) {
    const expected = Object.keys(manifest.blobs).length
    const actual = existsSync(BUNDLE_FILES_DIR)
      ? readdirSync(BUNDLE_FILES_DIR).length
      : -1
    if (actual < expected) {
      throw new DemoDataMissing([
        `Bundle is incomplete: manifest lists ${expected} blobs, found ${actual === -1 ? 'no files/ directory' : actual}.`,
        'Re-fetch it with:  npm run demo:fetch',
        'To seed rows without vault files, set DEMO_SKIP_FILES=true.',
      ])
    }
  }

  // ============================================================================
  // 1. Vault paths
  // ============================================================================
  //
  // Storage paths embed the item's master id and the file's own id, both of which
  // the bake remapped, so the source paths are meaningless here. Regenerate them
  // with the same helper the upload path uses, before the rows are inserted -
  // `storage_path` is what every later read resolves against.

  const itemRows = readTable('items')
  const itemById = new Map(itemRows.map((r) => [String(r.id), r]))

  const vaultRows = readTable('vault_files')
  const blobForFile = new Map<string, string>()

  for (const row of vaultRows) {
    const item = itemById.get(String(row.item_id))
    if (!item) continue
    const fileName = String(row.file_name)
    const storagePath = generateStoragePath(
      String(item.master_id),
      String(item.revision),
      String(row.id),
      Number(row.file_version ?? 1),
      fileName,
    )
    row.storage_path = storagePath
    const hash = row.content_sha256
    if (typeof hash === 'string') blobForFile.set(String(row.id), hash)
  }

  // ============================================================================
  // 2. Insert every table, in the order the bake computed
  // ============================================================================

  const tableRows = new Map<string, Array<Row>>()
  for (const table of manifest.insertOrder) {
    tableRows.set(table, table === 'vault_files' ? vaultRows : readTable(table))
  }

  // All of it in one transaction. A demo seed that dies halfway leaves a database
  // that is neither empty nor seeded, and — because the idempotency check above
  // keys on the program row, which goes in first — a retry then exits 0 having
  // done nothing. Either it all lands or none of it does.

  let inserted = 0

  await db.transaction(async (tx) => {
    for (const table of manifest.insertOrder) {
      const rows = tableRows.get(table) ?? []
      if (rows.length === 0) continue

      const deferredCols = manifest.deferred[table] ?? []

      // Cut the deferred columns out entirely rather than setting them to null:
      // json_populate_recordset gives a missing key the column default, which for
      // these is null, and an absent key cannot be mistaken for an intended null.
      const payload =
        deferredCols.length === 0
          ? rows
          : rows.map((row) => {
              const copy: Row = { ...row }
              for (const c of deferredCols) delete copy[c]
              return copy
            })

      for (const batch of batches(payload)) {
        await tx.execute(
          sql`insert into ${sql.identifier(table)}
              select * from json_populate_recordset(null::${sql.identifier(table)}, ${JSON.stringify(batch)}::json)`,
        )
      }

      inserted += rows.length
      console.log(`   ${String(rows.length).padStart(6)}  ${table}`)
    }

    // ---- Patch the deferred columns -----------------------------------------
    //
    // These are the FK cycles the insert order could not linearise -
    // designs.default_branch_id against branches.design_id, and the commit
    // chain's self-references. Everything they point at exists by now.

    for (const [table, cols] of Object.entries(manifest.deferred)) {
      const rows = tableRows.get(table) ?? []
      const needing = rows.filter((r) => cols.some((c) => r[c] != null))
      if (needing.length === 0) continue

      const assignments = cols.map(
        (c) => sql`${sql.identifier(c)} = s.${sql.identifier(c)}`,
      )
      const key = manifest.deferredKeys[table]
      if (!key) {
        throw new Error(
          `Bundle defers ${table} columns but names no key to patch by.`,
        )
      }

      for (const batch of batches(needing)) {
        await tx.execute(
          sql`update ${sql.identifier(table)} as t
              set ${sql.join(assignments, sql`, `)}
              from json_populate_recordset(null::${sql.identifier(table)}, ${JSON.stringify(batch)}::json) as s
              where t.${sql.identifier(key)} = s.${sql.identifier(key)}`,
        )
      }
      console.log(`   patched ${needing.length} ${table} (${cols.join(', ')})`)
    }

    // ---- Advance the number sequences ----------------------------------------
    //
    // The demo consumed several hundred item numbers. Without this the next part
    // a user creates in the seeded demo is handed PUC-1001 again and collides
    // with a row that is already there.

    for (const seq of manifest.sequences) {
      await tx.execute(
        sql`insert into number_sequences (item_type, scope_key, current_value)
            values (${seq.itemType}, ${seq.scopeKey}, ${seq.currentValue})
            on conflict on constraint unique_sequence do update
            set current_value = greatest(number_sequences.current_value, excluded.current_value)`,
      )
    }
    if (manifest.sequences.length > 0) {
      console.log(`   advanced ${manifest.sequences.length} number sequences`)
    }
  })

  // ============================================================================
  // 3. Vault blobs
  // ============================================================================
  //
  // After the transaction, deliberately: a filesystem copy cannot roll back, so
  // blobs are written only once the rows they belong to are committed. A stray
  // blob left by a later failure is harmless; a row pointing at a file that was
  // rolled back is not.

  let copied = 0
  let missing = 0

  if (SKIP_FILES) {
    console.log('   DEMO_SKIP_FILES=true - skipping vault file ingestion')
  } else {
    for (const row of vaultRows) {
      const hash = blobForFile.get(String(row.id))
      if (!hash) {
        missing++
        continue
      }
      const src = join(BUNDLE_FILES_DIR, hash)
      if (!existsSync(src)) {
        missing++
        continue
      }
      const dst = join(VAULT_ROOT, String(row.storage_path))
      mkdirSync(dirname(dst), { recursive: true })
      copyFileSync(src, dst)
      copied++
    }
    console.log(
      `   ${copied} vault files copied` +
        (missing > 0 ? `, ${missing} had no blob in the bundle` : ''),
    )
  }

  // ============================================================================
  // Summary
  // ============================================================================

  return {
    seeded: true,
    note:
      `${manifest.source.programs.join(', ')} — ${inserted} rows, ` +
      `${copied} vault files, baked ${manifest.generatedAt.slice(0, 10)}`,
  }
}
