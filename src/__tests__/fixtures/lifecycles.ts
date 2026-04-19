/**
 * Lifecycle & Item-Type Config Fixtures
 *
 * Shared seeding helpers for tests that need the Part lifecycle definition
 * and the Part -> lifecycle link in `item_type_configs`.
 *
 * All helpers are **beforeAll-safe** (idempotent, first-writer-wins on conflict)
 * and MUST NOT be called from `beforeEach` — see the TestDatabase memory note
 * on lock contention inside gate transactions.
 *
 * For ECO / ChangeOrder workflow definitions, keep those inline in the test
 * file — they intentionally vary in state/transition shape per test.
 */

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '@/lib/db/schema'
import { itemTypeConfigs, users, workflowDefinitions } from '@/lib/db/schema'
import { LIFECYCLE_IDS } from '@/lib/items/lifecycle-ids'

type DbSchema = typeof schema
type TestDbInstance = PostgresJsDatabase<DbSchema>

/**
 * Fixed system user ID used for `modifiedBy` foreign key constraints on
 * config rows. Matches the seed script pattern.
 */
export const SYSTEM_USER_ID = '00000000-0000-4000-8000-000000000000'

/**
 * Canonical Part lifecycle definition with changeActionMappings for ECO actions
 * (release / revise / obsolete). Use for tests that exercise the
 * Draft → Released → Superseded / Obsolete flow.
 */
export const PART_LIFECYCLE_DEFINITION = {
  states: [
    {
      id: 'Draft',
      name: 'Draft',
      color: 'gray',
      isInitial: true,
      isFinal: false,
    },
    {
      id: 'Released',
      name: 'Released',
      color: 'green',
      isInitial: false,
      isFinal: false,
    },
    {
      id: 'Superseded',
      name: 'Superseded',
      color: 'slate',
      isInitial: false,
      isFinal: true,
    },
    {
      id: 'Obsolete',
      name: 'Obsolete',
      color: 'red',
      isInitial: false,
      isFinal: true,
    },
  ],
  transitions: [],
  changeActionMappings: {
    release: {
      fromState: 'Draft',
      toState: 'Released',
      assignsRevision: true,
    },
    revise: {
      fromState: 'Released',
      newVersionState: 'Released',
      oldVersionState: 'Superseded',
      assignsRevision: true,
    },
    obsolete: {
      fromState: 'Released',
      toState: 'Obsolete',
      assignsRevision: false,
    },
  },
  definitionType: 'lifecycle' as const,
  applicableItemTypes: ['Part'],
}

/**
 * Insert the fixed system user if not already present.
 * Idempotent via `onConflictDoNothing` — safe across parallel test files.
 */
export async function seedSystemUser(db: TestDbInstance): Promise<void> {
  await db
    .insert(users)
    .values({
      id: SYSTEM_USER_ID,
      email: 'system@test.local',
      name: 'System User',
      passwordHash: 'not-used',
      active: true,
    })
    .onConflictDoNothing()
}

/**
 * Seed the Part lifecycle definition under the well-known `LIFECYCLE_IDS.part`
 * UUID. First-writer-wins across parallel test files; subsequent inserts no-op.
 */
export async function seedPartLifecycle(db: TestDbInstance): Promise<void> {
  await db
    .insert(workflowDefinitions)
    .values({
      id: LIFECYCLE_IDS.part,
      name: 'Part - Test Lifecycle',
      version: 1,
      workflowType: 'strict',
      definition: PART_LIFECYCLE_DEFINITION,
      isActive: true,
    })
    .onConflictDoNothing()
}

/**
 * Link the Part item type to the Part lifecycle via `item_type_configs`.
 * Uses `onConflictDoUpdate` to override any pre-existing app seed data so
 * tests see the canonical test lifecycle regardless of what the base seed
 * inserted.
 */
export async function seedPartItemTypeConfig(
  db: TestDbInstance,
  systemUserId: string = SYSTEM_USER_ID,
): Promise<void> {
  const config = { lifecycleDefinitionId: LIFECYCLE_IDS.part }
  await db
    .insert(itemTypeConfigs)
    .values({
      itemType: 'Part',
      config,
      modifiedBy: systemUserId,
    })
    .onConflictDoUpdate({
      target: itemTypeConfigs.itemType,
      set: { config, modifiedBy: systemUserId },
    })
}

/**
 * Convenience: seed system user + Part lifecycle + Part item-type link in one
 * call. Most tests only need this bundle; more complex tests (ECO/ChangeOrder
 * workflow) should keep their workflow-specific seeding inline.
 */
export async function seedStandardPartLifecycle(
  db: TestDbInstance,
): Promise<void> {
  await seedSystemUser(db)
  await seedPartLifecycle(db)
  await seedPartItemTypeConfig(db)
}
