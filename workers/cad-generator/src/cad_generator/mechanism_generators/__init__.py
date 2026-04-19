"""Mechanism generator registry — maps mechanism types to generator functions."""

from __future__ import annotations

from typing import Any, Callable

import cadquery as cq

# Generator signature: params dict -> (outputs dict of role->Workplane, metadata dict)
MechanismGeneratorFn = Callable[
    [dict[str, float]], tuple[dict[str, cq.Workplane], dict[str, Any]]
]

from .rack_and_pinion import generate_rack_and_pinion

MECHANISM_REGISTRY: dict[str, MechanismGeneratorFn] = {
    "rack_and_pinion": generate_rack_and_pinion,
}
