// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Test Database Utilities
 *
 * Provides database helpers for integration tests including:
 * - Transaction-based test isolation (rollback after each test)
 * - Database seeding utilities
 * - Cleanup functions
 *
 * @example
 * ```typescript
 * import { TestDatabase } from '@test/helpers/db'
 *
 * describe('MyService', () => {
 *   const testDb = new TestDatabase()
 *
 *   beforeAll(() => testDb.setup())
 *   afterAll(() => testDb.teardown())
 *   beforeEach(() => testDb.beginTransaction())
 *   afterEach(() => testDb.rollback())
 *
 *   test('creates item', async () => {
 *     const result = await testDb.db.insert(items).values({...})
 *     // Changes automatically rolled back after test
 *   })
 * })
 * ```
 */

import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { eq, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { TransactionClient } from '@/lib/db'
import * as schema from '@/lib/db/schema'
import { items, users } from '@/lib/db/schema'
import { resetDb, setTestAutonomousDb, setTestDb } from '@/lib/db'

type DbSchema = typeof schema
type TestDbInstance = PostgresJsDatabase<DbSchema>

/**
 * Test database configuration
 */
export interface TestDatabaseConfig {
  /** Database connection URL (defaults to TEST_DATABASE_URL or DATABASE_URL) */
  connectionUrl?: string
  /** Maximum connections in pool */
  maxConnections?: number
  /** Enable query logging */
  logging?: boolean
}

/**
 * TestDatabase class for managing test database connections and transactions
 *
 * Uses savepoints for transaction isolation, allowing tests to run in
 * parallel while maintaining isolation through nested transactions.
 */
export class TestDatabase {
  private client: postgres.Sql | null = null
  private _db: TestDbInstance | null = null
  private _tx: TransactionClient | null = null
  private gateReject: ((err: Error) => void) | null = null
  private txDone: Promise<void> | null = null
  private inTransaction = false
  private config: Required<TestDatabaseConfig>

  constructor(config: TestDatabaseConfig = {}) {
    // TEST_DATABASE_URL only. DATABASE_URL used to be the fallback here, which
    // is how a test run reached the development database; global-setup.ts
    // refuses to start without the test one, so by the time this constructor
    // runs it is set.
    const connectionUrl = config.connectionUrl || process.env.TEST_DATABASE_URL
    if (!connectionUrl) {
      throw new Error(
        'TestDatabase: TEST_DATABASE_URL is not set and no connectionUrl was ' +
          'passed. Refusing to fall back to an implicit database — see the ' +
          'provisioning steps in packages/core/src/__tests__/README.md.',
      )
    }
    this.config = {
      connectionUrl,
      // Two, not one. The gate transaction holds a connection open for the
      // whole test, and `autonomousDb` needs a second to allocate item numbers
      // on — with a single-connection pool that allocation would queue behind
      // the very transaction it is serving and hang.
      maxConnections: config.maxConnections || 2,
      logging: config.logging ?? false,
    }
  }

  /**
   * Get the database instance
   * @throws Error if setup() hasn't been called
   */
  get db(): TestDbInstance {
    if (this._tx) return this._tx
    if (!this._db) {
      throw new Error('TestDatabase not initialized. Call setup() first.')
    }
    return this._db
  }

  /**
   * Initialize the database connection and inject it as the global db
   */
  setup(): void {
    this.client = postgres(this.config.connectionUrl, {
      max: this.config.maxConnections,
      idle_timeout: 20,
      connect_timeout: 10,
      onnotice: () => {}, // Suppress notices
    })

    this._db = drizzle(this.client, {
      schema,
      logger: this.config.logging,
    })

    // Auto-terminate connections stuck in transactions after 30s.
    // This prevents force-killed tests from holding locks that block
    // subsequent test files.
    this._db
      .execute(sql`SET idle_in_transaction_session_timeout = '30s'`)
      .catch(() => {})

    // Inject this test db as the global db so services use it
    setTestDb(this._db)
    // `autonomousDb` keeps pointing at the pool even while `db` is swapped for
    // a transaction, so number allocation commits and releases its lock
    // immediately instead of holding it for the length of the test.
    setTestAutonomousDb(this._db)
  }

  /**
   * Close database connection and restore the original global db
   */
  async teardown(): Promise<void> {
    // Clean up any in-flight transaction before closing
    if (this.inTransaction) {
      await this.rollback()
    }

    // Restore the original global db before closing
    resetDb()

    if (this.client) {
      await this.client.end()
      this.client = null
      this._db = null
    }
  }

  /**
   * Begin a new transaction with a savepoint
   * Use this in beforeEach to isolate each test
   */
  async beginTransaction(): Promise<void> {
    if (!this._db) {
      throw new Error('TestDatabase not initialized. Call setup() first.')
    }
    if (this.inTransaction) {
      await this.rollback()
    }
    this.inTransaction = true

    await new Promise<void>((resolveReady) => {
      this.txDone = this._db!.transaction(async (tx) => {
        this._tx = tx
        setTestDb(this._tx)
        resolveReady()

        // Hold transaction open until rollback() rejects the gate
        await new Promise<void>((_resolve, reject) => {
          this.gateReject = reject
        })
      }).catch(() => {
        // Gate rejection causes transaction to rollback — expected
      })
    })
  }

  /**
   * Rollback to the savepoint, undoing all changes made during the test
   * Use this in afterEach to clean up after each test
   */
  async rollback(): Promise<void> {
    if (!this.inTransaction) return

    if (this.gateReject) {
      this.gateReject(new Error('rollback'))
      this.gateReject = null
    }

    // Wait for the transaction wrapper to finish (sends ROLLBACK)
    if (this.txDone) {
      await this.txDone
      this.txDone = null
    }

    this._tx = null
    this.inTransaction = false

    // Restore base db for between-test operations
    if (this._db) setTestDb(this._db)
  }

  /**
   * Force cleanup any stuck transactions. Use in afterAll as a safety net
   * when a test timeout may have left a connection in a bad state.
   */
  async forceCleanup(): Promise<void> {
    try {
      await this._db?.execute(sql`ROLLBACK`)
    } catch {
      // Connection is truly broken — nothing we can do
    }
  }

  /**
   * Execute a function within a transaction that gets rolled back
   * Useful for one-off tests that need isolation
   *
   * @example
   * ```typescript
   * await testDb.withRollback(async (db) => {
   *   await db.insert(items).values({...})
   *   // Automatically rolled back
   * })
   * ```
   */
  async withRollback<T>(fn: (db: TestDbInstance) => Promise<T>): Promise<T> {
    await this.beginTransaction()
    try {
      const result = await fn(this.db)
      return result
    } finally {
      await this.rollback()
    }
  }
}

/**
 * Singleton test database instance for simple test setups
 * Use TestDatabase class directly for more control
 */
let sharedTestDb: TestDatabase | null = null

export function getTestDatabase(): TestDatabase {
  if (!sharedTestDb) {
    sharedTestDb = new TestDatabase()
  }
  return sharedTestDb
}

/**
 * Setup helper for vitest - use in beforeAll/afterAll
 *
 * This helper automatically injects the test database as the global db,
 * so all services (ItemService, etc.) will use the test connection.
 *
 * @example
 * ```typescript
 * import { setupTestDb } from '@test/helpers/db'
 *
 * const { testDb, db } = setupTestDb()
 * // testDb handles lifecycle, db is the drizzle instance
 * // All services will use this db connection
 * ```
 */
export function setupTestDb() {
  const testDb = new TestDatabase()

  return {
    testDb,
    get db() {
      return testDb.db
    },
    async setup() {
      await testDb.setup()
      // Note: testDb.setup() already calls setTestDb()
    },
    async teardown() {
      await testDb.teardown()
      // Note: testDb.teardown() already calls resetDb()
    },
    async beginTransaction() {
      await testDb.beginTransaction()
    },
    async rollback() {
      await testDb.rollback()
    },
  }
}

/**
 * Quick test database queries for common operations
 */
export const testQueries = {
  /**
   * Get a user by email
   */
  async getUserByEmail(db: TestDbInstance, email: string) {
    const result = await db.select().from(users).where(eq(users.email, email))
    return result[0] ?? null
  },

  /**
   * Get an item by item number and revision
   */
  async getItemByNumber(
    db: TestDbInstance,
    itemNumber: string,
    revision = 'A',
  ) {
    const result = await db
      .select()
      .from(items)
      .where(eq(items.itemNumber, itemNumber))
    return result.find((i) => i.revision === revision) ?? null
  },

  /**
   * Get all items of a specific type
   */
  async getItemsByType(db: TestDbInstance, itemType: string) {
    return db.select().from(items).where(eq(items.itemType, itemType))
  },

  /**
   * Count items in the database
   */
  async countItems(db: TestDbInstance): Promise<number> {
    const result = await db.select({ count: sql<number>`COUNT(*)` }).from(items)
    return Number(result[0]?.count ?? 0)
  },
}
