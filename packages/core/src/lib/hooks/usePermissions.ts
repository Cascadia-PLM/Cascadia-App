// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useQuery } from '@tanstack/react-query'
import type { PermissionAction, ResourceType } from '@/lib/auth/permissions'
import {
  canAccessSystem,
  canManageSystem,
  hasPermission,
} from '@/lib/auth/permissions'
import { currentUserPermissionsQuery } from '@/lib/query'

/**
 * The signed-in user's permissions, read through the shared query cache so one
 * fetch serves every caller.
 *
 * `loading` distinguishes "not allowed" from "not yet known" — a nav bar wants
 * to render nothing rather than flash a section it is about to hide.
 */
export function usePermissions(): {
  permissions: Record<string, Array<string>>
  roles: Array<string>
  loading: boolean
} {
  const { data, isPending } = useQuery(currentUserPermissionsQuery())
  return {
    permissions: data?.permissions ?? {},
    roles: data?.roles ?? [],
    loading: isPending,
  }
}

/**
 * Whether the signed-in user holds `action` on `resource`.
 *
 * Presentation only. The server authorises every call independently, so this
 * decides what to *offer*, never what to allow.
 */
export function usePermission(
  resource: ResourceType,
  action: PermissionAction,
): { allowed: boolean; loading: boolean } {
  const { permissions, loading } = usePermissions()
  return { allowed: hasPermission(permissions, resource, action), loading }
}

/**
 * Whether the System section of the navigation — Lifecycles, Users,
 * Administration — is open to this user at all, and whether they may also
 * change instance configuration (everything under `/admin`).
 *
 * Two answers rather than one because they differ for a Power User: they run
 * lifecycles, but the admin console is Administrator-only and every route
 * under it enforces `system:manage` server-side.
 */
export function useSystemAccess(): {
  canAccess: boolean
  canManage: boolean
  loading: boolean
} {
  const { permissions, loading } = usePermissions()
  return {
    canAccess: canAccessSystem(permissions),
    canManage: canManageSystem(permissions),
    loading,
  }
}
