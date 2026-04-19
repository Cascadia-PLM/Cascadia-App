/**
 * Drop all tables in the public schema.
 * Used during demo deployments to ensure a clean database
 * that matches the current Drizzle schema exactly.
 *
 * Uses dynamic SQL to discover and drop all tables, which works
 * with RDS users that don't have permission to DROP SCHEMA.
 */
import { db } from '../src/lib/db/index.ts'

try {
  console.log('Dropping all tables in public schema...')

  // Drop all tables dynamically
  await db.execute(`
    DO $$ DECLARE
      r RECORD;
    BEGIN
      FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
        EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE';
      END LOOP;
    END $$
  `)

  // Also drop any custom types and enums
  await db.execute(`
    DO $$ DECLARE
      r RECORD;
    BEGIN
      FOR r IN (SELECT typname FROM pg_type t JOIN pg_namespace n ON t.typnamespace = n.oid WHERE n.nspname = 'public' AND t.typtype = 'e') LOOP
        EXECUTE 'DROP TYPE IF EXISTS public.' || quote_ident(r.typname) || ' CASCADE';
      END LOOP;
    END $$
  `)

  console.log('✓ All tables and types dropped')
  process.exit(0)
} catch (error) {
  console.error('Error dropping tables:', error)
  process.exit(1)
}
