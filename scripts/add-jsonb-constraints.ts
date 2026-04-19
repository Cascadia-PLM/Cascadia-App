/**
 * Add CHECK constraints to JSONB columns to enforce structural type safety
 * at the database level. This prevents storing scalars/arrays where objects
 * are expected and vice versa.
 *
 * Run with: npx tsx scripts/add-jsonb-constraints.ts
 */
import { sql } from 'drizzle-orm'
import { db } from '../src/lib/db'

interface JsonbConstraint {
  table: string
  column: string
  constraintName: string
  check: string
}

const constraints: Array<JsonbConstraint> = [
  {
    table: 'items',
    column: 'attributes',
    constraintName: 'chk_items_attributes_is_object',
    check: `attributes IS NULL OR jsonb_typeof(attributes) = 'object'`,
  },
  {
    table: 'designs',
    column: 'attributes',
    constraintName: 'chk_designs_attributes_is_object',
    check: `attributes IS NULL OR jsonb_typeof(attributes) = 'object'`,
  },
  {
    table: 'programs',
    column: 'settings',
    constraintName: 'chk_programs_settings_is_object',
    check: `settings IS NULL OR jsonb_typeof(settings) = 'object'`,
  },
  {
    table: 'programs',
    column: 'attributes',
    constraintName: 'chk_programs_attributes_is_object',
    check: `attributes IS NULL OR jsonb_typeof(attributes) = 'object'`,
  },
  {
    table: 'workflow_definitions',
    column: 'definition',
    constraintName: 'chk_workflow_definitions_definition_is_object',
    check: `jsonb_typeof(definition) = 'object'`,
  },
  {
    table: 'workflow_definitions',
    column: 'drivers',
    constraintName: 'chk_workflow_definitions_drivers_is_array',
    check: `drivers IS NULL OR jsonb_typeof(drivers) = 'array'`,
  },
  {
    table: 'jobs',
    column: 'payload',
    constraintName: 'chk_jobs_payload_is_object',
    check: `jsonb_typeof(payload) = 'object'`,
  },
  {
    table: 'jobs',
    column: 'result',
    constraintName: 'chk_jobs_result_is_object',
    check: `result IS NULL OR jsonb_typeof(result) = 'object'`,
  },
  {
    table: 'vault_files',
    column: 'metadata',
    constraintName: 'chk_vault_files_metadata_is_object',
    check: `metadata IS NULL OR jsonb_typeof(metadata) = 'object'`,
  },
]

async function preCheck() {
  console.log(
    '=== Pre-check: verifying no existing data violates constraints ===\n',
  )
  let violations = 0

  for (const c of constraints) {
    const result = await db.execute(
      sql.raw(
        `SELECT COUNT(*) as cnt FROM "${c.table}" WHERE NOT (${c.check})`,
      ),
    )
    const count = Number(
      (result as unknown as Array<{ cnt: string }>)[0]?.cnt ?? 0,
    )
    if (count > 0) {
      console.error(
        `  VIOLATION: ${c.table}.${c.column} has ${count} rows that would fail constraint`,
      )
      violations += count
    } else {
      console.log(`  OK: ${c.table}.${c.column}`)
    }
  }

  return violations
}

async function addConstraints() {
  console.log('\n=== Adding JSONB CHECK constraints ===\n')

  for (const c of constraints) {
    try {
      // Drop existing constraint if present (idempotent)
      await db.execute(
        sql.raw(
          `ALTER TABLE "${c.table}" DROP CONSTRAINT IF EXISTS "${c.constraintName}"`,
        ),
      )
      // Add the constraint
      await db.execute(
        sql.raw(
          `ALTER TABLE "${c.table}" ADD CONSTRAINT "${c.constraintName}" CHECK (${c.check})`,
        ),
      )
      console.log(`  Added: ${c.constraintName} on ${c.table}.${c.column}`)
    } catch (error) {
      console.error(
        `  FAILED: ${c.constraintName} on ${c.table}.${c.column}:`,
        error,
      )
    }
  }
}

async function main() {
  try {
    const violations = await preCheck()
    if (violations > 0) {
      console.error(
        `\nAborting: ${violations} data violations found. Fix data before adding constraints.`,
      )
      process.exit(1)
    }

    await addConstraints()
    console.log('\nDone. All JSONB CHECK constraints added successfully.')
    process.exit(0)
  } catch (error) {
    console.error('Fatal error:', error)
    process.exit(1)
  }
}

main()
