# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Cascadia PLM LLC

"""RabbitMQ consumer — processes parametric CAD generation jobs."""

from __future__ import annotations

import json
import logging
import os
import shutil
import signal
import socket
import tempfile
import threading
import time
from typing import Optional

import cadquery as cq
from cascadia_worker_common.watchdog import (
    CancelHandle,
    make_poison_exit,
    start_job_watchdog,
)
import pika
import pika.channel
import pika.spec

from .assembly import (
    apply_placement_transform,
    compose_assembly,
    compute_assembly_bounding_box,
)
from .config import settings
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
)
from .export import compute_bounding_box, export_step
from .health import set_health_check, start_health_server
from .models import (
    AssemblyComposePayload,
    AssemblyComposeResult,
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
BINDING_PATTERN_ASSEMBLE = "jobs.generation.cad.assemble.#"

# Worker state
_shutdown_requested = False
_active_jobs = 0
_connection: Optional[pika.BlockingConnection] = None
# Bounds in-flight job threads; sized with basic_qos prefetch (see
# _process_message). Module-level because settings are import-time fixed.
_worker_slots = threading.Semaphore(settings.worker_concurrency)
_channel: Optional[pika.channel.Channel] = None


def _generate_queue_name() -> str:
    """Return the shared queue name for all CAD generator instances.

    This is deliberately STABLE (not per-host/per-start). Every generator
    consumes from the same durable queue, so N generators compete for jobs and
    each job is delivered exactly once. A per-instance name would make the
    topic exchange fan the SAME job out to every instance — duplicate
    generations, duplicate vault writes, and racing status updates — and would
    orphan a still-bound durable queue on every restart that then silently
    accumulates a copy of every job forever.

    Head-of-line blocking across job types is not a concern: the queue is bound
    only to the parametric/mechanism/assemble patterns, so no unrelated job
    ever lands in it. Ordering within the queue is by x-max-priority, and
    throughput scales by adding generator instances.

    Note: bindings are additive and never auto-removed. If the BINDING_PATTERN
    constants change, delete this queue once so stale bindings go with it.
    """
    return "parametric-worker"


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
        name=f"cad-gen-{method.delivery_tag}",
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

        logger.info(
            "Received job %s (type=%s, attempt=%d)",
            msg.jobId,
            msg.type,
            msg.attemptNumber,
        )

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

        add_job_log(
            msg.jobId,
            "info",
            "Parametric CAD generation started",
            {"worker": socket.gethostname()},
        )

        # Dispatch based on job type
        if msg.type == "generation.cad.assemble":
            payload_asm = AssemblyComposePayload(**job.payload)
            result = _execute_assembly_composition(msg.jobId, payload_asm)
            mark_job_completed(msg.jobId, result.model_dump())
            add_job_log(
                msg.jobId,
                "info",
                "Assembly STEP composition completed",
                {
                    "assemblyTempId": result.assemblyTempId,
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
        elif msg.type == "generation.cad.mechanism":
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

    except JobCancelled:
        # The row is already terminal ('cancelled' in another process) —
        # log and ack, never mark_job_failed; the status guards on the mark
        # functions protect the row regardless.
        logger.info("Job %s cancelled in another process; stopping", msg.jobId)
        try:
            add_job_log(
                msg.jobId, "info", "CAD generation stopped: job was cancelled"
            )
        except Exception as db_err:
            logger.error("Failed to log cancellation: %s", db_err)

    except Exception as e:
        # Only reachable from phase 3, so `msg` is bound and the row is
        # 'running' — which is why this can name msg.jobId outright where it
        # used to probe `"msg" in dir()`.
        logger.exception("Job %s failed: %s", msg.jobId, e)
        try:
            mark_job_failed(msg.jobId, str(e))
            add_job_log(
                msg.jobId, "error", f"Parametric CAD generation failed: {e}"
            )
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


def _execute_assembly_composition(
    job_id: str, payload: AssemblyComposePayload
) -> AssemblyComposeResult:
    """Compose child STEP files into one assembly STEP and store it in vault."""
    start_time = time.monotonic()

    if not payload.placements:
        raise ValueError("Assembly composition requires at least one placement")

    update_job_progress(job_id, 5, "Loading child STEP files...")

    total = len(payload.placements)
    parts = []
    for idx, placement in enumerate(payload.placements):
        record = get_vault_file(placement.stepFileKey)
        if not record:
            raise ValueError(
                f"Vault file {placement.stepFileKey} not found "
                f"(part '{placement.partName}')"
            )
        step_path = os.path.join(settings.vault_root, record.storage_path)
        if not os.path.exists(step_path):
            raise ValueError(
                f"STEP file missing on disk: {record.storage_path} "
                f"(part '{placement.partName}')"
            )

        workplane = cq.importers.importStep(step_path)
        workplane = apply_placement_transform(workplane, placement.transform)

        if placement.quantity > 1:
            # The plan carries one transform per placement, so duplicate
            # instances have nowhere distinct to go (same gap as the
            # assembly script). Place a single instance and record the gap.
            add_job_log(
                job_id,
                "warning",
                f"Placement '{placement.partName}' has quantity "
                f"{placement.quantity} but only one transform — "
                "placing a single instance",
            )

        parts.append((placement.partName, workplane))
        progress = 5 + int(50 * (idx + 1) / total)
        update_job_progress(
            job_id, progress, f"Loaded {placement.partName} ({idx + 1}/{total})"
        )

    update_job_progress(job_id, 60, "Composing assembly...")
    assembly = compose_assembly(payload.assemblyName, parts)
    bbox = compute_assembly_bounding_box(assembly)

    update_job_progress(job_id, 75, "Exporting assembly STEP...")

    with tempfile.TemporaryDirectory(prefix="cad_asm_") as tmp_dir:
        safe_name = payload.assemblyName.replace(" ", "_")
        step_filename = f"{safe_name}_assembly.step"
        tmp_step_path = os.path.join(tmp_dir, step_filename)
        assembly.save(tmp_step_path, exportType="STEP")

        update_job_progress(job_id, 85, "Storing in vault...")

        vault_subdir = os.path.join("cad-output", job_id)
        vault_storage_path = os.path.join(vault_subdir, step_filename)
        dest_path = os.path.join(settings.vault_root, vault_storage_path)
        os.makedirs(os.path.dirname(dest_path), exist_ok=True)
        shutil.copy2(tmp_step_path, dest_path)

        file_size = os.path.getsize(dest_path)
        file_hash = compute_file_hash(dest_path)

        cad_metadata = {
            "software": "cadquery",
            "composition": "assembly",
            "childCount": total,
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
            f"Assembly STEP stored: {step_filename}",
            {"vaultFileId": vault_file_id, "size": file_size},
        )

    elapsed_ms = int((time.monotonic() - start_time) * 1000)

    return AssemblyComposeResult(
        assemblyTempId=payload.assemblyTempId,
        vaultFileId=vault_file_id,
        fileName=step_filename,
        generationTimeMs=elapsed_ms,
        boundingBox=bbox,
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
        "Starting CAD generator worker (queue=%s, concurrency=%d, types=[parametric, mechanism, assemble])",
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
            _channel.queue_bind(
                queue=queue_name,
                exchange=EXCHANGE_NAME,
                routing_key=BINDING_PATTERN_ASSEMBLE,
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