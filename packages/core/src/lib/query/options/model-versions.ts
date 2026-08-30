// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import { qk } from '../keys'
import type { ApiData } from '@/lib/api/typed'
import { apiFetch } from '@/lib/api/client'

/** Whether a model hangs off the item version itself or a Document it links. */
export type ModelVersionFileSource = ModelVersionFile['source']

/**
 * One version of an item's master, resolved to its viewable CAD models —
 * derived from the OpenAPI contract (FE-7). `key` is the stable picker
 * identity (`current`, `branch:<id>`, `historical:<itemId>`); `files` lists
 * every viewable model with the default pick first; `file` is the model this
 * version context would show, or null when it has none.
 */
export type ModelVersionEntry = ApiData<
  '/api/v1/items/{itemId}/model-versions',
  'get'
>['versions'][number]

/** One viewable CAD model a version context offers. */
export type ModelVersionFile = ModelVersionEntry['files'][number]

/**
 * Every version of the item's master with the CAD models each offers — the
 * pick list for the 3D comparison overlay, which chooses a version *and* a
 * file per side. Keyed under `items`, so file uploads and ECO releases
 * invalidate it through the resource graph.
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
