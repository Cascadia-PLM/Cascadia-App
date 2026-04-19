"""Rectangular extrusion template — solid or hollow rectangular profile."""

from __future__ import annotations

import cadquery as cq


def make_extrusion_rectangular(params: dict[str, float]) -> cq.Workplane:
    w = params["width"]
    h = params["height"]
    length = params["length"]
    wt = params.get("wall_thickness")

    if wt and wt > 0:
        # Hollow rectangular extrusion
        outer = cq.Workplane("XY").rect(w, h)
        inner = outer.rect(w - 2 * wt, h - 2 * wt)
        return inner.extrude(length)
    else:
        return cq.Workplane("XY").box(w, h, length)
