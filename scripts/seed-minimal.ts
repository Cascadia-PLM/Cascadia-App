// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Minimal Database Seed Script
 * Creates only the bare essentials needed to start using Cascadia:
 * - Admin User (with the Administrator role)
 * - Standard Parts Library
 * - Core Roles
 * - Default lifecycles for every item type, from the default-lifecycles
 *   module (the seed writes no lifecycle of its own), plus the shipped
 *   drivers allow-list on the Driven ones
 */
import { eq } from 'drizzle-orm'
import { db, describeConnection } from '../packages/core/src/lib/db/index.ts'
import {
  roles,
  userRoles,
  users,
} from '../packages/core/src/lib/db/schema/users.ts'
import { designs } from '../packages/core/src/lib/db/schema/designs.ts'
import {
  branches,
  commits,
} from '../packages/core/src/lib/db/schema/versioning.ts'
import { itemTypeConfigs } from '../packages/core/src/lib/db/schema/config.ts'
import { lifecycleDefinitions } from '../packages/core/src/lib/db/schema/lifecycles.ts'
import {
  DEFAULT_ITEM_LIFECYCLES,
  seedDefaultLifecycles,
} from '../packages/core/src/lib/items/default-lifecycles.ts'
import { hashPassword } from '../packages/core/src/lib/auth/password.ts'
import {
  ROLE_DEFINITIONS,
  roleToDbFormat,
} from '../packages/core/src/lib/auth/permissions.ts'
import { LIFECYCLE_IDS } from '../packages/core/src/lib/items/lifecycle-ids.ts'
import { takeFirst } from '../packages/core/src/lib/db/take-first'

// Fixed IDs for consistent references (RFC 4122 compliant UUIDs)
// Format: version 4 (13th char = 4), variant 1 (17th char = 8-b)
const IDS = {
  admin: '00000000-0000-4000-8000-000000000000',
  standardLibrary: '00000000-0000-4000-8000-000000000020',
  // Lifecycle definition IDs - imported from shared constants
  partLifecycle: LIFECYCLE_IDS.part,
  documentLifecycle: LIFECYCLE_IDS.document,
  requirementLifecycle: LIFECYCLE_IDS.requirement,
  changeOrderWorkflow: LIFECYCLE_IDS.changeOrder,
  flexibleChangeOrderWorkflow: LIFECYCLE_IDS.flexibleChangeOrder,
  issueLifecycle: LIFECYCLE_IDS.issue,
  toolLifecycle: LIFECYCLE_IDS.tool,
  physicalPartLifecycle: LIFECYCLE_IDS.physicalPart,
  workOrderLifecycle: LIFECYCLE_IDS.workOrder,
}

