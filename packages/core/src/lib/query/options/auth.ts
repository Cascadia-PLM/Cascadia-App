// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import { qk } from '../keys'
import { apiFetch } from '@/lib/api/client'

export interface SessionSetupStatus {
  completed: boolean
  isGlobalAdmin: boolean
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
