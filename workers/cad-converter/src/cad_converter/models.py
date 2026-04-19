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


class VaultFileRecord(BaseModel):
    """Subset of vault_files row needed for conversion."""

    id: str
    item_id: str
    branch_id: Optional[str] = None
    file_name: str
    storage_path: str
    uploaded_by: str


class JobRecord(BaseModel):
    """Subset of jobs row needed by the worker."""

    id: str
    type: str
    status: str
    payload: dict
    attempts: int = 0
    max_attempts: int = 3
