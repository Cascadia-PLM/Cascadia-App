/**
 * Migration: Create design_cross_references table
 *
 * Usage: npx tsx scripts/migrate-cross-references.ts
 */
import { sql } from 'drizzle-orm'
import { db } from '../src/lib/db'

async function migrate() {
  console.log('Creating design_cross_references table...')

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS design_cross_references (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      referencing_design_id UUID NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
      referenced_item_id UUID NOT NULL,
      source_design_id UUID NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
      branch_id UUID REFERENCES branches(id) ON DELETE CASCADE,
      change_type VARCHAR(20),
      in_design_structure BOOLEAN DEFAULT true,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_by UUID REFERENCES users(id),
      modified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      modified_by UUID REFERENCES users(id),
      CONSTRAINT design_cross_refs_unique UNIQUE (referencing_design_id, referenced_item_id, branch_id)
    );
  `)

  // Create indexes
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_cross_ref_design ON design_cross_references(referencing_design_id);
  `)
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_cross_ref_item ON design_cross_references(referenced_item_id);
  `)
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_cross_ref_source ON design_cross_references(source_design_id);
  `)
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_cross_ref_branch ON design_cross_references(branch_id);
  `)

  console.log('Migration complete: design_cross_references table created.')
  process.exit(0)
}

migrate().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
