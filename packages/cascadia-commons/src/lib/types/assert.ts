// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Compile-time type assertions.
 *
 * A wire type the web consumes is hand-written in commons, while the row it
 * describes is inferred from a Drizzle table the server owns. These let the
 * schema module pin the two together, so a column change that is not
 * mirrored in the wire type fails `tsc` at the table rather than at some
 * client call site.
 *
 *   export type _RowMatches = Expect<Equal<typeof table.$inferSelect, Row>>
 */

/** `true` when `TLeft` and `TRight` are identical types, `false` otherwise. */
export type Equal<TLeft, TRight> =
  (<T>() => T extends TLeft ? 1 : 2) extends <T>() => T extends TRight ? 1 : 2
    ? true
    : false

/** Fails to compile unless `T` is `true`. */
export type Expect<T extends true> = T
