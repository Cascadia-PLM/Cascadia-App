"""PostgreSQL operations — reads/updates jobs and vault_files tables."""

from __future__ import annotations

import hashlib
import logging
import uuid
from typing import Optional

import psycopg
import psycopg.types.json

from .config import settings
from .models import JobRecord, VaultFileRecord

logger = logging.getLogger(__name__)

# Module-level connection (reused across calls)
_conn: Optional[psycopg.Connection] = None


def get_connection() -> psycopg.Connection:
    """Get or create a PostgreSQL connection."""
    global _conn
    if _conn is None or _conn.closed:
        _conn = psycopg.connect(settings.database_url, autocommit=True)
        logger.info("Connected to PostgreSQL")
    return _conn


def close_connection() -> None:
    """Close the PostgreSQL connection."""
    global _conn
    if _conn and not _conn.closed:
        _conn.close()
        _conn = None
        logger.info("PostgreSQL connection closed")


def get_job(job_id: str) -> Optional[JobRecord]:
    """Fetch a job record by ID."""
    conn = get_connection()
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, type, status, payload, attempts, max_attempts "
            "FROM jobs WHERE id = %s",
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
        )


def mark_job_started(job_id: str) -> None:
    """Update job status to 'running' and set started_at."""
    conn = get_connection()
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE jobs SET status = 'running', started_at = NOW(), "
            "attempts = COALESCE(attempts, 0) + 1 WHERE id = %s",
            (job_id,),
        )


def update_job_progress(job_id: str, progress: int, message: str = "") -> None:
    """Update job progress percentage and message."""
    conn = get_connection()
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE jobs SET progress = %s, progress_message = %s WHERE id = %s",
            (progress, message, job_id),
        )


def mark_job_completed(job_id: str, result: dict) -> None:
    """Mark job as completed with result data."""
    conn = get_connection()
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE jobs SET status = 'completed', result = %s::jsonb, "
            "progress = 100, completed_at = NOW() WHERE id = %s",
            (psycopg.types.json.Json(result), job_id),
        )


def mark_job_failed(job_id: str, error_message: str) -> None:
    """Mark job as failed. Handles retry logic based on attempts vs max_attempts."""
    conn = get_connection()
    job = get_job(job_id)

    with conn.cursor() as cur:
        if job and job.attempts < job.max_attempts:
            # Schedule retry with exponential backoff
            retry_delays = [30, 60, 120]  # seconds
            delay_idx = min(job.attempts, len(retry_delays) - 1)
            delay_seconds = retry_delays[delay_idx]
            cur.execute(
                "UPDATE jobs SET status = 'queued', error = %s, "
                "next_retry_at = NOW() + INTERVAL '%s seconds' WHERE id = %s",
                (error_message, delay_seconds, job_id),
            )
            logger.info("Job %s scheduled for retry in %ds", job_id, delay_seconds)
        else:
            cur.execute(
                "UPDATE jobs SET status = 'failed', error = %s, "
                "completed_at = NOW() WHERE id = %s",
                (error_message, job_id),
            )
            logger.info("Job %s marked as failed (max attempts reached)", job_id)


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


def compute_file_hash(file_path: str) -> str:
    """Compute SHA-256 hash of a file."""
    h = hashlib.sha256()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()
