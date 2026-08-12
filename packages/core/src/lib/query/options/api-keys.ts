// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import { qk } from '../keys'
import type { ApiKeyPolicy } from '@/lib/auth/api-key-policy-types'
import type { ApiKeyStatus } from '@/lib/auth/ApiKeyService'
import { apiFetch } from '@/lib/api/client'

/**
 * One key as every read surface returns it. Never carries key material —
 * `keyPrefix` is the only fragment of the secret that survives creation.
 */
export interface ApiKeyRecord {
  id: string
  name: string
  keyPrefix: string
  permissions: Record<string, Array<string>> | null
  roles: Array<string> | null
  expiresAt: string | null
  lastUsedAt: string | null
  createdAt: string
  disabledAt: string | null
  revokedAt: string | null
  rotatedAt: string | null
  userId: string
  status: ApiKeyStatus
}

/** The admin list additionally resolves the owner. */
export interface AdminApiKeyRecord extends ApiKeyRecord {
  userName: string | null
  userEmail: string
}

export interface ApiKeyEvent {
  id: string
  outcome: string
  method: string | null
  path: string | null
  ipAddress: string | null
  userAgent: string | null
  occurredAt: string
}

/**
 * The caller's own keys, plus the roles they may scope a new one to.
 *
 * Keyed under `auth` rather than `admin` because it is per-caller: two admins
 * hitting this endpoint legitimately get different answers.
 */
export function myApiKeysQuery() {
  return queryOptions({
    queryKey: qk.collection('auth', 'api-keys'),
    queryFn: async (): Promise<{
      apiKeys: Array<ApiKeyRecord>
      scopableRoles: Array<string>
    }> => {
      const result = await apiFetch<{
        data: { apiKeys: Array<ApiKeyRecord>; scopableRoles: Array<string> }
      }>('/api/v1/auth/api-keys')
      return result.data
    },
  })
}

/** Activity for one of the caller's own keys. */
export function myApiKeyActivityQuery(keyId: string) {
  return queryOptions({
    queryKey: qk.sub('auth', keyId, 'activity'),
    queryFn: async (): Promise<Array<ApiKeyEvent>> => {
      const result = await apiFetch<{ data: { events: Array<ApiKeyEvent> } }>(
        `/api/v1/auth/api-keys/${keyId}/activity`,
      )
      return result.data.events
    },
  })
}

/** Every key on the instance, newest first, with its owner. */
export function adminApiKeysQuery() {
  return queryOptions({
    queryKey: qk.collection('admin', 'api-keys'),
    queryFn: async (): Promise<Array<AdminApiKeyRecord>> => {
      const result = await apiFetch<{
        data: { apiKeys: Array<AdminApiKeyRecord> }
      }>('/api/v1/admin/api-keys')
      return result.data.apiKeys
    },
  })
}

/** Activity for any key, for admins. */
export function adminApiKeyActivityQuery(keyId: string) {
  return queryOptions({
    queryKey: qk.sub('admin', keyId, 'activity'),
    queryFn: async (): Promise<Array<ApiKeyEvent>> => {
      const result = await apiFetch<{ data: { events: Array<ApiKeyEvent> } }>(
        `/api/v1/admin/api-keys/${keyId}/activity`,
      )
      return result.data.events
    },
  })
}

/**
 * The instance-wide expiration policy, alongside the built-in defaults so the
 * UI can show what a reset would restore.
 */
export function apiKeyPolicyQuery() {
  return queryOptions({
    queryKey: qk.collection('admin', 'api-key-policy'),
    queryFn: async (): Promise<{
      policy: ApiKeyPolicy
      defaults: ApiKeyPolicy
    }> => {
      const result = await apiFetch<{
        data: { policy: ApiKeyPolicy; defaults: ApiKeyPolicy }
      }>('/api/v1/admin/api-key-policy')
      return result.data
    },
  })
}
