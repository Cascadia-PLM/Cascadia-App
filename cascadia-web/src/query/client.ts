// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { QueryClient } from '@tanstack/react-query'

/**
 * The app's single QueryClient.
 *
 * It lives here rather than in `__root.tsx` because route loaders reach it
 * through router context (`src/router.tsx`) and must share the exact cache
 * the components read from — that shared instance is what collapses the old
 * loader-cache/query-cache split into one.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Long enough that navigating between pages doesn't refetch on every
        // hop, short enough that another user's change surfaces on its own.
        // Correctness after *our own* mutations comes from invalidation, not
        // from this window.
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        // A PLM is multi-user: coming back to the tab should show current
        // data. Cheap, because a fresh query within staleTime is a no-op.
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        // `apiFetch` already retries retryable failures with exponential
        // backoff. Retrying here too would multiply the attempts and stack
        // the delays on top of each other.
        retry: false,
      },
      mutations: {
        retry: false,
      },
    },
  })
}

export const queryClient = createQueryClient()
