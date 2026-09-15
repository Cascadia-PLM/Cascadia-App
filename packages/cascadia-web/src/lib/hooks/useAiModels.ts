// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Model picker options for an AI provider, discovered at runtime.
 *
 * Asks the server to query the provider's own list-models endpoint and falls
 * back to the static catalog when that is not possible — no key entered yet,
 * provider unreachable, air-gapped install. Shared by the admin settings page
 * and the setup wizard so the two pickers cannot disagree.
 */

import { useQuery } from '@tanstack/react-query'
import type { AiModelOption, AiProviderType } from '@/lib/ai/model-catalog'
import { fallbackModelOptions } from '@/lib/ai/model-catalog'
import { qk } from '@/lib/query/keys'
import { apiFetch } from '@/lib/api/client'

interface DiscoveryResponse {
  models: Array<AiModelOption>
  source: string
}

export interface UseAiModelsOptions {
  provider: AiProviderType
  /** Key as typed into the form. Never enters the query key. */
  apiKey?: string
  baseURL?: string
  /**
   * Whether credentials exist server-side (saved settings or environment) even
   * when the form's key field is empty or masked. Lets discovery run on a
   * freshly-loaded admin page.
   */
  hasServerCredentials?: boolean
}

export interface UseAiModelsResult {
  /** Discovered models, or the static fallback. Never empty. */
  options: Array<AiModelOption>
  /** True when `options` came from the provider rather than the catalog. */
  isLive: boolean
  isFetching: boolean
  /** Why discovery did not run or did not succeed; undefined when it did. */
  fallbackReason?: string
  /** Provider display name behind a live list. */
  source?: string
  refresh: () => void
}

export function useAiModels({
  provider,
  apiKey,
  baseURL,
  hasServerCredentials = false,
}: UseAiModelsOptions): UseAiModelsResult {
  // `GET /ai-settings` returns the stored key masked as `first8...last4`, and
  // the admin form hydrates its field from that. Treat a masked value as "no
  // key typed" so the key-presence check reflects reality; the server applies
  // the same rule before choosing which credential to use.
  const hasTypedKey = !!apiKey && !apiKey.includes('...')
  const canDiscover =
    provider === 'ollama' || hasTypedKey || hasServerCredentials

  const query = useQuery({
    // The key deliberately excludes `apiKey` — secrets should not end up in
    // cache keys or the query devtools. `hasTypedKey` is enough to refetch
    // when the admin types one in.
    queryKey: qk.collection('admin', 'ai-models', {
      provider,
      baseURL: baseURL ?? '',
      hasTypedKey,
    }),
    queryFn: async (): Promise<DiscoveryResponse> => {
      const result = await apiFetch<{ data: DiscoveryResponse }>(
        '/api/v1/admin/ai-settings/models',
        {
          method: 'POST',
          body: JSON.stringify({ provider, apiKey, baseURL }),
        },
      )
      return result.data
    },
    enabled: canDiscover,
    // Provider catalogues change on the order of weeks; re-listing on every
    // mount of the settings page is pure latency.
    staleTime: 30 * 60 * 1000,
    retry: false,
  })

  const discovered = query.data?.models ?? []
  if (discovered.length > 0) {
    return {
      options: discovered,
      isLive: true,
      isFetching: query.isFetching,
      source: query.data?.source,
      refresh: () => void query.refetch(),
    }
  }

  const fallbackReason = !canDiscover
    ? 'Enter an API key to load the live model list.'
    : query.isFetching
      ? undefined
      : query.error
        ? query.error.message
        : query.isSuccess
          ? 'The provider returned no models.'
          : undefined

  return {
    options: fallbackModelOptions(provider),
    isLive: false,
    isFetching: query.isFetching,
    fallbackReason,
    refresh: () => void query.refetch(),
  }
}

/**
 * Ensure the currently-selected model is selectable even when it is not in the
 * offered list — a pinned snapshot, a model the key has lost access to, or a
 * value carried over from a previous provider. Without this the Select renders
 * blank and silently loses the saved setting on the next save.
 */
export function withSelectedModel(
  options: Array<AiModelOption>,
  selected: string,
): Array<AiModelOption> {
  if (!selected || options.some((option) => option.id === selected)) {
    return options
  }
  return [{ id: selected, label: `${selected} (not listed)` }, ...options]
}
