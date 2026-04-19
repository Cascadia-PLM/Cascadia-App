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
      return 'success'
    case 'Draft':
      return 'secondary'
    case 'InReview':
      return 'warning'
    case 'Obsolete':
      return 'outline'
    default:
      return 'default'
  }
}

/**
 * Get detail page route for an item type
 */
export function getItemRoute(itemType: string, itemId: string): string {
  switch (itemType) {
    case 'Part':
      return `/parts/${itemId}`
    case 'Document':
      return `/documents/${itemId}`
    case 'Requirement':
      return `/requirements/${itemId}`
    case 'ChangeOrder':
      return `/change-orders/${itemId}`
    case 'Task':
      return `/tasks/${itemId}`
    default:
      return `/parts/${itemId}`
  }
}
