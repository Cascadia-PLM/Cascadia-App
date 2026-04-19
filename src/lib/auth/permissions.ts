/**
 * Role and Permission Definitions for Cascadia PLM
 *
 * This file defines the role-based access control (RBAC) system
 * for the application.
 */

// Permission actions
export type PermissionAction =
  | 'create'
  | 'read'
  | 'update'
  | 'delete'
  | 'approve'
  | 'manage'

// Resource types
export type ResourceType =
  | 'parts'
  | 'documents'
  | 'change_orders'
  | 'designs'
  | 'requirements'
  | 'tasks'
  | 'tools'
  | 'work_instructions'
  | 'work_orders'
  | 'issues'
  | 'workflows'
  | 'users'
  | 'roles'
  | 'programs'
  | 'reports'
  | 'system'

// Role names
export type RoleName =
  | 'Global Admin'
  | 'Administrator'
  | 'Power User'
  | 'Approver'
  | 'User'
  | 'View Only'

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
 * Global Admin: System-wide administrator with full access to all programs and data
 * Administrator: Full system access within assigned programs
 * Power User: Can create and edit all item types, manage workflows
 * Approver: Can approve items and change states, limited editing
 * User: Can create and edit draft items, view released items
 * View Only: Read-only access to all items
 */
export const ROLE_DEFINITIONS: Record<RoleName, RoleDefinition> = {
  'Global Admin': {
    name: 'Global Admin',
    description:
      'System-wide administrator with full access to all programs and data',
    permissions: [
      {
        resource: 'parts',
        actions: ['create', 'read', 'update', 'delete', 'approve', 'manage'],
      },
      {
        resource: 'documents',
        actions: ['create', 'read', 'update', 'delete', 'approve', 'manage'],
      },
      {
        resource: 'change_orders',
        actions: ['create', 'read', 'update', 'delete', 'approve', 'manage'],
      },
      {
        resource: 'designs',
        actions: ['create', 'read', 'update', 'delete', 'manage'],
      },
      {
        resource: 'requirements',
        actions: ['create', 'read', 'update', 'delete', 'approve', 'manage'],
      },
      {
        resource: 'tasks',
        actions: ['create', 'read', 'update', 'delete', 'manage'],
      },
      {
        resource: 'work_instructions',
        actions: ['create', 'read', 'update', 'delete', 'manage'],
      },
      {
        resource: 'work_orders',
        actions: ['create', 'read', 'update', 'delete', 'manage'],
      },
      {
        resource: 'issues',
        actions: ['create', 'read', 'update', 'delete', 'approve', 'manage'],
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
      {
        resource: 'programs',
        actions: ['create', 'read', 'update', 'delete', 'manage'],
      },
      {
        resource: 'reports',
        actions: ['create', 'read', 'update', 'delete', 'manage'],
      },
      { resource: 'system', actions: ['read', 'manage'] },
    ],
  },
  Administrator: {
    name: 'Administrator',
    description: 'Full system access within assigned programs',
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
      {
        resource: 'work_instructions',
        actions: ['create', 'read', 'update', 'delete'],
      },
      {
        resource: 'work_orders',
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
      { resource: 'programs', actions: ['read', 'update'] },
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
      {
        resource: 'work_instructions',
        actions: ['create', 'read', 'update', 'delete'],
      },
      {
        resource: 'work_orders',
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
      { resource: 'work_instructions', actions: ['read', 'update', 'approve'] },
      { resource: 'work_orders', actions: ['read', 'update', 'approve'] },
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
      { resource: 'work_instructions', actions: ['create', 'read', 'update'] },
      { resource: 'work_orders', actions: ['create', 'read', 'update'] },
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
      { resource: 'work_instructions', actions: ['read'] },
      { resource: 'work_orders', actions: ['read'] },
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
  if (!(resource in rolePermissions)) return false

  const actions = rolePermissions[resource]
  return actions.includes(action) || actions.includes('manage')
}
