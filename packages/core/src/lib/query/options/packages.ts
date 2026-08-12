// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { collectionQuery } from './entities'
import type { PackageStatus } from '@/lib/packages/types'

/**
 * Which optional packages this instance is licensed for.
 *
 * Entitlement is fixed at deploy time via `CASCADIA_PACKAGES`, so nothing in
 * the app writes it — this drives presentation only, and every gated route
 * re-checks the entitlement server-side.
 */
export function packageListQuery() {
  return collectionQuery<PackageStatus>('packages', 'packages')
}
