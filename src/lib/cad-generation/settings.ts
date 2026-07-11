// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

/**
 * Server-side resolver for CAD generation (Zoo) provider settings.
 *
 * Precedence (mirrors the AI provider resolver in `@/lib/ai/adapters`):
 *   1. Database settings (the `cad_generation` blob in the `settings` table),
 *      when present and `enabled`.
 *   2. The `ZOO_API_KEY` environment variable.
 *
 * Stored keys are encrypted at rest when `ENCRYPTION_KEY` is configured; this
 * module transparently decrypts them, falling back to treating the value as
 * plaintext if decryption fails (e.g. rows written before encryption was on).
 */

import type { CadGenerationConfig } from './settings-types'
import { SettingsService } from '@/lib/config/SettingsService'
import { SettingKeys } from '@/lib/config/SettingKeys'
import { decrypt, isEncryptionConfigured } from '@/lib/crypto/encryption'

/**
 * Read the stored CAD generation config blob (with the API key still encrypted).
 */
export async function loadCadGenerationConfig(): Promise<CadGenerationConfig | null> {
  return SettingsService.getJsonValue<CadGenerationConfig>(
    SettingKeys.CAD_GENERATION,
  )
}

/**
 * Decrypt a stored API key, tolerating plaintext values.
 */
export function decryptCadApiKey(apiKey: string): string {
  if (!isEncryptionConfigured()) return apiKey
  try {
    return decrypt(apiKey)
  } catch {
    // May be plaintext from before encryption was enabled — use as-is.
    return apiKey
  }
}

/**
 * Resolve the effective Zoo API key: database settings first (when enabled),
 * otherwise the `ZOO_API_KEY` environment variable. Returns `undefined` when
 * neither source provides a key (callers/`ZooClient` surface the error).
 */
export async function resolveZooApiKey(): Promise<string | undefined> {
  const stored = await loadCadGenerationConfig()
  if (stored?.enabled && stored.apiKey) {
    return decryptCadApiKey(stored.apiKey)
  }
  return process.env.ZOO_API_KEY || undefined
}
