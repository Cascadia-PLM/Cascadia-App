# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Cascadia PLM LLC

"""Thin shim over the shared workers db layer (JOBS-8).

The jobs/vault SQL lives once in ``cascadia_worker_common.db``; this module
binds it to the runner's settings. The runner only ever *writes* vault files
(the accepted script's STEP) and never reads one back, so the shared
``get_vault_file`` is not re-exported here.
"""

from __future__ import annotations

from cascadia_worker_common import db as _shared
from cascadia_worker_common.db import (  # noqa: F401 — re-exports
    RETRY_DELAYS_MS,
    JobCancelled,
    add_job_log,
    claim_job,
    close_connection,
    compute_file_hash,
    get_connection,
    get_job,
    insert_vault_file,
    mark_job_completed,
    mark_job_failed,
    update_job_progress,
)

from .config import settings

_shared.configure(settings.database_url)
