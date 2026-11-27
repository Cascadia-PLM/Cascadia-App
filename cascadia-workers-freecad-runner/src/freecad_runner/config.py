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
    # Must exceed max_script_timeout_ms plus FreeCAD's start-up and the vault
    # write, so the watchdog only ever fires on a wedged process and never on a
    # script the harness was about to time out itself. Matches the TypeScript
    # job config (generation.cad.freecad: 420 s).
    job_timeout: int = 420_000
    # How long a worker thread pauses before requeueing a delivery whose
    # claim could not be attempted (see worker._run_job phase 2). Seconds —
    # it is passed straight to time.sleep().
    claim_retry_delay_seconds: float = 5.0

    # Two-stage timeout enforcement (cascadia_worker_common.watchdog). The
    # script itself runs in a child process the runner kills at its own
    # deadline, so a wedged job here means the *worker* is stuck — which is
    # exactly what stage two exists for. Milliseconds, matching job_timeout.
    poison_exit_grace_ms: int = 60_000
    exit_on_hung_job: bool = True

    # Health check
    health_port: int = 3005

    # Vault
    vault_root: str = "/vault"

    # Script execution -------------------------------------------------------
    # Budget for one script process when the payload names none, and the
    # ceiling applied to whatever the payload names. Milliseconds.
    script_timeout_ms: int = 120_000
    max_script_timeout_ms: int = 300_000
    # The interpreter that can `import FreeCAD`. Empty means this process's
    # own interpreter, which in the conda image is the one FreeCAD was
    # installed into (INSTALL_TO_SITEPACKAGES). Point it at FreeCAD's bundled
    # python for a system or AppImage install.
    freecad_python: str = ""
    # Extra sys.path entries the harness adds before `import FreeCAD`
    # (os.pathsep-separated), for installs that keep FreeCAD.so outside
    # site-packages, e.g. /usr/lib/freecad/lib.
    freecad_lib_dir: str = ""
    # RLIMIT_AS for the script process, in MiB. 0 leaves it unlimited: FreeCAD
    # plus Qt map a lot of virtual memory at start-up and a low cap kills the
    # import, not the script.
    script_memory_mb: int = 0
    # How much of the script's stdout/stderr the report keeps (the tail).
    output_capture_chars: int = 8000

    model_config = {"env_prefix": "", "case_sensitive": False}


settings = Settings()
