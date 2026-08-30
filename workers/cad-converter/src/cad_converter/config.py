# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Cascadia PLM LLC

"""Configuration via environment variables using pydantic-settings."""

from __future__ import annotations

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Database
    database_url: str = "postgresql://postgres:postgres@localhost:5432/cascadia"

    # RabbitMQ
    rabbitmq_url: str = "amqp://localhost:5672"

    # Worker
    worker_concurrency: int = 2
    job_timeout: int = 600_000  # 10 minutes in ms
    # How long a worker thread pauses before requeueing a delivery whose
    # claim could not be attempted (see worker._run_job phase 2). Without a
    # pause a database outage would spin the queue at full speed; with it
    # each prefetch slot retries roughly once every five seconds. Seconds,
    # not milliseconds — it is passed straight to time.sleep().
    claim_retry_delay_seconds: float = 5.0

    # Two-stage timeout enforcement (cascadia_worker_common.watchdog). A
    # native call wedged inside pythonocc or CadQuery cannot be interrupted,
    # so the deadline first marks the row failed — which is what returns the
    # job to the ordinary retry ledger — and only then, if the job's thread is
    # still alive `poison_exit_grace_ms` later, exits the process so the
    # container restart policy reclaims the concurrency slot. Milliseconds,
    # matching job_timeout. Setting exit_on_hung_job to false keeps stage one
    # and declines the restart, leaving the slot lost until a manual restart.
    poison_exit_grace_ms: int = 60_000
    exit_on_hung_job: bool = True

    # Health check
    health_port: int = 3003

    # Vault
    vault_root: str = "/vault"

    # Mesh defaults (overridable per-job via payload)
    mesh_linear_deflection: float = 0.1
    mesh_angular_deflection: float = 0.5
    stl_format: str = "binary"  # "binary" or "ascii"

    model_config = {"env_prefix": "", "case_sensitive": False}


settings = Settings()
