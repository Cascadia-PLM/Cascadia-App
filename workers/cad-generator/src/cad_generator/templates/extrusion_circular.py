"""Circular extrusion template — solid or hollow circular profile."""

from __future__ import annotations

import cadquery as cq


def make_extrusion_circular(params: dict[str, float]) -> cq.Workplane:
    d = params["diameter"]
    length = params["length"]
    wt = params.get("wall_thickness")

    if wt and wt > 0:
        return (
            cq.Workplane("XY")
            .circle(d / 2)
            .circle((d - 2 * wt) / 2)
            .extrude(length)
        )
    else:
        return cq.Workplane("XY").circle(d / 2).extrude(length)
