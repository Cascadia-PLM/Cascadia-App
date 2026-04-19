"""Tests for parameter validation."""

from __future__ import annotations

import pytest

from cad_generator.validation import TEMPLATE_SCHEMAS, validate_parameters


class TestValidateParameters:
    def test_valid_bushing(self):
        result = validate_parameters("bushing", {"od": 20, "id": 10, "length": 30})
        assert result == {"od": 20, "id": 10, "length": 30}

    def test_valid_plate_with_optional(self):
        result = validate_parameters(
            "plate",
            {"width": 100, "height": 50, "thickness": 5, "corner_radius": 3},
        )
        assert result["corner_radius"] == 3

    def test_valid_plate_without_optional(self):
        result = validate_parameters(
            "plate", {"width": 100, "height": 50, "thickness": 5}
        )
        assert "corner_radius" not in result

    def test_unknown_template(self):
        with pytest.raises(ValueError, match="Unknown template"):
            validate_parameters("nonexistent", {"a": 1})

    def test_missing_required_param(self):
        with pytest.raises(ValueError, match="Missing required parameters"):
            validate_parameters("bushing", {"od": 20, "id": 10})

    def test_missing_multiple_required_params(self):
        with pytest.raises(ValueError, match="Missing required parameters"):
            validate_parameters("bushing", {"od": 20})

    def test_unknown_param(self):
        with pytest.raises(ValueError, match="Unknown parameter"):
            validate_parameters(
                "bushing", {"od": 20, "id": 10, "length": 30, "color": 5}
            )

    def test_non_positive_value_zero(self):
        with pytest.raises(ValueError, match="must be a positive number"):
            validate_parameters("bushing", {"od": 20, "id": 0, "length": 30})

    def test_non_positive_value_negative(self):
        with pytest.raises(ValueError, match="must be a positive number"):
            validate_parameters("bushing", {"od": 20, "id": -5, "length": 30})

    def test_non_numeric_value(self):
        with pytest.raises(ValueError, match="must be a positive number"):
            validate_parameters("bushing", {"od": 20, "id": "ten", "length": 30})

    def test_integer_values_accepted(self):
        result = validate_parameters("bushing", {"od": 20, "id": 10, "length": 30})
        assert result["od"] == 20

    def test_float_values_accepted(self):
        result = validate_parameters(
            "bushing", {"od": 20.5, "id": 10.2, "length": 30.0}
        )
        assert result["od"] == 20.5

    def test_all_templates_have_schemas(self):
        """Every template in the schema dict has required and optional keys."""
        for name, schema in TEMPLATE_SCHEMAS.items():
            assert "required" in schema, f"Template '{name}' missing 'required'"
            assert "optional" in schema, f"Template '{name}' missing 'optional'"
            assert len(schema["required"]) > 0, (
                f"Template '{name}' has no required params"
            )

    def test_plate_with_holes_all_optional(self):
        result = validate_parameters(
            "plate_with_holes",
            {
                "width": 200,
                "height": 100,
                "thickness": 8,
                "hole_diameter": 10,
                "corner_radius": 3,
                "hole_count_x": 4,
                "hole_count_y": 3,
                "hole_margin_x": 20,
                "hole_margin_y": 15,
            },
        )
        assert result["hole_count_x"] == 4

    def test_bracket_l_all_optional(self):
        result = validate_parameters(
            "bracket_l",
            {
                "leg1_length": 80,
                "leg2_length": 60,
                "width": 30,
                "thickness": 5,
                "fillet_radius": 3,
                "hole_diameter": 5,
                "holes_leg1": 2,
                "holes_leg2": 1,
            },
        )
        assert result["fillet_radius"] == 3
