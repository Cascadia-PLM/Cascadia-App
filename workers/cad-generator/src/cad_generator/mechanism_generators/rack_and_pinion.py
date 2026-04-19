"""Rack-and-pinion mechanism generator.

Generates a meshing rack and spur pinion gear pair with correct involute
tooth profiles using the cq-gears library. Returns two CadQuery Workplanes
(rack and pinion) plus computed engineering metadata.
"""

from __future__ import annotations

import math
from typing import Any

import cadquery as cq
from cq_gears import SpurGear, RackGear


def generate_rack_and_pinion(
    params: dict[str, float],
) -> tuple[dict[str, cq.Workplane], dict[str, Any]]:
    """Generate a meshing rack and pinion gear pair.

    Parameters
    ----------
    params : dict with keys:
        module : float          - Gear module (mm)
        rack_length : float     - Total rack length (mm)
        rack_height : float     - Rack body height below pitch line (mm)
        rack_thickness : float  - Rack face width / thickness (mm)
        pinion_teeth : int      - Number of pinion teeth (>= 6)
        pinion_face_width : float - Pinion face width (mm)
        pressure_angle : float  - Pressure angle in degrees (default 20)
        pinion_bore_diameter : float - Center bore diameter (optional)
        pinion_hub_diameter : float  - Hub boss diameter (optional)
        pinion_hub_length : float    - Hub boss length (optional)

    Returns
    -------
    (outputs, metadata) where outputs maps role -> cq.Workplane
    and metadata contains computed engineering values.
    """
    mod = params["module"]
    rack_length = params["rack_length"]
    rack_height = params["rack_height"]
    rack_thickness = params["rack_thickness"]
    pinion_teeth = int(params["pinion_teeth"])
    pinion_face_width = params["pinion_face_width"]
    pressure_angle = params.get("pressure_angle", 20.0)
    bore_d = params.get("pinion_bore_diameter")
    hub_d = params.get("pinion_hub_diameter")
    hub_l = params.get("pinion_hub_length")

    # --- Computed gear geometry ---
    pitch_diameter = mod * pinion_teeth
    pitch_radius = pitch_diameter / 2.0
    addendum = mod
    dedendum = 1.25 * mod
    tooth_pitch = mod * math.pi
    rack_tooth_count = int(rack_length / tooth_pitch)
    linear_per_rev = pitch_diameter * math.pi

    # --- Generate rack using cq-gears ---
    rack_gear = RackGear(
        module=mod,
        length=rack_length,
        width=rack_thickness,
        height=rack_height,
        pressure_angle=pressure_angle,
    )
    rack_wp = cq.Workplane("XY").gear(rack_gear)

    # --- Generate pinion using cq-gears ---
    build_params: dict[str, float] = {}
    if bore_d is not None:
        build_params["bore_d"] = bore_d
    if hub_d is not None:
        build_params["hub_d"] = hub_d
    if hub_l is not None:
        build_params["hub_length"] = hub_l

    pinion_gear = SpurGear(
        module=mod,
        teeth_number=pinion_teeth,
        width=pinion_face_width,
        pressure_angle=pressure_angle,
        **build_params,
    )
    pinion_wp = cq.Workplane("XY").gear(pinion_gear)

    # --- Metadata ---
    metadata: dict[str, Any] = {
        "module": mod,
        "pressureAngleDeg": pressure_angle,
        "pinionTeeth": pinion_teeth,
        "pitchDiameterMm": round(pitch_diameter, 3),
        "pitchRadiusMm": round(pitch_radius, 3),
        "addendumMm": round(addendum, 3),
        "dedendumMm": round(dedendum, 3),
        "toothPitchMm": round(tooth_pitch, 3),
        "rackToothCount": rack_tooth_count,
        "linearTravelPerRevolutionMm": round(linear_per_rev, 3),
        "centerDistanceMm": round(pitch_radius + rack_height + addendum, 3),
    }

    if bore_d is not None:
        metadata["pinionBoreDiameterMm"] = bore_d
    if hub_d is not None:
        metadata["pinionHubDiameterMm"] = hub_d
    if hub_l is not None:
        metadata["pinionHubLengthMm"] = hub_l

    return {"rack": rack_wp, "pinion": pinion_wp}, metadata
