// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

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

import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '@/lib/db/schema'
import { itemTypeConfigs, users, workflowDefinitions } from '@/lib/db/schema'
import { LIFECYCLE_IDS } from '@/lib/items/lifecycle-ids'
import { ItemTypeRegistry } from '@/lib/items/registry'

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
  lifecycleType: 'Driven' as const,
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
      // Raw inserts must state the truth: without this, a fresh database
      // gets the column's DEFAULT 'Free' lie
      lifecycleType: 'Driven',
    })
    .onConflictDoNothing()

  // Normalize the drivers allow-list to permissive regardless of who wrote
  // the row: `npm run db:seed` sets drivers to the two *seeded* CO workflow
  // IDs, which would block every test-local Driving workflow now that
  // WI-4.4 enforces the list — and only on databases that were seeded,
  // the exact environment split the fresh-DB rule exists to prevent.
  // Suites that test the allow-list itself own their rows (see
  // LifecycleService.test.ts) and never rely on this shared one.
  await db
    .update(workflowDefinitions)
    .set({ drivers: [] })
    .where(eq(workflowDefinitions.id, LIFECYCLE_IDS.part))
  // Definitions written straight to the table bypass WorkflowService, which is
  // where the lifecycle memo is normally dropped
  ItemTypeRegistry.invalidateLifecycleCache()
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

/**
 * Canonical Work Order lifecycle (Free): Not Started → In Progress →
 * Complete / Cancelled. Matches scripts/seed-minimal.ts so tests that
 * transition WO status via LifecycleService.transitionFreeItem work on a
 * fresh database (dev databases get this row from the app seed; CI's
 * db:push-built scratch database does not).
 */
export const WORK_ORDER_LIFECYCLE_DEFINITION = {
  states: [
    {
      id: 'Not Started',
      name: 'Not Started',
      color: 'gray',
      isInitial: true,
      isFinal: false,
    },
    {
      id: 'In Progress',
      name: 'In Progress',
      color: 'blue',
      isInitial: false,
      isFinal: false,
    },
    {
      id: 'Complete',
      name: 'Complete',
      color: 'green',
      isInitial: false,
      isFinal: true,
    },
    {
      id: 'Cancelled',
      name: 'Cancelled',
      color: 'red',
      isInitial: false,
      isFinal: true,
    },
  ],
  transitions: [
    {
      id: 'wo-t1',
      name: 'Start',
      fromStateId: 'Not Started',
      toStateId: 'In Progress',
    },
    {
      id: 'wo-t2',
      name: 'Cancel',
      fromStateId: 'Not Started',
      toStateId: 'Cancelled',
    },
    {
      id: 'wo-t3',
      name: 'Complete',
      fromStateId: 'In Progress',
      toStateId: 'Complete',
    },
    {
      id: 'wo-t4',
      name: 'Cancel In Progress',
      fromStateId: 'In Progress',
      toStateId: 'Cancelled',
    },
  ],
  lifecycleType: 'Free' as const,
  applicableItemTypes: ['WorkOrder'],
}

/**
 * Seed the Work Order lifecycle + item-type link. beforeAll-safe like the
 * Part helpers (first-writer-wins on the definition, last-writer-wins on
 * the config link).
 */
export async function seedWorkOrderLifecycle(
  db: TestDbInstance,
  systemUserId: string = SYSTEM_USER_ID,
): Promise<void> {
  await seedSystemUser(db)
  await db
    .insert(workflowDefinitions)
    .values({
      id: LIFECYCLE_IDS.workOrder,
      name: 'Work Order - Test Lifecycle',
      version: 1,
      workflowType: 'strict',
      definition: WORK_ORDER_LIFECYCLE_DEFINITION,
      isActive: true,
      lifecycleType: 'Free',
    })
    .onConflictDoNothing()
  const config = { lifecycleDefinitionId: LIFECYCLE_IDS.workOrder }
  await db
    .insert(itemTypeConfigs)
    .values({
      itemType: 'WorkOrder',
      config,
      modifiedBy: systemUserId,
    })
    .onConflictDoUpdate({
      target: itemTypeConfigs.itemType,
      set: { config, modifiedBy: systemUserId },
    })
  // Definitions written straight to the table bypass WorkflowService, which is
  // where the lifecycle memo is normally dropped
  ItemTypeRegistry.invalidateLifecycleCache()
}
