// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import { qk } from '../keys'
import type { FileAnnotation } from '@/lib/vault/annotations'
import { apiFetch } from '@/lib/api/client'

/**
 * Markup on one vault file version.
 *
 * Keyed under `files` so `invalidate('files')` — which every markup mutation
 * calls — refreshes it, and so does anything that changes the file itself.
 */
export function fileAnnotationsQuery(fileId: string) {
  return queryOptions({
    queryKey: qk.sub('files', fileId, 'annotations'),
    queryFn: async (): Promise<Array<FileAnnotation>> => {
      const result = await apiFetch<{
        data: { annotations?: Array<FileAnnotation> }
      }>(`/api/v1/files/${fileId}/annotations`)
      return result.data.annotations ?? []
    },
    // Callers resolve which file is on screen after their hooks have run, so
    // an empty id is a normal "nothing selected yet" rather than a bug.
    enabled: Boolean(fileId),
  })
}
