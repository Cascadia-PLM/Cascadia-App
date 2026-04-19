"""L-bracket template — two legs with optional fillet and mounting holes."""

from __future__ import annotations

import cadquery as cq


def make_bracket_l(params: dict[str, float]) -> cq.Workplane:
    l1 = params["leg1_length"]
    l2 = params["leg2_length"]
    w = params["width"]
    t = params["thickness"]
    fr = params.get("fillet_radius")
    hd = params.get("hole_diameter")
    h1 = int(params.get("holes_leg1", 0))
    h2 = int(params.get("holes_leg2", 0))

    # Build L-profile as 2D sketch then extrude
    result = (
        cq.Workplane("XZ")
        .moveTo(0, 0)
        .lineTo(l1, 0)
        .lineTo(l1, t)
        .lineTo(t, t)
        .lineTo(t, l2)
        .lineTo(0, l2)
        .close()
        .extrude(w)
    )

    if fr and fr > 0:
        # Fillet the inner corner
        result = result.edges("|Y").fillet(min(fr, t * 0.9))

    if hd and hd > 0:
        # Add mounting holes on leg1 (bottom face)
        if h1 > 0:
            spacing1 = (l1 - 2 * t) / max(h1, 1)
            pts1 = [(t + spacing1 * (i + 0.5), w / 2) for i in range(h1)]
            result = result.faces("<Z").workplane().pushPoints(pts1).hole(hd)
        # Add mounting holes on leg2 (back face)
        if h2 > 0:
            spacing2 = (l2 - 2 * t) / max(h2, 1)
            pts2 = [(w / 2, t + spacing2 * (i + 0.5)) for i in range(h2)]
            result = result.faces("<X").workplane().pushPoints(pts2).hole(hd)

    return result
