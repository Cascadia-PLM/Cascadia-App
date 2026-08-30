// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * User Test Fixtures
 *
 * Factory functions for creating user and role test data.
 *
 * @example
 * ```typescript
 * import { createTestUser, insertTestUser, userPresets } from '@test/fixtures/users'
 *
 * // Create in-memory user data
 * const user = createTestUser({ email: 'test@example.com' })
 *
 * // Use presets for common user types
 * const admin = userPresets.admin()
 *
 * // Insert into test database
 * const insertedUser = await insertTestUser(db, { email: 'new@example.com' })
 * ```
 */

import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '@/lib/db/schema'
import type { RoleName } from '@/lib/auth/permissions'
import { roles, userRoles, users } from '@/lib/db/schema'
import { ROLE_DEFINITIONS, roleToDbFormat } from '@/lib/auth/permissions'
import { takeFirst } from '@/lib/db/take-first'

type DbSchema = typeof schema
type TestDbInstance = PostgresJsDatabase<DbSchema>

/**
 * Test user data type
 */
export interface TestUser {
  id: string
  email: string
  name: string | null
  passwordHash: string | null
  provider: string | null
  providerId: string | null
  active: boolean
  lastLogin: Date | null
  createdAt: Date
}

/**
 * Input for creating test users
 */
export interface CreateTestUserInput {
  id?: string
  email?: string
  name?: string
  passwordHash?: string | null
  provider?: string
  providerId?: string
  active?: boolean
  lastLogin?: Date
  createdAt?: Date
}

/**
 * Test role data type
 */
export interface TestRole {
  id: string
  name: string
  description: string | null
  permissions: Record<string, Array<string>>
}

/**
 * Test session data type
 */

let userCounter = 0
let roleCounter = 0

/**
 * Create test user data (in-memory only)
 */
export function createTestUser(overrides: CreateTestUserInput = {}): TestUser {
  userCounter++
  const timestamp = Date.now()
  const random = Math.random().toString(36).slice(2, 8)

  return {
    id: overrides.id ?? crypto.randomUUID(),
    email:
      overrides.email ??
      `testuser${userCounter}-${timestamp}-${random}@example.com`,
    name: overrides.name ?? `Test User ${userCounter}`,
    passwordHash: overrides.passwordHash ?? '$test$hash$placeholder', // Not a real hash
    provider: overrides.provider ?? 'local',
    providerId: overrides.providerId ?? null,
    active: overrides.active ?? true,
    lastLogin: overrides.lastLogin ?? null,
    createdAt: overrides.createdAt ?? new Date(),
  }
}

/**
 * Insert test user into database
 *
 * @param db - Database instance
 * @param overrides - Optional field overrides
 * @returns Inserted user record
 */
export async function insertTestUser(
  db: TestDbInstance,
  overrides: CreateTestUserInput = {},
): Promise<TestUser> {
  const userData = createTestUser(overrides)

  const inserted = takeFirst(
    await db
      .insert(users)
      .values({
        id: userData.id,
        email: userData.email,
        name: userData.name,
        passwordHash: userData.passwordHash,
        provider: userData.provider,
        providerId: userData.providerId,
        active: userData.active,
      })
      .returning(),
  )

  return {
    ...inserted,
    createdAt: inserted.createdAt,
    lastLogin: inserted.lastLogin,
  }
}

/**
 * Create a test role from predefined role definitions
 */
export function createTestRole(roleName: RoleName): TestRole {
  const definition = ROLE_DEFINITIONS[roleName]
  return {
    id: crypto.randomUUID(),
    name: definition.name,
    description: definition.description,
    permissions: roleToDbFormat(definition),
  }
}

/**
 * Create a custom test role with specific permissions
 */
export function createCustomTestRole(
  name: string,
  permissions: Record<string, Array<string>>,
  description?: string,
): TestRole {
  roleCounter++
  return {
    id: crypto.randomUUID(),
    name: name || `Custom Role ${roleCounter}`,
    description: description ?? null,
    permissions,
  }
}

/**
 * Insert test role into database
 */
export async function insertTestRole(
  db: TestDbInstance,
  role: TestRole,
): Promise<TestRole> {
  const inserted = takeFirst(
    await db
      .insert(roles)
      .values({
        id: role.id,
        name: role.name,
        description: role.description,
        permissions: role.permissions,
      })
      .returning(),
  )

  return {
    ...inserted,
    permissions: inserted.permissions as Record<string, Array<string>>,
  }
}

/**
 * Assign a role to a user
 */
