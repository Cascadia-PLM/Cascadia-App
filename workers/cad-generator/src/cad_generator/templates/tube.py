"""Tube template — hollow cylinder defined by OD, wall thickness, and length."""

from __future__ import annotations

import cadquery as cq


def make_tube(params: dict[str, float]) -> cq.Workplane:
    od = params["od"]
    wt = params["wall_thickness"]
    length = params["length"]
    id_ = od - 2 * wt
    return cq.Workplane("XY").circle(od / 2).circle(id_ / 2).extrude(length)
