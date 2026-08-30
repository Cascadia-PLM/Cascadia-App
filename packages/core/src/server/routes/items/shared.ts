// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { permissionService } from '@/lib/auth/permission-service'
import { ITEM_TYPE_RESOURCES } from '@/lib/items/item-type-resources'

/**
 * Item types whose RBAC resource the user is allowed to read.
 * Exported for the enterprise-search results route, which gates the same way.
 */
export async function readableItemTypes(userId: string): Promise<Set<string>> {
  // Concurrent, not sequential: the checks are independent, and on a cold
  // permission cache an awaited loop costs one database round trip per item
  // type rather than one for the lot.
  const checks = await Promise.all(
    Object.entries(ITEM_TYPE_RESOURCES).map(
      async ([itemType, resource]) =>
        [
          itemType,
          await permissionService.canUser(userId, 'read', resource),
        ] as const,
    ),
  )
  return new Set(
    checks.filter(([, canRead]) => canRead).map(([itemType]) => itemType),
  )
}
