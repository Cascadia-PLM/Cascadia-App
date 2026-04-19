import { eq, isNull, or } from 'drizzle-orm'
import { items } from './schema'

/**
 * Reusable filter that excludes soft-deleted items.
 * Uses the defensive pattern: treats NULL and false as "not deleted"
 * for backward compatibility with rows inserted before the column existed.
 */
export function notDeleted() {
  return or(isNull(items.isDeleted), eq(items.isDeleted, false))!
}
