"""Plate with holes template — rectangular plate with a grid of through-holes."""

from __future__ import annotations

import cadquery as cq


def make_plate_with_holes(params: dict[str, float]) -> cq.Workplane:
    w = params["width"]
    h = params["height"]
    t = params["thickness"]
    hole_d = params["hole_diameter"]
    cr = params.get("corner_radius")
    nx = int(params.get("hole_count_x", 2))
    ny = int(params.get("hole_count_y", 2))
    mx = params.get("hole_margin_x", w * 0.15)
    my = params.get("hole_margin_y", h * 0.15)

    result = cq.Workplane("XY").box(w, h, t)
    if cr and cr > 0:
        result = result.edges("|Z").fillet(cr)

    # Create hole grid
    sx = (w - 2 * mx) / max(nx - 1, 1) if nx > 1 else 0
    sy = (h - 2 * my) / max(ny - 1, 1) if ny > 1 else 0
    start_x = -w / 2 + mx
    start_y = -h / 2 + my

    holes = []
    for ix in range(nx):
        for iy in range(ny):
            x = start_x + ix * sx if nx > 1 else 0
            y = start_y + iy * sy if ny > 1 else 0
            holes.append((x, y))

    result = result.faces(">Z").workplane().pushPoints(holes).hole(hole_d)
    return result
