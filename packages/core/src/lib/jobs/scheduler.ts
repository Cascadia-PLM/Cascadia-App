// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * DB-backed retry scheduler.
 *
 * `markFailed` parks a retryable job as 'pending' with a `nextRetryAt` — and
 * until this sweep existed, nothing re-published it. `getJobsForRetry` and
 * `requeueForRetry` implemented exactly the missing half and were dead for
 * want of a caller; every jobs worker now runs this sweep on an interval,
 * re-publishing whatever is due. The same sweep recovers submit-crash
 * orphans and 'queued' rows whose message was consumed without a claim (see
 * `getJobsForRetry` for all three shapes).
 *
 * Concurrency is deliberately unguarded: N worker processes sweeping at once
 * can re-publish the same job N times, and that is fine — the atomic claim
 * (`JobService.claimJob`) refuses every delivery but the first, which is a
 * cheaper and more honest dedupe than advisory locks around the sweep.
 *
 * The same loop carries the stale-running sweep, which is the other half of
 * durability: nothing but the worker executing a job ever moves it off
 * 'running', so a worker that dies mid-execution wedges its row there
 * forever. See `sweepStaleRunningJobs`.
 *
 * One operational consequence worth knowing: Python-executed job types (CAD
 * conversion and generation) park their retries in the same table, so their
 * re-publishing also happens here, in the Node worker. If a deployment runs
 * Python workers with no Node jobs worker, parked CAD retries stall — the
 * same availability assumption RabbitMQ dispatch already makes of the
 * process that publishes.
 */

import { JobService } from './JobService'
import { JobTypeRegistry } from './registry'
import type { JobTypeConfig } from './types'
import { workerLogger } from '@/lib/logging/logger'

export interface RetrySchedulerHandle {
  stop: () => void
}

/**
 * Job types this process has already reported as unregistered, so a foreign
 * row is skipped quietly on every tick after the first.
 *
 * Shared deliberately by every sweep that has to make the
 * skip-unregistered decision — see {@link registeredTypeForSweep}.
 */
const unregisteredTypesWarned = new Set<string>()

/**
 * The registered config a sweep needs to reason about `job`, or `undefined`
 * when this process has no definition for the job's type.
 *
 * Not knowing a type is a legitimate steady state rather than an error: a
 * community jobs worker may sweep a database that also carries enterprise
 * rows, and an upgrade can drop a type while rows of it are still in
 * flight. `undefined` therefore means "leave this row exactly as it is" —
 * whichever worker fleet does own the type is the one that can judge it.
 * The warning fires once per type per process; these sweeps run every few
 * seconds and a foreign row is permanent, so logging per tick would be a
 * log line every tick forever.
 */
function registeredTypeForSweep(
  job: { id: string; type: string },
  sweep: string,
): JobTypeConfig | undefined {
  const config = JobTypeRegistry.getType(job.type)
  if (config) return config
  if (!unregisteredTypesWarned.has(job.type)) {
    unregisteredTypesWarned.add(job.type)
    workerLogger.warn(
      { type: job.type, jobId: job.id, sweep },
      'Job type is not registered in this process; leaving its rows to whichever worker fleet owns the type',
    )
  }
  return undefined
}

/**
 * One maintenance job type the sweep keeps alive.
 *
 * Core declares its own as bare entries in {@link BASE_MAINTENANCE_JOBS}; a
 * module contributes one through {@link registerMaintenanceJobType}. The two
 * optional callbacks are exactly what a contribution needs and core cannot
 * supply on its behalf: `enabled` lets an entry answer to a licence and a
 * credential only its own package can see, and `periodMs` lets it carry a
 * cadence of its own rather than the shared one.
 *
 * Both are read on every sweep, never captured at registration, so an entry
 * reflects the environment the worker is actually running with.
 */
