// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * A test database with more than one connection, and no gate transaction.
 *
 * `TestDatabase` gives every test a transaction and rolls it back, which is
 * what makes the suite fast and isolated — and it is also why the suite is
 * blind to an entire class of bug. Two things follow from a single connection
 * wrapped in one transaction:
 *
 *  1. **Nothing is ever concurrent.** Two service calls issued through
 *     `Promise.all` queue on the same connection, so a race that needs two
 *     transactions interleaving cannot occur. A check-then-write that is wide
 *     open in production looks atomic under test.
 *  2. **A service that ignores its caller's `tx` looks correct.** `withTx`'s
 *     own doc comment in `lib/db/index.ts` spells this out: on the pooled
 *     handle, opening a second transaction lands on a *different* connection
 *     and commits independently of the caller's rollback — but under
 *     `TestDatabase` it lands on the same connection, nests as a savepoint,
 *     and rolls back with everything else. That comment ends "**This cannot be
 *     covered by a test**". This harness is what makes it coverable.
 *
 * So: a real pool, `setTestDb`/`setTestAutonomousDb` pointed at it, and **no
 * `beginTransaction`**. Writes commit for real, which is the whole point and
 * also the cost — the harness owns its cleanup, by scoped delete, never by
 * TRUNCATE. The test database is shared with whatever else is running.
 *
 * Use it from a dedicated file. Vitest runs one fork per file (`pool: 'forks'`
 * in vitest.config.ts), so a harness file never shares a process with a suite
 * whose `setTestDb` points at a gate transaction — but two suites in one file
 * would, and the second would silently inherit the first's handle. The naming
 * convention for such files is `*.race.test.ts`.
 *
 * @example
 * ```typescript
 * const concurrent = new ConcurrentTestDatabase()
 *
 * beforeAll(() => concurrent.setup())
 * afterAll(() => concurrent.teardown())
 * afterEach(() => concurrent.cleanup())
 *
 * it('refuses the second of two simultaneous checkouts', async () => {
 *   const { designId, user } = await concurrent.seedScope('checkout-race')
 *   const results = await Promise.allSettled([
 *     CheckoutService.checkout({ ... }, user.id),
 *     CheckoutService.checkout({ ... }, other.id),
 *   ])
 *   // Two real connections, so one of these genuinely lost.
 * })
 * ```
 */

import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { inArray, or, sql } from 'drizzle-orm'
import { insertTestUserWithRole } from '../fixtures/users'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { TestUser } from '../fixtures/users'
import * as schema from '@/lib/db/schema'
import {
  branchItems,
  changeOrderAffectedItems,
  designs,
  itemRelationships,
  items,
  jobs,
  programs,
  users,
} from '@/lib/db/schema'
import { resetDb, setTestAutonomousDb, setTestDb } from '@/lib/db'
import { DesignService } from '@/lib/services/DesignService'
import { ProgramService } from '@/lib/services/ProgramService'

type DbSchema = typeof schema
type TestDbInstance = PostgresJsDatabase<DbSchema>

/** One program, one design, and the member who owns both. */
export interface SeededScope {
  user: TestUser
  programId: string
  designId: string
}

export class ConcurrentTestDatabase {
  private client: postgres.Sql | null = null
  private _db: TestDbInstance | null = null

  private readonly createdUsers = new Set<string>()
  private readonly createdPrograms = new Set<string>()
  private readonly createdDesigns = new Set<string>()

  /**
   * Five, not two. A race test wants several service calls in flight at once
   * plus a connection spare for `autonomousDb`'s number allocation; a pool
   * that runs out does not fail, it queues — which would quietly restore the
   * serialization this harness exists to remove.
   */
  constructor(private readonly maxConnections = 5) {}

  get db(): TestDbInstance {
    if (!this._db) {
      throw new Error(
        'ConcurrentTestDatabase not initialized. Call setup() first.',
      )
    }
    return this._db
  }

  setup(): void {
    // TEST_DATABASE_URL only, like TestDatabase — global setup refuses to
    // start without it, and this harness commits, so guessing a database here
    // would be worse than anywhere else in the suite.
    const connectionUrl = process.env.TEST_DATABASE_URL
    if (!connectionUrl) {
      throw new Error(
        'ConcurrentTestDatabase: TEST_DATABASE_URL is not set. See the ' +
          'provisioning steps in packages/core/src/__tests__/README.md.',
      )
    }

    this.client = postgres(connectionUrl, {
      max: this.maxConnections,
      idle_timeout: 20,
      connect_timeout: 10,
      onnotice: () => {},
    })
    this._db = drizzle(this.client, { schema })

    // A stuck transaction here holds locks on committed data, so the timeout
    // matters more than it does under TestDatabase.
    this._db
      .execute(sql`SET idle_in_transaction_session_timeout = '30s'`)
      .catch(() => {})

    setTestDb(this._db)
    setTestAutonomousDb(this._db)
  }

