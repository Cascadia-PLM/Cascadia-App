// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Role and Permission Definitions for Cascadia PLM
 *
 * This file defines the role-based access control (RBAC) system
 * for the application.
 */

// Permission actions
export type PermissionAction =
  'create' | 'read' | 'update' | 'delete' | 'approve' | 'manage'

// Resource types
export type ResourceType =
  | 'parts'
  | 'documents'
  | 'change_orders'
  | 'designs'
  | 'requirements'
  | 'tasks'
  | 'tools'
  | 'software'
  // Mapped to from itemType in server/routes/items.ts.
  | 'test_plans'
  | 'test_cases'
  | 'work_instructions'
  | 'work_orders'
  | 'physical_parts'
  | 'issues'
  | 'workflows'
  | 'users'
  | 'roles'
  | 'programs'
  | 'reports'
  | 'system'

/**
 * Runtime lists of the two permission axes, for UIs that have to render every
 * option (the API key scope editor).
 *
 * `Record<ResourceType, true>` makes the map exhaustive: adding a member to
 * the union above without adding it here is a compile error, so the runtime
 * list cannot silently drift from the type.
 */
const RESOURCE_TYPE_MAP: Record<ResourceType, true> = {
  parts: true,
  documents: true,
  change_orders: true,
  designs: true,
  requirements: true,
  tasks: true,
  tools: true,
  software: true,
  test_plans: true,
  test_cases: true,
  work_instructions: true,
  work_orders: true,
  physical_parts: true,
  issues: true,
  workflows: true,
  users: true,
  roles: true,
  programs: true,
  reports: true,
  system: true,
}

export const RESOURCE_TYPES = Object.keys(
  RESOURCE_TYPE_MAP,
) as Array<ResourceType>

const PERMISSION_ACTION_MAP: Record<PermissionAction, true> = {
  create: true,
  read: true,
  update: true,
  delete: true,
  approve: true,
  manage: true,
}

export const PERMISSION_ACTIONS = Object.keys(
  PERMISSION_ACTION_MAP,
) as Array<PermissionAction>

// Role names
//
// There is deliberately no 'Global Admin': it was a leftover from an early
// multi-tenant design. In this single-tenant architecture, Administrator IS
// the top-level role — its programs:manage grant is what carries
// cross-program authority (see AccessControlService.hasCrossProgramAccess).
export type RoleName =
  'Administrator' | 'Power User' | 'Approver' | 'User' | 'View Only'

// Permission structure
export interface Permission {
  resource: ResourceType
  actions: Array<PermissionAction>
}

// Role definition
export interface RoleDefinition {
  name: RoleName
  description: string
  permissions: Array<Permission>
}

/**
 * Role Definitions
 *
 * Administrator: Top-level administrator — all programs, all settings
 * Power User: Can create and edit all item types, manage workflows
 * Approver: Can approve items and change states, limited editing
 * User: Can create and edit draft items, view released items
 * View Only: Read-only access to all items
 */
