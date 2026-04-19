"""Block template — rectangular solid with optional corner radius."""

from __future__ import annotations

import cadquery as cq


def make_block(params: dict[str, float]) -> cq.Workplane:
    w = params["width"]
    d = params["depth"]
    h = params["height"]
    result = cq.Workplane("XY").box(w, d, h)
    cr = params.get("corner_radius")
    if cr and cr > 0:
        result = result.edges("|Z").fillet(cr)
    return result
