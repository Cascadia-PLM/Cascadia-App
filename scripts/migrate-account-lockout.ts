/**
 * Migration: Add account lockout columns to users table.
 *
 * Adds:
 *  - failed_login_attempts (integer, default 0)
 *  - locked_until (timestamptz, nullable)
 *
 * Run: npx tsx scripts/migrate-account-lockout.ts
 */

import postgres from 'postgres'

const connectionString =
  process.env.DATABASE_URL ||
  'postgresql://postgres:postgres@localhost:5432/cascadia'

const sql = postgres(connectionString, { max: 1 })

async function migrate() {
  console.log('Adding account lockout columns to users table...')

  await sql`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS failed_login_attempts integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS locked_until timestamptz
  `

  console.log('Migration complete.')
  await sql.end()
}

migrate().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
