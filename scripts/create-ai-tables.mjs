/**
 * Script to create AI tables directly using SQL
 * Run with: node scripts/create-ai-tables.mjs
 */

import postgres from 'postgres'

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://postgres:postgres@localhost:5432/cascadia'

const sql = postgres(DATABASE_URL)

const createTablesSQL = `
-- AI Chat Sessions table
CREATE TABLE IF NOT EXISTS ai_chat_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  program_id UUID REFERENCES programs(id) ON DELETE SET NULL,
  design_id UUID REFERENCES designs(id) ON DELETE SET NULL,
  title VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS ai_chat_sessions_user_id_idx ON ai_chat_sessions(user_id);
CREATE INDEX IF NOT EXISTS ai_chat_sessions_program_id_idx ON ai_chat_sessions(program_id);

-- AI Chat Messages table
CREATE TABLE IF NOT EXISTS ai_chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL,
  content TEXT NOT NULL,
  tool_calls JSONB,
  tool_call_id VARCHAR(100),
  tool_name VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS ai_chat_messages_session_id_idx ON ai_chat_messages(session_id);
CREATE INDEX IF NOT EXISTS ai_chat_messages_created_at_idx ON ai_chat_messages(created_at);

-- AI Settings table
CREATE TABLE IF NOT EXISTS ai_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id UUID REFERENCES programs(id) ON DELETE CASCADE,
  provider VARCHAR(50) NOT NULL,
  config JSONB NOT NULL,
  enabled BOOLEAN DEFAULT TRUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS ai_settings_program_id_idx ON ai_settings(program_id);

-- AI Usage Logs table
CREATE TABLE IF NOT EXISTS ai_usage_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES ai_chat_sessions(id) ON DELETE SET NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool_name VARCHAR(100),
  tool_params JSONB,
  tool_result JSONB,
  error TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  provider VARCHAR(50),
  model VARCHAR(100),
  duration_ms INTEGER,
  timestamp TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS ai_usage_logs_session_id_idx ON ai_usage_logs(session_id);
CREATE INDEX IF NOT EXISTS ai_usage_logs_user_id_idx ON ai_usage_logs(user_id);
CREATE INDEX IF NOT EXISTS ai_usage_logs_timestamp_idx ON ai_usage_logs(timestamp);
`

async function main() {
  console.log('Creating AI tables...')

  try {
    await sql.unsafe(createTablesSQL)
    console.log('AI tables created successfully!')
  } catch (error) {
    console.error('Error creating AI tables:', error.message)
    process.exit(1)
  } finally {
    await sql.end()
  }
}

main()
