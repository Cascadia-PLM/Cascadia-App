// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Shared helper functions for BOM tree components
 */

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
