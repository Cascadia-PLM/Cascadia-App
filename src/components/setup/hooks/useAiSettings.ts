// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

/**
 * Wizard-friendly wrapper around `/api/v1/admin/ai-settings`.
 *
 * Mirrors the save/test handlers from `src/routes/admin/ai.tsx` so the
 * wizard step can reuse them without embedding the full admin page.
 */

import { useState } from 'react'

export type AiProviderType = 'openai' | 'anthropic' | 'gemini' | 'ollama'

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
  save: (form: AiSettingsForm) => Promise<boolean>
  testConnection: (form: AiSettingsForm) => Promise<boolean>
  reset: () => void
}

export function useAiSettings(): UseAiSettingsResult {
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>(
    'idle',
  )
  const [testStatus, setTestStatus] = useState<
    'idle' | 'success' | 'error' | 'testing'
  >('idle')
  const [saveMessage, setSaveMessage] = useState('')
  const [testMessage, setTestMessage] = useState('')

  const save = async (form: AiSettingsForm): Promise<boolean> => {
    setSaving(true)
    setSaveStatus('idle')
    setSaveMessage('')
    try {
      const response = await fetch('/api/v1/admin/ai-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      })
      if (!response.ok) {
        const json = await response.json().catch(() => ({}))
        throw new Error(json.error?.message ?? 'Failed to save AI settings')
      }
      setSaveStatus('success')
      return true
    } catch (err) {
      setSaveStatus('error')
      setSaveMessage((err as Error).message)
      return false
    } finally {
      setSaving(false)
    }
  }

  const testConnection = async (form: AiSettingsForm): Promise<boolean> => {
    setTesting(true)
    setTestStatus('testing')
    setTestMessage('')
    try {
      const response = await fetch('/api/v1/admin/ai-settings/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: form.provider,
          apiKey: form.apiKey,
          model: form.model,
          baseURL: form.baseURL || undefined,
        }),
      })
      const json = await response.json().catch(() => ({}))
      if (!response.ok) {
        setTestStatus('error')
        setTestMessage(json.error?.message ?? 'Connection test failed')
        return false
      }
      setTestStatus('success')
      setTestMessage(json.data?.message ?? 'Connection successful!')
      return true
    } catch (err) {
      setTestStatus('error')
      setTestMessage((err as Error).message)
      return false
    } finally {
      setTesting(false)
    }
  }

  const reset = () => {
    setSaveStatus('idle')
    setTestStatus('idle')
    setSaveMessage('')
    setTestMessage('')
  }

  return {
    saving,
    testing,
    saveStatus,
    testStatus,
    saveMessage,
    testMessage,
    save,
    testConnection,
    reset,
  }
}
