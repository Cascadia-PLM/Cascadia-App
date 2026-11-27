// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * FreeCAD Script Execution
 *
 * Submits a `generation.cad.freecad` job to the FreeCAD worker
 * (`cascadia-workers-freecad-runner/`) and waits for its report. One round trip is one
 * script attempt: the agent calls this once per attempt while it iterates,
 * and once more with `persist: true` for the script it accepts.
 *
 * Two kinds of failure are kept apart on purpose. A script that fails
 * resolves normally, with `ok: false` — the report is what the model
 * iterates on. Only the pipeline failing to run the script at all rejects:
 * the job row failing (the worker died under it twice), no worker answering
 * inside the wait budget, or the caller aborting. Callers stop iterating on
 * those, because no revision of the script can fix them.
 */

import type { FreecadScriptResult } from '@/jobs/definitions/freecad-script/types'
import { freecadScriptResultSchema } from '@/jobs/definitions/freecad-script/types'
import { ExternalServiceError } from '@/errors'

export interface ExecuteFreecadScriptOptions {
  script: string
  partName: string
  userId: string
  /** Store the STEP in the vault (needs `itemId`). False while iterating. */
  persist: boolean
  itemId?: string
  branchId?: string
  partTempId?: string
  /** The script's own wall-clock budget; the worker clamps it. */
  timeoutMs?: number
  /**
   * How long to wait for the job overall. Defaults to the script budget plus
   * `EXECUTION_OVERHEAD_MS`; the admin smoke test passes something shorter.
   */
  maxWaitMs?: number
  pollIntervalMs?: number
  signal?: AbortSignal
}

/** The service name every error from this module carries. */
export const FREECAD_WORKER_SERVICE = 'FreeCAD worker'

export const DEFAULT_SCRIPT_TIMEOUT_MS = 120_000

/**
 * Queueing, FreeCAD's own start-up (importing the kernel takes seconds) and
 * the vault write, on top of the script's budget. Generous, because the
 * alternative is giving up on a job that is about to finish.
 */
export const EXECUTION_OVERHEAD_MS = 90_000

/**
 * Run one script in the FreeCAD worker and return its report.
 */
export async function executeFreecadScript(
  options: ExecuteFreecadScriptOptions,
): Promise<FreecadScriptResult> {
  // Dynamic import keeps the DB out of the client bundle.
  const { JobService } = await import('@/jobs/JobService')

  const timeoutMs = options.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS
  const job = await JobService.submit(
    'generation.cad.freecad',
    {
      script: options.script,
      partName: options.partName,
      userId: options.userId,
      persist: options.persist,
      itemId: options.itemId,
      branchId: options.branchId,
      partTempId: options.partTempId,
      timeoutMs,
    },
    options.userId,
    options.persist && options.itemId
      ? { priority: 'high', itemId: options.itemId }
      : { priority: 'high' },
  )

  const maxWaitMs = options.maxWaitMs ?? timeoutMs + EXECUTION_OVERHEAD_MS
  const pollIntervalMs = options.pollIntervalMs ?? 1_000
  const startedAt = Date.now()

  while (Date.now() - startedAt < maxWaitMs) {
    if (options.signal?.aborted) {
      // Best effort: a queued job is withdrawn, a running one is told to stop
      // at its next progress checkpoint. Either way nobody is waiting for it.
      await JobService.cancel(job.id).catch(() => undefined)
      throw new Error('FreeCAD script execution cancelled')
    }

    const current = await JobService.get(job.id)
    if (!current) {
      throw new ExternalServiceError(
        FREECAD_WORKER_SERVICE,
        'the job record disappeared while waiting for it',
        { jobId: job.id },
      )
    }

    if (current.status === 'completed') {
      const parsed = freecadScriptResultSchema.safeParse(current.result)
      if (!parsed.success) {
        throw new ExternalServiceError(
          FREECAD_WORKER_SERVICE,
          'returned a malformed report',
          { jobId: job.id },
        )
      }
      return parsed.data
    }

    if (current.status === 'failed') {
      throw new ExternalServiceError(
        FREECAD_WORKER_SERVICE,
        current.error ?? 'the script job failed',
        { jobId: job.id },
      )
    }

    if (current.status === 'cancelled') {
      throw new Error('FreeCAD script job was cancelled')
    }

    await sleep(pollIntervalMs, options.signal)
  }

  // Leave nothing behind for a worker that comes up later to run.
  await JobService.cancel(job.id).catch(() => undefined)
  throw new ExternalServiceError(
    FREECAD_WORKER_SERVICE,
    `no result within ${Math.round(maxWaitMs / 1000)}s. If the job never left the queue, no FreeCAD worker (cascadia-workers-freecad-runner) is consuming jobs.generation.cad.freecad.`,
    { jobId: job.id, timeoutMs: maxWaitMs },
  )
}

/**
 * Abortable sleep. Resolves after `ms`, rejects promptly on abort — and
 * removes its abort listener either way, so a long poll loop does not
 * accumulate one listener per tick on a long-lived signal.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      cleanup()
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new Error('FreeCAD script execution cancelled'),
      )
    }
    const cleanup = () => signal?.removeEventListener('abort', onAbort)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
