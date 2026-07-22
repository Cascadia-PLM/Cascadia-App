"""Pydantic models for job payloads, results, and internal data."""

from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel


class ParametricSpec(BaseModel):
    """Template specification for parametric CAD generation."""

    shapeTemplate: str
    parameters: dict[str, float]
    units: str = "mm"


class ParametricGenerationPayload(BaseModel):
    """Payload stored in jobs.payload JSONB column."""

    partTempId: str
    partName: str
    itemId: str
    branchId: str
    userId: str
    spec: ParametricSpec


class BoundingBox6(BaseModel):
    """Axis-aligned bounding box with min/max coordinates."""

    minX: float
    minY: float
    minZ: float
    maxX: float
    maxY: float
    maxZ: float


class ParametricGenerationResult(BaseModel):
    """Result stored in jobs.result JSONB column."""

    partTempId: str
    vaultFileId: str
    fileName: str
    generationTimeMs: int
    boundingBox: Optional[BoundingBox6] = None


class JobMessage(BaseModel):
    """RabbitMQ message body — matches Node.js JobMessage type."""

    jobId: str
    type: str
    priority: int
    attemptNumber: int


class VaultFileRecord(BaseModel):
    """Subset of vault_files row needed for generation output."""

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


# ---------------------------------------------------------------------------
# Mechanism generation models
# ---------------------------------------------------------------------------


class MechanismPartMapping(BaseModel):
    """Maps a mechanism output role to a BOM node / PLM item."""

    role: str
    tempId: str
    itemId: str


class MechanismGenerationPayload(BaseModel):
    """Payload for mechanism CAD generation jobs."""

    assemblyTempId: str
    assemblyName: str
    mechanismType: str
    parameters: dict[str, float]
    units: str = "mm"
    partMapping: list[MechanismPartMapping]
    branchId: str
    userId: str


class MechanismPartOutput(BaseModel):
    """Per-role output from a mechanism generator."""

    vaultFileId: str
    fileName: str
    boundingBox: Optional[BoundingBox6] = None


class MechanismGenerationResult(BaseModel):
    """Result for mechanism CAD generation jobs."""

    assemblyTempId: str
    mechanismType: str
    generationTimeMs: int
    outputs: dict[str, MechanismPartOutput]
    metadata: dict[str, Any]


# ---------------------------------------------------------------------------
# Assembly composition models
# ---------------------------------------------------------------------------


class Vector3(BaseModel):
    """3D vector — translation in mm or Euler rotation in degrees."""

    x: float
    y: float
    z: float


class PlacementTransform(BaseModel):
    """Child placement transform.

    Rotation is Euler XYZ in degrees, applied rotateX -> rotateY -> rotateZ
    about the GLOBAL origin, then translated — the same convention the
    TypeScript KCL generator serializes (src/lib/cad-generation/kcl-generator.ts).
    """

    translation: Vector3
    rotation: Vector3


class AssemblyPlacement(BaseModel):
    """One child part placement within an assembly."""

    tempId: str
    partName: str
    stepFileKey: str  # vault_files.id of the child STEP
    transform: PlacementTransform
    quantity: int = 1


class AssemblyComposePayload(BaseModel):
    """Payload for assembly STEP composition jobs."""

    assemblyTempId: str
    assemblyName: str
    itemId: str
    branchId: str
    userId: str
    placements: list[AssemblyPlacement]


class AssemblyComposeResult(BaseModel):
    """Result for assembly STEP composition jobs."""

    assemblyTempId: str
    vaultFileId: str
    fileName: str
    generationTimeMs: int
    boundingBox: Optional[BoundingBox6] = None
