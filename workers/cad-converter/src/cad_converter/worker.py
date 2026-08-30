# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Cascadia PLM LLC

"""RabbitMQ consumer — processes CAD conversion jobs."""

from __future__ import annotations

import json
import logging
import os
import signal
import socket
import tempfile
import threading
import time
from datetime import datetime
from typing import Optional

from cascadia_worker_common.watchdog import (
    CancelHandle,
    make_poison_exit,
    start_job_watchdog,
)
import pika
import pika.channel
import pika.spec

from .assembly import decompose_step_assembly
from .config import settings
from .converter import convert_single, convert_single_with_colors
from .db import (
    JobCancelled,
    add_job_log,
    claim_job,
    close_connection,
    compute_file_hash,
    get_vault_file,
    insert_vault_file,
    mark_job_completed,
    mark_job_failed,
    update_job_progress,
    update_vault_file_thumbnail,
)
from .health import set_health_check, start_health_server
from .models import (
    BoundingBox,
    CadConversionPayload,
    CadConversionResult,
    JobMessage,
    ManifestPart,
    MeshQuality,
)

logger = logging.getLogger(__name__)

# RabbitMQ topology constants (must match Node.js client)
EXCHANGE_NAME = "jobs.topic"
DLX_EXCHANGE = "jobs.dlx"
DLQ_QUEUE = "jobs.dead-letter"
MAX_PRIORITY = 10
BINDING_PATTERN = "jobs.conversion.cad.#"

# Worker state
_shutdown_requested = False
_active_jobs = 0
_connection: Optional[pika.BlockingConnection] = None
# Bounds in-flight job threads; sized with basic_qos prefetch (see
# _process_message). Module-level because settings are import-time fixed.
_worker_slots = threading.Semaphore(settings.worker_concurrency)
_channel: Optional[pika.channel.Channel] = None


