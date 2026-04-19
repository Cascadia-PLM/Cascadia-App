import fs from 'node:fs'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { PgTransactionConfig } from 'drizzle-orm/pg-core'

export type DbSchema = typeof schema
export type DbInstance = PostgresJsDatabase<DbSchema>

/**
 * Transaction client type. Use as optional parameter in services
 * to allow callers to pass in an outer transaction.
 * If not provided, the service should use `db` directly.
 */
export type TransactionClient = Parameters<
  Parameters<DbInstance['transaction']>[0]
>[0]

const connectionString =
  process.env.DATABASE_URL ||
  'postgresql://postgres:postgres@localhost:5432/cascadia'

// Parse connection string for Cloud SQL Unix socket support
// postgres.js doesn't parse ?host= from URL, so we extract it manually
function parseConnectionOptions(connStr: string) {
  const url = new URL(connStr)
  const socketPath = url.searchParams.get('host')

  if (socketPath && socketPath.startsWith('/cloudsql/')) {
    // Cloud SQL Unix socket connection
    // Remove the host param from URL and pass it as option
    url.searchParams.delete('host')
    return {
      connectionString: url.toString(),
      options: { host: socketPath },
    }
  }

  return { connectionString: connStr, options: {} }
}

const { connectionString: cleanConnString, options } =
  parseConnectionOptions(connectionString)

// Enable SSL for production database connections
const isProduction = process.env.NODE_ENV === 'production'
const sslOptions: Record<string, unknown> = {}

if (isProduction && !options.host?.startsWith('/cloudsql/')) {
  // Cloud SQL Unix sockets don't need SSL (already local)
  const caCertPath = process.env.DATABASE_CA_CERT_PATH
  if (caCertPath) {
    sslOptions.ssl = { ca: fs.readFileSync(caCertPath) }
  } else {
    sslOptions.ssl = 'require'
  }
}

// For query purposes
const queryClient = postgres(cleanConnString, { ...options, ...sslOptions })
const defaultDb = drizzle(queryClient, { schema })

// Mutable reference for test injection
let currentDb: DbInstance | TransactionClient = defaultDb

/**
 * Get the current database instance.
 * In production, this is always the default db.
 * In tests, this can be replaced with a test db instance.
 */
export const db: DbInstance = new Proxy({} as DbInstance, {
  get(_target, prop) {
    return (currentDb as any)[prop]
  },
})

/**
 * Replace the database instance (for testing only).
 * Call resetDb() to restore the original.
 */
export function setTestDb(testDb: DbInstance | TransactionClient): void {
  currentDb = testDb
}

/**
 * Restore the original database instance.
 */
export function resetDb(): void {
  currentDb = defaultDb
}

/**
 * Execute a database transaction with RLS session variables set.
 *
 * Uses SET LOCAL so variables are scoped to the transaction only —
 * no leakage across pooled connections.
 */
export async function withUserContext<T>(
  userId: string,
  isGlobalAdmin: boolean,
  fn: (tx: TransactionClient) => Promise<T>,
  txConfig?: PgTransactionConfig,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.current_user_id = ${userId}`)
    await tx.execute(
      sql`SET LOCAL app.is_global_admin = ${isGlobalAdmin ? 'true' : 'false'}`,
    )
    return fn(tx)
  }, txConfig)
}

// For migrations
export const migrationClient = postgres(cleanConnString, {
  ...options,
  ...sslOptions,
  max: 1,
})
