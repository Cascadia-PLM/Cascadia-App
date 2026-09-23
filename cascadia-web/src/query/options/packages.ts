// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { collectionQuery } from './entities'
import type { ApiData } from '@/lib/api/typed'

/**
 * Which optional packages this instance is licensed for.
 *
 * Entitlement is fixed at deploy time via `CASCADIA_PACKAGES`, so nothing in
 * the app writes it — this drives presentation only, and every gated route
 * re-checks the entitlement server-side. The row type derives from the
 * OpenAPI contract (FE-7); it is structurally the registry's PackageStatus,
 * and stops compiling the day the wire shape moves.
 */
export function packageListQuery() {
  return collectionQuery<
    ApiData<'/api/v1/packages', 'get'>['packages'][number]
  >('packages', 'packages')
}
