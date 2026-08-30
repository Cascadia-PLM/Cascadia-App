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

import { AppError } from './AppError'

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

/** A SQLSTATE code: exactly five alphanumerics, as in `23505` or `22P02`. */
const SQLSTATE = /^[0-9A-Z]{5}$/

/**
 * Whether `code` has the shape of a SQLSTATE.
 *
 * The shape is all there is to go on: SQLSTATE classes are open — an extension
 * or a future server version can raise a code no table here lists — so this
 * cannot be an allow-list. Callers use it to narrow `asPostgresError`, which
 * matches anything carrying a string `code` and so answers yes for an fs
 * `ENOENT`, an undici `ECONNREFUSED`, or an AMQP failure just as readily as for
 * a driver error.
 *
 * The accepted residual: a five-character uppercase errno — `EPIPE`, `EBUSY`,
 * `EXDEV` — is indistinguishable from a SQLSTATE by shape and still passes.
 * Narrowing further would mean an allow-list, which fails the other way by
 * misclassifying real database errors, and those are the ones worth getting
 * right.
 */
export function isSqlStateCode(code: string): boolean {
  return SQLSTATE.test(code)
}

/**
 * Whether `error` came out of the database layer.
 *
 * Two shapes qualify: drizzle's query wrapper, whose `message` *is* the failed
 * SQL plus its bound parameters, and a driver error anywhere under it. The
 * wrapper is recognised by its own fields (`query` text + `params` array)
 * rather than by importing `DrizzleQueryError`, which would pull drizzle into
 * every module that only wants to ask this question.
 *
 * `AppError` is excluded outright, and the driver's `code` is narrowed by
 * `isSqlStateCode`, because `asPostgresError` matches anything carrying a
 * string `code` — which every `AppError` does. Without both guards this would
 * call `NotFoundError` a database failure and redact the one message the
 * caller needed.
 */
export function isDatabaseError(error: unknown): boolean {
  if (error instanceof AppError) return false
  if (
    error instanceof Error &&
    typeof (error as { query?: unknown }).query === 'string' &&
    Array.isArray((error as { params?: unknown }).params)
  ) {
    return true
  }
  const code = asPostgresError(error)?.code
  return code !== undefined && isSqlStateCode(code)
}

/**
 * An error message safe to hand to a client or a model.
 *
 * Database failures describe the *statement*, not the request: the drizzle
 * wrapper spells out the SQL and every bound parameter, and the driver error
 * beneath it names columns and types. Neither is actionable by the caller, so
 * both collapse to `fallback`. Everything else keeps its own message — service
 * errors (`NotFoundError`, `ValidationError`, permission denials) are written
 * to be read, and hiding them would make the caller worse off.
 */
export function safeErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || isDatabaseError(error)) return fallback
  return error.message
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
