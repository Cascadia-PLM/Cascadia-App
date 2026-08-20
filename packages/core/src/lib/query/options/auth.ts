// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import { qk } from '../keys'
import { apiFetch } from '@/lib/api/client'

export interface SessionSetupStatus {
  completed: boolean
  /** Whether the user carries cross-program (top-level admin) authority. */
  isAdmin: boolean
}

export interface SessionState {
  authenticated: boolean
  setupStatus?: SessionSetupStatus
  /**
   * Who is signed in. The endpoint has always returned this; typing it here
   * saves every "is this mine?" check from firing its own `/auth/session`.
   */
  user?: { id: string; email: string; name: string | null }
}

const UNAUTHENTICATED: SessionState = { authenticated: false }

/**
 * The current session, as the root route's `beforeLoad` sees it.
 *
 * Routing this through the cache gives the setup wizard's
 * `invalidateQueries(['auth', 'session'])` something real to invalidate — it
 * previously matched no query at all — and collapses the burst of identical
 * `/auth/session` requests that a multi-segment navigation used to fire.
 *
 * The short staleTime is deliberate: the server authorises every API call
 * independently, so this cache only front-runs the client-side redirect, and
 * a few seconds of slack there costs nothing.
 */
export function authSessionQuery() {
  return queryOptions({
    queryKey: qk.collection('auth', 'session'),
    queryFn: async (): Promise<SessionState> => {
      try {
        const result = await apiFetch<{ data?: SessionState }>(
          '/api/v1/auth/session',
          { retry: false },
        )
        return result.data ?? UNAUTHENTICATED
      } catch {
        // A failed session probe means "not signed in" for redirect
        // purposes; the root route turns this into a /login redirect.
        return UNAUTHENTICATED
      }
    },
    staleTime: 10_000,
  })
}

/** The signed-in user's roles and their union of permissions. */
export interface CurrentUserPermissions {
  roles: Array<string>
  permissions: Record<string, Array<string>>
}

const NO_PERMISSIONS: CurrentUserPermissions = { roles: [], permissions: {} }

/**
 * What the signed-in user is allowed to do, as the union of their roles'
 * grants.
 *
 * This drives *presentation and routing only* — which sections the sidebar
 * offers, and which pages the System route guards admit. Every API route
 * authorises independently, so a tampered client gains nothing by lying here.
 *
 * A failed probe resolves to no permissions rather than rejecting: the callers
 * are a nav bar and a set of route guards, and both want "deny" from a
 * transient failure, not an exception to render.
 */
export function currentUserPermissionsQuery() {
  return queryOptions({
    queryKey: qk.collection('auth', 'permissions'),
    queryFn: async (): Promise<CurrentUserPermissions> => {
      try {
        const result = await apiFetch<{ data?: CurrentUserPermissions }>(
          '/api/v1/auth/permissions',
          { retry: false },
        )
        return result.data ?? NO_PERMISSIONS
      } catch {
        return NO_PERMISSIONS
      }
    },
    staleTime: 10_000,
  })
}
