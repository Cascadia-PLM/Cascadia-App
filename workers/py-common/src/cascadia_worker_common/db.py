# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Cascadia PLM LLC

"""PostgreSQL operations — reads/updates jobs and vault_files tables.

The single copy of the workers' database layer (JOBS-8). A worker calls
:func:`configure` with its own settings once at import, then uses the
functions directly (or through its thin ``db.py`` shim, which preserves the
historical per-worker defaults).
"""

from __future__ import annotations

import hashlib
import logging
import threading
import uuid
from typing import Optional

import psycopg
import psycopg.types.json

from .models import JobRecord, VaultFileRecord

logger = logging.getLogger(__name__)

# Fallback backoff for a job row that carries no schedule of its own, in
# **milliseconds** — the same unit the jobs.retry_delays column and the TS
# JobTypeConfig use, so this file has exactly one unit convention and the
# conversion to seconds happens once, at the make_interval() call site.
#
# The real schedule is the type's JobTypeConfig, snapshotted onto
# jobs.retry_delays when JobService.submit inserts the row (JOBS2-10). This
# constant only covers rows submitted before that column existed, and rows
# whose type declares an empty schedule.
RETRY_DELAYS_MS = [30000, 60000, 120000]

# Per-thread connections: psycopg connections are not safe for concurrent
# use, and job execution runs on worker threads (see worker._process_message).
# With the default worker_concurrency=1 this is exactly one connection beyond
# the main thread's.
_local = threading.local()

_database_url: Optional[str] = None


class JobCancelled(Exception):
    """The job's row reached 'cancelled' in another process.

    Raised by :func:`update_job_progress` so every progress checkpoint
    doubles as a cancellation poll — ``_run_job`` catches it, skips
    ``mark_job_failed`` (the row is already terminal; the status guards on
    the mark functions protect it regardless), and acks the delivery.
    """


def configure(database_url: str) -> None:
    """Point this module at a database. Each worker calls it once at import
    with its own settings; reconfiguring drops no existing connections (they
    are per-thread and re-open lazily against the new URL only after being
    closed)."""
    global _database_url
    _database_url = database_url


def get_connection() -> psycopg.Connection:
    """Get or create this thread's PostgreSQL connection."""
    if _database_url is None:
        raise RuntimeError(
            "cascadia_worker_common.db is not configured — call "
            "configure(database_url) before any database operation."
        )
    conn: Optional[psycopg.Connection] = getattr(_local, "conn", None)
    if conn is None or conn.closed:
        conn = psycopg.connect(_database_url, autocommit=True)
        _local.conn = conn
        logger.info(
            "Connected to PostgreSQL (thread %s)",
            threading.current_thread().name,
        )
    return conn


def close_connection() -> None:
    """Close this thread's PostgreSQL connection. Worker threads are daemons
    whose sockets the OS reclaims at exit; this closes the caller's own."""
    conn: Optional[psycopg.Connection] = getattr(_local, "conn", None)
    if conn is not None and not conn.closed:
        conn.close()
        logger.info("PostgreSQL connection closed")
    _local.conn = None


def get_job(job_id: str) -> Optional[JobRecord]:
    """Fetch a job record by ID."""
    conn = get_connection()
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, type, status, payload, attempts, max_attempts, "
            "retry_delays FROM jobs WHERE id = %s",
            (job_id,),
        )
        row = cur.fetchone()
        if not row:
            return None
        return JobRecord(
            id=str(row[0]),
            type=row[1],
            status=row[2],
            payload=row[3],
            attempts=row[4] or 0,
            max_attempts=row[5] or 3,
            retry_delays=row[6],
        )


