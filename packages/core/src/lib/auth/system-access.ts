// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Route guards for the System section — Lifecycles, Users, Administration.
 *
 * Hiding the section in the sidebar is not a gate: the URLs are still typeable,
 * and a bookmark outlives a role change. These run in `beforeLoad`, so a user
 * without the grant is redirected to the dashboard before the page's loader
 * fires a single request.
 *
 * They are still only the *client* half. Every API route behind these pages
 * authorises independently — that is what actually protects the data — and
 * these exist so a denied user meets a dashboard instead of a screen of
 * failed panels.
 *
 * Client-safe: this module reaches nothing server-only. `permissions.ts` is
 * pure definitions, and the permission map arrives over the API like any other
 * cached read.
 */

import { redirect } from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'
import { canAccessSystem, canManageSystem } from '@/lib/auth/permissions'
import { currentUserPermissionsQuery } from '@/lib/query'

/**
 * `fetchQuery`, not `ensureQueryData`: this read decides a redirect, so it has
 * to honour invalidation. `ensureQueryData` returns whatever is cached whenever
 * an entry exists, which would let a revoked role keep its System access until
 * the tab is reloaded — the same trap `__root.tsx` documents for the session.
 *
 * The query already swallows its own failures and resolves to no permissions,
 * so a transient outage denies rather than throwing into the router.
 */
async function loadPermissions(
  queryClient: QueryClient,
): Promise<Record<string, Array<string>>> {
  const { permissions } = await queryClient.fetchQuery(
    currentUserPermissionsQuery(),
  )
  return permissions
}

/** Admit only users the System section is open to. Administrator, Power User. */
export async function requireSystemAccess(
  queryClient: QueryClient,
): Promise<void> {
  if (!canAccessSystem(await loadPermissions(queryClient))) {
    throw redirect({ to: '/' })
  }
}

/**
 * Admit only users who may change instance configuration — everything under
 * `/admin`. Administrator alone; a Power User reaches the rest of the System
 * section but not this.
 */
export async function requireSystemManage(
  queryClient: QueryClient,
): Promise<void> {
  if (!canManageSystem(await loadPermissions(queryClient))) {
    throw redirect({ to: '/' })
  }
}
