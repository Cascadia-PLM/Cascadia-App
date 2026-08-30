# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Cascadia PLM LLC

"""Pydantic models for job payloads, results, and internal data."""

from __future__ import annotations

from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


class MeshQuality(str, Enum):
    PREVIEW = "preview"
    STANDARD = "standard"
    HIGH = "high"


# Mesh quality presets: (linear_deflection_mm, angular_deflection_rad)
MESH_PRESETS: dict[MeshQuality, tuple[float, float]] = {
    MeshQuality.PREVIEW: (0.5, 1.0),
    MeshQuality.STANDARD: (0.1, 0.5),
    MeshQuality.HIGH: (0.01, 0.1),
}


class BoundingBox(BaseModel):
    x: float
    y: float
    z: float


class CadConversionPayload(BaseModel):
    """Payload stored in jobs.payload JSONB column."""

    vaultFileId: str
    itemId: str
    outputFormat: str = "stl"
    meshQuality: MeshQuality = MeshQuality.STANDARD
    decompose: bool = False
    userId: str


class ManifestPart(BaseModel):
    """Single part entry in an assembly manifest."""

    name: str
    stlFileId: str
    polygonCount: int
    boundingBox: Optional[BoundingBox] = None
    transform: Optional[list[float]] = None  # 4x4 matrix as flat array
    glbFileId: Optional[str] = None
    color: Optional[list[float]] = None  # [r, g, b] in [0.0, 1.0]


class CadConversionResult(BaseModel):
    """Result stored in jobs.result JSONB column."""

    outputFileIds: list[str]
    totalParts: int
    polygonCount: int
    boundingBox: Optional[BoundingBox] = None
    conversionTimeMs: int
    manifest: Optional[list[ManifestPart]] = None
    thumbnailFileId: Optional[str] = None
    glbFileIds: Optional[list[str]] = None


class ConversionOutput(BaseModel):
    """Internal result from the converter, before vault storage."""

    stl_path: str
    part_name: str
    polygon_count: int
    bounding_box: Optional[BoundingBox] = None
    transform: Optional[list[float]] = None
    thumbnail_path: Optional[str] = None
    glb_path: Optional[str] = None
    color: Optional[list[float]] = None  # [r, g, b] in [0.0, 1.0]


class JobMessage(BaseModel):
    """RabbitMQ message body — matches Node.js JobMessage type."""

    jobId: str
    type: str
    priority: int
    attemptNumber: int


# Row shapes live in the shared workers package (JOBS-8); re-exported here so
# every existing `from .models import JobRecord` keeps resolving.
from cascadia_worker_common.models import (  # noqa: E402,F401
    JobRecord,
    VaultFileRecord,
)
