# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Cascadia PLM LLC

"""Pydantic models for job payloads, results, and internal data.

Field names are camelCase because these are the JSON shapes the TypeScript
side declares in ``cascadia-design-engine/src/jobs/definitions/freecad-script/types.ts``;
the two must agree byte for byte.
"""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field

# Row shapes live in the shared workers package (JOBS-8); re-exported here so
# `from .models import JobRecord` resolves the way it does in the other workers.
from cascadia_worker_common.models import (  # noqa: F401
    JobRecord,
    VaultFileRecord,
)


class FreecadScriptPayload(BaseModel):
    """Payload stored in jobs.payload JSONB column."""

    script: str
    partName: str
    userId: str
    persist: bool
    itemId: Optional[str] = None
    branchId: Optional[str] = None
    partTempId: Optional[str] = None
    timeoutMs: Optional[int] = None


class BoundingBox6(BaseModel):
    """Axis-aligned bounding box with min/max coordinates, in mm."""

    minX: float
    minY: float
    minZ: float
    maxX: float
    maxY: float
    maxZ: float


class Vector3(BaseModel):
    x: float
    y: float
    z: float


class GeometrySummary(BaseModel):
    """What the harness measured on the script's ``result`` shape."""

    solidCount: int
    faceCount: int
    edgeCount: int
    volumeMm3: float
    surfaceAreaMm2: float
    isValid: bool
    boundingBox: BoundingBox6
    centerOfMass: Optional[Vector3] = None


class FreecadScriptResult(BaseModel):
    """Result stored in jobs.result JSONB column.

    ``ok`` is about the *script*: it ran, ``result`` passed validation and
    (when asked) was stored. A false ``ok`` is still a completed job — see the
    worker for why a script failure is never a job failure.
    """

    ok: bool
    freecadVersion: Optional[str] = None
    executionTimeMs: int
    stdout: str = ""
    stderr: str = ""
    errorMessage: Optional[str] = None
    traceback: Optional[str] = None
    issues: list[str] = Field(default_factory=list)
    geometry: Optional[GeometrySummary] = None
    vaultFileId: Optional[str] = None
    fileName: Optional[str] = None


class JobMessage(BaseModel):
    """RabbitMQ message body — matches Node.js JobMessage type."""

    jobId: str
    type: str
    priority: int
    attemptNumber: int
