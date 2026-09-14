// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/** How far an empty message is chased through inner errors and causes. */
const MAX_DEPTH = 4

/**
 * The text of an error, for a record someone reads later: a job's `error`, an
 * event consumer's `last_error`, the message of an error wrapping another.
 *
 * That is `error.message` whenever there is one. This exists for the error
 * whose message is **empty**, which is what a refused connection produces on
 * current Node. A host name that resolves to more than one address —
 * `localhost` is both `::1` and `127.0.0.1` — is dialled on each, and when
 * every attempt is refused the rejection is an `AggregateError` whose message
 * is `""`. Its `code` says `ECONNREFUSED`; which addresses refused is only in
 * `errors`. Read as `error.message`, a broker that was down recorded
 * `Failed to queue job: ` — nothing after the colon — on the job, and the same
 * blank on the event consumer stuck behind it.
 *
 * So an empty message falls back to an aggregate's inner errors, then the
 * `cause`, then the `code`, and last the error's name. The walk is
 * depth-limited because an error chain is caller-supplied and can be cyclic.
 *
 * **Not for a client.** An inner connection error names an internal host and
 * port; text that leaves the server goes through `safeErrorMessage` in `./pg`.
 */
export function describeError(error: unknown): string {
  return describeAt(error, 0)
}

function describeAt(error: unknown, depth: number): string {
  if (!(error instanceof Error)) return String(error)
  if (error.message) return error.message

  if (depth < MAX_DEPTH) {
    const { errors, cause } = error as { errors?: unknown; cause?: unknown }
    if (Array.isArray(errors) && errors.length > 0) {
      return errors.map((inner) => describeAt(inner, depth + 1)).join('; ')
    }
    if (cause !== undefined) return describeAt(cause, depth + 1)
  }

  const { code } = error as { code?: unknown }
  return typeof code === 'string' && code !== '' ? code : error.name
}
