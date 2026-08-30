# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Cascadia PLM LLC

"""State transitions on the `jobs` table, against a real PostgreSQL.

Every write in db.py is guarded in SQL — `AND status = 'running'`, `AND status
IN ('pending','queued')` — and those guards are what stop two workers, or a
worker and a cancelling user, from resurrecting a settled job. A guard lives in
a string that no type checker reads, so the only way to know it is still there
is to drive a row through the transition and look at what came out.

The mirror of this file is packages/core/src/lib/jobs/JobService.test.ts. Where
the two implementations must agree, they are asserted to the same values here.
"""

from __future__ import annotations

import uuid

import pytest

from cascadia_worker_common.db import RETRY_DELAYS_MS, JobCancelled

pytestmark = pytest.mark.db

# Deliberately unlike RETRY_DELAYS_MS at every index, so a test that passes
# cannot be passing off the fallback.
ROW_SCHEDULE_MS = [45000, 90000, 300000]


def _seconds_until_retry(worker_db, job_id: str) -> float:
    """How far in the future the row's next_retry_at sits, measured server-side.

    Compared as an interval rather than an absolute timestamp: the value was
    computed from the database's NOW(), and the test process's clock is not the
    same clock.
    """
    conn = worker_db.get_connection()
    with conn.cursor() as cur:
        cur.execute(
            "SELECT EXTRACT(EPOCH FROM (next_retry_at - NOW())) FROM jobs "
            "WHERE id = %s",
            (job_id,),
        )
        row = cur.fetchone()
    assert row is not None and row[0] is not None, "next_retry_at was not set"
    return float(row[0])


def _status(worker_db, job_id: str) -> str:
    conn = worker_db.get_connection()
    with conn.cursor() as cur:
        cur.execute("SELECT status FROM jobs WHERE id = %s", (job_id,))
        row = cur.fetchone()
    assert row is not None
    return row[0]


class TestMarkJobFailed:
    def test_a_retryable_failure_parks_from_the_rows_own_schedule(
        self, worker_db, make_job
    ) -> None:
        """The invariant the retry_delays column exists to provide.

        The job type's schedule is snapshotted onto the row at submit time
        precisely because the Python workers cannot read the TypeScript
        registry. If the park used the module fallback instead, a type that
        configured a five-minute backoff would silently get thirty seconds.
        """
        job_id = make_job(status="running", attempts=2, retry_delays=ROW_SCHEDULE_MS)

        worker_db.mark_job_failed(job_id, "boom")

        assert _status(worker_db, job_id) == "pending"
        expected = ROW_SCHEDULE_MS[1] / 1000.0  # attempts=2 -> index 1
        delay = _seconds_until_retry(worker_db, job_id)
        assert expected - 10 <= delay <= expected

    @pytest.mark.parametrize("schedule", [None, []])
    def test_a_row_with_no_usable_schedule_parks_from_the_fallback(
        self, worker_db, make_job, schedule
    ) -> None:
        """NULL is a row written before the column existed; [] is a type that
        declares no delays. Neither may leave next_retry_at unset — a job with
        no next_retry_at is never swept back up, so it is lost, not retried."""
        job_id = make_job(status="running", attempts=1, retry_delays=schedule)

        worker_db.mark_job_failed(job_id, "boom")

        assert _status(worker_db, job_id) == "pending"
        expected = RETRY_DELAYS_MS[0] / 1000.0
        delay = _seconds_until_retry(worker_db, job_id)
        assert expected - 10 <= delay <= expected

    def test_the_last_attempt_settles_the_job_instead_of_parking_it(
        self, worker_db, make_job
    ) -> None:
        job_id = make_job(
            status="running", attempts=3, max_attempts=3, retry_delays=ROW_SCHEDULE_MS
        )

        worker_db.mark_job_failed(job_id, "boom")

        conn = worker_db.get_connection()
        with conn.cursor() as cur:
            cur.execute(
                "SELECT status, completed_at, next_retry_at FROM jobs WHERE id = %s",
                (job_id,),
            )
            status, completed_at, next_retry_at = cur.fetchone()
        assert status == "failed"
        assert completed_at is not None
        assert next_retry_at is None

    @pytest.mark.parametrize("terminal", ["cancelled", "completed"])
    @pytest.mark.parametrize("attempts", [1, 3])
    def test_neither_branch_moves_a_terminal_row(
        self, worker_db, make_job, read_job, terminal, attempts
    ) -> None:
        """A job cancelled while it ran is settled; the worker finding out
        afterwards must not undo that. Both attempts values are exercised
        because the retry branch and the give-up branch carry the guard
        separately, and only one of them is on any given code path."""
        job_id = make_job(
            status=terminal,
            attempts=attempts,
            max_attempts=3,
            retry_delays=ROW_SCHEDULE_MS,
        )
        before = read_job(job_id)

        worker_db.mark_job_failed(job_id, "late failure")

        assert read_job(job_id) == before