export interface MaintenanceJobEntry {
  /** The registered job type to submit, e.g. `maintenance.session.cleanup`. */
  type: string
  /**
   * Whether this entry should be submitted at all. Absent means always — the
   * shape core's own types have, since nothing gates them.
   */
  enabled?: () => boolean
  /**
   * How long a gap between runs this type wants, overriding the shared
   * `JOB_MAINTENANCE_PERIOD_MS` period. A non-positive (or unparseable) value
   * is the documented opt-out: the entry is skipped entirely rather than
   * submitted on every tick, which is what a zero window would otherwise mean.
   */
  periodMs?: () => number
}

/**
 * Maintenance job types core itself keeps alive. Both configs said
 * "recommended to run daily via a scheduler" while no scheduler existed —
 * these jobs had zero submit sites anywhere in the codebase (JOBS-4).
 */
const BASE_MAINTENANCE_JOBS: ReadonlyArray<MaintenanceJobEntry> = [
  { type: 'maintenance.session.cleanup' },
  { type: 'maintenance.cache.cleanup' },
]

/** Entries contributed by modules, in registration order. */
const contributedMaintenanceJobs: Array<MaintenanceJobEntry> = []

/**
 * Contribute a maintenance job type. Called from a composition root at boot,
 * before the worker starts its scheduler.
 *
 * This registry exists because the list above was a hardcoded `const` and a
 * `const` in core can only ever name core's own job types. A proprietary type
 * — advanced auditing's chain anchoring is the first — had no way in, so it
 * shipped with a sweep built for exactly its problem and no way to reach it.
 *
 * A duplicate type throws rather than being ignored, mirroring
 * `registerTool`: two entries for one type would mean two cadences competing
 * over the same recency guard, and whichever ran first would silently decide.
 */
export function registerMaintenanceJobType(entry: MaintenanceJobEntry): void {
  const clash = maintenanceJobEntries().find((e) => e.type === entry.type)
  if (clash) {
    throw new Error(
      `Maintenance job type "${entry.type}" is already registered`,
    )
  }
  contributedMaintenanceJobs.push(entry)
}

/** Core's entries followed by every contributed one. */
export function maintenanceJobEntries(): ReadonlyArray<MaintenanceJobEntry> {
  return [...BASE_MAINTENANCE_JOBS, ...contributedMaintenanceJobs]
}

/** Drop contributed entries, keeping core's. Tests only. */
export function clearContributedMaintenanceJobTypes(): void {
  contributedMaintenanceJobs.length = 0
}

/**
 * How often a maintenance job should run when its entry does not say (env
 * `JOB_MAINTENANCE_PERIOD_MS`, default 24h — core's configs describe a daily
 * cadence).
 */
function maintenancePeriodMs(): number {
  return Number(process.env.JOB_MAINTENANCE_PERIOD_MS ?? 24 * 60 * 60 * 1000)
}

/**
 * One maintenance sweep: submit each maintenance job whose type has no
 * active (pending/queued/running) row and none created within its period.
 * Submitted with `userId: null` — the system path; no user is involved.
 *
 * `basePeriodMs` is the window for entries that do not carry their own; the
 * cutoff is therefore computed per entry inside the loop rather than once for
 * the sweep, since a contributed entry may want a very different cadence from
 * core's daily cleanups.
 *
 * Deliberately unguarded against concurrent sweepers, like the retry sweep:
 * N workers checking at once can each submit one, and that is harmless —
 * core's handlers are idempotent deletions, a contributed entry is expected to
 * tolerate the same duplicate, and the window closes the moment the first row
 * lands.
 *
 * A throwing `enabled()` or `periodMs()` is caught with everything else: a
 * module callback must not be able to stop the other maintenance types from
 * being submitted.
 */
