// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import { qk } from '../keys'
import { apiFetch } from '@/lib/api/client'

export interface SetupProgressState {
  orgInfo: boolean
  users: boolean
  ai: boolean
  programs: boolean
  tools: boolean
  dismissedAt: string | null
}

export interface SetupStatus {
  completed: boolean
  isGlobalAdmin: boolean
  progress: SetupProgressState
}

export const DEFAULT_SETUP_PROGRESS: SetupProgressState = {
  orgInfo: false,
  users: false,
  ai: false,
  programs: false,
  tools: false,
  dismissedAt: null,
}

const DEFAULT_STATUS: SetupStatus = {
  completed: false,
  isGlobalAdmin: false,
  progress: DEFAULT_SETUP_PROGRESS,
}

/** First-run wizard state: which steps are done, and whether to show it. */
export function setupStatusQuery() {
  return queryOptions({
    queryKey: qk.collection('setup', 'status'),
    queryFn: async (): Promise<SetupStatus> => {
      try {
        const result = await apiFetch<{ data?: SetupStatus }>(
          '/api/v1/setup/status',
          { retry: false },
        )
        const data = result.data
        if (!data) return DEFAULT_STATUS
        // Progress predating a newly added step won't carry its flag —
        // fill the gaps so every step key is a real boolean.
        return {
          ...data,
          progress: { ...DEFAULT_SETUP_PROGRESS, ...data.progress },
        }
      } catch {
        return DEFAULT_STATUS
      }
    },
    staleTime: 30_000,
  })
}
