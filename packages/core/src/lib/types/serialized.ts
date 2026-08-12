// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The shape a value has after a round-trip through JSON over HTTP.
 *
 * Drizzle's `$inferSelect` row types describe the DATABASE row - `Date` for
 * timestamp columns. But a client route never sees a Date: `JSON.stringify`
 * turns Dates into ISO strings, and the client parses them back as strings.
 * Typing client-side data with the raw row type is a lie the compiler can't
 * catch until you call a Date method on a string.
 *
 * `Serialized<T>` rewrites that row type to what actually arrives on the
 * client: every `Date` becomes `string`, recursively through arrays and
 * nested objects. Use it wherever a `$inferSelect` type crosses the HTTP
 * boundary into browser code.
 */
export type Serialized<T> = T extends Date
  ? string
  : T extends Array<infer U>
    ? Array<Serialized<U>>
    : T extends object
      ? { [K in keyof T]: Serialized<T[K]> }
      : T