export async function sweepMaintenanceJobs(
  basePeriodMs = maintenancePeriodMs(),
): Promise<number> {
  let submitted = 0
  for (const entry of maintenanceJobEntries()) {
    const type = entry.type
    try {
      if (!(entry.enabled?.() ?? true)) continue
      const periodMs = entry.periodMs?.() ?? basePeriodMs
      // Non-positive covers the opt-out; `!(x > 0)` also covers the NaN a
      // mistyped environment variable produces, which would otherwise reach
      // the query as an invalid Date.
      if (!(periodMs > 0)) continue
      const since = new Date(Date.now() - periodMs)
      if (await JobService.hasActiveOrRecentJob(type, since)) continue
      await JobService.submit(type, {}, null)
      submitted++
      workerLogger.info({ type }, 'Maintenance sweep submitted job')
    } catch (error) {
      workerLogger.warn(
        { type, err: error },
        'Maintenance sweep could not submit job; next tick retries',
      )
    }
  }
  return submitted
}

/**
 * One sweep: re-publish every row `getJobsForRetry` says is due — a parked
 * retry, a submit-crash orphan, or a 'queued' row whose message never
 * produced a claim — returning how many were requeued. A publish failure
 * (broker down, mid-restart) is caught per job: the row keeps the status it
 * had and the next tick retries it; one unreachable broker must not turn a
 * sweep into a crash.
 */
export async function sweepRetryableJobs(): Promise<number> {
  const due = await JobService.getJobsForRetry()
  let requeued = 0
  for (const job of due) {
    try {
      await JobService.requeueForRetry(job.id)
      requeued++
    } catch (error) {
      workerLogger.warn(
        { jobId: job.id, type: job.type, err: error },
        'Retry sweep could not requeue job; leaving it for the next tick',
      )
    }
  }
  if (requeued > 0) {
    workerLogger.info({ requeued }, 'Retry sweep re-published due jobs')
  }
  return requeued
}

/**
 * How far past a job type's own `timeout` a 'running' row may sit before the
 * stale sweep concludes its worker is gone (env
 * `JOB_STALE_RUNNING_GRACE_MS`, default 5 minutes).
 *
 * It is added to the type's timeout, never used instead of it: the timeout
 * is how long the work may legitimately take, the grace is the slack for
 * everything around it — clock skew between the worker and the sweeper, a
 * handler unwinding after its abort, a Python worker that does not enforce
 * its timeout at all yet.
 */
function staleRunningGraceMs(): number {
  return Number(process.env.JOB_STALE_RUNNING_GRACE_MS ?? 5 * 60 * 1000)
}

/**
 * The reason recorded on a reaped row, in both `jobs.error` and the job's
 * log. It is what an operator sees on a job whose worker never came back.
 */
const STALE_RUNNING_REASON =
  'Stale running job: worker lost or exceeded its timeout'

/**
 * One stale-running sweep: fail every 'running' row whose execution is past
 * `type timeout + grace`, returning how many were reaped.
 *
 * A row leaves 'running' only because its worker marks it, so a worker that
 * dies mid-execution strands the row: the claim refuses redelivery, the
 * retry sweep never looks at 'running' rows, and admin retry requires
 * 'failed'. `started_at` plus the type's registered timeout is the lease
 * this expires — no schema change and no heartbeat column, because the
 * claim already stamps `started_at` and the registry already declares how
 * long the type may run.
 *
 * The reap is `JobService.markFailed`, deliberately, not a bespoke UPDATE:
 * it is guarded to 'running' rows (so a worker that was merely slow and
 * finishes during the sweep still wins the race and its result stands) and
 * it already implements the park-for-retry-vs-fail-terminally decision on
 * the attempts ledger. A reaped job with attempts left re-enters the
 * existing park → sweep → re-publish → claim pipeline like any other
 * failure.
 *
 * Rows whose type this process does not know are left alone; see
 * {@link registeredTypeForSweep}.
 */
