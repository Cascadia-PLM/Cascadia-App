// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The keys an item read returns, which an item update accepts back and ignores.
 *
 * Request bodies reject keys their schema does not declare (`strict-body.ts`).
 * Item updates need one tolerance: every detail page saves by PUTting back the
 * object its read handed it, edited — `{ ...part, attributes }` — so the body
 * carries the row's identity and server-managed columns (`id`, `revision`,
 * `createdAt`, a requirement's derived `verificationStatus`, …) alongside the
 * fields the caller meant to change. Those are not mistakes; they are the
 * read-modify-write REST invites, and they are never writable.
 *
 * So the set is derived, not listed: every column of `items`, every column of
 * the type's extension table, and the few computed keys the item reads add.
 * A key the update schema *declares* is never in effect ignored — the route
 * subtracts its schema's own keys — so `name` or `state` is still validated.
 * What remains rejected is anything a read could not have returned: a typo,
 * a field from another type, a field that does not exist.
 */

import { getTableColumns } from 'drizzle-orm'
import { items } from '@/db/schema'
import { getTypeHandler } from '@/items/type-handlers'

/** Keys the item reads add beyond the two rows' columns. */
const COMPUTED_READ_KEYS: Record<string, ReadonlyArray<string>> = {
  // `GET /items/:id` counts where-used.
  '*': ['usageCount'],
  // `GET /work-instructions/:id` inlines the steps, which have their own
  // endpoints; the edit form spreads the whole read into its values.
  WorkInstruction: ['steps'],
}

const cache = new Map<string, ReadonlySet<string>>()

export function itemReadEchoFields(itemType: string): ReadonlySet<string> {
  const cached = cache.get(itemType)
  if (cached) return cached

  const keys = new Set<string>(Object.keys(getTableColumns(items)))
  for (const key of COMPUTED_READ_KEYS['*'] ?? []) keys.add(key)
  for (const key of COMPUTED_READ_KEYS[itemType] ?? []) keys.add(key)

  const handler = getTypeHandler(itemType)
  // Registered at server start; until then the set is the base columns only
  // and is not cached, so a later call sees the type's own columns.
  if (!handler) return keys
  for (const key of Object.keys(getTableColumns(handler.table))) keys.add(key)

  cache.set(itemType, keys)
  return keys
}