  async teardown(): Promise<void> {
    await this.cleanup()
    resetDb()
    if (this.client) {
      await this.client.end()
      this.client = null
      this._db = null
    }
  }

  /** Register a row for deletion. Anything a test creates itself needs this. */
  trackUser(id: string): void {
    this.createdUsers.add(id)
  }

  trackProgram(id: string): void {
    this.createdPrograms.add(id)
  }

  trackDesign(id: string): void {
    this.createdDesigns.add(id)
  }

  /**
   * A member, their program, and a design in it — the minimum any versioning
   * race needs, and all three tracked for cleanup.
   *
   * Built with the real services rather than direct inserts, because
   * `ProgramService.create` is what enrols the creator; a hand-built program
   * row leaves its owner outside it, which is the trap the plan records.
   */
  async seedScope(label: string): Promise<SeededScope> {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    const { user } = await insertTestUserWithRole(this.db, 'User')
    this.trackUser(user.id)

    const program = await ProgramService.create(
      { name: `Concurrent ${label}`, code: `CR-${unique}` },
      user.id,
    )
    this.trackProgram(program.id)

    const design = await DesignService.create(
      {
        programId: program.id,
        name: `Concurrent ${label}`,
        code: `CRD-${unique}`,
        designType: 'Engineering',
      },
      user.id,
    )
    this.trackDesign(design.id)

    return { user, programId: program.id, designId: design.id }
  }

  /**
   * Delete everything this harness created, in FK-safe order.
   *
   * Scoped deletes, never TRUNCATE: the test database is shared with every
   * other suite in the run, and a crashed race test that truncated would take
   * them all with it.
   *
   * The order is not arbitrary. `items.design_id`, both design columns on
   * `item_relationships`, and `requirements.allocated_design_id` are all
   * `ON DELETE NO ACTION`, so a design cannot go before the rows naming it —
   * while branches, commits and every type-extension table cascade, so they
   * need no line here. Users go last: half the schema records who touched a
   * row.
   *
   * Items are scoped by **design or author**, not by design alone. A change
   * order is an item with no `designId` at all — its designs hang off
   * `change_order_designs` — so a design-scoped delete walks straight past
   * every ECO a test created, and the user delete then fails on
   * `items_created_by_users_id_fk`. Authorship is the only scope that covers
   * both.
   */
  async cleanup(): Promise<void> {
    if (!this._db) return

    const designIds = [...this.createdDesigns]
    const programIds = [...this.createdPrograms]
    const userIds = [...this.createdUsers]

    const scopeConditions = [
      designIds.length > 0 ? inArray(items.designId, designIds) : undefined,
      userIds.length > 0 ? inArray(items.createdBy, userIds) : undefined,
    ].filter((c) => c !== undefined)

    if (userIds.length > 0) {
      // `affected_item_id` is NO ACTION, so these rows outlive a cascade from
      // the change order and would block deleting the items they point at.
      await this._db
        .delete(changeOrderAffectedItems)
        .where(inArray(changeOrderAffectedItems.createdBy, userIds))
      // Job rows land as post-commit side effects of the flows under test —
      // an ECO release submits watermark and notification jobs — and
      // `jobs.created_by` is NO ACTION, so they would block the user delete
      // below. Job logs cascade from the job.
      await this._db.delete(jobs).where(inArray(jobs.createdBy, userIds))
    }
    if (designIds.length > 0) {
      await this._db
        .delete(itemRelationships)
        .where(inArray(itemRelationships.sourceDesignId, designIds))
      await this._db
        .delete(itemRelationships)
        .where(inArray(itemRelationships.targetDesignId, designIds))
    }
    if (scopeConditions.length > 0) {
      // branch_items.current_item_id/base_item_id are NO ACTION FKs (DBI-6):
      // the tracking rows must go before the items they point at. The design
      // cascade below would have taken them anyway — but after the items
      // delete, which is too late for an immediate FK check.
      const doomedItems = this._db
        .select({ id: items.id })
        .from(items)
        .where(or(...scopeConditions))
      await this._db
        .delete(branchItems)
        .where(
          or(
            inArray(branchItems.currentItemId, doomedItems),
            inArray(branchItems.baseItemId, doomedItems),
          ),
        )
      // Cascades parts, documents, requirements, change_orders, physical_parts,
      // work_orders, vault_files and the relationship rows keyed on the items.
      await this._db.delete(items).where(or(...scopeConditions))
    }
    if (designIds.length > 0) {
      await this._db.delete(designs).where(inArray(designs.id, designIds))
    }
    if (programIds.length > 0) {
      await this._db.delete(programs).where(inArray(programs.id, programIds))
    }
    if (userIds.length > 0) {
      await this._db.delete(users).where(inArray(users.id, userIds))
    }

    this.createdDesigns.clear()
    this.createdPrograms.clear()
    this.createdUsers.clear()
  }
}
