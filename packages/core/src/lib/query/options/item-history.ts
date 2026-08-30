// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import { qk } from '../keys'
import { apiFetch } from '@/lib/api/client'

/**
 * One item's history, resolved against a version context.
 *
 * Addressed by the id of the revision being viewed, but not scoped to it: the
 * server resolves that item's master id first and returns every version of the
 * lineage in its design, newest first. This is the revision timeline as much as
 * the per-item one. Keyed beneath the item.
 */
export function itemHistoryQuery<T>(
  itemId: string,
  search: string,
  enabled = true,
) {
  return queryOptions({
    queryKey: qk.sub('items', itemId, 'history', search || undefined),
    queryFn: async (): Promise<T> => {
      const suffix = search ? `?${search}` : ''
      const result = await apiFetch<{ data: T }>(
        `/api/v1/items/${itemId}/history${suffix}`,
      )
      return result.data
    },
    enabled: enabled && Boolean(itemId),
  })
}
