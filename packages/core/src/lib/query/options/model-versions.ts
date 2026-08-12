// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import { qk } from '../keys'
import { apiFetch } from '@/lib/api/client'

/** One version of an item's master, resolved to its viewable CAD model. */
export interface ModelVersionEntry {
  /** Stable identity for pickers: `current`, `branch:<id>`, `historical:<itemId>`. */
  key: string
  kind: 'current' | 'branch' | 'historical'
  itemId: string
  revision: string
  state: string
  modifiedAt: string
  branch: {
    id: string
    name: string
    branchType: string
    changeOrderItemId: string | null
    changeOrderNumber: string | null
  } | null
  /** The model this version context would show, or null when it has none. */
  file: {
    id: string
    fileName: string
    fileType: string
    hasColors: boolean
    fileSize: number
    uploadedAt: string
  } | null
}

/**
 * Every version of the item's master with the CAD model each would display —
 * the pick list for the 3D comparison overlay. Keyed under `items`, so file
 * uploads and ECO releases invalidate it through the resource graph.
 */
export function itemModelVersionsQuery(
  itemId: string | undefined,
  enabled = true,
) {
  return queryOptions({
    queryKey: qk.sub('items', itemId ?? '', 'model-versions'),
    queryFn: async (): Promise<Array<ModelVersionEntry>> => {
      const result = await apiFetch<{
        data: { versions: Array<ModelVersionEntry> }
      }>(`/api/v1/items/${itemId}/model-versions`)
      return result.data.versions
    },
    enabled: enabled && Boolean(itemId),
  })
}
