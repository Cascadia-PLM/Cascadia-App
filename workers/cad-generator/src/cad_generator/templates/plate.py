"""Plate template — rectangular solid with optional corner radius."""

from __future__ import annotations

import cadquery as cq


def make_plate(params: dict[str, float]) -> cq.Workplane:
    w = params["width"]
    h = params["height"]
    t = params["thickness"]
    result = cq.Workplane("XY").box(w, h, t)
    cr = params.get("corner_radius")
    if cr and cr > 0:
        result = result.edges("|Z").fillet(cr)
    return result
