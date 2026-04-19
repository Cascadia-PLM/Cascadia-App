"""CadQuery to STEP export and bounding box computation."""

from __future__ import annotations

import cadquery as cq

from .models import BoundingBox6


def export_step(workplane: cq.Workplane, output_path: str) -> None:
    """Export CadQuery workplane to STEP file."""
    cq.exporters.export(workplane, output_path, exportType="STEP")


def compute_bounding_box(workplane: cq.Workplane) -> BoundingBox6:
    """Compute axis-aligned bounding box from CadQuery workplane."""
    bb = workplane.val().BoundingBox()
    return BoundingBox6(
        minX=bb.xmin,
        minY=bb.ymin,
        minZ=bb.zmin,
        maxX=bb.xmax,
        maxY=bb.ymax,
        maxZ=bb.zmax,
    )
