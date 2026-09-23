# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Cascadia PLM LLC

"""The two stages of :mod:`cascadia_worker_common.watchdog`, and their seam.

Stage 1 is ordinary bookkeeping — a guarded UPDATE that returns a timed-out
row to the retry ledger. Stage 2 kills the process. The interesting property
is not either stage on its own but the window between them: the whole reason
the grace period exists is that a job which was merely slow must be allowed to
finish, and only a job that is genuinely wedged may cost the process. Every
test below pins one side of that decision.

No database and no real timers longer than a few tens of milliseconds: the
deadlines here are arguments, so the arithmetic can be exercised at
millisecond scale. The database layer is monkeypatched because stage 1's
correctness against the real schema is `test_jobs_db.py`'s job, not this
file's.
"""

from __future__ import annotations

import threading
import time
from typing import Callable, Optional

import pytest

from cascadia_worker_common import db, watchdog

JOB_ID = "66666666-6666-4666-8666-666666666666"

# Deadlines for the fake job. Small enough that the suite stays fast, large
# enough that a loaded CI runner's scheduler jitter cannot reorder the stages.
TIMEOUT_MS = 40
GRACE_MS = 40

# How long to wait for something that must happen. Generous on purpose: an
# over-tight wait here would be a flake, and the tests that assert absence use
# QUIET instead.
WAIT_S = 5.0

# A deliberately roomy grace, for the two tests that have to do something in
# the window between the stages. With GRACE_MS a scheduler stall on a loaded
# runner could let stage 2 overtake stage 1, and the test would fail for a
# reason that has nothing to do with what it asserts.
SLOW_GRACE_MS = 400

# How long to wait before concluding that something will NOT happen —
# comfortably past whichever pair of deadlines the test used.
QUIET_S = 1.0


class Recorder:
    """Stands in for the database layer and for the poison-exit trigger."""

    def __init__(self) -> None:
        self.marks: list[tuple[str, str]] = []
        self.logs: list[tuple[str, str, str]] = []
        self.closes = 0
        self.poisons = 0
        # Set by close_connection, which stage 1 always reaches — including
        # when the marks above raised — so it is the reliable "stage 1 is
        # over" signal.
        self.stage_one_done = threading.Event()
        self.poisoned = threading.Event()

    def mark_job_failed(self, job_id: str, error_message: str) -> None:
        self.marks.append((job_id, error_message))

    def add_job_log(
        self,
        job_id: str,
        level: str,
        message: str,
        data: Optional[dict] = None,
    ) -> None:
        self.logs.append((job_id, level, message))

    def close_connection(self) -> None:
        self.closes += 1
        self.stage_one_done.set()

    def poison(self) -> None:
        self.poisons += 1
        self.poisoned.set()

    def finished_after_the_mark(self) -> bool:
        """A ``job_thread_alive`` that reports the job gone once stage 1 ran.

        This is the "merely slow" job, expressed without a sleep race: by the
        time the grace timer asks, the answer is deterministically False.
        """
        return not self.stage_one_done.is_set()


@pytest.fixture
def rec(monkeypatch: pytest.MonkeyPatch) -> Recorder:
    """Wire a Recorder into the module's database calls."""
    recorder = Recorder()
    monkeypatch.setattr(db, "mark_job_failed", recorder.mark_job_failed)
    monkeypatch.setattr(db, "add_job_log", recorder.add_job_log)
    monkeypatch.setattr(db, "close_connection", recorder.close_connection)
    return recorder


def _start(
    rec: Recorder,
    alive: Callable[[], bool],
    *,
    timeout_ms: int = TIMEOUT_MS,
    grace_ms: int = GRACE_MS,
) -> watchdog.CancelHandle:
    return watchdog.start_job_watchdog(
        job_id=JOB_ID,
        timeout_ms=timeout_ms,
        poison_grace_ms=grace_ms,
        job_thread_alive=alive,
        on_poison=rec.poison,
    )


def test_the_deadline_marks_the_job_failed(rec: Recorder) -> None:
    """Stage 1 is the half that matters: the row rejoins the retry ledger.

    Until this existed, `job_timeout` was a setting no code read — a hung
    conversion held its concurrency slot forever and its row sat at 'running'
    where no sweep or admin retry could reach it.
    """
    handle = _start(rec, lambda: False)
    try:
        assert rec.stage_one_done.wait(WAIT_S), "stage 1 never ran"
    finally:
        handle.cancel()

    assert [job_id for job_id, _ in rec.marks] == [JOB_ID]
    # The recorded reason has to name the deadline it broke — it is the only
    # explanation an operator reading the job ever gets.
    assert str(TIMEOUT_MS) in rec.marks[0][1]
    assert [(job_id, level) for job_id, level, _ in rec.logs] == [
        (JOB_ID, "error")
    ]
    # The stage runs on a Timer thread of its own, and db.get_connection is
    # thread-local — so a stage that did not close would leak one connection
    # per timeout for the garbage collector to find.
    assert rec.closes == 1


