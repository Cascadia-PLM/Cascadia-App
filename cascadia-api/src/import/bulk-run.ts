// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * What a bulk creation run is told by whoever runs it.
 *
 * The services that take these (`ImportService`, `BatchCreateService`) know
 * nothing about jobs: the jobs worker passes its job context's signal and a
 * progress reporter, and a test passes nothing. Keeping the job plumbing out
 * of the services is what lets their tests run without a broker.
 */
export interface BulkRunOptions {
  /**
   * Called after every row and relationship. Cheap to call: the caller is the
   * one that decides how often a report is worth a write.
   */
  onProgress?: (progress: BulkProgress) => Promise<void>
  /**
   * Checked before every row. A run that finds it aborted stops at once and
   * throws, leaving the rows it already wrote in place.
   */
  signal?: AbortSignal
}

export interface BulkProgress {
  /** Units of work finished: rows, then relationships. */
  done: number
  /** Units of work in the run, fixed when it starts. */
  total: number
  /** A sentence for the person watching, e.g. "Processed 1,200 of 4,000 rows". */
  message: string
}

/**
 * Stop the run if its signal has been aborted.
 *
 * Throws the abort's own reason when it is an Error — the worker aborts with
 * "Job timed out after …" or "Job was cancelled", which is the sentence the
 * job's log should carry.
 */
export function throwIfStopped(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  const reason: unknown = signal.reason
  throw reason instanceof Error ? reason : new Error('Bulk creation stopped')
}

/** `1234` → `"1,234"`, for progress messages a person reads. */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US')
}