def _generate_queue_name() -> str:
    """Return the shared queue name for all CAD converter instances.

    This is deliberately STABLE (not per-host/per-start). Every converter
    consumes from the same durable queue, so N converters compete for jobs and
    each job is delivered exactly once. A per-instance name would make the
    topic exchange fan the SAME job out to every instance — duplicate
    conversions, duplicate vault writes, and racing status updates — and would
    orphan a still-bound durable queue on every restart that then silently
    accumulates a copy of every job forever.

    Head-of-line blocking across job types is not a concern: the queue is bound
    only to BINDING_PATTERN, so nothing but CAD conversion jobs ever lands in
    it. Ordering within the queue is by x-max-priority, and throughput scales
    by adding converter instances.

    Note: bindings are additive and never auto-removed. If BINDING_PATTERN
    changes, delete this queue once so the stale binding goes with it.
    """
    return "cad-worker"


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
    return {
        "status": "ok" if not _shutdown_requested else "shutting_down",
        "service": "cad-converter",
        "active_jobs": _active_jobs,
        "connected": _connection is not None and _connection.is_open,
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

    The semaphore matches basic_qos prefetch, so acquire never actually
    blocks: the broker never has more than worker_concurrency deliveries
    outstanding, and a slot frees before the ack that lets the next one in.
    It exists as a backstop so a prefetch misconfiguration degrades to
    waiting instead of unbounded threads.
    """
    _worker_slots.acquire()
    threading.Thread(
        target=_run_job,
        args=(ch, method.delivery_tag, body),
        daemon=True,
        name=f"cad-conv-{method.delivery_tag}",
    ).start()


def _schedule_ack(ch: pika.channel.Channel, delivery_tag: int) -> None:
    """Always ACK (retries are handled via DB status, not requeue) — but only
    ever from the connection thread. If the connection died mid-job the ack
    is lost, and that is correct: the broker already requeued the delivery
    when the channel closed, and the atomic claim refuses the redelivery.
    """

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

    `requeue=True` puts the job back on the queue. That is the right answer
    only when the worker never found out whether the job was claimable: the
    delivery is the job's ONLY copy, so acking it there would discard the
    job. `requeue=False` routes the message to the queue's dead-letter
    exchange, for a body no amount of retrying can fix.

    Losing the nack is as harmless as losing an ack, and for the same
    reason: the broker requeues everything unacknowledged on a channel when
    that channel dies, and the atomic claim refuses the redelivery.
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

    Everything here may block for minutes; the one rule is that no pika call
    happens on this thread — the settlement is scheduled back onto the
    connection thread via add_callback_threadsafe, the only thread-safe pika
    entry point.

    The body runs in three phases — parse, claim, execute — and each settles
    `outcome`, which the single `finally` dispatches exactly once. The phases
    exist because the delivery is the job's only copy, so the three failure
    modes need three different answers: an unparseable body is a poison
    message and goes to the dead-letter exchange; a claim that could not even
    be attempted (a database outage) is requeued, because the row is still
    'queued' and nothing else will ever pick it up; and everything from a
    successful claim onward is settled in the database, so it acks — retries
    are scheduled by status, never by requeueing.
    """
    global _active_jobs
    _active_jobs += 1

    # 'ack' | 'nack_requeue' | 'nack_dlq'. Ack is the default because it is
    # the outcome of every path that reached the database, including failure.
    outcome = "ack"

    # Started once the claim succeeds and cancelled in the `finally` below,
    # whichever way the job ends. None until then: a delivery that never
    # reached phase 3 has no deadline to enforce.
    watchdog: Optional[CancelHandle] = None

    try:
        # Phase 1 — parse. A body that will not parse will never parse, so
        # requeueing it would spin the queue forever and acking it would hide
        # it: dead-letter it instead, which is what the Node worker does with
        # the same input. `msg` is bound from here on, which is what lets the
        # handlers below name it unconditionally.
        try:
            raw = json.loads(body)
            msg = JobMessage(**raw)
        except Exception as parse_err:
            logger.error(
                "Unparseable message body, dead-lettering: %s", parse_err
            )
            outcome = "nack_dlq"
            return

        logger.info("Received job %s (type=%s, attempt=%d)", msg.jobId, msg.type, msg.attemptNumber)

        # Phase 2 — atomically claim the job: one UPDATE flips pending/queued
        # to running and counts the attempt, so a duplicate delivery, a job
        # cancelled while queued, one another worker already claimed, and one
        # already settled all refuse in the same place. Do NOT ack here — the
        # `finally` block below settles the delivery. Acking twice makes the
        # broker close the channel with 406 PRECONDITION_FAILED (unknown
        # delivery tag), which tears down the consumer and reconnects on
        # every skipped message.
        try:
            job = claim_job(msg.jobId)
        except Exception as claim_err:
            # The claim never landed, so the row is still 'queued' —
            # mark_job_failed is guarded to 'running' and would no-op, and
            # acking would consume the job's only delivery and strand the row
            # at 'queued' forever. Requeue instead, after a pause so a
            # database outage redelivers on a slow cadence rather than
            # spinning. Sleeping here is allowed: this is the worker thread,
            # not pika's, and the slot it holds is released in the `finally`.
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

        # Phase 3 — execute. The row is 'running' and ours; every exit from
        # here is recorded in the database, so every exit acks — and the
        # deadline becomes enforceable, because stage one of the watchdog is
        # the same guarded 'running'-only mark every other failure uses.
        # Stage two exits the process, but only if this thread is still alive
        # a grace period after that: a native call wedged inside pythonocc or
        # CadQuery is unreachable by any cooperative signal, so there is no
        # third option. See cascadia_worker_common.watchdog.
        watchdog = start_job_watchdog(
            job_id=msg.jobId,
            timeout_ms=settings.job_timeout,
            poison_grace_ms=settings.poison_exit_grace_ms,
            job_thread_alive=threading.current_thread().is_alive,
            on_poison=make_poison_exit(
                msg.jobId, enabled=settings.exit_on_hung_job
            ),
        )

        add_job_log(msg.jobId, "info", "CAD conversion started", {"worker": socket.gethostname()})

        # Parse payload
        payload = CadConversionPayload(**job.payload)

        # Execute conversion
        result = _execute_conversion(msg.jobId, payload)

        # Mark completed
        mark_job_completed(msg.jobId, result.model_dump())
        add_job_log(msg.jobId, "info", "CAD conversion completed", {
            "totalParts": result.totalParts,
            "polygonCount": result.polygonCount,
            "conversionTimeMs": result.conversionTimeMs,
        })
        logger.info("Job %s completed: %d parts, %d polygons", msg.jobId, result.totalParts, result.polygonCount)

    except JobCancelled:
        # The row is already terminal ('cancelled' in another process) —
        # log and ack, never mark_job_failed; the status guards on the mark
        # functions protect the row regardless.
        logger.info("Job %s cancelled in another process; stopping", msg.jobId)
        try:
            add_job_log(msg.jobId, "info", "CAD conversion stopped: job was cancelled")
        except Exception as db_err:
            logger.error("Failed to log cancellation: %s", db_err)

    except Exception as e:
        # Only reachable from phase 3, so `msg` is bound and the row is
        # 'running' — which is why this can name msg.jobId outright where it
        # used to probe `'msg' in dir()`.
        logger.exception("Job %s failed: %s", msg.jobId, e)
        try:
            mark_job_failed(msg.jobId, str(e))
            add_job_log(msg.jobId, "error", f"CAD conversion failed: {e}")
        except Exception as db_err:
            logger.error("Failed to update job status in DB: %s", db_err)

    finally:
        # First, and before the slot is released: past this point the job is
        # over, and a watchdog that fired now would fail a settled row and —
        # worse — take the whole process down over a job that finished.
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


def _execute_conversion(job_id: str, payload: CadConversionPayload) -> CadConversionResult:
    """Run the actual CAD conversion and store results in vault."""
    start_time = time.monotonic()

    # Fetch the source vault file
    vault_file = get_vault_file(payload.vaultFileId)
    if not vault_file:
        raise ValueError(f"Vault file not found: {payload.vaultFileId}")

    # Resolve the physical file path
    # Normalize backslashes from Windows-generated paths to forward slashes for Linux
    storage_path = vault_file.storage_path.replace("\\", "/")
    input_path = os.path.join(settings.vault_root, storage_path)
    if not os.path.exists(input_path):
        raise FileNotFoundError(f"CAD file not found on disk: {input_path}")

    update_job_progress(job_id, 5, "Reading CAD file...")
    add_job_log(job_id, "info", f"Input file: {vault_file.file_name}", {"size": os.path.getsize(input_path)})

    # Create temp output directory
    with tempfile.TemporaryDirectory(prefix="cad_conv_") as tmp_dir:
        binary_stl = settings.stl_format == "binary"

        # Thumbnail output path (shared by single and assembly modes)
        thumbnail_path = os.path.join(tmp_dir, "thumbnail.png")

        if payload.decompose:
            # Assembly decomposition
            update_job_progress(job_id, 10, "Decomposing assembly...")

            # Render thumbnail from the full assembly shape before decomposition.
            # Uses XDE reader for accurate geometry and dominant color extraction.
            from .assembly import read_xde_shape_and_color
            from .thumbnail import render_thumbnail
            try:
                assembly_shape, dominant_color = read_xde_shape_and_color(input_path)
                color_arg = (dominant_color.r, dominant_color.g, dominant_color.b) if dominant_color else None
                if not render_thumbnail(assembly_shape, thumbnail_path, color=color_arg):
                    thumbnail_path = None
            except Exception as e:
                logger.warning("Assembly thumbnail failed (non-blocking): %s", e)
                thumbnail_path = None

            def on_progress(pct: int, msg: str) -> None:
                # Scale progress: 10% (setup) + 80% (conversion) + 10% (storage)
                scaled = 10 + int(pct * 0.8)
                update_job_progress(job_id, scaled, msg)

            outputs = decompose_step_assembly(
                input_path,
                tmp_dir,
                quality=payload.meshQuality,
                binary_stl=binary_stl,
                progress_callback=on_progress,
            )
        else:
            # Single file conversion with color extraction
            update_job_progress(job_id, 10, "Converting to STL and GLB...")
            stl_output_path = os.path.join(tmp_dir, f"{vault_file.file_name}.stl")
            glb_output_path = os.path.join(tmp_dir, f"{vault_file.file_name}.glb")
            output = convert_single_with_colors(
                input_path,
                stl_output_path,
                glb_output_path,
                quality=payload.meshQuality,
                binary_stl=binary_stl,
                thumbnail_path=thumbnail_path,
            )
            # Use thumbnail path from converter output (None if rendering failed)
            thumbnail_path = output.thumbnail_path
            outputs = [output]

        update_job_progress(job_id, 90, "Storing output files...")

        # Store output STL files in vault
        output_file_ids: list[str] = []
        manifest_parts: list[ManifestPart] = []
        total_polygons = 0
        combined_bbox: Optional[BoundingBox] = None

        for output in outputs:
            file_size = os.path.getsize(output.stl_path)
            file_hash = compute_file_hash(output.stl_path)

            # Create vault storage path
            stl_filename = os.path.basename(output.stl_path)
            vault_subdir = os.path.join("cad-output", job_id)
            vault_storage_path = os.path.join(vault_subdir, stl_filename)

            # Copy to vault
            dest_path = os.path.join(settings.vault_root, vault_storage_path)
            os.makedirs(os.path.dirname(dest_path), exist_ok=True)
            _copy_file(output.stl_path, dest_path)

            # Insert vault record
            cad_meta = {
                "software": "pythonocc-core",
                "polygonCount": output.polygon_count,
            }
            if output.bounding_box:
                cad_meta["boundingBox"] = output.bounding_box.model_dump()

            file_id = insert_vault_file(
                item_id=payload.itemId,
                branch_id=vault_file.branch_id,
                file_name=stl_filename,
                original_file_name=stl_filename,
                file_size=file_size,
                mime_type="model/stl",
                file_hash=file_hash,
                storage_path=vault_storage_path,
                uploaded_by=payload.userId,
                file_category="cad_model",
                cad_metadata=cad_meta,
            )

            output_file_ids.append(file_id)
            total_polygons += output.polygon_count

            if payload.decompose:
                manifest_parts.append(ManifestPart(
                    name=output.part_name,
                    stlFileId=file_id,
                    polygonCount=output.polygon_count,
                    boundingBox=output.bounding_box,
                    transform=output.transform,
                    color=output.color,
                ))

            # Combine bounding boxes (take max extents)
            if output.bounding_box:
                if combined_bbox is None:
                    combined_bbox = output.bounding_box
                else:
                    combined_bbox = BoundingBox(
                        x=max(combined_bbox.x, output.bounding_box.x),
                        y=max(combined_bbox.y, output.bounding_box.y),
                        z=max(combined_bbox.z, output.bounding_box.z),
                    )

        # Store GLB files in vault alongside STLs
        glb_file_ids: list[str] = []
        for i, output in enumerate(outputs):
            if not output.glb_path or not os.path.exists(output.glb_path):
                continue

            try:
                glb_size = os.path.getsize(output.glb_path)
                glb_hash = compute_file_hash(output.glb_path)

                glb_filename = os.path.basename(output.glb_path)
                vault_subdir = os.path.join("cad-output", job_id)
                glb_vault_path = os.path.join(vault_subdir, glb_filename)

                glb_dest = os.path.join(settings.vault_root, glb_vault_path)
                os.makedirs(os.path.dirname(glb_dest), exist_ok=True)
                _copy_file(output.glb_path, glb_dest)

                glb_cad_meta = {
                    "software": "pythonocc-core",
                    "polygonCount": output.polygon_count,
                    "hasColors": True,
                }
                if output.bounding_box:
                    glb_cad_meta["boundingBox"] = output.bounding_box.model_dump()

                glb_file_id = insert_vault_file(
                    item_id=payload.itemId,
                    branch_id=vault_file.branch_id,
                    file_name=glb_filename,
                    original_file_name=glb_filename,
                    file_size=glb_size,
                    mime_type="model/gltf-binary",
                    file_hash=glb_hash,
                    storage_path=glb_vault_path,
                    uploaded_by=payload.userId,
                    file_category="cad_model",
                    cad_metadata=glb_cad_meta,
                )

                glb_file_ids.append(glb_file_id)

                # Update manifest part with GLB file ID
                if payload.decompose and i < len(manifest_parts):
                    manifest_parts[i].glbFileId = glb_file_id

                add_job_log(job_id, "info", f"GLB stored: {glb_filename}", {
                    "glbFileId": glb_file_id,
                    "size": glb_size,
                    "hasColors": True,
                })
            except Exception as e:
                logger.warning("Failed to store GLB file (non-blocking): %s", e)

        # Store thumbnail in vault and link to source/output files
        thumbnail_file_id: Optional[str] = None
        if thumbnail_path and os.path.exists(thumbnail_path):
            try:
                thumb_size = os.path.getsize(thumbnail_path)
                thumb_hash = compute_file_hash(thumbnail_path)

                thumb_vault_subdir = os.path.join("cad-output", job_id)
                thumb_vault_path = os.path.join(thumb_vault_subdir, "thumbnail.png")

                thumb_dest = os.path.join(settings.vault_root, thumb_vault_path)
                os.makedirs(os.path.dirname(thumb_dest), exist_ok=True)
                _copy_file(thumbnail_path, thumb_dest)

                thumbnail_file_id = insert_vault_file(
                    item_id=payload.itemId,
                    branch_id=vault_file.branch_id,
                    file_name="thumbnail.png",
                    original_file_name="thumbnail.png",
                    file_size=thumb_size,
                    mime_type="image/png",
                    file_hash=thumb_hash,
                    storage_path=thumb_vault_path,
                    uploaded_by=payload.userId,
                    file_category="thumbnail",
                )

                # Link thumbnail to the source CAD file
                update_vault_file_thumbnail(payload.vaultFileId, thumbnail_file_id)

                # Link thumbnail to all output STL files
                for stl_file_id in output_file_ids:
                    update_vault_file_thumbnail(stl_file_id, thumbnail_file_id)

                # Link thumbnail to all output GLB files
                for glb_fid in glb_file_ids:
                    update_vault_file_thumbnail(glb_fid, thumbnail_file_id)

                add_job_log(job_id, "info", "Thumbnail generated", {
                    "thumbnailFileId": thumbnail_file_id,
                    "size": thumb_size,
                })
            except Exception as e:
                logger.warning("Failed to store thumbnail (non-blocking): %s", e)

    elapsed_ms = int((time.monotonic() - start_time) * 1000)

    return CadConversionResult(
        outputFileIds=output_file_ids,
        totalParts=len(outputs),
        polygonCount=total_polygons,
        boundingBox=combined_bbox,
        conversionTimeMs=elapsed_ms,
        manifest=manifest_parts if manifest_parts else None,
        thumbnailFileId=thumbnail_file_id,
        glbFileIds=glb_file_ids if glb_file_ids else None,
    )


def _copy_file(src: str, dst: str) -> None:
    """Copy a file efficiently."""
    import shutil
    shutil.copy2(src, dst)


def run_worker() -> None:
    """Start the RabbitMQ consumer worker."""
    global _connection, _channel, _shutdown_requested

    # Install signal handlers
    signal.signal(signal.SIGTERM, _signal_handler)
    signal.signal(signal.SIGINT, _signal_handler)

    # Start health check server
    start_health_server()
    set_health_check(_get_health_status)

    queue_name = _generate_queue_name()
    logger.info("Starting CAD converter worker (queue=%s, concurrency=%d)", queue_name, settings.worker_concurrency)

    while not _shutdown_requested:
        try:
            # Connect to RabbitMQ
            params = pika.URLParameters(settings.rabbitmq_url)
            params.heartbeat = 60
            params.blocked_connection_timeout = 300
            _connection = pika.BlockingConnection(params)
            _channel = _connection.channel()

            # Declare exchange topology (idempotent — matches Node.js setup)
            _channel.exchange_declare(exchange=EXCHANGE_NAME, exchange_type="topic", durable=True)
            _channel.exchange_declare(exchange=DLX_EXCHANGE, exchange_type="fanout", durable=True)
            _channel.queue_declare(queue=DLQ_QUEUE, durable=True)
            _channel.queue_bind(queue=DLQ_QUEUE, exchange=DLX_EXCHANGE, routing_key="")

            # Declare worker queue with priority and DLX
            _channel.queue_declare(
                queue=queue_name,
                durable=True,
                arguments={
                    "x-max-priority": MAX_PRIORITY,
                    "x-dead-letter-exchange": DLX_EXCHANGE,
                },
            )
            _channel.queue_bind(queue=queue_name, exchange=EXCHANGE_NAME, routing_key=BINDING_PATTERN)

            # Set prefetch (concurrency limit)
            _channel.basic_qos(prefetch_count=settings.worker_concurrency)

            # Start consuming
            _channel.basic_consume(queue=queue_name, on_message_callback=_process_message)

            logger.info("Worker connected and consuming from queue '%s'", queue_name)
            _channel.start_consuming()

        except pika.exceptions.AMQPConnectionError as e:
            if _shutdown_requested:
                break
            logger.error("RabbitMQ connection failed: %s. Retrying in 5s...", e)
            time.sleep(5)

        except Exception as e:
            if _shutdown_requested:
                break
            logger.exception("Worker error: %s. Retrying in 5s...", e)
            time.sleep(5)

    # Graceful shutdown: wait for active jobs
    if _active_jobs > 0:
        logger.info("Waiting for %d active job(s) to finish (max 30s)...", _active_jobs)
        deadline = time.monotonic() + 30
        # Pump the connection's I/O loop while waiting: worker threads
        # schedule their acks onto it, and a plain sleep would strand
        # those acks unsent (harmless — the claim refuses the redelivery
        # — but every job finished during shutdown would come back once
        # after restart).
        while _active_jobs > 0 and time.monotonic() < deadline:
            if _connection is not None and _connection.is_open:
                try:
                    _connection.process_data_events(time_limit=0.5)
                except Exception:
                    time.sleep(0.5)
            else:
                time.sleep(0.5)
    # One final pump so acks scheduled by the last finishing thread
    # go out before the channel closes.
    if _connection is not None and _connection.is_open:
        try:
            _connection.process_data_events(time_limit=1)
        except Exception:
            pass

    # Close connections
    try:
        if _channel and _channel.is_open:
            _channel.close()
        if _connection and _connection.is_open:
            _connection.close()
    except Exception:
        pass

    close_connection()
    logger.info("Worker shut down cleanly")