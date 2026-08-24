// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Tool Seed Script
 *
 * Loads the shop equipment dataset from `test-data/tools.json` — manufacturing
 * machines, quality instruments and utility devices, each with its structured
 * `capabilities` blob. Tools are standalone items: no design, no commit, no BOM.
 *
 * Idempotent: tools are matched on itemNumber, and any that already exist are
 * left untouched. Re-running only inserts what is missing.
 *
 * Run with:
 *   npm run db:seed:tools
 *
 * Requires the minimal seed to have run first (needs the admin user and the
 * Tool item-type config / lifecycle):
 *   npm run db:seed
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../packages/core/src/lib/db/index.ts'
import { users } from '../packages/core/src/lib/db/schema/users.ts'
import { items, tools } from '../packages/core/src/lib/db/schema/items.ts'
import { numberSequences } from '../packages/core/src/lib/db/schema/numbering.ts'

// ============================================================================
// Config
// ============================================================================

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
const DATA_FILE = join(REPO_ROOT, 'packages', 'core', 'test-data', 'tools.json')

/** Mirrors the `Tool` interface in src/lib/items/types/tool.ts */
interface ToolSeedRow {
  itemNumber: string
  revision: string
  name: string
  state: string
  toolType: 'manufacturing' | 'quality' | 'utility'
  toolSubtype: string
  manufacturer?: string
  model?: string
  location?: string
  notes?: string
  attributes?: Record<string, string>
  capabilities?: Record<string, unknown>
}

console.log('=== Tool Seed ===\n')

const seedRows = JSON.parse(
  readFileSync(DATA_FILE, 'utf8'),
) as Array<ToolSeedRow>

// ---- 1. Admin user ---------------------------------------------------------

const adminRows = await db
  .select()
  .from(users)
  .where(eq(users.email, 'admin@cascadia.local'))
  .limit(1)

const admin = adminRows.at(0)
if (!admin) {
  console.error(
    'Admin user (admin@cascadia.local) not found. Run scripts/seed-minimal.ts first.',
  )
  process.exit(1)
}

// ---- 2. Idempotency: skip tools that already exist --------------------------

const seedNumbers = seedRows.map((t) => t.itemNumber)

const existingRows = await db
  .select({ itemNumber: items.itemNumber })
  .from(items)
  .where(
    and(eq(items.itemType, 'Tool'), inArray(items.itemNumber, seedNumbers)),
  )

const existing = new Set(existingRows.map((r) => r.itemNumber))
const pending = seedRows.filter((t) => !existing.has(t.itemNumber))

if (pending.length === 0) {
  console.log(`All ${seedRows.length} tools already present — nothing to do.`)
  process.exit(0)
}

// ---- 3. Insert -------------------------------------------------------------

await db.transaction(async (tx) => {
  for (const row of pending) {
    const itemId = randomUUID()

    await tx.insert(items).values({
      id: itemId,
      masterId: itemId,
      designId: null,
      itemNumber: row.itemNumber,
      revision: row.revision,
      itemType: 'Tool',
      name: row.name,
      state: row.state,
      attributes: row.attributes ?? {},
      isCurrent: true,
      createdBy: admin.id,
      modifiedBy: admin.id,
    })

    await tx.insert(tools).values({
      itemId,
      toolType: row.toolType,
      toolSubtype: row.toolSubtype,
      manufacturer: row.manufacturer ?? null,
      model: row.model ?? null,
      capabilities: row.capabilities ?? null,
      location: row.location ?? null,
      notes: row.notes ?? null,
    })
  }
})

// ---- 4. Advance the Tool number sequence -----------------------------------
//
// The dataset ships auto-generated numbers (TOOL-000001…). Without this, the
// next tool created in the UI would reuse a number already in the dataset and
// collide on the (item_number, revision, design_id, item_type) unique index.
// Tool uses a global-scope sequence, so scopeKey is just the item type.

const highestSeeded = seedRows.reduce((max, row) => {
  const match = /^TOOL-(\d+)$/.exec(row.itemNumber)
  return match ? Math.max(max, Number(match[1])) : max
}, 0)

if (highestSeeded > 0) {
  await db
    .insert(numberSequences)
    .values({
      itemType: 'Tool',
      scopeKey: 'Tool',
      currentValue: highestSeeded,
    })
    .onConflictDoUpdate({
      target: [numberSequences.itemType, numberSequences.scopeKey],
      set: {
        currentValue: sql`GREATEST(${numberSequences.currentValue}, ${highestSeeded})`,
        modifiedAt: new Date(),
      },
    })
}

// ---- Summary ---------------------------------------------------------------

const byType = pending.reduce<Record<string, number>>((acc, t) => {
  acc[t.toolType] = (acc[t.toolType] ?? 0) + 1
  return acc
}, {})

console.log(`✓ ${pending.length} tools inserted`)
if (existing.size > 0) {
  console.log(`  ${existing.size} already present, skipped`)
}
for (const [type, count] of Object.entries(byType).sort()) {
  console.log(`  ${type}: ${count}`)
}
console.log(`  Tool number sequence at ${highestSeeded}`)

process.exit(0)
