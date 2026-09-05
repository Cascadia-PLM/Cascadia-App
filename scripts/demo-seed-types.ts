// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/** Shared vocabulary for the demo datasets that `seed-demo.ts` drives. */

/** What one dataset's seed did. */
export interface DatasetResult {
  /** False when the dataset was already present and nothing was written. */
  seeded: boolean
  /** One line for the summary — what landed, or why nothing did. */
  note: string
}

/**
 * The dataset is not on disk, or is only half there.
 *
 * Distinguished from an ordinary failure because it is the one error a user can
 * fix themselves, and the fix is always the same: fetch the data. `seed-demo`
 * prints these without a stack trace, and lets the other dataset carry on.
 */
export class DemoDataMissing extends Error {
  override readonly name = 'DemoDataMissing'

  /** One line each, so the caller can indent or prefix them as it likes. */
  readonly lines: Array<string>

  constructor(lines: Array<string>) {
    super(lines.join(' '))
    this.lines = lines
  }
}
