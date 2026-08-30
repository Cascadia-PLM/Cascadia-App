// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Preflight for the items identity constraint (NULLS NOT DISTINCT).
 *
 * The (item_number, revision, design_id, item_type) unique constraint never
 * fired for design-less item types while NULLs compared distinct, so a
 * database that lived through that era can hold twin identities the
 * tightened constraint will reject. The migration itself cannot half-apply —
 * ADD CONSTRAINT validates existing rows and aborts its transaction on a
 * duplicate — but "the upgrade refused to start" is a poor place to discover
 * which rows collide. Run this first; it names them.
 *
 * Usage: npx tsx scripts/check-items-duplicates.ts
 * Exit code 0 = clean; 1 = duplicates found (listed on stdout).
 */
import { sql } from 'drizzle-orm'
import { db, describeConnection } from '../packages/core/src/lib/db/index.ts'

console.log(`Target database: ${describeConnection()}`)

const duplicates = await db.execute<{
  item_number: string
  revision: string
  item_type: string
  count: string
  ids: Array<string>
}>(sql`
  SELECT item_number, revision, item_type, count(*) AS count,
         array_agg(id ORDER BY created_at) AS ids
  FROM items
  WHERE design_id IS NULL
  GROUP BY item_number, revision, item_type
  HAVING count(*) > 1
  ORDER BY item_number, revision
`)

if (duplicates.length === 0) {
  console.log(
    '✅ No design-less identity duplicates; the NULLS NOT DISTINCT migration will apply cleanly.',
  )
  process.exit(0)
}

console.log(
  `❌ ${duplicates.length} duplicated design-less identit${duplicates.length === 1 ? 'y' : 'ies'} — the migration will refuse until these are resolved:`,
)
for (const row of duplicates) {
  console.log(
    `  ${row.item_type} ${row.item_number} rev ${row.revision}: ${row.count} rows (${row.ids.join(', ')})`,
  )
}
console.log(
  '\nResolve by renumbering or deleting the extra rows, then re-run this check.',
)
process.exit(1)
