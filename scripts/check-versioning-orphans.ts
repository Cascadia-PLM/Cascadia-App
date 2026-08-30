// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Report-only preflight for the DBI-6 versioning-graph foreign keys.
 *
 *   npm run db:check-orphans
 *
 * Lists every dangling reference the FK migration will meet, per edge, with
 * counts. Exits 1 when any orphan exists, 0 on a clean graph — so it can gate
 * an upgrade script.
 *
 * The migration itself cleans the inert classes (tracking rows on archived
 * branches, stale provenance pointers) but deliberately NOT a dangling
 * commits.parent_id / commits.branch_id — that is real history corruption,
 * and the ADD CONSTRAINT aborting the transaction is the correct outcome:
 * a human decides, this report tells them where to look.
 */

import { sql } from 'drizzle-orm'
import { db } from '../packages/core/src/lib/db'

interface EdgeCheck {
  edge: string
  /** What the migration does about it. */
  disposition: 'cleaned by migration' | 'ABORTS migration — investigate'
  query: string
}

const CHECKS: Array<EdgeCheck> = [
  {
    edge: 'commits.branch_id → branches.id',
    disposition: 'ABORTS migration — investigate',
    query: `SELECT count(*)::int AS n FROM commits c WHERE NOT EXISTS (SELECT 1 FROM branches b WHERE b.id = c.branch_id)`,
  },
  {
    edge: 'commits.parent_id → commits.id',
    disposition: 'ABORTS migration — investigate',
    query: `SELECT count(*)::int AS n FROM commits c WHERE c.parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM commits p WHERE p.id = c.parent_id)`,
  },
  {
    edge: 'commits.merge_parent_id → commits.id',
    disposition: 'ABORTS migration — investigate',
    query: `SELECT count(*)::int AS n FROM commits c WHERE c.merge_parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM commits p WHERE p.id = c.merge_parent_id)`,
  },
  {
    // Added with the FK itself (DBI2-2), which DBI-6 skipped.
    edge: 'commits.change_order_item_id → items.id',
    disposition: 'cleaned by migration',
    query: `SELECT count(*)::int AS n FROM commits c WHERE c.change_order_item_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM items i WHERE i.id = c.change_order_item_id)`,
  },
  {
    edge: 'branches.head_commit_id → commits.id',
    disposition: 'ABORTS migration — investigate',
    query: `SELECT count(*)::int AS n FROM branches b WHERE b.head_commit_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM commits c WHERE c.id = b.head_commit_id)`,
  },
  {
    edge: 'branches.base_commit_id → commits.id',
    disposition: 'ABORTS migration — investigate',
    query: `SELECT count(*)::int AS n FROM branches b WHERE b.base_commit_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM commits c WHERE c.id = b.base_commit_id)`,
  },
  {
    edge: 'branches.change_order_item_id → items.id',
    disposition: 'cleaned by migration',
    query: `SELECT count(*)::int AS n FROM branches b WHERE b.change_order_item_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM items i WHERE i.id = b.change_order_item_id)`,
  },
  {
    edge: 'branches.source_tag_id → tags.id',
    disposition: 'cleaned by migration',
    query: `SELECT count(*)::int AS n FROM branches b WHERE b.source_tag_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tags t WHERE t.id = b.source_tag_id)`,
  },
  {
    edge: 'branch_items.current_item_id → items.id',
    disposition: 'cleaned by migration',
    query: `SELECT count(*)::int AS n FROM branch_items bi WHERE bi.current_item_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM items i WHERE i.id = bi.current_item_id)`,
  },
  {
    edge: 'branch_items.base_item_id → items.id',
    disposition: 'cleaned by migration',
    query: `SELECT count(*)::int AS n FROM branch_items bi WHERE bi.base_item_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM items i WHERE i.id = bi.base_item_id)`,
  },
  {
    edge: 'item_versions.item_id → items.id',
    disposition: 'cleaned by migration',
    query: `SELECT count(*)::int AS n FROM item_versions iv WHERE NOT EXISTS (SELECT 1 FROM items i WHERE i.id = iv.item_id)`,
  },
  {
    edge: 'item_versions.previous_item_id → items.id',
    disposition: 'cleaned by migration',
    query: `SELECT count(*)::int AS n FROM item_versions iv WHERE iv.previous_item_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM items i WHERE i.id = iv.previous_item_id)`,
  },
  {
    edge: 'conflict_reviews.change_order_id → items.id',
    disposition: 'cleaned by migration',
    query: `SELECT count(*)::int AS n FROM conflict_reviews cr WHERE NOT EXISTS (SELECT 1 FROM items i WHERE i.id = cr.change_order_id)`,
  },
  {
    edge: 'conflict_reviews.their_eco_id → items.id',
    disposition: 'cleaned by migration',
    query: `SELECT count(*)::int AS n FROM conflict_reviews cr WHERE cr.their_eco_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM items i WHERE i.id = cr.their_eco_id)`,
  },
]

let orphans = 0
for (const check of CHECKS) {
  const rows = (await db.execute(sql.raw(check.query))) as unknown as Array<{
    n: number
  }>
  const n = Number(rows[0]?.n ?? 0)
  const marker = n === 0 ? ' ok ' : n.toString().padStart(4)
  console.log(
    `[${marker}] ${check.edge}${n > 0 ? ` — ${check.disposition}` : ''}`,
  )
  orphans += n
}

if (orphans > 0) {
  console.error(
    `\n${orphans} dangling reference(s). Rows marked "cleaned by migration" ` +
      'are handled automatically; rows marked ABORTS need a human before ' +
      'db:migrate will pass.',
  )
  process.exit(1)
}
console.log('\nVersioning graph is orphan-free.')
process.exit(0)
