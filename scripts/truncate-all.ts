/**
 * Truncate all tables to reset the database for fresh seeding
 *
 * This must cover every pgTable() defined in src/lib/db/schema/.
 * When adding a new table to the schema, add it here too.
 *
 * Queries pg_tables to skip any that haven't been migrated yet,
 * so newly added schema files won't break the reset.
 */
import { sql } from 'drizzle-orm'
import { db } from '../src/lib/db/index.ts'

/** Every table from src/lib/db/schema/, grouped by domain. */
const ALL_TABLES = [
  // Items & type-specific tables
  'items',
  'parts',
  'documents',
  'change_orders',
  'requirements',
  'tasks',
  'work_instructions',
  'tools',
  'issues',
  // Item relationships
  'item_relationships',
  // Change order detail tables
  'change_order_affected_items',
  'change_order_impacted_items',
  'change_order_risks',
  'change_order_impact_reports',
  'change_order_designs',
  // Test management
  'test_plans',
  'test_cases',
  'test_executions',
  // Issue detail tables
  'issue_designs',
  'issue_affected_items',
  // Work instruction detail tables
  'work_instruction_operations',
  'work_instruction_steps',
  'work_instruction_part_attachments',
  'work_instruction_change_alerts',
  // Versioning & branching
  'designs',
  'branches',
  'commits',
  'tags',
  'item_versions',
  'branch_items',
  'item_field_changes',
  'conflict_reviews',
  // Threading
  'upstream_changes',
  'thread_path_cache',
  // Programs & products
  'programs',
  'program_members',
  'products',
  // Users & auth
  'users',
  'roles',
  'user_roles',
  'sessions',
  'auth_events',
  // Workflows
  'workflow_definitions',
  'workflow_instances',
  'workflow_history',
  'workflow_state_approvers',
  'workflow_approval_votes',
  // Config & settings
  'item_type_configs',
  'settings',
  'number_sequences',
  // Vault (file storage)
  'vault_files',
  'vault_file_history',
  // Component catalog
  'component_catalog_media',
  'component_catalog_entries',
  'component_catalog_categories',
  // COTS components
  'cots_components',
  'part_cots_mapping',
  // Cross references
  'design_cross_references',
  // Design engine
  'design_sessions',
  // AI
  'ai_chat_sessions',
  'ai_chat_messages',
  'ai_settings',
  'ai_usage_logs',
  // Jobs
  'jobs',
  'job_logs',
  // Reports
  'reports',
  'report_columns',
  'report_filters',
  'report_sorts',
  'report_executions',
  'report_exports',
  // Work orders
  'work_orders',
  'work_instruction_executions',
  'execution_sign_offs',
  // Error logs
  'error_logs',
]

// Query which of our tables actually exist in the database
// (some schema tables may not have been migrated yet)
const arrayLiteral = `ARRAY[${ALL_TABLES.map((t) => `'${t}'`).join(',')}]`
const existing = await db.execute<{ tablename: string }>(
  sql.raw(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY(${arrayLiteral})`,
  ),
)
const rows = Array.isArray(existing) ? existing : ((existing as any).rows ?? [])
const existingSet = new Set(rows.map((r: any) => r.tablename))
const toTruncate = ALL_TABLES.filter((t) => existingSet.has(t))
const skipped = ALL_TABLES.filter((t) => !existingSet.has(t))

if (skipped.length > 0) {
  console.log(
    `Skipping ${skipped.length} unmigrated tables: ${skipped.join(', ')}`,
  )
}

if (toTruncate.length === 0) {
  console.log('No tables to truncate')
  process.exit(0)
}

console.log(`Truncating ${toTruncate.length} tables...`)
await db.execute(sql.raw(`TRUNCATE ${toTruncate.join(', ')} CASCADE`))

console.log('✓ All tables truncated')
process.exit(0)
