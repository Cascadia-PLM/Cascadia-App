# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Cascadia PLM LLC

"""RabbitMQ consumer — processes FreeCAD script execution jobs.

The consumer, the claim and the settlement are the same three-phase shape as
the CadQuery generator's worker (``cascadia-workers-cad-generator``), kept identical
on purpose: ``tests/test_worker_claim.py`` pins the wiring in both.

What differs is the job: a script failing is a *completed* job with
``ok: false``. The job system's retry ledger exists for infrastructure faults
— a lost database, a FreeCAD that will not import — and re-running a script
that raised would only burn a worker slot to reach the same traceback. The
agent that submitted it reads the report and submits a corrected script; that
is the retry.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import signal
import socket
import tempfile
import threading
import time
from typing import Optional

import pika
import pika.channel
import pika.spec
from cascadia_worker_common.watchdog import (
    CancelHandle,
    make_poison_exit,
    start_job_watchdog,
)

from .config import settings
from .db import (
    JobCancelled,
    add_job_log,
    claim_job,
    close_connection,
    compute_file_hash,
    insert_vault_file,
    mark_job_completed,
    mark_job_failed,
    update_job_progress,
)
from .guard import check_script
from .health import set_health_check, start_health_server
from .models import FreecadScriptPayload, FreecadScriptResult, JobMessage
from .runner import build_result, copy_step, execute_script, probe_freecad

logger = logging.getLogger(__name__)

# RabbitMQ topology constants (must match Node.js client)
EXCHANGE_NAME = "jobs.topic"
DLX_EXCHANGE = "jobs.dlx"
DLQ_QUEUE = "jobs.dead-letter"
MAX_PRIORITY = 10
BINDING_PATTERN = "jobs.generation.cad.freecad.#"

JOB_TYPE = "generation.cad.freecad"

# How much of the accepted script is kept beside the STEP in cad_metadata.
SCRIPT_METADATA_CHARS = 65_536

# Worker state
_shutdown_requested = False
_active_jobs = 0
_connection: Optional[pika.BlockingConnection] = None
# Bounds in-flight job threads; sized with basic_qos prefetch (see
# _process_message). Module-level because settings are import-time fixed.
_worker_slots = threading.Semaphore(settings.worker_concurrency)
_channel: Optional[pika.channel.Channel] = None


def _generate_queue_name() -> str:
    """Return the shared queue name for all FreeCAD runner instances.

    Deliberately STABLE (not per-host/per-start), for the same reason the
    generator's is: every runner consumes from one durable queue, so N runners
    compete for jobs and each job is delivered exactly once. A per-instance
    name would fan the SAME job out to every instance and orphan a durable
    queue on every restart.
    """
    return "freecad-runner"


def _signal_handler(signum: int, frame) -> None:
    """Handle SIGTERM/SIGINT for graceful shutdown."""
    global _shutdown_requested
    sig_name = signal.Signals(signum).name
    logger.info("Received %s, initiating graceful shutdown...", sig_name)
    _shutdown_requested = True

    # Stop consuming new messages
    if _channel and _channel.is_open:
        try:
            _channel.stop_consuming()
        except Exception:
            pass


def _get_health_status() -> dict:
    """Return health status for the HTTP health endpoint."""
    freecad = probe_freecad()
    if _shutdown_requested:
        status = "shutting_down"
    elif not freecad["available"]:
        # Alive but useless: every job would fail. 503 lets the orchestrator
        # see it without the worker having to exit.
        status = "degraded"
    else:
        status = "ok"
    return {
        "status": status,
        "service": "freecad-runner",
        "active_jobs": _active_jobs,
        "connected": _connection is not None and _connection.is_open,
        "freecad": freecad,
    }


def _process_message(
    ch: pika.channel.Channel,
    method: pika.spec.Basic.Deliver,
    properties: pika.spec.BasicProperties,
    body: bytes,
) -> None:
    """Dispatch a delivery to a worker thread and return immediately.

    The job must NOT run on pika's connection thread: a long job blocks the
    I/O loop, so no heartbeat frames flow, the broker times the connection
    out (~2x heartbeat) and redelivers the job mid-run. The callback only
    takes a concurrency slot and hands off; the main thread stays inside
    start_consuming(), pumping heartbeats.
    """
    _worker_slots.acquire()
    threading.Thread(
        target=_run_job,
        args=(ch, method.delivery_tag, body),
        daemon=True,
        name=f"freecad-{method.delivery_tag}",
    ).start()


def _schedule_ack(ch: pika.channel.Channel, delivery_tag: int) -> None:
    """Always ACK (retries are handled via DB status, not requeue) — but only
    ever from the connection thread."""

    def _ack() -> None:
        try:
            if ch.is_open:
                ch.basic_ack(delivery_tag=delivery_tag)
            else:
                logger.warning(
                    "Channel closed before ack; broker will redeliver "
                    "and the claim refuses it"
                )
        except Exception as ack_err:
            logger.warning("Ack failed: %s", ack_err)

    conn = _connection
    if conn is None or not conn.is_open:
        logger.warning(
            "Connection gone before ack; broker will redeliver "
            "and the claim refuses it"
        )
        return
    try:
        conn.add_callback_threadsafe(_ack)
    except Exception as sched_err:
        logger.warning("Could not schedule ack: %s", sched_err)


def _schedule_nack(
    ch: pika.channel.Channel, delivery_tag: int, requeue: bool
) -> None:
    """Negatively acknowledge a delivery — from the connection thread only.

    ``requeue=True`` when the worker never found out whether the job was
    claimable (the delivery is the job's ONLY copy); ``requeue=False`` routes
    a body no retry can fix to the dead-letter exchange.
    """

    def _nack() -> None:
        try:
            if ch.is_open:
                ch.basic_nack(delivery_tag=delivery_tag, requeue=requeue)
            else:
                logger.warning(
                    "Channel closed before nack; broker will redeliver "
                    "and the claim refuses it"
                )
        except Exception as nack_err:
            logger.warning("Nack failed: %s", nack_err)

    conn = _connection
    if conn is None or not conn.is_open:
        logger.warning(
            "Connection gone before nack; broker will redeliver "
            "and the claim refuses it"
        )
        return
    try:
        conn.add_callback_threadsafe(_nack)
    except Exception as sched_err:
        logger.warning("Could not schedule nack: %s", sched_err)


def _run_job(
    ch: pika.channel.Channel, delivery_tag: int, body: bytes
) -> None:
    """Execute one job on a worker thread.

    Three phases — parse, claim, execute — each settling ``outcome``, which
    the single ``finally`` dispatches exactly once: an unparseable body is
    dead-lettered, a claim that could not be attempted is requeued, and
    everything from a successful claim onward is settled in the database and
    acks. See the generator's worker for the long-form reasoning; the two are
    kept identical.
    """
    global _active_jobs
    _active_jobs += 1

    outcome = "ack"
    watchdog: Optional[CancelHandle] = None

    try:
        # Phase 1 — parse.
        try:
            raw = json.loads(body)
            msg = JobMessage(**raw)
        except Exception as parse_err:
            logger.error(
                "Unparseable message body, dead-lettering: %s", parse_err
            )
            outcome = "nack_dlq"
            return

        logger.info(
            "Received job %s (type=%s, attempt=%d)",
            msg.jobId,
            msg.type,
            msg.attemptNumber,
        )

        # Phase 2 — atomically claim the job. Do NOT ack here.
        try:
            job = claim_job(msg.jobId)
        except Exception as claim_err:
            logger.warning(
                "Could not claim job %s (%s); requeueing the delivery",
                msg.jobId,
                claim_err,
            )
            time.sleep(settings.claim_retry_delay_seconds)
            outcome = "nack_requeue"
            return

        if not job:
            logger.info(
                "Job %s not claimable (missing, cancelled, or already "
                "claimed/settled), skipping",
                msg.jobId,
            )
            return

        # Phase 3 — execute. The row is 'running' and ours.
        watchdog = start_job_watchdog(
            job_id=msg.jobId,
            timeout_ms=settings.job_timeout,
            poison_grace_ms=settings.poison_exit_grace_ms,
            job_thread_alive=threading.current_thread().is_alive,
            on_poison=make_poison_exit(
                msg.jobId, enabled=settings.exit_on_hung_job
            ),
        )

        add_job_log(
            msg.jobId,
            "info",
            "FreeCAD script execution started",
            {"worker": socket.gethostname()},
        )

        if msg.type != JOB_TYPE:
            raise ValueError(
                f"Unexpected job type {msg.type!r} on the FreeCAD runner queue"
            )

        payload = FreecadScriptPayload(**job.payload)
        result = _execute_script_job(msg.jobId, payload)
        mark_job_completed(msg.jobId, result.model_dump())
        add_job_log(
            msg.jobId,
            "info" if result.ok else "warning",
            "FreeCAD script execution completed"
            if result.ok
            else "FreeCAD script execution completed: script failed",
            {
                "ok": result.ok,
                "executionTimeMs": result.executionTimeMs,
                "errorMessage": result.errorMessage,
                "persisted": result.vaultFileId is not None,
            },
        )
        logger.info(
            "Job %s completed (ok=%s) in %dms",
            msg.jobId,
            result.ok,
            result.executionTimeMs,
        )

    except JobCancelled:
        logger.info("Job %s cancelled in another process; stopping", msg.jobId)
        try:
            add_job_log(
                msg.jobId, "info", "FreeCAD script execution stopped: job was cancelled"
            )
        except Exception as db_err:
            logger.error("Failed to log cancellation: %s", db_err)

    except Exception as e:
        # Only reachable from phase 3: `msg` is bound and the row is 'running'.
        logger.exception("Job %s failed: %s", msg.jobId, e)
        try:
            mark_job_failed(msg.jobId, str(e))
            add_job_log(
                msg.jobId, "error", f"FreeCAD script execution failed: {e}"
            )
        except Exception as db_err:
            logger.error("Failed to update job status in DB: %s", db_err)

    finally:
        if watchdog is not None:
            watchdog.cancel()
        _active_jobs -= 1
        _worker_slots.release()
        if outcome == "ack":
            _schedule_ack(ch, delivery_tag)
        else:
            _schedule_nack(
                ch, delivery_tag, requeue=outcome == "nack_requeue"
            )


def _safe_file_stem(name: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in "_-" else "_" for ch in name)
    while "__" in cleaned:
        cleaned = cleaned.replace("__", "_")
    return cleaned.strip("_")[:100] or "part"


def _execute_script_job(
    job_id: str, payload: FreecadScriptPayload
) -> FreecadScriptResult:
    """Run the script and, if asked and it succeeded, store the STEP."""
    start_time = time.monotonic()

    update_job_progress(job_id, 5, "Checking script...")
    violations = check_script(payload.script)
    if violations:
        add_job_log(job_id, "warning", "Script rejected by static guard", {"violations": violations})
        return FreecadScriptResult(
            ok=False,
            executionTimeMs=int((time.monotonic() - start_time) * 1000),
            errorMessage=violations[0],
            issues=violations,
        )

    timeout_ms = min(
        payload.timeoutMs or settings.script_timeout_ms,
        settings.max_script_timeout_ms,
    )

    with tempfile.TemporaryDirectory(prefix="freecad_run_") as work_dir:
        update_job_progress(job_id, 15, "Running FreeCAD...")
        outcome = execute_script(
            payload.script,
            timeout_ms=timeout_ms,
            work_dir=work_dir,
            export_step=True,
        )

        if outcome.infrastructure_error:
            # Not the script's fault: fail the job so the retry ledger applies
            # and the operator sees it in the job list.
            raise RuntimeError(outcome.infrastructure_error)

        result = build_result(outcome)
        result.executionTimeMs = int((time.monotonic() - start_time) * 1000)

        add_job_log(
            job_id,
            "info",
            "Script ran",
            {
                "ok": result.ok,
                "timedOut": outcome.timed_out,
                "exitCode": outcome.exit_code,
                "issues": result.issues,
            },
        )

        if not (result.ok and payload.persist):
            update_job_progress(job_id, 95, "Reporting...")
            return result

        if not payload.itemId:
            raise ValueError("persist requires itemId")

        update_job_progress(job_id, 85, "Storing in vault...")

        step_filename = f"{_safe_file_stem(payload.partName)}.step"
        vault_subdir = os.path.join("cad-output", job_id)
        vault_storage_path = os.path.join(vault_subdir, step_filename)
        dest_path = os.path.join(settings.vault_root, vault_storage_path)
        copy_step(outcome, dest_path)

        file_size = os.path.getsize(dest_path)
        file_hash = compute_file_hash(dest_path)

        cad_metadata = {
            "software": "freecad",
            "freecadVersion": result.freecadVersion,
            "generator": "ai-script",
            "boundingBox": result.geometry.boundingBox.model_dump() if result.geometry else None,
            "volumeMm3": result.geometry.volumeMm3 if result.geometry else None,
            # The script *is* the parametric record of this part: kept beside
            # the STEP so the geometry can be reproduced or revised later.
            "script": payload.script[:SCRIPT_METADATA_CHARS],
            "scriptSha256": hashlib.sha256(payload.script.encode("utf-8")).hexdigest(),
        }

        vault_file_id = insert_vault_file(
            item_id=payload.itemId,
            branch_id=payload.branchId,
            file_name=step_filename,
            original_file_name=step_filename,
            file_size=file_size,
            mime_type="application/step",
            file_hash=file_hash,
            storage_path=vault_storage_path,
            uploaded_by=payload.userId,
            file_category="cad_model",
            cad_metadata=cad_metadata,
        )

        add_job_log(
            job_id,
            "info",
            f"STEP stored: {step_filename}",
            {"vaultFileId": vault_file_id, "size": file_size},
        )

        result.vaultFileId = vault_file_id
        result.fileName = step_filename
        result.executionTimeMs = int((time.monotonic() - start_time) * 1000)
        return result


def run_worker() -> None:
    """Start the RabbitMQ consumer worker."""
    global _connection, _channel, _shutdown_requested

    # Install signal handlers
    signal.signal(signal.SIGTERM, _signal_handler)
    signal.signal(signal.SIGINT, _signal_handler)

    # Start health check server
    start_health_server()
    set_health_check(_get_health_status)

    freecad = probe_freecad()
    if freecad["available"]:
        logger.info("FreeCAD %s available", freecad["version"])
    else:
        # Keep consuming: every job fails loudly with the reason, which is a
        # better operator signal than an empty queue nobody drains.
        logger.error("FreeCAD is not importable: %s", freecad["error"])

    queue_name = _generate_queue_name()
    logger.info(
        "Starting FreeCAD runner worker (queue=%s, concurrency=%d)",
        queue_name,
        settings.worker_concurrency,
    )

    while not _shutdown_requested:
        try:
            # Connect to RabbitMQ
            params = pika.URLParameters(settings.rabbitmq_url)
            params.heartbeat = 60
            params.blocked_connection_timeout = 300
            _connection = pika.BlockingConnection(params)
            _channel = _connection.channel()

            # Declare exchange topology (idempotent — matches Node.js setup)
            _channel.exchange_declare(
                exchange=EXCHANGE_NAME, exchange_type="topic", durable=True
            )
            _channel.exchange_declare(
                exchange=DLX_EXCHANGE, exchange_type="fanout", durable=True
            )
            _channel.queue_declare(queue=DLQ_QUEUE, durable=True)
            _channel.queue_bind(
                queue=DLQ_QUEUE, exchange=DLX_EXCHANGE, routing_key=""
            )

            # Declare worker queue with priority and DLX
            _channel.queue_declare(
                queue=queue_name,
                durable=True,
                arguments={
                    "x-max-priority": MAX_PRIORITY,
                    "x-dead-letter-exchange": DLX_EXCHANGE,
                },
            )
            _channel.queue_bind(
                queue=queue_name,
                exchange=EXCHANGE_NAME,
                routing_key=BINDING_PATTERN,
            )

            # Set prefetch (concurrency limit)
            _channel.basic_qos(prefetch_count=settings.worker_concurrency)

            # Start consuming
            _channel.basic_consume(
                queue=queue_name, on_message_callback=_process_message
            )

            logger.info(
                "Worker connected and consuming from queue '%s'", queue_name
            )
            _channel.start_consuming()

        except pika.exceptions.AMQPConnectionError as e:
            if _shutdown_requested:
                break
            logger.error(
                "RabbitMQ connection failed: %s. Retrying in 5s...", e
            )
            time.sleep(5)

        except Exception as e:
            if _shutdown_requested:
                break
            logger.exception("Worker error: %s. Retrying in 5s...", e)
            time.sleep(5)

    # Graceful shutdown: wait for active jobs
    if _active_jobs > 0:
        logger.info(
            "Waiting for %d active job(s) to finish (max 30s)...", _active_jobs
        )
        deadline = time.monotonic() + 30
        # Pump the connection's I/O loop while waiting: worker threads
        # schedule their acks onto it, and a plain sleep would strand
        # those acks unsent.
        while _active_jobs > 0 and time.monotonic() < deadline:
            conn = _connection
            if conn is not None and conn.is_open:
                try:
                    conn.process_data_events(time_limit=0.5)
                    continue
                except Exception:
                    pass
            time.sleep(0.5)

    # Close connections
    if _connection and _connection.is_open:
        try:
            _connection.close()
        except Exception:
            pass
    close_connection()
    logger.info("Worker shut down")
