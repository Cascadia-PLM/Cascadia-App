// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Postgres driver error inspection.
 *
 * Drizzle wraps driver failures in a `DrizzleQueryError` whose `message` is the
 * full SQL text plus bound parameters ("Failed query: insert into
 * \"item_relationships\" (...) values ($1, $2, …)"). That message must never
 * reach a client — it is the query, not an explanation — so code that wants to
 * react to a constraint violation has to reach past the wrapper to the driver
 * error underneath rather than string-matching the wrapper.
 */

/**
 * The fields a driver sets on a Postgres error.
 *
 * The names differ by driver and the difference is silent: postgres.js (what
 * this codebase uses) reports `table_name` / `constraint_name` / `column_name`,
 * while node-postgres reports `table` / `constraint` / `column`. Reading only
 * one spelling yields `undefined` rather than an error, so every accessor below
 * reads both.
 */
export interface PostgresDriverError {
  code: string
  detail?: string
  constraint?: string
  constraint_name?: string
  column?: string
  column_name?: string
  table?: string
  table_name?: string
}

/** The constraint that rejected the statement, under either driver's spelling. */
export function constraintOf(error: PostgresDriverError): string | undefined {
  return error.constraint ?? error.constraint_name
}

/** The table the statement targeted, under either driver's spelling. */
export function tableOf(error: PostgresDriverError): string | undefined {
  return error.table ?? error.table_name
}

/** Postgres `unique_violation`. */
export const UNIQUE_VIOLATION = '23505'

function hasStringCode(value: unknown): value is PostgresDriverError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    typeof (value as Record<string, unknown>).code === 'string'
  )
}

/**
 * Find the driver error inside `error`, following the `cause` chain.
 *
 * Returns null when nothing in the chain looks like a Postgres error, so a
 * caller can fall through to its generic handling. The walk is depth-limited
 * because an error chain is caller-supplied and can be cyclic.
 */
export function asPostgresError(error: unknown): PostgresDriverError | null {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current != null; depth++) {
    if (hasStringCode(current)) return current
    current = (current as { cause?: unknown }).cause
  }
  return null
}

/**
 * Whether `error` is a unique-constraint violation, optionally narrowed to the
 * table it was raised on. The constraint name is the fallback because a
 * partial unique index reports no table: drizzle names an unnamed `unique()`
 * after the table it is declared on, so the prefix identifies it.
 */
export function isUniqueViolation(
  error: unknown,
  options?: { table?: string },
): boolean {
  const pgError = asPostgresError(error)
  if (pgError?.code !== UNIQUE_VIOLATION) return false
  if (!options?.table) return true
  return (
    tableOf(pgError) === options.table ||
    (constraintOf(pgError)?.startsWith(`${options.table}_`) ?? false)
  )
}
