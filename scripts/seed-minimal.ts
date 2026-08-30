// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Minimal Database Seed Script
 * Creates only the bare essentials needed to start using Cascadia:
 * - Admin User (with the Administrator role)
 * - Default Program
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
import {
  programMembers,
  programs,
} from '../packages/core/src/lib/db/schema/programs.ts'
import { designs } from '../packages/core/src/lib/db/schema/designs.ts'
import {
  branches,
  commits,
} from '../packages/core/src/lib/db/schema/versioning.ts'
import { itemTypeConfigs } from '../packages/core/src/lib/db/schema/config.ts'
import { workflowDefinitions } from '../packages/core/src/lib/db/schema/workflows.ts'
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
  program: '00000000-0000-4000-8000-000000000010',
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
  // 3. Create Default Program
  // ============================================================================
  const existingProgram = await db
    .select()
    .from(programs)
    .where(eq(programs.code, 'DEFAULT'))
    .limit(1)

  const existingDefaultProgram = existingProgram[0]
  let program
  if (existingDefaultProgram) {
    program = existingDefaultProgram
  } else {
    const created = takeFirst(
      await db
        .insert(programs)
        .values({
          id: IDS.program,
          name: 'Default Program',
          code: 'DEFAULT',
          description: 'Default program for general use',
          status: 'Active',
          createdBy: adminId,
        })
        .returning(),
    )
    program = created
  }

  // Add admin as program admin
  await db
    .insert(programMembers)
    .values({
      programId: program.id,
      userId: adminId,
      role: 'admin',
      canCreateEco: true,
      canApproveEco: true,
      canManageDesigns: true,
    })
    .onConflictDoNothing()

  console.log('✓ Default Program')

  // ============================================================================
  // 4. Create Standard Parts Library (Global)
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
  // 5. Default Lifecycles
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
      .select({ drivers: workflowDefinitions.drivers })
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.id, lifecycleId))
      .then(takeFirst)
    if ((row.drivers ?? []).length === 0) {
      await db
        .update(workflowDefinitions)
        .set({ drivers: shippedDrivers })
        .where(eq(workflowDefinitions.id, lifecycleId))
    }
  }

  console.log(
    '✓ Default lifecycles for every item type (ECO + Dynamic Change Order workflows included)',
  )

  // ============================================================================
  // 6. Create Item Type Configs with Lifecycle Assignments
  // ============================================================================
  const typeConfigs = [
    {
      itemType: 'Part',
      config: {
        lifecycleDefinitionId: IDS.partLifecycle,
        permissions: {
          create: ['Power User', 'Administrator'],
          read: ['*'],
          update: ['Power User', 'Administrator'],
          delete: ['Administrator'],
        },
      },
    },
    {
      itemType: 'Document',
      config: {
        lifecycleDefinitionId: IDS.documentLifecycle,
        permissions: {
          create: ['Power User', 'Administrator', 'View Only'],
          read: ['*'],
          update: ['Power User', 'Administrator'],
          delete: ['Administrator'],
        },
      },
    },
    {
      itemType: 'Requirement',
      config: {
        lifecycleDefinitionId: IDS.requirementLifecycle,
        permissions: {
          create: ['Power User', 'Administrator'],
          read: ['*'],
          update: ['Power User', 'Administrator'],
          delete: ['Administrator'],
        },
      },
    },
    {
      itemType: 'ChangeOrder',
      config: {
        lifecycleDefinitionId: IDS.changeOrderWorkflow,
        // Map all change order types to the default workflow
        // XCO (Flexible Change Order) uses the flexible workflow that can be customized per instance
        workflowsByChangeType: {
          ECO: IDS.changeOrderWorkflow,
          ECN: IDS.changeOrderWorkflow,
          Deviation: IDS.changeOrderWorkflow,
          MCO: IDS.changeOrderWorkflow,
          XCO: IDS.flexibleChangeOrderWorkflow,
        },
        permissions: {
          create: ['Power User', 'Administrator'],
          read: ['*'],
          update: ['Power User', 'Administrator'],
          delete: ['Administrator'],
        },
      },
    },
    {
      itemType: 'Issue',
      config: {
        lifecycleDefinitionId: IDS.issueLifecycle,
        permissions: {
          create: ['Power User', 'Administrator', 'User'],
          read: ['*'],
          update: ['Power User', 'Administrator', 'User'],
          delete: ['Administrator'],
        },
      },
    },
    {
      itemType: 'Tool',
      config: {
        lifecycleDefinitionId: IDS.toolLifecycle,
        permissions: {
          create: ['*'],
          read: ['*'],
          update: ['*'],
          delete: ['Administrator'],
        },
      },
    },
    {
      itemType: 'Task',
      config: {
        lifecycleDefinitionId: LIFECYCLE_IDS.task,
        permissions: {
          create: ['*'],
          read: ['*'],
          update: ['*'],
          delete: ['Administrator'],
        },
      },
    },
    {
      itemType: 'TestPlan',
      config: {
        lifecycleDefinitionId: LIFECYCLE_IDS.testPlan,
        permissions: {
          create: ['Power User', 'Administrator'],
          read: ['*'],
          update: ['Power User', 'Administrator'],
          delete: ['Administrator'],
        },
      },
    },
    {
      itemType: 'TestCase',
      config: {
        lifecycleDefinitionId: LIFECYCLE_IDS.testCase,
        permissions: {
          create: ['Power User', 'Administrator'],
          read: ['*'],
          update: ['Power User', 'Administrator'],
          delete: ['Administrator'],
        },
      },
    },
    {
      itemType: 'WorkInstruction',
      config: {
        lifecycleDefinitionId: LIFECYCLE_IDS.workInstruction,
        permissions: {
          create: ['Power User', 'Administrator'],
          read: ['*'],
          update: ['Power User', 'Administrator'],
          delete: ['Administrator'],
        },
      },
    },
    {
      // Software shares the Part lifecycle: driven, ECO-controlled release
      itemType: 'Software',
      config: {
        lifecycleDefinitionId: LIFECYCLE_IDS.part,
        permissions: {
          create: ['Power User', 'Administrator'],
          read: ['*'],
          update: ['Power User', 'Administrator'],
          delete: ['Administrator'],
        },
      },
    },
    {
      itemType: 'PhysicalPart',
      config: {
        lifecycleDefinitionId: IDS.physicalPartLifecycle,
        permissions: {
          create: ['*'],
          read: ['*'],
          update: ['*'],
          delete: ['Administrator'],
        },
      },
    },
    {
      itemType: 'WorkOrder',
      config: {
        lifecycleDefinitionId: IDS.workOrderLifecycle,
        permissions: {
          create: ['*'],
          read: ['*'],
          update: ['*'],
          delete: ['Administrator'],
        },
      },
    },
  ]

  for (const typeConfig of typeConfigs) {
    await db
      .insert(itemTypeConfigs)
      .values({
        itemType: typeConfig.itemType,
        config: typeConfig.config,
        modifiedBy: adminId,
      })
      .onConflictDoUpdate({
        target: itemTypeConfigs.itemType,
        set: {
          config: typeConfig.config,
          modifiedBy: adminId,
          modifiedAt: new Date(),
        },
      })
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
  console.log('\nProgram:')
  console.log(`  Name: ${program.name}`)
  console.log(`  Code: ${program.code}`)
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