def claim_job(job_id: str) -> Optional[JobRecord]:
    """Atomically claim a job for execution.

    One UPDATE flips a claimable row to 'running' and counts the attempt, so
    a duplicate delivery (broker redelivery, or the retry sweep re-publishing
    a job another worker took), a job cancelled while queued, and a job
    already settled all refuse in the same place. Returns the claimed record,
    or None when there is nothing to claim — mirror of JobService.claimJob.
    """
    conn = get_connection()
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE jobs SET status = 'running', started_at = NOW(), "
            "attempts = COALESCE(attempts, 0) + 1 "
            "WHERE id = %s AND status IN ('pending', 'queued') "
            "RETURNING id, type, status, payload, attempts, max_attempts, "
            "retry_delays",
            (job_id,),
        )
        row = cur.fetchone()
        if not row:
            return None
        # retry_delays comes back so a claimed record carries the same fields
        # as one read by get_job — the field is declared on JobRecord and
        # documented there, and leaving it None on this path made that
        # documentation false. RETURNING on an UPDATE yields post-update
        # values and this column is not written here, so the value is the
        # row's own snapshot.
        return JobRecord(
            id=str(row[0]),
            type=row[1],
            status=row[2],
            payload=row[3],
            attempts=row[4] or 0,
            max_attempts=row[5] or 3,
            retry_delays=row[6],
        )


def update_job_progress(job_id: str, progress: int, message: str = "") -> Optional[str]:
    """Update job progress and return the row's current status.

    The write is guarded to 'running' rows, so a job cancelled mid-run keeps
    its terminal row untouched — and the cancellation surfaces here as
    :class:`JobCancelled`, making every progress checkpoint a cancellation
    poll (the mirror of the TS worker's context wrapper). A handler that
    never reports progress is only stopped by its timeout.
    """
    conn = get_connection()
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE jobs SET progress = %s, progress_message = %s "
            "WHERE id = %s AND status = 'running' RETURNING status",
            (progress, message, job_id),
        )
        row = cur.fetchone()
        if row:
            return row[0]
        cur.execute("SELECT status FROM jobs WHERE id = %s", (job_id,))
        current = cur.fetchone()
    status: Optional[str] = current[0] if current else None
    if status == "cancelled":
        raise JobCancelled(job_id)
    return status


def mark_job_completed(job_id: str, result: dict) -> None:
    """Mark job as completed with result data.

    Guarded to 'running' rows: a job cancelled (or timed out and re-claimed)
    in another process is terminal there, and a late completion from this
    one must not overwrite it — mirror of JobService.markCompleted.
    """
    conn = get_connection()
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE jobs SET status = 'completed', result = %s::jsonb, "
            "progress = 100, completed_at = NOW() "
            "WHERE id = %s AND status = 'running'",
            (psycopg.types.json.Json(result), job_id),
        )


def _retry_delay_seconds(
    attempts: int, retry_delays: Optional[list[int]] = None
) -> float:
    """Seconds to park a failed job for, from the schedule it carries.

    `retry_delays` is the job row's snapshot of its type's JobTypeConfig, in
    milliseconds — the single source of truth both this and
    JobService.markFailed read (JOBS2-10). An absent or empty schedule (a
    pre-migration row, or a type declaring ``retryDelays: []``) falls back to
    RETRY_DELAYS_MS, which is what the TS side's ``?? 30000`` does.

    `attempts` was counted at claim time, so the first failure arrives with
    attempts=1 and takes index 0 — the same arithmetic as markFailed.
    """
    schedule = retry_delays if retry_delays else RETRY_DELAYS_MS
    idx = min(max(attempts - 1, 0), len(schedule) - 1)
    return schedule[idx] / 1000.0