class TestMarkJobCompleted:
    def test_completes_a_running_job(self, worker_db, make_job) -> None:
        job_id = make_job(status="running")

        worker_db.mark_job_completed(job_id, {"ok": True})

        conn = worker_db.get_connection()
        with conn.cursor() as cur:
            cur.execute(
                "SELECT status, result, progress, completed_at FROM jobs "
                "WHERE id = %s",
                (job_id,),
            )
            status, result, progress, completed_at = cur.fetchone()
        assert status == "completed"
        assert result == {"ok": True}
        assert progress == 100
        assert completed_at is not None

    @pytest.mark.parametrize("terminal", ["cancelled", "failed"])
    def test_a_late_completion_does_not_overwrite_a_settled_row(
        self, worker_db, make_job, read_job, terminal
    ) -> None:
        """A job that timed out and was re-claimed elsewhere, or was cancelled,
        is settled. The straggler's success is not authoritative."""
        job_id = make_job(status=terminal)
        before = read_job(job_id)

        worker_db.mark_job_completed(job_id, {"ok": True})

        assert read_job(job_id) == before


class TestUpdateJobProgress:
    def test_progress_on_a_cancelled_job_raises_and_writes_nothing(
        self, worker_db, make_job, read_job
    ) -> None:
        """Every progress checkpoint doubles as a cancellation poll — that is
        the only thing that stops a long-running handler after the user has
        cancelled it. Matched by class, never by message."""
        job_id = make_job(status="cancelled")
        before = read_job(job_id)

        with pytest.raises(JobCancelled):
            worker_db.update_job_progress(job_id, 50, "halfway")

        assert read_job(job_id) == before

    def test_progress_on_a_running_job_is_recorded(
        self, worker_db, make_job
    ) -> None:
        job_id = make_job(status="running")

        assert worker_db.update_job_progress(job_id, 50, "halfway") == "running"

        conn = worker_db.get_connection()
        with conn.cursor() as cur:
            cur.execute(
                "SELECT progress, progress_message FROM jobs WHERE id = %s",
                (job_id,),
            )
            assert cur.fetchone() == (50, "halfway")

    def test_a_missing_job_reports_no_status_rather_than_raising(
        self, worker_db
    ) -> None:
        assert worker_db.update_job_progress(str(uuid.uuid4()), 10) is None


class TestClaimJob:
    @pytest.mark.parametrize("claimable", ["pending", "queued"])
    def test_a_claim_takes_the_row_and_counts_the_attempt(
        self, worker_db, make_job, claimable
    ) -> None:
        job_id = make_job(status=claimable, attempts=0)

        record = worker_db.claim_job(job_id)

        assert record is not None
        assert record.status == "running"
        assert record.attempts == 1
        assert _status(worker_db, job_id) == "running"

    def test_a_second_claim_of_the_same_job_refuses(
        self, worker_db, make_job, read_job
    ) -> None:
        """The whole point of claiming in one UPDATE: a broker redelivery, or
        the retry sweep republishing a job another worker already took, must
        lose here rather than run the handler twice."""
        job_id = make_job(status="pending", attempts=0)
        assert worker_db.claim_job(job_id) is not None
        after_first = read_job(job_id)

        assert worker_db.claim_job(job_id) is None
        assert read_job(job_id) == after_first

    @pytest.mark.parametrize("terminal", ["running", "completed", "cancelled"])
    def test_an_unclaimable_row_is_refused_untouched(
        self, worker_db, make_job, read_job, terminal
    ) -> None:
        job_id = make_job(status=terminal)
        before = read_job(job_id)

        assert worker_db.claim_job(job_id) is None
        assert read_job(job_id) == before

    def test_a_claimed_record_carries_the_rows_retry_schedule(
        self, worker_db, make_job
    ) -> None:
        """JobRecord.retry_delays must mean the same thing however the record
        was obtained. It did not: claim_job's RETURNING omitted the column, so
        a claimed record reported None and any caller deriving a backoff from
        it would have used the fallback schedule for every job type."""
        job_id = make_job(status="pending", attempts=0, retry_delays=ROW_SCHEDULE_MS)

        claimed = worker_db.claim_job(job_id)
        fetched = worker_db.get_job(job_id)

        assert claimed is not None and fetched is not None
        assert claimed.retry_delays == ROW_SCHEDULE_MS
        assert claimed.retry_delays == fetched.retry_delays

    def test_a_claimed_record_with_no_schedule_reports_none(
        self, worker_db, make_job
    ) -> None:
        """The pre-migration row still reads as absent, not as an empty list —
        `_retry_delay_seconds` treats both alike, but JobRecord should not
        invent data the row does not have."""
        job_id = make_job(status="pending", attempts=0, retry_delays=None)

        claimed = worker_db.claim_job(job_id)

        assert claimed is not None
        assert claimed.retry_delays is None

    def test_a_missing_job_is_not_claimable(self, worker_db) -> None:
        assert worker_db.claim_job(str(uuid.uuid4())) is None


class TestAddJobLog:
    def test_a_log_line_is_attached_to_its_job(self, worker_db, make_job) -> None:
        job_id = make_job(status="running")

        worker_db.add_job_log(job_id, "info", "hello", {"k": "v"})

        conn = worker_db.get_connection()
        with conn.cursor() as cur:
            cur.execute(
                "SELECT level, message, data FROM job_logs WHERE job_id = %s",
                (job_id,),
            )
            assert cur.fetchall() == [("info", "hello", {"k": "v"})]
