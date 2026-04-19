/**
 * Migration: Add instance-level workflow structure columns for flexible workflows
 *
 * Adds:
 * - instance_states: JSONB column for instance-level state definitions
 * - instance_transitions: JSONB column for instance-level transition definitions
 */
import { db } from '../src/lib/db/index.ts'

console.log('Adding flexible workflow columns to workflow_instances...')

await db.execute(`
  ALTER TABLE workflow_instances
  ADD COLUMN IF NOT EXISTS instance_states jsonb,
  ADD COLUMN IF NOT EXISTS instance_transitions jsonb
`)

console.log('✓ Migration completed successfully')
process.exit(0)