export async function assignRoleToUser(
  db: TestDbInstance,
  userId: string,
  roleId: string,
): Promise<void> {
  await db.insert(userRoles).values({
    userId,
    roleId,
  })
}

/**
 * Seed the built-in roles, once, before any worker forks.
 *
 * `roles.name` is unique and no suite seeds the table, so every suite that
 * wanted a built-in role inserted it — inside its own gate transaction, which
 * then rolled back, so the next suite inserted it again. Run in parallel that
 * is a queue of transactions contending on one unique index, and because
 * different suites ask for different roles in different orders, it deadlocks:
 * a full run failed here 9 to 12 times out of ~2000, in a different set of
 * tests each time.
 *
 * Committed in global setup instead, first-writer-wins, the way the default
 * lifecycles already are. After this, `insertTestUserWithRole` finds every
 * built-in role and inserts nothing.
 */
export async function seedBuiltInRoles(db: TestDbInstance): Promise<void> {
  for (const definition of Object.values(ROLE_DEFINITIONS)) {
    await db
      .insert(roles)
      .values({
        name: definition.name,
        description: definition.description,
        permissions: roleToDbFormat(definition),
      })
      .onConflictDoNothing({ target: roles.name })
  }
}

/**
 * Insert test user with a specific role
 */
export async function insertTestUserWithRole(
  db: TestDbInstance,
  roleName: RoleName,
  userOverrides: CreateTestUserInput = {},
): Promise<{ user: TestUser; role: TestRole }> {
  const definition = ROLE_DEFINITIONS[roleName]
  let roleRow = await findRoleByName(db, definition.name)

  if (!roleRow) {
    // Global setup seeds these before any worker forks, so this is only
    // reached on a database that predates it. Conflict-tolerant, then re-read:
    // two forks racing on the unique name must not become a failed insert.
    await db
      .insert(roles)
      .values({
        name: definition.name,
        description: definition.description,
        permissions: roleToDbFormat(definition),
      })
      .onConflictDoNothing({ target: roles.name })
    roleRow = await findRoleByName(db, definition.name)
  }

  if (!roleRow) {
    throw new Error(`Role '${definition.name}' could not be seeded`)
  }

  const role: TestRole = {
    id: roleRow.id,
    name: roleRow.name,
    description: roleRow.description,
    permissions: roleRow.permissions as Record<string, Array<string>>,
  }

  // Create and insert user
  const user = await insertTestUser(db, userOverrides)

  // Assign role to user
  await assignRoleToUser(db, user.id, role.id)

  return { user, role }
}

async function findRoleByName(db: TestDbInstance, name: string) {
  const [row] = await db
    .select()
    .from(roles)
    .where(eq(roles.name, name))
    .limit(1)
  return row ?? null
}

/**
 * User presets for common test scenarios
 */
export const userPresets = {
  /** Administrator with full permissions */
  admin: (overrides?: CreateTestUserInput) =>
    createTestUser({
      name: 'Admin User',
      email: `admin-${Date.now()}@example.com`,
      ...overrides,
    }),

  /** Power user with elevated permissions */
  powerUser: (overrides?: CreateTestUserInput) =>
    createTestUser({
      name: 'Power User',
      email: `poweruser-${Date.now()}@example.com`,
      ...overrides,
    }),

  /** Approver who can approve items */
  approver: (overrides?: CreateTestUserInput) =>
    createTestUser({
      name: 'Approver User',
      email: `approver-${Date.now()}@example.com`,
      ...overrides,
    }),

  /** Standard user */
  standard: (overrides?: CreateTestUserInput) =>
    createTestUser({
      name: 'Standard User',
      email: `user-${Date.now()}@example.com`,
      ...overrides,
    }),

  /** View-only user */
  viewOnly: (overrides?: CreateTestUserInput) =>
    createTestUser({
      name: 'Viewer User',
      email: `viewer-${Date.now()}@example.com`,
      ...overrides,
    }),

  /** Inactive user */
  inactive: (overrides?: CreateTestUserInput) =>
    createTestUser({
      name: 'Inactive User',
      email: `inactive-${Date.now()}@example.com`,
      active: false,
      ...overrides,
    }),

  /** OAuth user */
  oauth: (provider: string, overrides?: CreateTestUserInput) =>
    createTestUser({
      name: 'OAuth User',
      email: `oauth-${Date.now()}@example.com`,
      provider,
      providerId: `provider-id-${Date.now()}`,
      passwordHash: null,
      ...overrides,
    }),
}
