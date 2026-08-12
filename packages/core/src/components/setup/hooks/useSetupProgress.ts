// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { STEP_ORDER } from '../strings'
import type { WizardStep } from '../strings'
import type { SetupProgressState } from '@/lib/query/options/setup'
import { useResourceMutation } from '@/lib/query'
import { apiFetch } from '@/lib/api/client'

export function firstIncompleteStep(progress: SetupProgressState): WizardStep {
  if (!progress.orgInfo) return 'org'
  if (!progress.users) return 'users'
  if (!progress.ai) return 'ai'
  if (!progress.programs) return 'programs'
  if (!progress.tools) return 'tools'
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
  return useResourceMutation({
    mutationFn: async (progress: SetupProgressState) => {
      await apiFetch('/api/v1/setup/progress', {
        method: 'POST',
        body: JSON.stringify(progress),
      })
      return progress
    },
    invalidates: ['setup'],
  })
}

export function useCompleteSetup() {
  return useResourceMutation({
    mutationFn: async (mode: 'finish' | 'skip') => {
      const path =
        mode === 'finish' ? '/api/v1/setup/complete' : '/api/v1/setup/skip'
      await apiFetch(path, { method: 'POST' })
    },
    // `setup` fans out to `auth` — finishing the wizard changes whether the
    // root route still redirects here.
    invalidates: ['setup'],
  })
}
