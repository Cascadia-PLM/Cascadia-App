# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Cascadia PLM contributors

"""RabbitMQ consumer — processes parametric CAD generation jobs."""

from __future__ import annotations

import json
import logging
import os
import shutil
import signal
import socket
import tempfile
import time
from typing import Optional

import pika
import pika.channel
import pika.spec

from .config import settings
from .db import (
    add_job_log,
    close_connection,
    compute_file_hash,
    get_job,
    insert_vault_file,
    mark_job_completed,
    mark_job_failed,
    mark_job_started,
    update_job_progress,
)
from .export import compute_bounding_box, export_step
from .health import set_health_check, start_health_server
from .models import (
    JobMessage,
    MechanismGenerationPayload,
    MechanismGenerationResult,
    MechanismPartOutput,
    ParametricGenerationPayload,
    ParametricGenerationResult,
    ParametricSpec,
)
from .mechanism_generators import MECHANISM_REGISTRY
from .templates import TEMPLATE_REGISTRY
from .validation import validate_mechanism_parameters, validate_parameters

logger = logging.getLogger(__name__)

# RabbitMQ topology constants (must match Node.js client)
EXCHANGE_NAME = "jobs.topic"
DLX_EXCHANGE = "jobs.dlx"
DLQ_QUEUE = "jobs.dead-letter"
MAX_PRIORITY = 10
BINDING_PATTERN = "jobs.generation.cad.parametric.#"
BINDING_PATTERN_MECHANISM = "jobs.generation.cad.mechanism.#"

# Worker state
_shutdown_requested = False
_active_jobs = 0
_connection: Optional[pika.BlockingConnection] = None
_channel: Optional[pika.channel.Channel] = None


def _generate_queue_name() -> str:
    """Generate a unique queue name for this worker instance."""
    hostname = socket.gethostname()
    timestamp = int(time.time())
    return f"parametric-worker-{hostname}-{timestamp}"


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
        "service": "cad-generator",
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
        logger.info(
            "Received job %s (type=%s, attempt=%d)",
            msg.jobId,
            msg.type,
            msg.attemptNumber,
        )

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
        add_job_log(
            msg.jobId,
            "info",
            "Parametric CAD generation started",
            {"worker": socket.gethostname()},
        )

        # Dispatch based on job type
        if msg.type == "generation.cad.mechanism":
            payload_mech = MechanismGenerationPayload(**job.payload)
            result = _execute_mechanism_generation(msg.jobId, payload_mech)
            mark_job_completed(msg.jobId, result.model_dump())
            add_job_log(
                msg.jobId,
                "info",
                "Mechanism CAD generation completed",
                {
                    "assemblyTempId": result.assemblyTempId,
                    "mechanismType": result.mechanismType,
                    "generationTimeMs": result.generationTimeMs,
                    "outputRoles": list(result.outputs.keys()),
                },
            )
            logger.info(
                "Job %s completed: %s mechanism (%d parts) in %dms",
                msg.jobId,
                result.mechanismType,
                len(result.outputs),
                result.generationTimeMs,
            )
        else:
            payload_param = ParametricGenerationPayload(**job.payload)
            result = _execute_generation(msg.jobId, payload_param)
            mark_job_completed(msg.jobId, result.model_dump())
            add_job_log(
                msg.jobId,
                "info",
                "Parametric CAD generation completed",
                {
                    "partTempId": result.partTempId,
                    "fileName": result.fileName,
                    "generationTimeMs": result.generationTimeMs,
                },
            )
            logger.info(
                "Job %s completed: %s in %dms",
                msg.jobId,
                result.fileName,
                result.generationTimeMs,
            )

    except Exception as e:
        logger.exception(
            "Job %s failed: %s", msg.jobId if "msg" in dir() else "unknown", e
        )
        try:
            if "msg" in dir():
                mark_job_failed(msg.jobId, str(e))
                add_job_log(
                    msg.jobId, "error", f"Parametric CAD generation failed: {e}"
                )
        except Exception as db_err:
            logger.error("Failed to update job status in DB: %s", db_err)

    finally:
        _active_jobs -= 1
        # Always ACK the message (retries are handled via DB status, not requeue)
        ch.basic_ack(delivery_tag=method.delivery_tag)


