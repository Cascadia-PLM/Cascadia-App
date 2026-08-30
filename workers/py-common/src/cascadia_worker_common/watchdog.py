# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Cascadia PLM LLC

"""Two-stage enforcement of a job's timeout on the Python workers.

Both workers declare a ``job_timeout`` and, until this module existed, neither
read it: a pythonocc or CadQuery call that wedged inside native code held its
``worker_concurrency`` slot forever, the row sat at 'running' where nothing
sweeps it, and the health endpoint still answered "ok" because the process was
perfectly alive — just never coming back.

The Node worker aborts a job's ``AbortSignal`` at the deadline. Python has no
equivalent: a thread cannot be killed, and a thread parked in a C extension
does not even reach the interpreter's check interval, so no cooperative
mechanism can reach it. Enforcement is therefore split into two stages, and
the second one is a blunt instrument on purpose:

**Stage 1, at the deadline** — mark the row failed through the ordinary
guarded UPDATE. That is the stage that matters: the row rejoins the normal
attempts ledger and either parks for retry or fails terminally, exactly as if
the handler had raised. It is also safe if the diagnosis was wrong, because
every mark in :mod:`cascadia_worker_common.db` is guarded to 'running' rows —
a job that turns out to be merely slow and finishes afterwards finds its own
``mark_job_completed`` no-oping against a row somebody else already settled,
which is the same race the Node worker has and resolves the same way.

**Stage 2, after a grace period** — if the job's thread is *still* alive, the
slot is not coming back on its own, so log critically and ``os._exit(1)`` and
let the container restart policy reclaim it. The grace window is the whole
reason this is two stages rather than one: killing the process at the deadline
would take down every other in-flight job on a worker whose only real problem
was one slow conversion. Rows left 'running' by the exit are collateral, and
are recovered by the stale-running reaper (``sweepStaleRunningJobs`` in
packages/core/src/lib/jobs/scheduler.ts), which is why that landed first.

Nothing here is a substitute for a correct ``JOB_TIMEOUT``. A deployment whose
STEP files legitimately take longer than the default should raise the timeout
rather than collect timed-out retries.
"""

from __future__ import annotations

import logging
import os
import threading
from typing import Callable, Optional

from . import db

logger = logging.getLogger(__name__)


class CancelHandle:
    """What :func:`start_job_watchdog` hands back — the way to call it off.

    The handle owns exactly one pending :class:`threading.Timer` at a time:
    first the deadline timer, then (once that has fired) the grace timer.
    ``cancel`` is idempotent, safe from any thread, and safe to call after the
    watchdog has already run to completion, because the caller — a ``finally``
    block on the job thread — cannot know which of those states it is in.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._cancelled = False
        self._timer: Optional[threading.Timer] = None

    @property
    def cancelled(self) -> bool:
        """Whether :meth:`cancel` has been called."""
        with self._lock:
            return self._cancelled

    def _arm(self, timer: threading.Timer) -> None:
        """Make ``timer`` the pending stage, unless already cancelled.

        Daemonised before it starts: a watchdog that outlives its job must
        never be the thread that keeps a shutting-down worker from exiting.
        """
        with self._lock:
            if self._cancelled:
                return
            self._timer = timer
            timer.daemon = True
            timer.start()

    def cancel(self) -> None:
        """Stop the watchdog. Idempotent, and callable from any thread."""
        with self._lock:
            if self._cancelled:
                return
            self._cancelled = True
            timer, self._timer = self._timer, None
        # Outside the lock: Timer.cancel only sets the timer's own event, but
        # keeping foreign lock acquisitions out of ours costs nothing.
        if timer is not None:
            timer.cancel()


def make_poison_exit(job_id: str, *, enabled: bool) -> Callable[[], None]:
    """Build the stage-2 action both workers pass to the watchdog.

    ``enabled`` is the ``EXIT_ON_HUNG_JOB`` kill switch. Turning it off keeps
    stage 1 — the job is still failed at its deadline and still retried — and
    only declines to reclaim the slot, which is the right trade for an
    operator who would rather debug a wedged container than have it restart
    under them. It is not the default, because the standing state of a worker
    that has silently lost a concurrency slot is worse than a restart.
    """

    def _poison_exit() -> None:
        if not enabled:
            logger.critical(
                "Job %s is still running after its timeout was recorded, but "
                "EXIT_ON_HUNG_JOB is off: this worker slot stays occupied "
                "until the process is restarted by hand",
                job_id,
            )
            return
        logger.critical(
            "Job %s is wedged past its timeout grace; exiting so the "
            "container restart policy reclaims the worker slot. Jobs still "
            "running in this process are left 'running' and recovered by the "
            "stale-running sweep",
            job_id,
        )
        # os._exit, not sys.exit: the interpreter is presumed stuck in native
        # code, where an exception raised on this thread would unwind nothing
        # and interpreter shutdown would join a thread that never returns.
        # Skipping atexit and buffer flushing is the point. Logging handlers
        # flush per record, so the message above is already out.
        os._exit(1)

    return _poison_exit


def start_job_watchdog(
    job_id: str,
    timeout_ms: int,
    poison_grace_ms: int,
    job_thread_alive: Callable[[], bool],
    on_poison: Callable[[], None],
) -> CancelHandle:
    """Start enforcing ``timeout_ms`` on the job that is running right now.

    Call it immediately after a successful claim — the row has to be 'running'
    for stage 1's guarded mark to bite — and cancel the returned handle in the
    job's ``finally``.

    ``job_thread_alive`` is what stage 2 asks before pulling the trigger;
    the workers pass the bound ``is_alive`` of the thread running the job.
    ``on_poison`` is the trigger itself, normally :func:`make_poison_exit`.

    Both timers run on their own :class:`threading.Timer` threads, so the
    database work in stage 1 uses a connection of that thread's own
    (``db.get_connection`` is thread-local) and closes it before returning
    rather than leaving one per timeout for the garbage collector.
    """

    handle = CancelHandle()
    reason = f"Job exceeded worker timeout ({timeout_ms}ms)"

    def _on_grace_expired() -> None:
        # Cancelled between the mark and here means the job finished on its
        # own — the ordinary outcome of a job that was merely slow.
        if handle.cancelled:
            return
        if not job_thread_alive():
            logger.info(
                "Job %s finished after its timeout was recorded; no restart "
                "needed",
                job_id,
            )
            return
        on_poison()

    def _on_deadline() -> None:
        # Armed before the database work, deliberately: the grace window
        # measures how long the job gets after its deadline, not after however
        # long the database took to answer. A stage 1 that itself blocks on a
        # sick database is exactly the case where the slot most needs
        # reclaiming.
        handle._arm(threading.Timer(poison_grace_ms / 1000.0, _on_grace_expired))

        logger.error("Job %s: %s; marking it failed", job_id, reason)
        # Each write stands alone: a failure to record the log must not cost
        # the mark, which is the half that unwedges the row.
        try:
            db.mark_job_failed(job_id, reason)
        except Exception as db_err:
            logger.error(
                "Watchdog could not mark job %s failed: %s", job_id, db_err
            )
        try:
            db.add_job_log(job_id, "error", reason)
        except Exception as db_err:
            logger.error(
                "Watchdog could not log the timeout for job %s: %s",
                job_id,
                db_err,
            )
        try:
            db.close_connection()
        except Exception as db_err:
            logger.warning(
                "Watchdog could not close its connection for job %s: %s",
                job_id,
                db_err,
            )

    handle._arm(threading.Timer(timeout_ms / 1000.0, _on_deadline))
    return handle
