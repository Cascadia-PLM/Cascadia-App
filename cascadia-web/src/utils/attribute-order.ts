// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

type Attributes = Record<string, unknown>

/**
 * Attribute keys in display order: alphabetical.
 *
 * `items.attributes` is jsonb, which does not keep insertion order (Postgres
 * stores keys shortest first), so listing `Object.entries` as loaded shows an
 * order nobody chose. Alphabetical is the one order that is the same for
 * every item and every install, whatever its attribute names are.
 */
export function sortedAttributeKeys(
  attributes: Attributes | null | undefined,
): Array<string> {
  return Object.keys(attributes ?? {}).sort((a, b) => a.localeCompare(b))
}

/** Attribute entries in display order, for read-only lists. */
export function sortedAttributeEntries(
  attributes: Attributes | null | undefined,
): Array<[string, unknown]> {
  const source = attributes ?? {}
  return sortedAttributeKeys(source).map((key) => [key, source[key]])
}

/**
 * Attribute entries in a fixed row order, for an editor.
 *
 * Keys listed in `rowOrder` come first, in that order, where they still
 * exist; any key it does not list follows in the map's own order. An editor
 * holds `rowOrder` steady while someone types, so a row never moves under
 * the cursor the way it would if the list were re-sorted on every keystroke.
 */
export function attributeEntriesInRowOrder(
  attributes: Attributes,
  rowOrder: ReadonlyArray<string>,
): Array<[string, unknown]> {
  const keys = new Set(rowOrder.filter((key) => key in attributes))
  for (const key of Object.keys(attributes)) keys.add(key)
  return [...keys].map((key) => [key, attributes[key]])
}
