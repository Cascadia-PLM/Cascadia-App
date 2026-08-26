// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Quantity rules for relationship lines, shared by every dialog that writes
 * one. `item_relationships.quantity` is `numeric(10,3)`, so anything that is
 * not a decimal is rejected by the database with a raw SQL error — validate
 * here instead. A BOM line additionally REQUIRES a quantity: the dialogs
 * default it to `1` and refuse to submit without a valid value, which is what
 * keeps "-" quantities out of released BOMs.
 */

/** What a new BOM line's quantity field starts at. */
export const DEFAULT_BOM_QUANTITY = '1'

/** True when `value` is a positive decimal the quantity column can hold. */
export function isValidQuantity(value: string): boolean {
  const trimmed = value.trim()
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(trimmed)) return false
  return parseFloat(trimmed) > 0
}