export async function sweepStaleRunningJobs(
  graceMs = staleRunningGraceMs(),
): Promise<number> {
  const now = Date.now()
  // Prefilter: no row can be past `timeout + grace` without also being past
  // `grace`, so this is sound for every type however short its timeout, and
  // the per-type deadline below does the real deciding.
  const candidates = await JobService.getRunningJobsOlderThan(
    new Date(now - graceMs),
  )
  let reaped = 0
  for (const job of candidates) {
    const config = registeredTypeForSweep(job, 'stale-running')
    if (!config) continue
    // The query filters on started_at, so a null cannot come back here —
    // this narrows the column's nullable type, it is not a real case.
    if (!job.startedAt) continue
    if (job.startedAt.getTime() + config.timeout + graceMs > now) continue

    try {
      await JobService.markFailed(job.id, STALE_RUNNING_REASON)
      reaped++
      // Best-effort explanation for whoever reads the job later. Written
      // after the guarded mark, and true either way: the row *was* running
      // past its lease when the sweep looked at it, even in the rare case
      // where the worker beat the mark by a hair.
      await JobService.addLog(job.id, 'warn', STALE_RUNNING_REASON, {
        sweep: 'stale-running',
        startedAt: job.startedAt.toISOString(),
        timeoutMs: config.timeout,
        graceMs,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
      })
    } catch (error) {
      workerLogger.warn(
        { jobId: job.id, type: job.type, err: error },
        'Stale-running sweep could not reap job; leaving it for the next tick',
      )
    }
  }
  if (reaped > 0) {
    workerLogger.warn(
      { reaped },
      'Stale-running sweep failed jobs whose workers were lost',
    )
  }
  return reaped
}

/**
 * Run the sweep every `intervalMs` (env `JOB_RETRY_SWEEP_MS`, default 15s)
 * until stopped. A tick that is still running when the next fires is not
 * stacked — the interval skips instead. The timer is unref'd so it never
 * keeps a shutting-down process alive.
 *
 * The same loop carries two slower cadences, each with its own last-checked
 * stamp:
 *
 *  - The maintenance check (env `JOB_MAINTENANCE_SWEEP_MS`, default 10
 *    minutes): each due tick submits whichever maintenance jobs have not run
 *    within their period.
 *  - The stale-running sweep (env `JOB_STALE_SWEEP_MS`, default 1 minute):
 *    each due tick reaps 'running' rows past their lease. It is far cheaper
 *    than the retry sweep's cadence would make it and nothing is urgent
 *    about it — the rows it finds have already been stranded for minutes.
 *
 * Both run on the first tick, so a fresh deployment gets its cleanup jobs
 * and recovers whatever the last deployment stranded without waiting out a
 * period.
 */
export function startRetryScheduler(
  intervalMs = Number(process.env.JOB_RETRY_SWEEP_MS ?? 15_000),
  maintenanceCheckMs = Number(
    process.env.JOB_MAINTENANCE_SWEEP_MS ?? 10 * 60 * 1000,
  ),
  staleCheckMs = Number(process.env.JOB_STALE_SWEEP_MS ?? 60_000),
): RetrySchedulerHandle {
  let sweeping = false
  let lastMaintenanceCheck = 0
  let lastStaleCheck = 0
  const timer = setInterval(() => {
    if (sweeping) return
    sweeping = true
    const runMaintenance =
      Date.now() - lastMaintenanceCheck >= maintenanceCheckMs
    if (runMaintenance) lastMaintenanceCheck = Date.now()
    const runStale = Date.now() - lastStaleCheck >= staleCheckMs
    if (runStale) lastStaleCheck = Date.now()
    void sweepRetryableJobs()
      .then(() => (runStale ? sweepStaleRunningJobs() : 0))
      .then(() => (runMaintenance ? sweepMaintenanceJobs() : 0))
      .catch((error: unknown) => {
        workerLogger.error({ err: error }, 'Retry sweep failed')
      })
      .finally(() => {
        sweeping = false
      })
  }, intervalMs)
  timer.unref()

  workerLogger.info(
    { intervalMs, maintenanceCheckMs, staleCheckMs },
    'Retry scheduler started',
  )
  return {
    stop: () => {
      clearInterval(timer)
    },
  }
}
