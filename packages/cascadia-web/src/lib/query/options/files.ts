// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import { qk } from '../keys'
import { collectionQuery } from './entities'
import type { FileRecordWithItem } from '@/lib/vault/services/FileService'
import { apiFetch } from '@/lib/api/client'

export interface FileMetadata {
  id: string
  originalFileName: string
  fileName: string
  fileSize: number
}

/** Metadata for one vault file, without downloading its contents. */
export function fileMetadataQuery(fileId: string, enabled = true) {
  return queryOptions({
    queryKey: qk.sub('files', fileId, 'metadata'),
    queryFn: async (): Promise<FileMetadata> => {
      const result = await apiFetch<{ data: { file: FileMetadata } }>(
        `/api/v1/files/${fileId}/metadata`,
      )
      return result.data.file
    },
    enabled,
  })
}

/**
 * Every file in the vault, latest revision only.
 *
 * The list page filters, sorts and counts client-side, so it takes one capped
 * page rather than a server-paged grid.
 */
export function fileListQuery(limit = 200) {
  return collectionQuery<FileRecordWithItem>('files', 'files', {
    search: `limit=${limit}`,
  })
}
