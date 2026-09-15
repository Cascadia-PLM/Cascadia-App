// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { z } from 'zod'

/**
 * A nullable date column as it actually arrives over the wire, where "no date"
 * has three spellings and only one of them is `undefined`.
 *
 * `z.coerce.date()` handles exactly one of the three. It hands its input
 * straight to `new Date()`, and the two spellings a browser produces both
 * survive that call without throwing — which is the whole problem:
 *
 * - `''`, what an emptied `<input type="date">` reads back as, becomes
 *   `new Date('')` — an Invalid Date. Zod rejects it as
 *   `Invalid input: expected date, received Date`, a message that names
 *   neither the value nor anything a reader can act on. `PUT /programs/:id`
 *   400'd on every save of a program with no dates set for exactly this
 *   reason, because the edit form sent `startDate: editProgram.startDate || ''`.
 * - `null`, how a cleared date is spelled in JSON, becomes `new Date(null)` —
 *   the Unix epoch. `.optional()` guards `undefined`, not `null`, so this one
 *   does not even fail: clearing a date silently stamped it 1970-01-01.
 *
 * Both spellings mean the same thing, so both normalize to `null`, which is
 * what the nullable timestamp columns already use for "unset". `undefined` is
 * passed through untouched and keeps its partial-update meaning of "leave this
 * field alone" — the distinction is load-bearing, because one clears the
 * column and the other must not write to it at all.
 *
 * Optionality is left to the call site (`clearableDate().optional()`) so that
 * "may be omitted" and "may be cleared" stay visibly separate decisions.
 */
export function clearableDate() {
  return z.preprocess(
    (value) => (value === '' ? null : value),
    z.coerce.date({ error: 'Invalid date' }).nullable(),
  )
}