def test_a_job_that_finishes_before_its_deadline_leaves_no_trace(
    rec: Recorder,
) -> None:
    """The overwhelmingly common case: cancel, and the watchdog never fires."""
    handle = _start(rec, lambda: True)
    handle.cancel()

    time.sleep(QUIET_S)

    assert rec.marks == []
    assert rec.logs == []
    assert rec.poisons == 0


def test_a_thread_that_survives_the_grace_is_poisoned(rec: Recorder) -> None:
    """Still running a grace period after being failed means wedged.

    The slot is not coming back on its own, so the process is given up. Note
    the order: the mark has already happened, which is what makes the exit
    survivable — the row is settled before the process dies.
    """
    handle = _start(rec, lambda: True)
    try:
        assert rec.poisoned.wait(WAIT_S), "the poison exit never fired"
        assert rec.stage_one_done.wait(WAIT_S), "stage 1 never ran"
    finally:
        handle.cancel()

    assert rec.poisons == 1
    assert [job_id for job_id, _ in rec.marks] == [JOB_ID]


def test_a_job_that_finishes_between_the_mark_and_the_grace_is_not_poisoned(
    rec: Recorder,
) -> None:
    """The grace window's entire reason for existing.

    A job that was merely slow — it overran its deadline and then finished —
    must cost only its own row, never the other jobs in flight on the same
    process. Killing the worker at the deadline instead of after the grace
    would take those down too.
    """
    handle = _start(rec, rec.finished_after_the_mark, grace_ms=SLOW_GRACE_MS)
    try:
        assert rec.stage_one_done.wait(WAIT_S), "stage 1 never ran"
        time.sleep(QUIET_S)
    finally:
        handle.cancel()

    assert rec.poisons == 0
    # …and stage 1 genuinely did happen, so this is the seam being tested and
    # not a watchdog that failed to start.
    assert [job_id for job_id, _ in rec.marks] == [JOB_ID]


def test_cancelling_after_the_mark_also_prevents_the_exit(
    rec: Recorder,
) -> None:
    """The worker's own path: `_run_job`'s `finally` cancels unconditionally.

    It cannot know whether the deadline already passed, so a cancel arriving
    after stage 1 has to be as final as one arriving before it — even while
    the job's thread is still alive, which it is at that moment.
    """
    handle = _start(rec, lambda: True, grace_ms=SLOW_GRACE_MS)
    assert rec.stage_one_done.wait(WAIT_S), "stage 1 never ran"
    handle.cancel()

    time.sleep(QUIET_S)

    assert rec.poisons == 0


def test_a_database_failure_at_the_deadline_still_reaches_the_poison_stage(
    rec: Recorder, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The grace is measured from the deadline, not from the database.

    A worker whose database has gone away is precisely when a wedged slot is
    least affordable, so stage 2 is armed before stage 1 does any I/O. Were it
    armed afterwards, a mark that blocked would disable the restart as well.
    """

    def _explode(*args: object, **kwargs: object) -> None:
        raise RuntimeError("connection to the database failed")

    monkeypatch.setattr(db, "mark_job_failed", _explode)
    monkeypatch.setattr(db, "add_job_log", _explode)

    handle = _start(rec, lambda: True)
    try:
        assert rec.poisoned.wait(WAIT_S), "the poison exit never fired"
    finally:
        handle.cancel()

    assert rec.marks == []
    assert rec.poisons == 1


def test_cancel_is_idempotent_and_safe_once_the_watchdog_has_run(
    rec: Recorder,
) -> None:
    """`_run_job` cancels in a `finally`, blind to which state it is in."""
    handle = _start(rec, lambda: False)
    assert rec.stage_one_done.wait(WAIT_S), "stage 1 never ran"

    handle.cancel()
    handle.cancel()

    assert handle.cancelled


def test_the_poison_action_exits_the_process(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Exit code 1, so a container restart policy treats it as a crash."""
    codes: list[int] = []
    monkeypatch.setattr(watchdog.os, "_exit", lambda code: codes.append(code))

    watchdog.make_poison_exit(JOB_ID, enabled=True)()

    assert codes == [1]


def test_the_kill_switch_suppresses_only_the_exit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """EXIT_ON_HUNG_JOB=false keeps stage 1 and declines the restart.

    Stage 1 is unconditional — it happens before this callable is reached at
    all — so an operator who turns the switch off still gets timed-out jobs
    failed and retried; they just keep the wedged container to look at.
    """
    codes: list[int] = []
    monkeypatch.setattr(watchdog.os, "_exit", lambda code: codes.append(code))

    watchdog.make_poison_exit(JOB_ID, enabled=False)()

    assert codes == []
