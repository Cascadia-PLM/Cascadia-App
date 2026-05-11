// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

import { useQuery } from '@tanstack/react-query'

export interface SetupProgressState {
  orgInfo: boolean
  users: boolean
  ai: boolean
  programs: boolean
  dismissedAt: string | null
}

export interface SetupStatus {
  completed: boolean
  isGlobalAdmin: boolean
  progress: SetupProgressState
}

const DEFAULT_PROGRESS: SetupProgressState = {
  orgInfo: false,
  users: false,
  ai: false,
  programs: false,
  dismissedAt: null,
}

const DEFAULT_STATUS: SetupStatus = {
  completed: false,
  isGlobalAdmin: false,
  progress: DEFAULT_PROGRESS,
}

export function useSetupStatus() {
  return useQuery({
    queryKey: ['setup', 'status'],
    queryFn: async (): Promise<SetupStatus> => {
      const response = await fetch('/api/v1/setup/status')
      if (!response.ok) {
        return DEFAULT_STATUS
      }
      const json = await response.json()
      const data = json.data as SetupStatus | undefined
      return data ?? DEFAULT_STATUS
    },
    staleTime: 30_000,
  })
}
