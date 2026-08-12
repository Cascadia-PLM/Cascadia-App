// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import { qk } from '../keys'
import { apiFetch } from '@/lib/api/client'

/**
 * Every revision of one item lineage, newest first.
 *
 * Keyed by master id rather than by the id of the revision being viewed, so
 * the timeline is shared by every revision page of the same lineage and is
 * refreshed by any write that names `items` — releasing an ECO adds a
 * revision without the timeline knowing to ask again.
 */
export function itemRevisionHistoryQuery<T>(
  masterId: string,
  designId?: string,
  enabled = true,
) {
  return queryOptions({
    queryKey: qk.collection('items', 'revisions', { masterId, designId }),
    queryFn: async (): Promise<Array<T>> => {
      const search = new URLSearchParams({ masterId })
      if (designId) search.set('designId', designId)
      const result = await apiFetch<{ data: { revisions?: Array<T> } }>(
        `/api/v1/items/history?${search}`,
      )
      return result.data.revisions ?? []
    },
    enabled: enabled && Boolean(masterId),
  })
}
