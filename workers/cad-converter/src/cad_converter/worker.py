# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Cascadia PLM contributors

"""RabbitMQ consumer — processes CAD conversion jobs."""

from __future__ import annotations

import json
import logging
import os
import signal
import socket
import tempfile
import time
from datetime import datetime
from typing import Optional

import pika
import pika.channel
import pika.spec

from .assembly import decompose_step_assembly
from .config import settings
from .converter import convert_single, convert_single_with_colors
from .db import (
    add_job_log,
    close_connection,
    compute_file_hash,
    get_job,
    get_vault_file,
    insert_vault_file,
    mark_job_completed,
    mark_job_failed,
    mark_job_started,
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
_channel: Optional[pika.channel.Channel] = None


def _generate_queue_name() -> str:
    """Generate a unique queue name for this worker instance."""
    hostname = socket.gethostname()
    timestamp = int(time.time())
    return f"cad-worker-{hostname}-{timestamp}"


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
    """Process a single job message from RabbitMQ."""
    global _active_jobs
    _active_jobs += 1

    try:
        # Parse message
        raw = json.loads(body)
        msg = JobMessage(**raw)
        logger.info("Received job %s (type=%s, attempt=%d)", msg.jobId, msg.type, msg.attemptNumber)

        # Fetch full job record from database
        job = get_job(msg.jobId)
        if not job:
            logger.error("Job %s not found in database, skipping", msg.jobId)
            ch.basic_ack(delivery_tag=method.delivery_tag)
            return

        if job.status == "cancelled":
            logger.info("Job %s is cancelled, skipping", msg.jobId)
            ch.basic_ack(delivery_tag=method.delivery_tag)
            return

        # Mark as running
        mark_job_started(msg.jobId)
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

    except Exception as e:
        logger.exception("Job %s failed: %s", msg.jobId if 'msg' in dir() else 'unknown', e)
        try:
            if 'msg' in dir():
                mark_job_failed(msg.jobId, str(e))
                add_job_log(msg.jobId, "error", f"CAD conversion failed: {e}")
        except Exception as db_err:
            logger.error("Failed to update job status in DB: %s", db_err)

    finally:
        _active_jobs -= 1
        # Always ACK the message (retries are handled via DB status, not requeue)
        ch.basic_ack(delivery_tag=method.delivery_tag)


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
        while _active_jobs > 0 and time.monotonic() < deadline:
            time.sleep(0.5)

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