try {
  console.log(`🌱 Seeding minimal database: ${describeConnection()}\n`)

  // ============================================================================
  // 1. Create Roles
  // ============================================================================
  const createdRoles: Record<string, string> = {}

  for (const [roleName, roleDef] of Object.entries(ROLE_DEFINITIONS)) {
    const dbPermissions = roleToDbFormat(roleDef)

    const createdRole = takeFirst(
      await db
        .insert(roles)
        .values({
          name: roleDef.name,
          description: roleDef.description,
          permissions: dbPermissions,
        })
        .onConflictDoUpdate({
          target: roles.name,
          set: {
            description: roleDef.description,
            permissions: dbPermissions,
          },
        })
        .returning(),
    )

    createdRoles[roleName] = createdRole.id
  }

  console.log('✓ Roles (Administrator, Power User, Approver, User, View Only)')

  // ============================================================================
  // 2. Create Admin User
  // ============================================================================
  const existingUser = await db
    .select()
    .from(users)
    .where(eq(users.email, 'admin@cascadia.local'))
    .limit(1)

  const existingAdmin = existingUser[0]
  let adminId: string
  if (existingAdmin) {
    // Never touch an existing admin row. An operator has likely changed the
    // password (and possibly active/provider), and re-running a seed must not
    // silently reset credentials to the published default.
    adminId = existingAdmin.id
    console.log('✓ Admin User already exists — credentials left untouched')
  } else {
    const created = takeFirst(
      await db
        .insert(users)
        .values({
          id: IDS.admin,
          email: 'admin@cascadia.local',
          name: 'System Admin',
          passwordHash: await hashPassword('Cascadia'),
          active: true,
          provider: 'local',
        })
        .returning(),
    )
    adminId = created.id
    console.log('✓ Admin User (admin@cascadia.local / Cascadia)')
  }

  // Assign the Administrator role — the top-level role; its programs:manage
  // grant is what carries cross-program authority.
  const administratorRoleId = createdRoles['Administrator']
  if (administratorRoleId) {
    await db
      .insert(userRoles)
      .values({
        userId: adminId,
        roleId: administratorRoleId,
      })
      .onConflictDoNothing()
  }

  // ============================================================================
  // 3. Create Standard Parts Library (Global)
  // ============================================================================
  const existingLibrary = await db
    .select()
    .from(designs)
    .where(eq(designs.code, 'STD-LIB'))
    .limit(1)

  const existingStandardLibrary = existingLibrary[0]
  let standardLibrary
  if (existingStandardLibrary) {
    standardLibrary = existingStandardLibrary
  } else {
    // Create the design (global library - no programId)
    const created = takeFirst(
      await db
        .insert(designs)
        .values({
          id: IDS.standardLibrary,
          programId: null, // Global library - not tied to any program
          name: 'Standard Parts Library',
          code: 'STD-LIB',
          description: 'System-wide standard parts, materials, and components',
          designType: 'Library',
          createdBy: adminId,
        })
        .returning(),
    )

    // Create main branch first (head unset), then the initial commit on it —
    // commits.branch_id is a real FK now, so the old placeholder-then-fixup
    // order cannot insert.
    const mainBranch = takeFirst(
      await db
        .insert(branches)
        .values({
          designId: created.id,
          name: 'main',
          branchType: 'main',
          createdBy: adminId,
        })
        .returning(),
    )

    const initialCommit = takeFirst(
      await db
        .insert(commits)
        .values({
          designId: created.id,
          branchId: mainBranch.id,
          message: 'Initial commit',
          createdBy: adminId,
        })
        .returning(),
    )

    await db
      .update(branches)
      .set({ headCommitId: initialCommit.id, baseCommitId: initialCommit.id })
      .where(eq(branches.id, mainBranch.id))

    // Update design with default branch
    const [updated] = await db
      .update(designs)
      .set({ defaultBranchId: mainBranch.id })
      .where(eq(designs.id, created.id))
      .returning()

    if (!updated) {
      throw new Error('Failed to update Standard Parts Library design')
    }

    standardLibrary = updated
  }
  console.log('✓ Standard Parts Library (Global)')

  // ============================================================================
  // 4. Default Lifecycles
  // ============================================================================

  // Every item type's default lifecycle — and both change-order workflows —
  // come from the default-lifecycles module, the same data the test
  // global-setup seeds, through version-gated upgrade-only upserts. The seed
  // used to carry its own copies of the long-established ones and overwrite
  // unconditionally; on a re-seed that handed a row the module had already
  // upgraded its old shape back while leaving the version number in place,
  // so the module's gate then refused to repair it.
  await seedDefaultLifecycles(db)

  // The shipped Driven lifecycles are driven only by the shipped change-order
  // workflows. Applied where nothing has chosen yet — the module seeds the
  // permissive empty list — so an admin's own allow-list survives a re-seed.
  const shippedDrivers = [
    IDS.changeOrderWorkflow,
    IDS.flexibleChangeOrderWorkflow,
  ]
  for (const lifecycleId of [
    IDS.partLifecycle,
    IDS.documentLifecycle,
    IDS.requirementLifecycle,
  ]) {
    const row = await db
      .select({ drivers: lifecycleDefinitions.drivers })
      .from(lifecycleDefinitions)
      .where(eq(lifecycleDefinitions.id, lifecycleId))
      .then(takeFirst)
    if ((row.drivers ?? []).length === 0) {
      await db
        .update(lifecycleDefinitions)
        .set({ drivers: shippedDrivers })
        .where(eq(lifecycleDefinitions.id, lifecycleId))
    }
  }

  console.log(
    '✓ Default lifecycles for every item type (the standard and flexible change-order workflows included)',
  )

  // ============================================================================
  // 5. Create Item Type Configs with Lifecycle Assignments
  // ============================================================================
  const typeConfigs = [
    {
      itemType: 'Part',
      config: {
        lifecycleDefinitionId: IDS.partLifecycle,
      },
    },
    {
      itemType: 'Document',
      config: {
        lifecycleDefinitionId: IDS.documentLifecycle,
      },
    },
    {
      itemType: 'Requirement',
      config: {
        lifecycleDefinitionId: IDS.requirementLifecycle,
      },
    },
    {
      itemType: 'ChangeOrder',
      config: {
        lifecycleDefinitionId: IDS.changeOrderWorkflow,
        // Map all change order types to the default workflow
        // XCO (Flexible Change Order) uses the flexible workflow that can be customized per instance
        lifecyclesByChangeType: {
          ECO: IDS.changeOrderWorkflow,
          ECN: IDS.changeOrderWorkflow,
          Deviation: IDS.changeOrderWorkflow,
          MCO: IDS.changeOrderWorkflow,
          XCO: IDS.flexibleChangeOrderWorkflow,
        },
      },
    },
    {
      itemType: 'Issue',
      config: {
        lifecycleDefinitionId: IDS.issueLifecycle,
      },
    },
    {
      itemType: 'Tool',
      config: {
        lifecycleDefinitionId: IDS.toolLifecycle,
      },
    },
    {
      itemType: 'Task',
      config: {
        lifecycleDefinitionId: LIFECYCLE_IDS.task,
      },
    },
    {
      itemType: 'TestPlan',
      config: {
        lifecycleDefinitionId: LIFECYCLE_IDS.testPlan,
      },
    },
    {
      itemType: 'TestCase',
      config: {
        lifecycleDefinitionId: LIFECYCLE_IDS.testCase,
      },
    },
    {
      itemType: 'WorkInstruction',
      config: {
        lifecycleDefinitionId: LIFECYCLE_IDS.workInstruction,
      },
    },
    {
      // Software shares the Part lifecycle: driven, ECO-controlled release
      itemType: 'Software',
      config: {
        lifecycleDefinitionId: LIFECYCLE_IDS.part,
      },
    },
    {
      itemType: 'PhysicalPart',
      config: {
        lifecycleDefinitionId: IDS.physicalPartLifecycle,
      },
    },
    {
      itemType: 'WorkOrder',
      config: {
        lifecycleDefinitionId: IDS.workOrderLifecycle,
      },
    },
  ]

  // First-writer-wins, like `seedDefaultLifecycles` above and for the same
  // reason: this is the row that carries an item type's lifecycle assignment,
  // and the seed is a command the deployment docs hand operators as a repair
  // step. Upserting it replaced the whole config document, so re-running the
  // seed silently reverted every lifecycle reassignment an administrator had
  // made in /admin — and, because the seed runs out of process, the running
  // app went on serving the admin's version until it was restarted.
  for (const typeConfig of typeConfigs) {
    await db
      .insert(itemTypeConfigs)
      .values({
        itemType: typeConfig.itemType,
        config: typeConfig.config,
        modifiedBy: adminId,
      })
      .onConflictDoNothing({ target: itemTypeConfigs.itemType })
  }
  console.log('✓ Item Type Configs (with lifecycle assignments)')

  // ============================================================================
  // Summary
  // ============================================================================
  console.log('\n✅ Minimal seed complete!\n')
  console.log('Admin User:')
  console.log('  Email: admin@cascadia.local')
  console.log(
    existingAdmin
      ? '  Password: unchanged (existing user preserved)'
      : '  Password: Cascadia',
  )
  console.log('  Roles: Administrator')
  console.log('\nStandard Library (Global):')
  console.log(`  Name: ${standardLibrary.name}`)
  console.log(`  Code: ${standardLibrary.code}`)
  console.log('\nLifecycles (from default-lifecycles.ts):')
  for (const lifecycle of DEFAULT_ITEM_LIFECYCLES) {
    const kind =
      lifecycle.workflowType === 'flexible'
        ? `${lifecycle.lifecycleType}, flexible`
        : lifecycle.lifecycleType
    console.log(`  ${lifecycle.name} (${kind})`)
  }

  process.exit(0)
} catch (error) {
  console.error('Error seeding database:', error)
  process.exit(1)
}
