/**
 * Minimal Database Seed Script
 * Creates only the bare essentials needed to start using Cascadia:
 * - Admin User (with Global Admin role)
 * - Default Program
 * - Standard Parts Library
 * - Core Roles
 * - Default Lifecycles for Part, Document, ChangeOrder
 */
import { eq } from 'drizzle-orm'
import dagre from 'dagre'
import { db } from '../src/lib/db/index.ts'
import { roles, userRoles, users } from '../src/lib/db/schema/users.ts'
import { programMembers, programs } from '../src/lib/db/schema/programs.ts'
import { designs } from '../src/lib/db/schema/designs.ts'
import { branches, commits } from '../src/lib/db/schema/versioning.ts'
import { itemTypeConfigs } from '../src/lib/db/schema/config.ts'
import { workflowDefinitions } from '../src/lib/db/schema/workflows.ts'
import { hashPassword } from '../src/lib/auth/password.ts'
import {
  ROLE_DEFINITIONS,
  roleToDbFormat,
} from '../src/lib/auth/permissions.ts'
import { LIFECYCLE_IDS } from '../src/lib/items/lifecycle-ids.ts'

// ============================================================================
// Auto-layout utility using dagre
// ============================================================================
interface LayoutState {
  id: string
  [key: string]: unknown
}

interface LayoutEdge {
  fromStateId: string
  toStateId: string
}

function layoutLifecycleStates<T extends LayoutState>(
  states: Array<T>,
  edges: Array<LayoutEdge>,
  direction: 'TB' | 'LR' = 'LR',
): Array<T & { position: { x: number; y: number } }> {
  const dagreGraph = new dagre.graphlib.Graph()
  dagreGraph.setDefaultEdgeLabel(() => ({}))

  const nodeWidth = 180
  const nodeHeight = 80

  dagreGraph.setGraph({
    rankdir: direction,
    ranksep: 100,
    nodesep: 50,
    marginx: 20,
    marginy: 20,
  })

  states.forEach((state) => {
    dagreGraph.setNode(state.id, { width: nodeWidth, height: nodeHeight })
  })

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.fromStateId, edge.toStateId)
  })

  dagre.layout(dagreGraph)

  return states.map((state) => {
    const nodeWithPosition = dagreGraph.node(state.id)
    return {
      ...state,
      position: {
        x: nodeWithPosition.x - nodeWidth / 2,
        y: nodeWithPosition.y - nodeHeight / 2,
      },
    }
  })
}

// Fixed IDs for consistent references (RFC 4122 compliant UUIDs)
// Format: version 4 (13th char = 4), variant 1 (17th char = 8-b)
const IDS = {
  admin: '00000000-0000-4000-8000-000000000000',
  program: '00000000-0000-4000-8000-000000000010',
  standardLibrary: '00000000-0000-4000-8000-000000000020',
  // Lifecycle definition IDs - imported from shared constants
  partLifecycle: LIFECYCLE_IDS.part,
  documentLifecycle: LIFECYCLE_IDS.document,
  changeOrderWorkflow: LIFECYCLE_IDS.changeOrder,
  flexibleChangeOrderWorkflow: LIFECYCLE_IDS.flexibleChangeOrder,
  issueLifecycle: LIFECYCLE_IDS.issue,
  toolLifecycle: LIFECYCLE_IDS.tool,
}

