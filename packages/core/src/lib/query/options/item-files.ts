// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import { qk } from '../keys'
import { apiFetch } from '@/lib/api/client'

/**
 * Vault files attached to an item, resolved in a version context.
 *
 * Keyed under the item so that invalidating `files` — whose dependents
 * include `items` — refreshes it. It previously lived in component state
 * behind a `useEffect` that only re-ran when the item or branch changed, so
 * an upload or a delete left the list showing the pre-mutation set until the
 * page was navigated away from and back.
 */
export function itemFilesQuery<T>(
  itemId: string,
  context: { branchId?: string; mainBranchId?: string } = {},
) {
  const search = new URLSearchParams()
  if (context.branchId) search.set('branchId', context.branchId)
  if (context.mainBranchId) search.set('mainBranchId', context.mainBranchId)
  const suffix = search.size > 0 ? `?${search}` : ''

  return queryOptions({
    queryKey: qk.sub('items', itemId, 'files', {
      branchId: context.branchId,
      mainBranchId: context.mainBranchId,
    }),
    queryFn: async (): Promise<Array<T>> => {
      const result = await apiFetch<{ data: { files?: Array<T> } }>(
        `/api/v1/items/${itemId}/files${suffix}`,
      )
      return result.data.files ?? []
    },
  })
}
