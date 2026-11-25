// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Save and test AI settings from the setup wizard or the admin page.
 */

import { useMutation } from '@tanstack/react-query'
import type { AiProviderType } from '@cascadia/commons/ai/model-catalog'
import { apiFetch } from '@/api/client'
import { useInvalidateResources } from '@/query'

export type { AiProviderType }

export interface AiSettingsForm {
  enabled: boolean
  provider: AiProviderType
  apiKey: string
  model: string
  baseURL?: string
}

export interface UseAiSettingsResult {
  saving: boolean
  testing: boolean
  saveStatus: 'idle' | 'success' | 'error'
  testStatus: 'idle' | 'success' | 'error' | 'testing'
  saveMessage: string
  testMessage: string
  save: (form: AiSettingsForm) => Promise<string | null>
  testConnection: (form: AiSettingsForm) => Promise<boolean>
  reset: () => void
}

export function useAiSettings(): UseAiSettingsResult {
  const invalidate = useInvalidateResources()

  const saveMutation = useMutation({
    mutationFn: async (form: AiSettingsForm): Promise<string> => {
      const result = await apiFetch<{ data: { settings: { id: string } } }>(
        '/api/v1/admin/ai-settings',
        {
          method: 'POST',
          body: JSON.stringify({
            enabled: form.enabled,
            provider: form.provider,
            config: {
              provider: form.provider,
              apiKey: form.apiKey,
              model: form.model,
              baseURL: form.baseURL || undefined,
            },
          }),
        },
      )
      await invalidate('admin')
      return result.data.settings.id
    },
  })

  const testMutation = useMutation({
    mutationFn: async (form: AiSettingsForm): Promise<string> => {
      const result = await apiFetch<{ data: { message?: string } }>(
        '/api/v1/admin/ai-settings/test',
        {
          method: 'POST',
          body: JSON.stringify({
            provider: form.provider,
            apiKey: form.apiKey,
            model: form.model,
            baseURL: form.baseURL || undefined,
          }),
        },
      )
      return result.data.message ?? 'Connection successful!'
    },
  })

  const save = async (form: AiSettingsForm): Promise<string | null> => {
    try {
      return await saveMutation.mutateAsync(form)
    } catch {
      return null
    }
  }

  const testConnection = async (form: AiSettingsForm): Promise<boolean> => {
    try {
      await testMutation.mutateAsync(form)
      return true
    } catch {
      return false
    }
  }

  const reset = () => {
    saveMutation.reset()
    testMutation.reset()
  }

  return {
    saving: saveMutation.isPending,
    testing: testMutation.isPending,
    saveStatus: saveMutation.isSuccess
      ? 'success'
      : saveMutation.isError
        ? 'error'
        : 'idle',
    testStatus: testMutation.isPending
      ? 'testing'
      : testMutation.isSuccess
        ? 'success'
        : testMutation.isError
          ? 'error'
          : 'idle',
    saveMessage: saveMutation.error?.message ?? '',
    testMessage: testMutation.data ?? testMutation.error?.message ?? '',
    save,
    testConnection,
    reset,
  }
}
