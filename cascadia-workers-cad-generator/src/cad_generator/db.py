# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Cascadia PLM LLC

"""Thin shim over the shared workers db layer (JOBS-8).

The jobs/vault SQL lives once in ``cascadia_worker_common.db``, shared with
the CAD converter and the FreeCAD runner. This module binds it to the
generator's settings and preserves the generator's one historical
difference: ``get_vault_file`` reads soft-deleted rows too, because the
generator re-reads STEPs it previously produced.
"""

from __future__ import annotations

from typing import Optional

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
from cascadia_worker_common.models import VaultFileRecord

from .config import settings

_shared.configure(settings.database_url)


def get_vault_file(file_id: str) -> Optional[VaultFileRecord]:
    """Fetch a vault file record by ID (to read previously generated STEPs)."""
    return _shared.get_vault_file(file_id, include_deleted=True)
