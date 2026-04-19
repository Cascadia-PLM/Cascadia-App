/**
 * Row-Level Security (RLS) setup script.
 *
 * Creates a non-superuser `cascadia_app` role and enables RLS on key tables
 * with program-level data isolation. Policies use `current_setting('app.current_user_id', true)`
 * so they are enforced only when the session variable is set via `withUserContext()`.
 *
 * Deployment steps:
 *   1. Run this script to create role + policies (pass-through when no session var)
 *   2. Switch DATABASE_URL to `cascadia_app` role → RLS active but pass-through
 *   3. Adopt `withUserContext()` in services → RLS enforced for those paths
 *
 * Run with: npx tsx scripts/rls-setup.ts
 */
import { sql } from 'drizzle-orm'
import { db } from '../src/lib/db'

async function setupRole() {
  console.log('=== Setting up cascadia_app role ===\n')

  // Create role if not exists
  await db.execute(
    sql.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cascadia_app') THEN
        CREATE ROLE cascadia_app LOGIN PASSWORD 'cascadia_app';
      END IF;
    END
    $$;
  `),
  )
  console.log('  Role cascadia_app created (or already exists)')

  // Grant necessary permissions
  await db.execute(
    sql.raw(`
    GRANT CONNECT ON DATABASE cascadia TO cascadia_app;
  `),
  )
  await db.execute(
    sql.raw(`
    GRANT USAGE ON SCHEMA public TO cascadia_app;
  `),
  )
  await db.execute(
    sql.raw(`
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cascadia_app;
  `),
  )
  await db.execute(
    sql.raw(`
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cascadia_app;
  `),
  )
  // Ensure future tables also get grants
  await db.execute(
    sql.raw(`
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cascadia_app;
  `),
  )
  await db.execute(
    sql.raw(`
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO cascadia_app;
  `),
  )
  console.log('  Grants applied')
}

const RLS_TABLES = ['items', 'designs', 'programs', 'program_members'] as const

async function enableRLS() {
  console.log('\n=== Enabling Row-Level Security ===\n')

  for (const table of RLS_TABLES) {
    await db.execute(
      sql.raw(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`),
    )
    // Force RLS even for table owners (except superuser)
    await db.execute(
      sql.raw(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`),
    )
    console.log(`  RLS enabled on ${table}`)
  }
}

async function createPolicies() {
  console.log('\n=== Creating RLS policies ===\n')

  // Helper: drop policy if exists, then create
  async function createPolicy(
    table: string,
    name: string,
    operation: string,
    using: string,
    withCheck?: string,
  ) {
    await db.execute(sql.raw(`DROP POLICY IF EXISTS "${name}" ON "${table}";`))
    const withCheckClause = withCheck ? ` WITH CHECK (${withCheck})` : ''
    await db.execute(
      sql.raw(
        `CREATE POLICY "${name}" ON "${table}" FOR ${operation} USING (${using})${withCheckClause};`,
      ),
    )
    console.log(`  Created: ${name} on ${table}`)
  }

  // ---- Pass-through when no session variable is set ----
  // This ensures backward compatibility: migrations, seeds, and admin scripts
  // that don't set app.current_user_id can still access all data.
  for (const table of RLS_TABLES) {
    await createPolicy(
      table,
      `${table}_passthrough_no_session`,
      'ALL',
      `current_setting('app.current_user_id', true) IS NULL OR current_setting('app.current_user_id', true) = ''`,
    )
  }

  // ---- Global admin bypass ----
  for (const table of RLS_TABLES) {
    await createPolicy(
      table,
      `${table}_global_admin_bypass`,
      'ALL',
      `current_setting('app.is_global_admin', true) = 'true'`,
    )
  }

  // ---- Program-scoped policies ----

  // programs: user must be a member
  await createPolicy(
    'programs',
    'programs_member_access',
    'SELECT',
    `id IN (
      SELECT program_id FROM program_members
      WHERE user_id = current_setting('app.current_user_id', true)::uuid
    )`,
  )

  // program_members: user can see memberships for programs they belong to
  await createPolicy(
    'program_members',
    'program_members_member_access',
    'SELECT',
    `program_id IN (
      SELECT program_id FROM program_members
      WHERE user_id = current_setting('app.current_user_id', true)::uuid
    )`,
  )

  // designs: user must be a member of the design's program, OR design has no program (global library)
  await createPolicy(
    'designs',
    'designs_member_access',
    'SELECT',
    `program_id IS NULL OR program_id IN (
      SELECT program_id FROM program_members
      WHERE user_id = current_setting('app.current_user_id', true)::uuid
    )`,
  )

  // items: user must be a member of the design's program, OR item has no design (global library)
  await createPolicy(
    'items',
    'items_member_access',
    'SELECT',
    `design_id IS NULL OR design_id IN (
      SELECT d.id FROM designs d
      WHERE d.program_id IS NULL
         OR d.program_id IN (
           SELECT program_id FROM program_members
           WHERE user_id = current_setting('app.current_user_id', true)::uuid
         )
    )`,
  )

  // Write policies (INSERT/UPDATE) — same logic as SELECT
  await createPolicy(
    'items',
    'items_member_write',
    'ALL',
    `design_id IS NULL OR design_id IN (
      SELECT d.id FROM designs d
      WHERE d.program_id IS NULL
         OR d.program_id IN (
           SELECT program_id FROM program_members
           WHERE user_id = current_setting('app.current_user_id', true)::uuid
         )
    )`,
    `design_id IS NULL OR design_id IN (
      SELECT d.id FROM designs d
      WHERE d.program_id IS NULL
         OR d.program_id IN (
           SELECT program_id FROM program_members
           WHERE user_id = current_setting('app.current_user_id', true)::uuid
         )
    )`,
  )

  await createPolicy(
    'designs',
    'designs_member_write',
    'ALL',
    `program_id IS NULL OR program_id IN (
      SELECT program_id FROM program_members
      WHERE user_id = current_setting('app.current_user_id', true)::uuid
    )`,
    `program_id IS NULL OR program_id IN (
      SELECT program_id FROM program_members
      WHERE user_id = current_setting('app.current_user_id', true)::uuid
    )`,
  )
}

async function main() {
  try {
    await setupRole()
    await enableRLS()
    await createPolicies()
    console.log('\nRLS setup complete.')
    console.log('\nNext steps:')
    console.log(
      '  1. Test with current DATABASE_URL — all queries should still work (pass-through)',
    )
    console.log('  2. Update DATABASE_URL to use cascadia_app role')
    console.log('  3. Adopt withUserContext() in critical service paths')
    process.exit(0)
  } catch (error) {
    console.error('Fatal error:', error)
    process.exit(1)
  }
}

main()
