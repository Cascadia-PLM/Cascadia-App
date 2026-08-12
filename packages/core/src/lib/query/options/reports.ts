// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { collectionQuery, entityQuery } from './entities'
import type { Report } from '@/lib/reports/types'

/** Every report visible to the caller, grouped by item type in the UI. */
export function reportListQuery() {
  return collectionQuery<Report>('reports', 'reports')
}

export function reportDetailQuery(id: string) {
  return entityQuery<Report>('reports', id, 'report')
}
