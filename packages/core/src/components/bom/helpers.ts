// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Shared helper functions for BOM tree components
 */

import { getItemDetailPath } from '@/lib/items/item-type-ui'

/**
 * Get badge variant for item state
 */
export function getStateBadgeVariant(
  state: string,
): 'default' | 'secondary' | 'success' | 'warning' | 'destructive' | 'outline' {
  switch (state) {
    case 'Released':
    case 'Resolved':
    case 'Verified':
      return 'success'
    case 'Draft':
    case 'Pending':
    case 'Closed':
      return 'secondary'
    case 'InReview':
    case 'InProgress':
      return 'warning'
    case 'Obsolete':
      return 'outline'
    case 'Cancelled':
      return 'destructive'
    default:
      return 'default'
  }
}

/**
 * Get detail page route for an item type
 */
export function getItemRoute(itemType: string, itemId: string): string {
  return getItemDetailPath(itemType, itemId) ?? `/parts/${itemId}`
}
