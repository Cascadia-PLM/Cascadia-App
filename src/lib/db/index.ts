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

export type SslMode = 'disable' | 'require' | 'verify-ca' | 'verify-full'

const VALID_SSL_MODES: ReadonlyArray<SslMode> = [
  'disable',
  'require',
  'verify-ca',
  'verify-full',
]

function isSslMode(value: string): value is SslMode {
  return (VALID_SSL_MODES as ReadonlyArray<string>).includes(value)
}

// Parse connection string for Cloud SQL Unix socket support and libpq-style
// sslmode query parameter. postgres.js doesn't honor ?host= or ?sslmode= from
// the URL, so we extract them manually and strip them before handing the URL
// to the driver.
export function parseConnectionOptions(connStr: string): {
  connectionString: string
  options: { host?: string }
  sslMode?: SslMode
} {
  const url = new URL(connStr)
  const socketPath = url.searchParams.get('host')
  const rawSslMode = url.searchParams.get('sslmode')

  let sslMode: SslMode | undefined
  if (rawSslMode !== null) {
    if (!isSslMode(rawSslMode)) {
      throw new Error(
        `Invalid sslmode "${rawSslMode}" in DATABASE_URL. ` +
          `Supported values: ${VALID_SSL_MODES.join(', ')}.`,
      )
    }
    sslMode = rawSslMode
    url.searchParams.delete('sslmode')
  }

  if (socketPath && socketPath.startsWith('/cloudsql/')) {
    // Cloud SQL Unix socket connection
    // Remove the host param from URL and pass it as option
    url.searchParams.delete('host')
    return {
      connectionString: url.toString(),
      options: { host: socketPath },
      sslMode,
    }
  }

  return {
    connectionString: url.toString(),
    options: {},
    sslMode,
  }
}

const {
  connectionString: cleanConnString,
  options,
  sslMode: urlSslMode,
} = parseConnectionOptions(connectionString)

// SSL configuration. Precedence (highest first):
//   1. Cloud SQL Unix socket — SSL is meaningless, always off
//   2. DATABASE_SSL env var ("disable" | "require") — explicit operator override
//   3. ?sslmode= in DATABASE_URL — libpq-style URL parameter
//   4. NODE_ENV=production fallback — require SSL by default in production
//
// The DATABASE_CA_CERT_PATH env var supplies a CA bundle when verification is
// requested. verify-ca / verify-full require it; without it we throw rather
// than silently downgrade.
export function resolveSslOption(args: {
  databaseSslEnv: string | undefined
  urlSslMode: SslMode | undefined
  isProduction: boolean
  isCloudSqlSocket: boolean
  caCertPath: string | undefined
  readCaFile: (p: string) => Buffer
}): { ssl?: 'require' | { ca: Buffer } } {
  const {
    databaseSslEnv,
    urlSslMode: urlMode,
    isProduction,
    isCloudSqlSocket,
    caCertPath,
    readCaFile,
  } = args

  if (isCloudSqlSocket) return {}

  // Effective mode after applying precedence. `undefined` means "fall back to
  // NODE_ENV-based default" (off in dev, require in prod).
  let effective: SslMode | undefined
  if (databaseSslEnv === 'disable' || databaseSslEnv === 'require') {
    effective = databaseSslEnv
  } else if (urlMode) {
    effective = urlMode
  } else if (isProduction) {
    effective = 'require'
  }

  if (!effective || effective === 'disable') return {}

  if (effective === 'verify-ca' || effective === 'verify-full') {
    if (!caCertPath) {
      throw new Error(
        `sslmode=${effective} requires DATABASE_CA_CERT_PATH to be set ` +
          `so the server certificate can be verified.`,
      )
    }
    return { ssl: { ca: readCaFile(caCertPath) } }
  }

  // require
  if (caCertPath) return { ssl: { ca: readCaFile(caCertPath) } }
  return { ssl: 'require' }
}

const sslOptions = resolveSslOption({
  databaseSslEnv: process.env.DATABASE_SSL,
  urlSslMode,
  isProduction: process.env.NODE_ENV === 'production',
  isCloudSqlSocket: options.host?.startsWith('/cloudsql/') ?? false,
  caCertPath: process.env.DATABASE_CA_CERT_PATH,
  readCaFile: (p) => fs.readFileSync(p),
})

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
