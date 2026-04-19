"""Template parameter validation schemas and validation function."""

from __future__ import annotations

TEMPLATE_SCHEMAS: dict[str, dict[str, list[str]]] = {
    "bushing": {"required": ["od", "id", "length"], "optional": []},
    "spacer": {"required": ["od", "id", "length"], "optional": []},
    "tube": {"required": ["od", "wall_thickness", "length"], "optional": []},
    "plate": {
        "required": ["width", "height", "thickness"],
        "optional": ["corner_radius"],
    },
    "plate_with_holes": {
        "required": ["width", "height", "thickness", "hole_diameter"],
        "optional": [
            "corner_radius",
            "hole_count_x",
            "hole_count_y",
            "hole_margin_x",
            "hole_margin_y",
        ],
    },
    "block": {
        "required": ["width", "depth", "height"],
        "optional": ["corner_radius"],
    },
    "bracket_l": {
        "required": ["leg1_length", "leg2_length", "width", "thickness"],
        "optional": ["fillet_radius", "hole_diameter", "holes_leg1", "holes_leg2"],
    },
    "bracket_u": {
        "required": ["base_length", "leg_height", "width", "thickness"],
        "optional": ["fillet_radius"],
    },
    "extrusion_rectangular": {
        "required": ["width", "height", "length"],
        "optional": ["wall_thickness"],
    },
    "extrusion_circular": {
        "required": ["diameter", "length"],
        "optional": ["wall_thickness"],
    },
}


def validate_parameters(
    template_name: str, parameters: dict[str, float]
) -> dict[str, float]:
    """Validate and return cleaned parameters. Raises ValueError on invalid input."""
    schema = TEMPLATE_SCHEMAS.get(template_name)
    if not schema:
        raise ValueError(f"Unknown template: {template_name}")

    # Check required params exist
    missing = [p for p in schema["required"] if p not in parameters]
    if missing:
        raise ValueError(
            f"Missing required parameters for {template_name}: {missing}"
        )

    # Check all params are known and positive numbers
    for key, val in parameters.items():
        if key not in schema["required"] and key not in schema["optional"]:
            raise ValueError(
                f"Unknown parameter '{key}' for template {template_name}"
            )
        if not isinstance(val, (int, float)) or val <= 0:
            raise ValueError(
                f"Parameter '{key}' must be a positive number, got {val}"
            )

    return parameters


# ---------------------------------------------------------------------------
# Mechanism template validation
# ---------------------------------------------------------------------------

MECHANISM_SCHEMAS: dict[str, dict[str, list[str]]] = {
    "rack_and_pinion": {
        "required": [
            "module",
            "rack_length",
            "rack_height",
            "rack_thickness",
            "pinion_teeth",
            "pinion_face_width",
        ],
        "optional": [
            "pressure_angle",
            "pinion_bore_diameter",
            "pinion_hub_diameter",
            "pinion_hub_length",
        ],
        "roles": ["rack", "pinion"],
    },
}


def validate_mechanism_parameters(
    mechanism_type: str, parameters: dict[str, float]
) -> dict[str, float]:
    """Validate mechanism parameters. Raises ValueError on invalid input."""
    schema = MECHANISM_SCHEMAS.get(mechanism_type)
    if not schema:
        raise ValueError(f"Unknown mechanism type: {mechanism_type}")

    # Check required params
    missing = [p for p in schema["required"] if p not in parameters]
    if missing:
        raise ValueError(
            f"Missing required parameters for {mechanism_type}: {missing}"
        )

    # Check all params are known
    known = set(schema["required"]) | set(schema["optional"])
    for key, val in parameters.items():
        if key not in known:
            raise ValueError(
                f"Unknown parameter '{key}' for mechanism {mechanism_type}"
            )
        if not isinstance(val, (int, float)) or val <= 0:
            raise ValueError(
                f"Parameter '{key}' must be a positive number, got {val}"
            )

    # Mechanism-specific validation
    if mechanism_type == "rack_and_pinion":
        if parameters["pinion_teeth"] < 6:
            raise ValueError("pinion_teeth must be >= 6 to avoid undercut")
        if parameters["pinion_teeth"] % 1 != 0:
            raise ValueError("pinion_teeth must be an integer")
        pa = parameters.get("pressure_angle")
        if pa is not None and (pa < 14.5 or pa > 25):
            raise ValueError("pressure_angle must be between 14.5 and 25 degrees")
        hub_d = parameters.get("pinion_hub_diameter")
        bore_d = parameters.get("pinion_bore_diameter")
        if hub_d is not None and bore_d is not None and hub_d <= bore_d:
            raise ValueError(
                "pinion_hub_diameter must be larger than pinion_bore_diameter"
            )

    return parameters
