"""Template registry — maps template names to generator functions."""

from __future__ import annotations

from typing import Callable

import cadquery as cq

from .block import make_block
from .bracket_l import make_bracket_l
from .bracket_u import make_bracket_u
from .bushing import make_bushing
from .extrusion_circular import make_extrusion_circular
from .extrusion_rectangular import make_extrusion_rectangular
from .plate import make_plate
from .plate_with_holes import make_plate_with_holes
from .spacer import make_spacer
from .tube import make_tube

TEMPLATE_REGISTRY: dict[str, Callable[[dict[str, float]], cq.Workplane]] = {
    "bushing": make_bushing,
    "spacer": make_spacer,
    "tube": make_tube,
    "plate": make_plate,
    "plate_with_holes": make_plate_with_holes,
    "block": make_block,
    "bracket_l": make_bracket_l,
    "bracket_u": make_bracket_u,
    "extrusion_rectangular": make_extrusion_rectangular,
    "extrusion_circular": make_extrusion_circular,
}
