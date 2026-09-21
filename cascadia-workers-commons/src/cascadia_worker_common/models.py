# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Cascadia PLM LLC

"""Row shapes shared by every Python worker's database layer."""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel


class JobRecord(BaseModel):
    """Subset of jobs row needed by a worker."""

    id: str
    type: str
    status: str
    payload: dict
    attempts: int = 0
    max_attempts: int = 3
    # Backoff schedule in milliseconds, snapshotted from the type's
    # JobTypeConfig when the job was submitted. None on rows written before
    # the column existed — the worker falls back to RETRY_DELAYS_MS then.
    retry_delays: Optional[list[int]] = None


class VaultFileRecord(BaseModel):
    """Subset of vault_files row a worker reads or writes."""

    id: str
    item_id: str
    branch_id: Optional[str] = None
    file_name: str
    storage_path: str
    uploaded_by: str
