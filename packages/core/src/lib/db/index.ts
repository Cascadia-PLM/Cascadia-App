// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

// Load .env before anything reads process.env. Every consumer of `db` comes
// through here — the API server, the jobs worker, and every tsx script under
// scripts/ — and bare `tsx foo.ts` does not load .env on its own. Without this
// the scripts ran against whatever DATABASE_URL defaulted to, which is how
// `npm run db:reset:seed` silently hit the wrong database. dotenv never
// overrides an already-set variable, so CI and Docker still win.
import 'dotenv/config'
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

// No fallback on purpose. A default connection string means a missing .env
// points every script at some other machine's database instead of failing.
const envConnectionString = process.env.DATABASE_URL
if (!envConnectionString) {
  throw new Error(
    'DATABASE_URL is not set. Copy .env.example to .env and point ' +
      'DATABASE_URL at your database, or export it in the environment. ' +
      '(Working in a git worktree? .env is gitignored — copy it in.)',
  )
}
const connectionString: string = envConnectionString

/**
 * The connection target with credentials stripped, e.g.
 * `localhost:5432/cascadia`. For logging which database a script is
 * about to touch — never log `connectionString` itself, it carries the password.
 */
export function describeConnection(connStr = connectionString): string {
  try {
    const url = new URL(connStr)
    return `${url.host}${url.pathname}`
  } catch {
    return '(unparseable DATABASE_URL)'
  }
}

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

let currentAutonomousDb: DbInstance = defaultDb

/**
 * A handle that always runs on its own pooled connection and commits
 * immediately, never joining a caller's transaction.
 *
 * For the few writes whose whole point is to be independent of whether the
 * caller commits — number allocation above all. In production `db` already
 * behaves this way for them, because a service calling `db` from inside
 * `db.transaction(tx => …)` gets a *different* pooled connection. Tests are
 * where the distinction matters: `setTestDb` points `db` at the test's
 * long-lived gate transaction, which silently pulls those writes into it.
 *
 * That is not a hypothetical. Two test files, each holding a gate transaction
 * open for its whole run, both upserted the same `number_sequences` rows in
 * different orders and deadlocked — reproducibly, whenever the scheduler
 * happened to run them at the same time. Allocation on this handle releases
 * its row lock at once, so there is nothing left to deadlock on.
 */
export const autonomousDb: DbInstance = new Proxy({} as DbInstance, {
  get(_target, prop) {
    return (currentAutonomousDb as any)[prop]
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
 * Point `autonomousDb` at the test pool (for testing only).
 *
 * Deliberately separate from `setTestDb`: the test harness swaps `db` for a
 * transaction on every test, and this must keep pointing at the pool behind
 * it. The pool needs a spare connection — see `TestDatabase`.
 */
export function setTestAutonomousDb(testDb: DbInstance): void {
  currentAutonomousDb = testDb
}

/**
 * Restore the original database instance.
 */
export function resetDb(): void {
  currentDb = defaultDb
  currentAutonomousDb = defaultDb
}

/**
 * Run `fn` inside the caller's transaction when there is one, otherwise open a
 * new one.
 *
 * The pattern services need in order to compose. A service that always calls
 * `db.transaction()` cannot take part in a caller's transaction: on the global
 * `db` handle that opens a *second*, independent transaction on another pooled
 * connection, so the caller's rollback leaves its writes behind. That is what
 * made the change-order release's outer transaction decorative — every nested
 * `ItemService.update()` committed on its own.
 *
 * Accept an optional `tx`, pass it down, and hand it to this. Nesting a real
 * transaction client produces a savepoint, which is what you want.
 *
 * **This cannot be covered by a test**, which is why it went unnoticed for so
 * long. `TestDatabase` injects its gate transaction as the global `db` and caps
 * the pool at one connection, so a service that ignores the caller's `tx` and
 * opens its own still lands on the same connection — as a savepoint nested
 * inside the caller's — and rolls back with it. Ignoring `tx` therefore looks
 * perfectly atomic under test and is not atomic at all in production, where the
 * global handle is a pool. Review this by reading the call chain, not by
 * trusting a green suite.
 */
export async function withTx<T>(
  tx: TransactionClient | undefined,
  fn: (tx: TransactionClient) => Promise<T>,
  txConfig?: PgTransactionConfig,
): Promise<T> {
  return tx ? fn(tx) : db.transaction(fn, txConfig)
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
