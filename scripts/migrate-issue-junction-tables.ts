/**
 * Migration: Issue JSONB arrays -> Junction tables
 *
 * Migrates designIds and affectedItemIds from JSONB arrays on the issues table
 * to proper junction tables (issue_designs, issue_affected_items) with FK constraints.
 *
 * Usage:
 *   npx tsx scripts/migrate-issue-junction-tables.ts
 *
 * Steps:
 *   1. Creates junction tables (if they don't exist)
 *   2. Migrates existing JSONB data into junction tables
 *   3. Drops the JSONB columns and GIN index
 *
 * This script is idempotent -- safe to run multiple times.
 */

import { sql } from 'drizzle-orm'
import { db } from '../src/lib/db'

async function migrate() {
  console.log('Starting Issue junction table migration...')

  // Step 1: Create junction tables
  console.log('Step 1: Creating junction tables...')

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS issue_designs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      issue_item_id UUID NOT NULL REFERENCES issues(item_id) ON DELETE CASCADE,
      design_id UUID NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_issue_design UNIQUE (issue_item_id, design_id)
    )
  `)

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_issue_designs_issue ON issue_designs(issue_item_id)
  `)
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_issue_designs_design ON issue_designs(design_id)
  `)

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS issue_affected_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      issue_item_id UUID NOT NULL REFERENCES issues(item_id) ON DELETE CASCADE,
      affected_item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_issue_affected_item UNIQUE (issue_item_id, affected_item_id)
    )
  `)

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_issue_affected_items_issue ON issue_affected_items(issue_item_id)
  `)
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_issue_affected_items_item ON issue_affected_items(affected_item_id)
  `)

  console.log('  Junction tables created.')

  // Step 2: Migrate existing JSONB data
  console.log('Step 2: Migrating JSONB data...')

  // Check if JSONB columns still exist before migrating
  const colCheck = await db.execute(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'issues' AND column_name IN ('design_ids', 'affected_item_ids')
  `)

  const existingCols = (
    colCheck as unknown as Array<{ column_name: string }>
  ).map((r) => r.column_name)

  if (existingCols.includes('design_ids')) {
    await db.execute(sql`
      INSERT INTO issue_designs (issue_item_id, design_id)
      SELECT i.item_id, d.value::uuid
      FROM issues i, jsonb_array_elements_text(i.design_ids) AS d(value)
      WHERE i.design_ids IS NOT NULL AND jsonb_array_length(i.design_ids) > 0
      ON CONFLICT DO NOTHING
    `)
    console.log(`  Migrated design associations.`)
  } else {
    console.log('  design_ids column already dropped, skipping.')
  }

  if (existingCols.includes('affected_item_ids')) {
    await db.execute(sql`
      INSERT INTO issue_affected_items (issue_item_id, affected_item_id)
      SELECT i.item_id, a.value::uuid
      FROM issues i, jsonb_array_elements_text(i.affected_item_ids) AS a(value)
      WHERE i.affected_item_ids IS NOT NULL AND jsonb_array_length(i.affected_item_ids) > 0
      ON CONFLICT DO NOTHING
    `)
    console.log(`  Migrated affected item associations.`)
  } else {
    console.log('  affected_item_ids column already dropped, skipping.')
  }

  // Step 3: Drop JSONB columns and GIN index
  console.log('Step 3: Dropping JSONB columns...')

  if (existingCols.includes('design_ids')) {
    await db.execute(sql`DROP INDEX IF EXISTS idx_issue_design_ids`)
    await db.execute(sql`ALTER TABLE issues DROP COLUMN IF EXISTS design_ids`)
    console.log('  Dropped design_ids column and GIN index.')
  }

  if (existingCols.includes('affected_item_ids')) {
    await db.execute(
      sql`ALTER TABLE issues DROP COLUMN IF EXISTS affected_item_ids`,
    )
    console.log('  Dropped affected_item_ids column.')
  }

  console.log('Migration complete!')
  process.exit(0)
}

migrate().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
