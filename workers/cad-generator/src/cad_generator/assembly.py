# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Cascadia PLM contributors

"""Assembly composition — position child STEP shapes and export one STEP assembly.

Rotation convention (MUST match src/lib/cad-generation/kcl-generator.ts):
rotateX, then rotateY, then rotateZ — each about the GLOBAL axis through the
origin, in degrees — followed by translation. Transforms are baked into each
shape before it is added to the cq.Assembly with an identity location, so the
exported XDE structure carries per-part names that the cad-converter worker's
decomposer reads back.
"""

from __future__ import annotations

import cadquery as cq

from .models import BoundingBox6, PlacementTransform


def apply_placement_transform(
    workplane: cq.Workplane, transform: PlacementTransform
) -> cq.Workplane:
    """Apply a placement transform: Euler XYZ rotation about the global
    origin (degrees), then translation. Order matters and must match the
    KCL serialization exactly."""
    r = transform.rotation
    t = transform.translation

    if r.x != 0:
        workplane = workplane.rotate((0, 0, 0), (1, 0, 0), r.x)
    if r.y != 0:
        workplane = workplane.rotate((0, 0, 0), (0, 1, 0), r.y)
    if r.z != 0:
        workplane = workplane.rotate((0, 0, 0), (0, 0, 1), r.z)

    if t.x != 0 or t.y != 0 or t.z != 0:
        workplane = workplane.translate((t.x, t.y, t.z))

    return workplane


def compose_assembly(
    assembly_name: str,
    parts: list[tuple[str, cq.Workplane]],
) -> cq.Assembly:
    """Build a structured assembly from (name, already-transformed workplane)
    pairs. Names are deduplicated so the XDE document stays unambiguous."""
    assembly = cq.Assembly(name=_sanitize_name(assembly_name) or "assembly")

    seen: dict[str, int] = {}
    for part_name, workplane in parts:
        name = _sanitize_name(part_name) or "part"
        if name in seen:
            seen[name] += 1
            name = f"{name}_{seen[name]}"
        else:
            seen[name] = 0
        assembly.add(workplane, name=name)

    return assembly


def compute_assembly_bounding_box(assembly: cq.Assembly) -> BoundingBox6:
    """Axis-aligned bounding box of the composed assembly."""
    bb = assembly.toCompound().BoundingBox()
    return BoundingBox6(
        minX=bb.xmin,
        minY=bb.ymin,
        minZ=bb.zmin,
        maxX=bb.xmax,
        maxY=bb.ymax,
        maxZ=bb.zmax,
    )


def _sanitize_name(name: str) -> str:
    """Sanitize a part/assembly name for use as an XDE component name."""
    cleaned = "".join(ch if ch.isalnum() or ch in "_-" else "_" for ch in name)
    while "__" in cleaned:
        cleaned = cleaned.replace("__", "_")
    return cleaned.strip("_")[:100]
