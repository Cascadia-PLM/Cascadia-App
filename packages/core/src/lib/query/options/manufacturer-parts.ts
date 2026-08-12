// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import { qk } from '../keys'
import { apiFetch } from '@/lib/api/client'

/**
 * The Approved Manufacturer List for a part master.
 *
 * Keyed under `manufacturer-parts` rather than the ad-hoc `['part-aml', id]`
 * it used to use, so a write here reaches the part views too — the
 * dependency graph lists `parts` and `items` as dependents.
 */
export function partAmlQuery<T>(partMasterId: string) {
  return queryOptions({
    queryKey: qk.collection('manufacturer-parts', 'by-part', partMasterId),
    queryFn: async (): Promise<Array<T>> => {
      const result = await apiFetch<{ data: { sources: Array<T> } }>(
        `/api/v1/manufacturer-parts/part/${partMasterId}`,
      )
      return result.data.sources
    },
  })
}
