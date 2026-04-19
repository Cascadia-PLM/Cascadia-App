/**
 * Migration script: Create design_sessions table
 * Run with: npx tsx scripts/create-design-sessions.ts
 */
import { sql } from 'drizzle-orm'
import { db } from '../src/lib/db'

async function migrate() {
  console.log('Creating design_sessions table...')

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS design_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ai_chat_session_id UUID REFERENCES ai_chat_sessions(id) ON DELETE SET NULL,
      program_id UUID NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
      design_id UUID REFERENCES designs(id) ON DELETE SET NULL,
      title VARCHAR(255),
      stage VARCHAR(50) NOT NULL DEFAULT 'idle',
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      description TEXT,
      artifacts JSONB,
      llm_history JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      materialized_design_id UUID REFERENCES designs(id) ON DELETE SET NULL,
      error_message TEXT
    )
  `)

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS design_sessions_user_id_idx ON design_sessions(user_id)
  `)

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS design_sessions_program_id_idx ON design_sessions(program_id)
  `)

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS design_sessions_status_idx ON design_sessions(status)
  `)

  console.log('Done! design_sessions table created.')
  process.exit(0)
}

migrate().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
