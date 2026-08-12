// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Server-side resolver for the instance API key policy.
 *
 * Reads the `api_key_policy` blob from the settings table, falling back to
 * `DEFAULT_API_KEY_POLICY` when it has never been written. Stored blobs are
 * merged over the defaults field-by-field so a policy written before a new
 * field existed still resolves.
 */

import { DEFAULT_API_KEY_POLICY } from './api-key-policy-types'
import type { ApiKeyPolicy } from './api-key-policy-types'
import { SettingsService } from '@/lib/config/SettingsService'
import { SettingKeys } from '@/lib/config/SettingKeys'

export async function loadApiKeyPolicy(): Promise<ApiKeyPolicy> {
  const stored = await SettingsService.getJsonValue<Partial<ApiKeyPolicy>>(
    SettingKeys.API_KEY_POLICY,
  )

  if (!stored) return DEFAULT_API_KEY_POLICY

  return {
    defaultExpirationDays:
      stored.defaultExpirationDays === undefined
        ? DEFAULT_API_KEY_POLICY.defaultExpirationDays
        : stored.defaultExpirationDays,
    maxExpirationDays:
      stored.maxExpirationDays === undefined
        ? DEFAULT_API_KEY_POLICY.maxExpirationDays
        : stored.maxExpirationDays,
    requireExpiration:
      stored.requireExpiration ?? DEFAULT_API_KEY_POLICY.requireExpiration,
  }
}

export async function saveApiKeyPolicy(
  policy: ApiKeyPolicy,
  userId: string,
): Promise<void> {
  await SettingsService.setJsonValue(
    SettingKeys.API_KEY_POLICY,
    policy,
    userId,
    'Expiration policy applied to newly created API keys',
  )
}