def _execute_generation(
    job_id: str, payload: ParametricGenerationPayload
) -> ParametricGenerationResult:
    """Run the actual parametric CAD generation and store results in vault."""
    start_time = time.monotonic()

    spec = payload.spec
    template_name = spec.shapeTemplate
    parameters = dict(spec.parameters)

    update_job_progress(job_id, 5, "Validating parameters...")

    # Resolve template
    template_fn = TEMPLATE_REGISTRY.get(template_name)
    if not template_fn:
        raise ValueError(
            f"Unknown template: {template_name}. "
            f"Available: {', '.join(TEMPLATE_REGISTRY.keys())}"
        )

    # Validate parameters
    parameters = validate_parameters(template_name, parameters)

    # Convert inches to mm if needed
    if spec.units == "in":
        parameters = {k: v * 25.4 for k, v in parameters.items()}
        add_job_log(
            job_id, "info", "Converted parameters from inches to mm", parameters
        )

    update_job_progress(job_id, 20, f"Generating {template_name} geometry...")
    add_job_log(
        job_id,
        "info",
        f"Template: {template_name}",
        {"parameters": parameters, "units": "mm"},
    )

    # Generate CadQuery workplane
    workplane = template_fn(parameters)

    update_job_progress(job_id, 50, "Exporting to STEP...")

    # Export to STEP in temp directory
    with tempfile.TemporaryDirectory(prefix="cad_gen_") as tmp_dir:
        step_filename = f"{payload.partName}.step"
        tmp_step_path = os.path.join(tmp_dir, step_filename)
        export_step(workplane, tmp_step_path)

        update_job_progress(job_id, 70, "Computing bounding box...")

        # Compute bounding box
        bbox = compute_bounding_box(workplane)

        update_job_progress(job_id, 80, "Storing in vault...")

        # Write STEP to vault
        vault_subdir = os.path.join("cad-output", job_id)
        vault_storage_path = os.path.join(vault_subdir, step_filename)
        dest_path = os.path.join(settings.vault_root, vault_storage_path)
        os.makedirs(os.path.dirname(dest_path), exist_ok=True)
        shutil.copy2(tmp_step_path, dest_path)

        # Compute file hash and size
        file_size = os.path.getsize(dest_path)
        file_hash = compute_file_hash(dest_path)

        # Insert vault record
        cad_metadata = {
            "software": "cadquery",
            "template": template_name,
            "parameters": parameters,
            "boundingBox": bbox.model_dump(),
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

    elapsed_ms = int((time.monotonic() - start_time) * 1000)

    return ParametricGenerationResult(
        partTempId=payload.partTempId,
        vaultFileId=vault_file_id,
        fileName=step_filename,
        generationTimeMs=elapsed_ms,
        boundingBox=bbox,
    )


def _execute_mechanism_generation(
    job_id: str, payload: MechanismGenerationPayload
) -> MechanismGenerationResult:
    """Generate mechanism parts (multi-output) and store each in vault."""
    start_time = time.monotonic()

    mechanism_type = payload.mechanismType
    parameters = dict(payload.parameters)

    update_job_progress(job_id, 5, "Validating mechanism parameters...")

    # Validate parameters
    parameters = validate_mechanism_parameters(mechanism_type, parameters)

    # Convert inches to mm if needed
    if payload.units == "in":
        parameters = {k: v * 25.4 for k, v in parameters.items()}
        add_job_log(
            job_id, "info", "Converted parameters from inches to mm", parameters
        )

    # Resolve mechanism generator
    generator_fn = MECHANISM_REGISTRY.get(mechanism_type)
    if not generator_fn:
        raise ValueError(
            f"Unknown mechanism type: {mechanism_type}. "
            f"Available: {', '.join(MECHANISM_REGISTRY.keys())}"
        )

    update_job_progress(job_id, 15, f"Generating {mechanism_type} geometry...")
    add_job_log(
        job_id,
        "info",
        f"Mechanism: {mechanism_type}",
        {"parameters": parameters, "units": "mm"},
    )

    # Generate all parts
    workplanes, metadata = generator_fn(parameters)

    update_job_progress(job_id, 50, "Exporting STEP files...")

    # Build role -> mapping lookup
    role_to_mapping = {m.role: m for m in payload.partMapping}

    # Export each part to STEP and store in vault
    outputs: dict[str, MechanismPartOutput] = {}

    with tempfile.TemporaryDirectory(prefix="mech_gen_") as tmp_dir:
        roles = list(workplanes.keys())
        for idx, role in enumerate(roles):
            workplane = workplanes[role]
            mapping = role_to_mapping.get(role)
            if not mapping:
                raise ValueError(
                    f"No partMapping entry for role '{role}' "
                    f"(available: {list(role_to_mapping.keys())})"
                )

            # Sanitize filename
            safe_name = payload.assemblyName.replace(" ", "_")
            step_filename = f"{safe_name}_{role}.step"
            tmp_path = os.path.join(tmp_dir, step_filename)
            export_step(workplane, tmp_path)

            progress = 50 + int(40 * (idx + 1) / len(roles))
            update_job_progress(
                job_id, progress, f"Storing {role} ({idx + 1}/{len(roles)})..."
            )

            bbox = compute_bounding_box(workplane)

            # Write to vault
            vault_subdir = os.path.join("cad-output", job_id)
            vault_storage_path = os.path.join(vault_subdir, step_filename)
            dest_path = os.path.join(settings.vault_root, vault_storage_path)
            os.makedirs(os.path.dirname(dest_path), exist_ok=True)
            shutil.copy2(tmp_path, dest_path)

            file_size = os.path.getsize(dest_path)
            file_hash = compute_file_hash(dest_path)

            cad_metadata = {
                "software": "cadquery",
                "mechanism": mechanism_type,
                "role": role,
                "parameters": parameters,
                "boundingBox": bbox.model_dump(),
                "engineeringMetadata": metadata,
            }

            vault_file_id = insert_vault_file(
                item_id=mapping.itemId,
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

            outputs[role] = MechanismPartOutput(
                vaultFileId=vault_file_id,
                fileName=step_filename,
                boundingBox=bbox,
            )

            add_job_log(
                job_id,
                "info",
                f"STEP stored for role '{role}': {step_filename}",
                {"vaultFileId": vault_file_id, "size": file_size},
            )

    elapsed_ms = int((time.monotonic() - start_time) * 1000)

    return MechanismGenerationResult(
        assemblyTempId=payload.assemblyTempId,
        mechanismType=mechanism_type,
        generationTimeMs=elapsed_ms,
        outputs=outputs,
        metadata=metadata,
    )


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
    logger.info(
        "Starting CAD generator worker (queue=%s, concurrency=%d, types=[parametric, mechanism])",
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
            _channel.queue_bind(
                queue=queue_name,
                exchange=EXCHANGE_NAME,
                routing_key=BINDING_PATTERN_MECHANISM,
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