// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { collectionQuery } from './entities'
import type { FileRecordWithItem } from '@/lib/vault/services/FileService'

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