def mark_job_failed(job_id: str, error_message: str) -> None:
    """Mark job as failed. Handles retry logic based on attempts vs max_attempts."""
    conn = get_connection()
    job = get_job(job_id)

    with conn.cursor() as cur:
        if job and job.attempts < job.max_attempts:
            delay_seconds = _retry_delay_seconds(job.attempts, job.retry_delays)
            # 'pending' (not 'queued') means parked for retry, matching
            # JobService.markFailed; 'queued' is reserved for jobs actually
            # published to RabbitMQ. Build the delay with make_interval(): a
            # placeholder interpolated into an interval string literal is
            # never bound, and the UPDATE then throws at execute time.
            # Both branches are guarded to 'running' rows so a cancelled
            # job stays cancelled — neither a retry-park nor a final failure
            # may resurrect a terminal row.
            cur.execute(
                "UPDATE jobs SET status = 'pending', error = %s, "
                "next_retry_at = NOW() + make_interval(secs => %s) "
                "WHERE id = %s AND status = 'running'",
                (error_message, delay_seconds, job_id),
            )
            if cur.rowcount:
                logger.info(
                    "Job %s scheduled for retry in %.3gs", job_id, delay_seconds
                )
            else:
                logger.info("Job %s already terminal; failure mark skipped", job_id)
        else:
            cur.execute(
                "UPDATE jobs SET status = 'failed', error = %s, "
                "completed_at = NOW() WHERE id = %s AND status = 'running'",
                (error_message, job_id),
            )
            if cur.rowcount:
                logger.info("Job %s marked as failed (max attempts reached)", job_id)
            else:
                logger.info("Job %s already terminal; failure mark skipped", job_id)


def add_job_log(
    job_id: str,
    level: str,
    message: str,
    data: Optional[dict] = None,
) -> None:
    """Insert a log entry for a job."""
    conn = get_connection()
    log_id = str(uuid.uuid4())
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO job_logs (id, job_id, level, message, data, created_at) "
            "VALUES (%s, %s, %s, %s, %s::jsonb, NOW())",
            (log_id, job_id, level, message, psycopg.types.json.Json(data) if data else None),
        )


def get_vault_file(
    file_id: str,
    include_deleted: bool = False,
) -> Optional[VaultFileRecord]:
    """Fetch a vault file record by ID.

    ``include_deleted`` preserves the workers' historical split: the
    converter reads only live files, while the generator re-reads STEPs it
    previously produced regardless of soft-delete state.
    """
    conn = get_connection()
    where = "id = %s" if include_deleted else "id = %s AND deleted_at IS NULL"
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, item_id, branch_id, file_name, storage_path, uploaded_by "
            f"FROM vault_files WHERE {where}",
            (file_id,),
        )
        row = cur.fetchone()
        if not row:
            return None
        return VaultFileRecord(
            id=str(row[0]),
            item_id=str(row[1]),
            branch_id=str(row[2]) if row[2] else None,
            file_name=row[3],
            storage_path=row[4],
            uploaded_by=str(row[5]),
        )


def insert_vault_file(
    item_id: str,
    branch_id: Optional[str],
    file_name: str,
    original_file_name: str,
    file_size: int,
    mime_type: str,
    file_hash: str,
    storage_path: str,
    uploaded_by: str,
    file_category: str = "cad_model",
    cad_metadata: Optional[dict] = None,
) -> str:
    """Insert a new vault_files record and return the new file ID."""
    conn = get_connection()
    file_id = str(uuid.uuid4())
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO vault_files "
            "(id, item_id, branch_id, file_name, original_file_name, file_size, "
            "mime_type, file_hash, storage_type, storage_path, file_version, "
            "is_latest_version, uploaded_by, uploaded_at, file_category, cad_metadata) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'local', %s, 1, true, %s, NOW(), %s, %s::jsonb)",
            (
                file_id,
                item_id,
                branch_id,
                file_name,
                original_file_name,
                file_size,
                mime_type,
                file_hash,
                storage_path,
                uploaded_by,
                file_category,
                psycopg.types.json.Json(cad_metadata) if cad_metadata else None,
            ),
        )
    return file_id


def update_vault_file_thumbnail(file_id: str, thumbnail_file_id: str) -> None:
    """Link a thumbnail vault file to its parent CAD file."""
    conn = get_connection()
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE vault_files SET thumbnail_file_id = %s WHERE id = %s",
            (thumbnail_file_id, file_id),
        )


def compute_file_hash(file_path: str) -> str:
    """Compute SHA-256 hash of a file."""
    h = hashlib.sha256()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()