export const ROLE_DEFINITIONS: Record<RoleName, RoleDefinition> = {
  Administrator: {
    name: 'Administrator',
    description:
      'Top-level administrator with full access to all programs, users, and system settings',
    permissions: [
      {
        resource: 'parts',
        actions: ['create', 'read', 'update', 'delete', 'approve'],
      },
      {
        resource: 'documents',
        actions: ['create', 'read', 'update', 'delete', 'approve'],
      },
      {
        resource: 'change_orders',
        actions: ['create', 'read', 'update', 'delete', 'approve'],
      },
      { resource: 'designs', actions: ['create', 'read', 'update', 'delete'] },
      {
        resource: 'requirements',
        actions: ['create', 'read', 'update', 'delete', 'approve'],
      },
      { resource: 'tasks', actions: ['create', 'read', 'update', 'delete'] },
      { resource: 'tools', actions: ['create', 'read', 'update', 'delete'] },
      {
        resource: 'software',
        actions: ['create', 'read', 'update', 'delete', 'approve'],
      },
      {
        resource: 'test_plans',
        actions: ['create', 'read', 'update', 'delete', 'approve'],
      },
      {
        resource: 'test_cases',
        actions: ['create', 'read', 'update', 'delete', 'approve'],
      },
      {
        resource: 'work_instructions',
        actions: ['create', 'read', 'update', 'delete'],
      },
      {
        resource: 'work_orders',
        actions: ['create', 'read', 'update', 'delete'],
      },
      {
        resource: 'physical_parts',
        actions: ['create', 'read', 'update', 'delete'],
      },
      {
        resource: 'issues',
        actions: ['create', 'read', 'update', 'delete', 'approve'],
      },
      {
        resource: 'workflows',
        actions: ['create', 'read', 'update', 'delete', 'manage'],
      },
      {
        resource: 'users',
        actions: ['create', 'read', 'update', 'delete', 'manage'],
      },
      {
        resource: 'roles',
        actions: ['create', 'read', 'update', 'delete', 'manage'],
      },
      // programs:manage is the cross-program-authority grant: it is what
      // AccessControlService.hasCrossProgramAccess() keys the membership
      // bypass on, so it belongs only on a role that should see and manage
      // every program.
      {
        resource: 'programs',
        actions: ['create', 'read', 'update', 'delete', 'manage'],
      },
      { resource: 'reports', actions: ['create', 'read', 'update', 'delete'] },
      { resource: 'system', actions: ['read', 'manage'] },
    ],
  },
  'Power User': {
    name: 'Power User',
    description: 'Can create and edit all item types, manage workflows',
    permissions: [
      { resource: 'parts', actions: ['create', 'read', 'update', 'delete'] },
      {
        resource: 'documents',
        actions: ['create', 'read', 'update', 'delete'],
      },
      {
        resource: 'change_orders',
        actions: ['create', 'read', 'update', 'delete'],
      },
      { resource: 'designs', actions: ['create', 'read', 'update', 'delete'] },
      {
        resource: 'requirements',
        actions: ['create', 'read', 'update', 'delete'],
      },
      { resource: 'tasks', actions: ['create', 'read', 'update', 'delete'] },
      { resource: 'tools', actions: ['create', 'read', 'update', 'delete'] },
      { resource: 'software', actions: ['create', 'read', 'update', 'delete'] },
      {
        resource: 'test_plans',
        actions: ['create', 'read', 'update', 'delete'],
      },
      {
        resource: 'test_cases',
        actions: ['create', 'read', 'update', 'delete'],
      },
      {
        resource: 'work_instructions',
        actions: ['create', 'read', 'update', 'delete'],
      },
      {
        resource: 'work_orders',
        actions: ['create', 'read', 'update', 'delete'],
      },
      {
        resource: 'physical_parts',
        actions: ['create', 'read', 'update', 'delete'],
      },
      { resource: 'issues', actions: ['create', 'read', 'update', 'delete'] },
      { resource: 'workflows', actions: ['read', 'manage'] },
      { resource: 'users', actions: ['read'] },
      { resource: 'roles', actions: ['read'] },
      { resource: 'programs', actions: ['read'] },
      { resource: 'reports', actions: ['create', 'read', 'update', 'delete'] },
      { resource: 'system', actions: ['read'] },
    ],
  },
  Approver: {
    name: 'Approver',
    description:
      'Can approve items and change states, limited editing capabilities',
    permissions: [
      { resource: 'parts', actions: ['read', 'update', 'approve'] },
      { resource: 'documents', actions: ['read', 'update', 'approve'] },
      { resource: 'change_orders', actions: ['read', 'update', 'approve'] },
      { resource: 'designs', actions: ['read', 'update'] },
      { resource: 'requirements', actions: ['read', 'update', 'approve'] },
      { resource: 'tasks', actions: ['read', 'update'] },
      { resource: 'tools', actions: ['read', 'update'] },
      { resource: 'software', actions: ['read', 'update', 'approve'] },
      { resource: 'test_plans', actions: ['read', 'update', 'approve'] },
      { resource: 'test_cases', actions: ['read', 'update', 'approve'] },
      { resource: 'work_instructions', actions: ['read', 'update', 'approve'] },
      { resource: 'work_orders', actions: ['read', 'update', 'approve'] },
      { resource: 'physical_parts', actions: ['read', 'update', 'approve'] },
      { resource: 'issues', actions: ['read', 'update', 'approve'] },
      { resource: 'workflows', actions: ['read'] },
      { resource: 'users', actions: ['read'] },
      { resource: 'roles', actions: ['read'] },
      { resource: 'programs', actions: ['read'] },
      { resource: 'reports', actions: ['read'] },
      { resource: 'system', actions: ['read'] },
    ],
  },
  User: {
    name: 'User',
    description: 'Can create and edit draft items, view released items',
    permissions: [
      { resource: 'parts', actions: ['create', 'read', 'update'] },
      { resource: 'documents', actions: ['create', 'read', 'update'] },
      { resource: 'change_orders', actions: ['create', 'read'] },
      { resource: 'designs', actions: ['create', 'read', 'update'] },
      { resource: 'requirements', actions: ['create', 'read', 'update'] },
      { resource: 'tasks', actions: ['create', 'read', 'update'] },
      { resource: 'tools', actions: ['create', 'read', 'update'] },
      { resource: 'software', actions: ['create', 'read', 'update'] },
      { resource: 'test_plans', actions: ['create', 'read', 'update'] },
      { resource: 'test_cases', actions: ['create', 'read', 'update'] },
      { resource: 'work_instructions', actions: ['create', 'read', 'update'] },
      { resource: 'work_orders', actions: ['create', 'read', 'update'] },
      { resource: 'physical_parts', actions: ['create', 'read', 'update'] },
      { resource: 'issues', actions: ['create', 'read', 'update'] },
      { resource: 'workflows', actions: ['read'] },
      { resource: 'users', actions: ['read'] },
      { resource: 'roles', actions: ['read'] },
      { resource: 'programs', actions: ['read'] },
      { resource: 'reports', actions: ['read'] },
      { resource: 'system', actions: ['read'] },
    ],
  },
  'View Only': {
    name: 'View Only',
    description: 'Read-only access to all items',
    permissions: [
      { resource: 'parts', actions: ['read'] },
      { resource: 'documents', actions: ['read'] },
      { resource: 'change_orders', actions: ['read'] },
      { resource: 'designs', actions: ['read'] },
      { resource: 'requirements', actions: ['read'] },
      { resource: 'tasks', actions: ['read'] },
      { resource: 'tools', actions: ['read'] },
      { resource: 'software', actions: ['read'] },
      { resource: 'test_plans', actions: ['read'] },
      { resource: 'test_cases', actions: ['read'] },
      { resource: 'work_instructions', actions: ['read'] },
      { resource: 'work_orders', actions: ['read'] },
      { resource: 'physical_parts', actions: ['read'] },
      { resource: 'issues', actions: ['read'] },
      { resource: 'workflows', actions: ['read'] },
      { resource: 'users', actions: ['read'] },
      { resource: 'roles', actions: ['read'] },
      { resource: 'programs', actions: ['read'] },
      { resource: 'reports', actions: ['read'] },
      { resource: 'system', actions: ['read'] },
    ],
  },
}

/**
 * Convert role definitions to the database format
 * Database format: { resource: [actions] }
 */
export function roleToDbFormat(
  role: RoleDefinition,
): Record<string, Array<string>> {
  const result: Record<string, Array<string>> = {}

  for (const permission of role.permissions) {
    result[permission.resource] = permission.actions
  }

  return result
}

/**
 * Check if a role has a specific permission
 */
export function hasPermission(
  rolePermissions: Record<string, Array<string>>,
  resource: ResourceType,
  action: PermissionAction,
): boolean {
  const actions = rolePermissions[resource]
  if (!actions) return false

  return actions.includes(action) || actions.includes('manage')
}
