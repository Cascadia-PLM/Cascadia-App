// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * No committed constraint or index name may exceed Postgres's identifier
 * limit (DBI2-7) — data-integrity gate.
 *
 * Postgres truncates every identifier at 63 bytes. It does so with a NOTICE,
 * not an error, so a longer name is accepted, silently shortened, and stored
 * under a string the schema never mentions again. Seventeen foreign keys had
 * been in that state since the baseline: the migrations asked for names of
 * 68-82 bytes and every database held their 63-byte prefixes. Nothing read the
 * names, so nothing broke — but a `DROP CONSTRAINT` written from the schema
 * would not have found them, and two names differing only past byte 63 would
 * have collided outright, the second `ADD CONSTRAINT` failing on a duplicate
 * the source made look distinct.
 *
 * This reads the committed artefact rather than a live database on purpose.
 * The names ship in `cascadia-app/drizzle/` and are what a customer's install
 * replays; the checked-in snapshot is where a too-long name first exists, one
 * `db:generate` before it reaches anyone. No database and no fixtures — the
 * guard costs a file read.
 *
 * Run: npx vitest run cascadia-api/src/db/constraint-name-length.test.ts
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
// The repo root by what it is, not by counting `..` from here — the same
// marker-based walk, and the same reason, as the dev MCP server's paths.
import { REPO_ROOT } from '@/mcp/repo-root'

/**
 * `NAMEDATALEN` is 64 and one byte goes to the terminator, so 63 bytes is the
 * most Postgres keeps. Bytes, not characters: truncation applies to the
 * encoded identifier.
 */
const MAX_IDENTIFIER_BYTES = 63

const byteLength = (name: string): number => Buffer.byteLength(name, 'utf8')

/** Every group scanned below is keyed by name, and each entry repeats it. */
const namedGroupSchema = z.record(z.string(), z.object({ name: z.string() }))

/**
 * Only the four groups that mint an identifier of their own. Columns and
 * composite primary keys take names Postgres derives from the table, and views
 * and policies are outside the finding.
 *
 * Parsing rather than casting is what keeps this honest: if drizzle-kit
 * reshapes the snapshot, the parse fails loudly instead of scanning an empty
 * object and reporting success.
 */
const snapshotSchema = z.object({
  tables: z.record(
    z.string(),
    z.object({
      foreignKeys: namedGroupSchema,
      uniqueConstraints: namedGroupSchema,
      checkConstraints: namedGroupSchema,
      indexes: namedGroupSchema,
    }),
  ),
})

const journalSchema = z.object({
  entries: z.array(z.object({ idx: z.number().int(), tag: z.string() })),
})

/** The app's committed migrations. */
const DRIZZLE_DIR = path.join(REPO_ROOT, 'cascadia-app', 'drizzle')

/** Every constraint and index name in the journal's newest snapshot. */
function headSnapshotNames(): Array<string> {
  const metaDir = path.join(DRIZZLE_DIR, 'meta')
  const journal = journalSchema.parse(
    JSON.parse(
      readFileSync(path.join(metaDir, '_journal.json'), { encoding: 'utf8' }),
    ),
  )

  const head = journal.entries.at(-1)
  if (!head) {
    throw new Error('The migration journal is empty.')
  }

  const prefix = String(head.idx).padStart(4, '0')
  const snapshotFile = path.join(metaDir, `${prefix}_snapshot.json`)
  if (!existsSync(snapshotFile)) {
    throw new Error(
      `Journal head ${head.tag} has no snapshot at ${snapshotFile}.`,
    )
  }

  const snapshot = snapshotSchema.parse(
    JSON.parse(readFileSync(snapshotFile, { encoding: 'utf8' })),
  )
  return Object.values(snapshot.tables).flatMap((table) =>
    [
      table.foreignKeys,
      table.uniqueConstraints,
      table.checkConstraints,
      table.indexes,
    ].flatMap((group) => Object.values(group).map((entry) => entry.name)),
  )
}

describe('committed schema identifiers fit Postgres', () => {
  it('declares no identifier over 63 bytes', () => {
    const names = headSnapshotNames()
    // Without this the case would pass by scanning nothing, which is the
    // failure mode a file-based guard is most prone to.
    expect(names.length).toBeGreaterThan(0)

    const tooLong = names
      .filter((name) => byteLength(name) > MAX_IDENTIFIER_BYTES)
      .map((name) => `${name} (${byteLength(name)} bytes)`)
      .sort()

    // The fix, when this fails: give the constraint an explicit `name` in its
    // table's extras — drizzle's `foreignKey` / `unique` / `check` / `index`
    // all take one — then re-mint the migration.
    expect(tooLong).toEqual([])
  })
})