try {
  console.log('🌱 Seeding minimal database...\n')

  // ============================================================================
  // 1. Create Roles (including Global Admin)
  // ============================================================================
  const createdRoles: Record<string, string> = {}

  for (const [roleName, roleDef] of Object.entries(ROLE_DEFINITIONS)) {
    const dbPermissions = roleToDbFormat(roleDef)

    const [createdRole] = await db
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
      .returning()

    createdRoles[roleName] = createdRole.id
  }

  console.log(
    '✓ Roles (Global Admin, Administrator, Power User, Approver, User, View Only)',
  )

  // ============================================================================
  // 2. Create Admin User
  // ============================================================================
  const adminPassword = await hashPassword('Cascadia')

  const existingUser = await db
    .select()
    .from(users)
    .where(eq(users.email, 'admin@cascadia.local'))
    .limit(1)

  let adminId: string
  if (existingUser.length > 0) {
    await db
      .update(users)
      .set({
        name: 'System Admin',
        passwordHash: adminPassword,
        active: true,
        provider: 'local',
      })
      .where(eq(users.email, 'admin@cascadia.local'))
    adminId = existingUser[0].id
  } else {
    const [created] = await db
      .insert(users)
      .values({
        id: IDS.admin,
        email: 'admin@cascadia.local',
        name: 'System Admin',
        passwordHash: adminPassword,
        active: true,
        provider: 'local',
      })
      .returning()
    adminId = created.id
  }
  console.log('✓ Admin User (admin@cascadia.local / Cascadia)')

  // Assign Global Admin role to admin user
  if (createdRoles['Global Admin']) {
    await db
      .insert(userRoles)
      .values({
        userId: adminId,
        roleId: createdRoles['Global Admin'],
      })
      .onConflictDoNothing()
  }

  // Also assign Administrator role for backward compatibility
  await db
    .insert(userRoles)
    .values({
      userId: adminId,
      roleId: createdRoles['Administrator'],
    })
    .onConflictDoNothing()

  // ============================================================================
  // 3. Create Default Program
  // ============================================================================
  const existingProgram = await db
    .select()
    .from(programs)
    .where(eq(programs.code, 'DEFAULT'))
    .limit(1)

  let program
  if (existingProgram.length > 0) {
    program = existingProgram[0]
  } else {
    const [created] = await db
      .insert(programs)
      .values({
        id: IDS.program,
        name: 'Default Program',
        code: 'DEFAULT',
        description: 'Default program for general use',
        status: 'Active',
        createdBy: adminId,
      })
      .returning()
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
      canManageProducts: true,
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

  let standardLibrary
  if (existingLibrary.length > 0) {
    standardLibrary = existingLibrary[0]
  } else {
    // Create the design (global library - no programId)
    const [created] = await db
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
      .returning()

    // Create initial commit
    const [initialCommit] = await db
      .insert(commits)
      .values({
        designId: created.id,
        branchId: created.id, // Temporary
        message: 'Initial commit',
        createdBy: adminId,
      })
      .returning()

    // Create main branch
    const [mainBranch] = await db
      .insert(branches)
      .values({
        designId: created.id,
        name: 'main',
        branchType: 'main',
        headCommitId: initialCommit.id,
        baseCommitId: initialCommit.id,
        createdBy: adminId,
      })
      .returning()

    // Update commit with correct branchId
    await db
      .update(commits)
      .set({ branchId: mainBranch.id })
      .where(eq(commits.id, initialCommit.id))

    // Update design with default branch
    const [updated] = await db
      .update(designs)
      .set({ defaultBranchId: mainBranch.id })
      .where(eq(designs.id, created.id))
      .returning()

    standardLibrary = updated
  }
  console.log('✓ Standard Parts Library (Global)')

  // ============================================================================
  // 5. Create Default Lifecycles
  // ============================================================================

  // Part/Document Lifecycle - Standard PLM lifecycle
  // Note: All state changes go through ECOs - this is a "Driven" lifecycle
  // For layout purposes, we define the logical flow even though these aren't manual transitions
  const itemLifecycleStates = layoutLifecycleStates(
    [
      {
        id: 'Draft',
        name: 'Draft',
        color: 'gray',
        description: 'Item is being created or edited',
        isInitial: true,
        isFinal: false,
      },
      {
        id: 'Released',
        name: 'Released',
        color: 'green',
        description: 'Item is released for use',
        isInitial: false,
        isFinal: false,
      },
      {
        id: 'Superseded',
        name: 'Superseded',
        color: 'slate',
        description: 'Replaced by a newer revision',
        isInitial: false,
        isFinal: true,
      },
      {
        id: 'Obsolete',
        name: 'Obsolete',
        color: 'red',
        description: 'Item is no longer used',
        isInitial: false,
        isFinal: true,
      },
    ],
    // Logical flow edges for layout (not actual transitions - Driven lifecycles have no manual transitions)
    [
      { fromStateId: 'Draft', toStateId: 'Released' },
      { fromStateId: 'Released', toStateId: 'Superseded' },
      { fromStateId: 'Released', toStateId: 'Obsolete' },
    ],
    'LR',
  )

  const itemLifecycleDefinition = {
    states: itemLifecycleStates,
    // No manual transitions - Driven lifecycles only define states
    transitions: [],
    // Legacy: change action mappings (deprecated, use TransitionDrivenItem actions on Driving lifecycle)
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
    definitionType: 'lifecycle',
    lifecycleType: 'Driven', // ECO-controlled lifecycle
    description:
      'Standard lifecycle for Parts and Documents. All state changes go through ECOs.',
    applicableItemTypes: ['Part', 'Document'],
  }

  // Create Part Lifecycle (Driven - controlled by ECOs)
  await db
    .insert(workflowDefinitions)
    .values({
      id: IDS.partLifecycle,
      name: 'Part - Default Lifecycle',
      version: 1,
      workflowType: 'strict',
      definition: { ...itemLifecycleDefinition, applicableItemTypes: ['Part'] },
      isActive: true,
      lifecycleType: 'Driven',
      drivers: [IDS.changeOrderWorkflow, IDS.flexibleChangeOrderWorkflow],
    })
    .onConflictDoUpdate({
      target: workflowDefinitions.id,
      set: {
        name: 'Part - Default Lifecycle',
        version: 1,
        definition: {
          ...itemLifecycleDefinition,
          applicableItemTypes: ['Part'],
        },
        isActive: true,
        lifecycleType: 'Driven',
        drivers: [IDS.changeOrderWorkflow, IDS.flexibleChangeOrderWorkflow],
      },
    })

  // Create Document Lifecycle (Driven - controlled by ECOs)
  await db
    .insert(workflowDefinitions)
    .values({
      id: IDS.documentLifecycle,
      name: 'Document - Default Lifecycle',
      version: 1,
      workflowType: 'strict',
      definition: {
        ...itemLifecycleDefinition,
        applicableItemTypes: ['Document'],
      },
      isActive: true,
      lifecycleType: 'Driven',
      drivers: [IDS.changeOrderWorkflow, IDS.flexibleChangeOrderWorkflow],
    })
    .onConflictDoUpdate({
      target: workflowDefinitions.id,
      set: {
        name: 'Document - Default Lifecycle',
        version: 1,
        definition: {
          ...itemLifecycleDefinition,
          applicableItemTypes: ['Document'],
        },
        isActive: true,
        lifecycleType: 'Driven',
        drivers: [IDS.changeOrderWorkflow, IDS.flexibleChangeOrderWorkflow],
      },
    })

  // Change Order Workflow - Simple approval workflow (Driving lifecycle)
  // Note: This is a "Driving" lifecycle that controls Driven lifecycles via TransitionDrivenItem actions
  const changeOrderTransitions = [
    { fromStateId: 'Draft', toStateId: 'InReview' },
    { fromStateId: 'InReview', toStateId: 'Approved' },
  ]

  const changeOrderStates = layoutLifecycleStates(
    [
      {
        id: 'Draft',
        name: 'Draft',
        color: 'gray',
        description: 'ECO is being prepared',
        isInitial: true,
        isFinal: false,
      },
      {
        id: 'InReview',
        name: 'In Review',
        color: 'yellow',
        description: 'ECO is under review',
        isInitial: false,
        isFinal: false,
      },
      {
        id: 'Approved',
        name: 'Approved',
        color: 'green',
        description: 'ECO has been approved and items are released',
        isInitial: false,
        isFinal: true,
      },
    ],
    changeOrderTransitions,
    'LR',
  )

  const changeOrderWorkflowDefinition = {
    states: changeOrderStates,
    transitions: [
      {
        id: 't1',
        name: 'Submit for Review',
        fromStateId: 'Draft',
        toStateId: 'InReview',
        description: 'Submit ECO for review',
      },
      {
        id: 't2',
        name: 'Approve',
        fromStateId: 'InReview',
        toStateId: 'Approved',
        description: 'Approve the ECO and release affected items',
        actions: [
          {
            id: 'release-parts',
            name: 'Release Affected Parts',
            type: 'transition_driven_item',
            executeOn: 'after',
            config: {
              drivenLifecycleId: LIFECYCLE_IDS.part,
              fromStateId: 'Draft',
              targetStateId: 'Released',
              validateGates: true,
            },
          },
          {
            id: 'release-documents',
            name: 'Release Affected Documents',
            type: 'transition_driven_item',
            executeOn: 'after',
            config: {
              drivenLifecycleId: LIFECYCLE_IDS.document,
              fromStateId: 'Draft',
              targetStateId: 'Released',
              validateGates: true,
            },
          },
        ],
      },
    ],
    definitionType: 'workflow',
    lifecycleType: 'Driving',
    description: 'Simple approval workflow for Engineering Change Orders',
    applicableItemTypes: ['ChangeOrder'],
  }

  await db
    .insert(workflowDefinitions)
    .values({
      id: IDS.changeOrderWorkflow,
      name: 'ECO - Default Workflow',
      version: 1,
      workflowType: 'strict',
      definition: changeOrderWorkflowDefinition,
      isActive: true,
      lifecycleType: 'Driving',
      drivers: [], // Driving lifecycles don't have drivers
    })
    .onConflictDoUpdate({
      target: workflowDefinitions.id,
      set: {
        name: 'ECO - Default Workflow',
        definition: changeOrderWorkflowDefinition,
        isActive: true,
        lifecycleType: 'Driving',
        drivers: [],
      },
    })

  // Flexible Change Order Workflow - Template that can be customized per instance
  // This provides a minimal starting point that users can modify on each change order
  const flexibleChangeOrderTransitions = [
    { fromStateId: 'start', toStateId: 'complete' },
  ]

  const flexibleChangeOrderStates = layoutLifecycleStates(
    [
      {
        id: 'start',
        name: 'Start',
        color: 'gray',
        description: 'Initial state - add review steps as needed',
        isInitial: true,
        isFinal: false,
      },
      {
        id: 'complete',
        name: 'Complete',
        color: 'green',
        description: 'Workflow completed',
        isInitial: false,
        isFinal: true,
      },
    ],
    flexibleChangeOrderTransitions,
    'LR',
  )

  const flexibleChangeOrderWorkflowDefinition = {
    states: flexibleChangeOrderStates,
    transitions: [
      {
        id: 'complete-transition',
        name: 'Complete',
        fromStateId: 'start',
        toStateId: 'complete',
        description: 'Mark as complete',
        // TransitionDrivenItem actions: move affected items to Released state
        actions: [
          {
            id: 'release-parts',
            name: 'Release Affected Parts',
            type: 'transition_driven_item',
            executeOn: 'after',
            config: {
              drivenLifecycleId: LIFECYCLE_IDS.part,
              fromStateId: 'Draft',
              targetStateId: 'Released',
              validateGates: true,
            },
          },
          {
            id: 'release-documents',
            name: 'Release Affected Documents',
            type: 'transition_driven_item',
            executeOn: 'after',
            config: {
              drivenLifecycleId: LIFECYCLE_IDS.document,
              fromStateId: 'Draft',
              targetStateId: 'Released',
              validateGates: true,
            },
          },
        ],
      },
    ],
    definitionType: 'workflow',
    lifecycleType: 'Driving', // Controls Driven lifecycles
    description:
      'Flexible workflow template for Change Orders. Each instance can customize its own review steps and transitions.',
    applicableItemTypes: ['ChangeOrder'],
  }

  await db
    .insert(workflowDefinitions)
    .values({
      id: IDS.flexibleChangeOrderWorkflow,
      name: 'Dynamic Change Order',
      version: 1,
      workflowType: 'flexible',
      definition: flexibleChangeOrderWorkflowDefinition,
      isActive: true,
      lifecycleType: 'Driving',
      drivers: [],
    })
    .onConflictDoUpdate({
      target: workflowDefinitions.id,
      set: {
        name: 'Dynamic Change Order',
        definition: flexibleChangeOrderWorkflowDefinition,
        workflowType: 'flexible',
        isActive: true,
        lifecycleType: 'Driving',
        drivers: [],
      },
    })

  console.log('✓ Default Lifecycles (Part, Document, ChangeOrder)')
  console.log('✓ Flexible Workflow (Dynamic Change Order)')

  // Issue Lifecycle - Free lifecycle (self-controlled, no ECO required)
  const issueTransitions = [
    { fromStateId: 'Open', toStateId: 'InProgress' },
    { fromStateId: 'InProgress', toStateId: 'Pending' },
    { fromStateId: 'InProgress', toStateId: 'Resolved' },
    { fromStateId: 'Pending', toStateId: 'InProgress' },
    { fromStateId: 'Pending', toStateId: 'Resolved' },
    { fromStateId: 'Resolved', toStateId: 'Verified' },
    { fromStateId: 'Resolved', toStateId: 'InProgress' },
    { fromStateId: 'Verified', toStateId: 'Closed' },
    { fromStateId: 'Open', toStateId: 'Cancelled' },
    { fromStateId: 'InProgress', toStateId: 'Cancelled' },
    { fromStateId: 'Pending', toStateId: 'Cancelled' },
  ]

  const issueStates = layoutLifecycleStates(
    [
      {
        id: 'Open',
        name: 'Open',
        color: 'blue',
        description: 'Issue has been reported and is awaiting triage',
        isInitial: true,
        isFinal: false,
      },
      {
        id: 'InProgress',
        name: 'In Progress',
        color: 'yellow',
        description: 'Issue is being actively investigated or worked on',
        isInitial: false,
        isFinal: false,
      },
      {
        id: 'Pending',
        name: 'Pending',
        color: 'orange',
        description: 'Issue is waiting for external input or action',
        isInitial: false,
        isFinal: false,
      },
      {
        id: 'Resolved',
        name: 'Resolved',
        color: 'green',
        description: 'Issue has been resolved but not yet verified',
        isInitial: false,
        isFinal: false,
      },
      {
        id: 'Verified',
        name: 'Verified',
        color: 'emerald',
        description: 'Resolution has been verified and confirmed',
        isInitial: false,
        isFinal: false,
      },
      {
        id: 'Closed',
        name: 'Closed',
        color: 'slate',
        description: 'Issue is closed and complete',
        isInitial: false,
        isFinal: true,
      },
      {
        id: 'Cancelled',
        name: 'Cancelled',
        color: 'red',
        description: 'Issue was cancelled (duplicate, invalid, etc.)',
        isInitial: false,
        isFinal: true,
      },
    ],
    issueTransitions,
    'LR',
  )

  const issueLifecycleDefinition = {
    states: issueStates,
    transitions: [
      {
        id: 'issue-t1',
        name: 'Start Work',
        fromStateId: 'Open',
        toStateId: 'InProgress',
        description: 'Begin investigating or working on the issue',
      },
      {
        id: 'issue-t2',
        name: 'Put on Hold',
        fromStateId: 'InProgress',
        toStateId: 'Pending',
        description: 'Waiting for external input or action',
      },
      {
        id: 'issue-t3',
        name: 'Resume',
        fromStateId: 'Pending',
        toStateId: 'InProgress',
        description: 'Resume work on the issue',
      },
      {
        id: 'issue-t4',
        name: 'Resolve',
        fromStateId: 'InProgress',
        toStateId: 'Resolved',
        description: 'Mark the issue as resolved',
      },
      {
        id: 'issue-t5',
        name: 'Resolve from Pending',
        fromStateId: 'Pending',
        toStateId: 'Resolved',
        description: 'Mark the issue as resolved',
      },
      {
        id: 'issue-t6',
        name: 'Verify',
        fromStateId: 'Resolved',
        toStateId: 'Verified',
        description: 'Verify the resolution',
      },
      {
        id: 'issue-t7',
        name: 'Reopen',
        fromStateId: 'Resolved',
        toStateId: 'InProgress',
        description: 'Reopen the issue for further work',
      },
      {
        id: 'issue-t8',
        name: 'Close',
        fromStateId: 'Verified',
        toStateId: 'Closed',
        description: 'Close the issue',
      },
      {
        id: 'issue-t9',
        name: 'Cancel from Open',
        fromStateId: 'Open',
        toStateId: 'Cancelled',
        description: 'Cancel the issue',
      },
      {
        id: 'issue-t10',
        name: 'Cancel from InProgress',
        fromStateId: 'InProgress',
        toStateId: 'Cancelled',
        description: 'Cancel the issue',
      },
      {
        id: 'issue-t11',
        name: 'Cancel from Pending',
        fromStateId: 'Pending',
        toStateId: 'Cancelled',
        description: 'Cancel the issue',
      },
    ],
    definitionType: 'lifecycle',
    lifecycleType: 'Free',
    description:
      'Issue tracking lifecycle. Users can manually transition states without ECO approval.',
    applicableItemTypes: ['Issue'],
  }

  await db
    .insert(workflowDefinitions)
    .values({
      id: IDS.issueLifecycle,
      name: 'Issue - Default Lifecycle',
      version: 1,
      workflowType: 'strict',
      definition: issueLifecycleDefinition,
      isActive: true,
      lifecycleType: 'Free',
      drivers: [],
    })
    .onConflictDoUpdate({
      target: workflowDefinitions.id,
      set: {
        name: 'Issue - Default Lifecycle',
        definition: issueLifecycleDefinition,
        isActive: true,
        lifecycleType: 'Free',
        drivers: [],
      },
    })

  console.log('✓ Issue Lifecycle (Free)')

  // Tool Lifecycle - Free lifecycle for manufacturing equipment tracking
  const toolTransitions = [
    { fromStateId: 'Draft', toStateId: 'Active' },
    { fromStateId: 'Active', toStateId: 'Maintenance' },
    { fromStateId: 'Maintenance', toStateId: 'Active' },
    { fromStateId: 'Active', toStateId: 'Retired' },
    { fromStateId: 'Maintenance', toStateId: 'Retired' },
  ]

  const toolStates = layoutLifecycleStates(
    [
      {
        id: 'Draft',
        name: 'Draft',
        color: 'gray',
        description: 'Tool is being configured and has not been validated',
        isInitial: true,
        isFinal: false,
      },
      {
        id: 'Active',
        name: 'Active',
        color: 'green',
        description: 'Tool is available for use in manufacturing',
        isInitial: false,
        isFinal: false,
      },
      {
        id: 'Maintenance',
        name: 'Maintenance',
        color: 'yellow',
        description: 'Tool is undergoing maintenance or calibration',
        isInitial: false,
        isFinal: false,
      },
      {
        id: 'Retired',
        name: 'Retired',
        color: 'red',
        description: 'Tool is no longer in service',
        isInitial: false,
        isFinal: true,
      },
    ],
    toolTransitions,
    'LR',
  )

  const toolLifecycleDefinition = {
    states: toolStates,
    transitions: [
      {
        id: 'tool-t1',
        name: 'Activate',
        fromStateId: 'Draft',
        toStateId: 'Active',
        description: 'Mark tool as available for use',
      },
      {
        id: 'tool-t2',
        name: 'Send to Maintenance',
        fromStateId: 'Active',
        toStateId: 'Maintenance',
        description: 'Take tool offline for maintenance or calibration',
      },
      {
        id: 'tool-t3',
        name: 'Return to Service',
        fromStateId: 'Maintenance',
        toStateId: 'Active',
        description: 'Return tool to active service after maintenance',
      },
      {
        id: 'tool-t4',
        name: 'Retire',
        fromStateId: 'Active',
        toStateId: 'Retired',
        description: 'Permanently retire tool from service',
      },
      {
        id: 'tool-t5',
        name: 'Retire from Maintenance',
        fromStateId: 'Maintenance',
        toStateId: 'Retired',
        description: 'Retire tool that is currently in maintenance',
      },
    ],
    definitionType: 'lifecycle',
    lifecycleType: 'Free',
    description:
      'Tool lifecycle for manufacturing equipment. Draft → Active → Maintenance ↔ Active → Retired.',
    applicableItemTypes: ['Tool'],
  }

  await db
    .insert(workflowDefinitions)
    .values({
      id: IDS.toolLifecycle,
      name: 'Tool - Default Lifecycle',
      version: 1,
      workflowType: 'strict',
      definition: toolLifecycleDefinition,
      isActive: true,
      lifecycleType: 'Free',
      drivers: [],
    })
    .onConflictDoUpdate({
      target: workflowDefinitions.id,
      set: {
        name: 'Tool - Default Lifecycle',
        definition: toolLifecycleDefinition,
        isActive: true,
        lifecycleType: 'Free',
        drivers: [],
      },
    })

  console.log('✓ Tool Lifecycle (Free)')

  // ============================================================================
  // 6. Create Item Type Configs with Lifecycle Assignments
  // ============================================================================
  const typeConfigs = [
    {
      itemType: 'Part',
      config: {
        lifecycleDefinitionId: IDS.partLifecycle,
        permissions: {
          create: ['Power User', 'Administrator', 'Global Admin'],
          read: ['*'],
          update: ['Power User', 'Administrator', 'Global Admin'],
          delete: ['Administrator', 'Global Admin'],
        },
      },
    },
    {
      itemType: 'Document',
      config: {
        lifecycleDefinitionId: IDS.documentLifecycle,
        permissions: {
          create: ['Power User', 'Administrator', 'Global Admin', 'View Only'],
          read: ['*'],
          update: ['Power User', 'Administrator', 'Global Admin'],
          delete: ['Administrator', 'Global Admin'],
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
          create: ['Power User', 'Administrator', 'Global Admin'],
          read: ['*'],
          update: ['Power User', 'Administrator', 'Global Admin'],
          delete: ['Administrator', 'Global Admin'],
        },
      },
    },
    {
      itemType: 'Issue',
      config: {
        lifecycleDefinitionId: IDS.issueLifecycle,
        permissions: {
          create: ['Power User', 'Administrator', 'Global Admin', 'User'],
          read: ['*'],
          update: ['Power User', 'Administrator', 'Global Admin', 'User'],
          delete: ['Administrator', 'Global Admin'],
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
          delete: ['Administrator', 'Global Admin'],
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
  console.log('  Password: Cascadia')
  console.log('  Roles: Global Admin, Administrator')
  console.log('\nProgram:')
  console.log(`  Name: ${program.name}`)
  console.log(`  Code: ${program.code}`)
  console.log('\nStandard Library (Global):')
  console.log(`  Name: ${standardLibrary.name}`)
  console.log(`  Code: ${standardLibrary.code}`)
  console.log('\nLifecycles:')
  console.log(
    '  Part - Default Lifecycle (Driven: Draft → Released → Superseded/Obsolete)',
  )
  console.log(
    '  Document - Default Lifecycle (Driven: Draft → Released → Superseded/Obsolete)',
  )
  console.log(
    '  ECO - Default Workflow (Driving: Draft → In Review → Approved)',
  )
  console.log(
    '  Dynamic Change Order (flexible - Start → Complete, customizable per instance)',
  )
  console.log(
    '  Issue - Default Lifecycle (Free: Open → InProgress → Resolved → Verified → Closed)',
  )
  console.log(
    '  Tool - Default Lifecycle (Free: Draft → Active ↔ Maintenance → Retired)',
  )

  process.exit(0)
} catch (error) {
  console.error('Error seeding database:', error)
  process.exit(1)
}
