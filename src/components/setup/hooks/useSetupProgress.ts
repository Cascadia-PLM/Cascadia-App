// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { STEP_ORDER } from '../strings'
import type { WizardStep } from '../strings'
import type { SetupProgressState } from './useSetupStatus'

export function firstIncompleteStep(progress: SetupProgressState): WizardStep {
  if (!progress.orgInfo) return 'org'
  if (!progress.users) return 'users'
  if (!progress.ai) return 'ai'
  if (!progress.programs) return 'programs'
  return 'summary'
}

export function nextStep(current: WizardStep): WizardStep {
  const idx = STEP_ORDER.indexOf(current)
  if (idx < 0 || idx === STEP_ORDER.length - 1) return 'summary'
  return STEP_ORDER[idx + 1] as WizardStep
}

export function previousStep(current: WizardStep): WizardStep {
  const idx = STEP_ORDER.indexOf(current)
  if (idx <= 0) return 'org'
  return STEP_ORDER[idx - 1] as WizardStep
}

export function useSetProgress() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (progress: SetupProgressState) => {
      const response = await fetch('/api/v1/setup/progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(progress),
      })
      if (!response.ok) {
        throw new Error('Failed to save progress')
      }
      return progress
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['setup', 'status'] })
    },
  })
}

export function useCompleteSetup() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (mode: 'finish' | 'skip') => {
      const path =
        mode === 'finish' ? '/api/v1/setup/complete' : '/api/v1/setup/skip'
      const response = await fetch(path, { method: 'POST' })
      if (!response.ok) {
        throw new Error('Failed to mark setup completed')
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['setup', 'status'] })
      queryClient.invalidateQueries({ queryKey: ['auth', 'session'] })
    },
  })
}
