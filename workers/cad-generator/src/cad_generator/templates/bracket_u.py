"""U-bracket template — base with two upright legs."""

from __future__ import annotations

import cadquery as cq


def make_bracket_u(params: dict[str, float]) -> cq.Workplane:
    bl = params["base_length"]
    lh = params["leg_height"]
    w = params["width"]
    t = params["thickness"]
    fr = params.get("fillet_radius")

    # Build U-profile as 2D sketch then extrude
    result = (
        cq.Workplane("XZ")
        .moveTo(0, 0)
        .lineTo(bl, 0)
        .lineTo(bl, lh)
        .lineTo(bl - t, lh)
        .lineTo(bl - t, t)
        .lineTo(t, t)
        .lineTo(t, lh)
        .lineTo(0, lh)
        .close()
        .extrude(w)
    )

    if fr and fr > 0:
        result = result.edges("|Y").fillet(min(fr, t * 0.9))

    return result
