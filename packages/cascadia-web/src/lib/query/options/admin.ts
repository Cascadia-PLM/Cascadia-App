// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import { qk } from '../keys'
import type { VaultConfigInfo } from '@/lib/vault/storage/storage-factory'
import { apiFetch } from '@/lib/api/client'

export interface AiProviderSettings {
  id: string
  provider: string
  enabled: boolean
  config: {
    provider?: string
    apiKey?: string
    model?: string
    baseURL?: string
  }
}

export interface AiSettingsEnvVars {
  openai: boolean
  anthropic: boolean
}

export interface AiSettings {
  settings: AiProviderSettings | null
  envVars: AiSettingsEnvVars
}

const NO_ENV_VARS: AiSettingsEnvVars = { openai: false, anthropic: false }

/**
 * How the vault resolves its storage backend, and where each value came from.
 *
 * Keyed under `admin` because writing a setting changes the *effective*
 * configuration this reports, not just the row that was written.
 */
/**
 * One system setting's JSON value, by key.
 *
 * Keyed under `admin` so a settings write refreshes every reader — the
 * setup wizard and the admin pages read the same entries.
 */
export function settingQuery<T>(key: string) {
  return queryOptions({
    queryKey: qk.detail('admin', `setting:${key}`),
    queryFn: async (): Promise<T | null> => {
      const result = await apiFetch<{
        data?: { setting?: { jsonValue?: T } }
      }>(`/api/v1/admin/settings?key=${encodeURIComponent(key)}`)
      return result.data?.setting?.jsonValue ?? null
    },
  })
}

export function vaultConfigQuery() {
  return queryOptions({
    queryKey: qk.collection('admin', 'vault-config'),
    queryFn: async (): Promise<VaultConfigInfo> => {
      const result = await apiFetch<{ data: VaultConfigInfo }>(
        '/api/v1/admin/vault-config',
      )
      return result.data
    },
  })
}

/**
 * Global AI provider settings, with the stored API key masked server-side,
 * alongside which provider keys the server process has in its environment.
 */
export function aiSettingsQuery() {
  return queryOptions({
    queryKey: qk.collection('admin', 'ai-settings'),
    queryFn: async (): Promise<AiSettings> => {
      const result = await apiFetch<{ data: Partial<AiSettings> }>(
        '/api/v1/admin/ai-settings',
      )
      return {
        settings: result.data.settings ?? null,
        envVars: result.data.envVars ?? NO_ENV_VARS,
      }
    },
  })
}
