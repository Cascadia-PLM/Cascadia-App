// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Retry wrapper for SERIALIZABLE transactions.
 *
 * PostgreSQL raises error code 40001 (serialization_failure) when two
 * concurrent SERIALIZABLE transactions conflict. This wrapper retries
 * with exponential backoff, which is the standard mitigation.
 */

/**
 * The Postgres error code carried by `error`, walked through wrapper chains.
 *
 * Drizzle wraps every failed statement in a `DrizzleQueryError` whose `cause`
 * is the driver error — so a 40001 raised by a statement (rather than at
 * COMMIT, where postgres.js surfaces it unwrapped) carries its code one level
 * down. Reading only the top-level `code` made this wrapper retry commit-time
 * conflicts but silently give up on statement-time ones.
 */
export function pgErrorCode(error: unknown): string | null {
  let current: unknown = error
  for (
    let depth = 0;
    depth < 5 && typeof current === 'object' && current !== null;
    depth++
  ) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string') return code
    current = (current as { cause?: unknown }).cause
  }
  return null
}

export async function withSerializableRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  retryCodes: ReadonlyArray<string> = ['40001'],
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error: unknown) {
      const code = pgErrorCode(error)
      if (code === null || !retryCodes.includes(code) || attempt === maxRetries)
        throw error
      await new Promise((r) => setTimeout(r, 50 * Math.pow(2, attempt)))
    }
  }
  throw new Error('Unreachable')
}
