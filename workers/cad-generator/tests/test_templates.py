"""Tests for parametric CAD templates — verify each template generates valid geometry."""

from __future__ import annotations

import os
import tempfile

import cadquery as cq
import pytest

from cad_generator.export import compute_bounding_box, export_step
from cad_generator.templates import TEMPLATE_REGISTRY
from cad_generator.templates.block import make_block
from cad_generator.templates.bracket_l import make_bracket_l
from cad_generator.templates.bracket_u import make_bracket_u
from cad_generator.templates.bushing import make_bushing
from cad_generator.templates.extrusion_circular import make_extrusion_circular
from cad_generator.templates.extrusion_rectangular import make_extrusion_rectangular
from cad_generator.templates.plate import make_plate
from cad_generator.templates.plate_with_holes import make_plate_with_holes
from cad_generator.templates.spacer import make_spacer
from cad_generator.templates.tube import make_tube


def _assert_valid_workplane(wp: cq.Workplane) -> None:
    """Assert that the workplane contains a valid solid."""
    solid = wp.val()
    assert solid is not None
    bb = solid.BoundingBox()
    assert bb.xmax > bb.xmin
    assert bb.ymax > bb.ymin
    assert bb.zmax > bb.zmin


def _assert_exports_step(wp: cq.Workplane) -> None:
    """Assert that the workplane can be exported to a STEP file."""
    with tempfile.TemporaryDirectory() as tmp_dir:
        path = os.path.join(tmp_dir, "test.step")
        export_step(wp, path)
        assert os.path.exists(path)
        assert os.path.getsize(path) > 0


class TestBushing:
    def test_basic(self):
        wp = make_bushing({"od": 20, "id": 10, "length": 30})
        _assert_valid_workplane(wp)

    def test_export_step(self):
        wp = make_bushing({"od": 20, "id": 10, "length": 30})
        _assert_exports_step(wp)

    def test_bounding_box(self):
        wp = make_bushing({"od": 20, "id": 10, "length": 30})
        bbox = compute_bounding_box(wp)
        assert bbox.maxX - bbox.minX == pytest.approx(20, abs=0.1)
        assert bbox.maxY - bbox.minY == pytest.approx(20, abs=0.1)
        assert bbox.maxZ - bbox.minZ == pytest.approx(30, abs=0.1)


class TestSpacer:
    def test_basic(self):
        wp = make_spacer({"od": 15, "id": 8, "length": 5})
        _assert_valid_workplane(wp)

    def test_export_step(self):
        wp = make_spacer({"od": 15, "id": 8, "length": 5})
        _assert_exports_step(wp)


class TestTube:
    def test_basic(self):
        wp = make_tube({"od": 25, "wall_thickness": 2, "length": 100})
        _assert_valid_workplane(wp)

    def test_export_step(self):
        wp = make_tube({"od": 25, "wall_thickness": 2, "length": 100})
        _assert_exports_step(wp)


class TestPlate:
    def test_basic(self):
        wp = make_plate({"width": 100, "height": 50, "thickness": 5})
        _assert_valid_workplane(wp)

    def test_with_corner_radius(self):
        wp = make_plate(
            {"width": 100, "height": 50, "thickness": 5, "corner_radius": 3}
        )
        _assert_valid_workplane(wp)

    def test_export_step(self):
        wp = make_plate({"width": 100, "height": 50, "thickness": 5})
        _assert_exports_step(wp)


class TestPlateWithHoles:
    def test_basic(self):
        wp = make_plate_with_holes(
            {"width": 100, "height": 60, "thickness": 5, "hole_diameter": 6}
        )
        _assert_valid_workplane(wp)

    def test_custom_hole_grid(self):
        wp = make_plate_with_holes(
            {
                "width": 200,
                "height": 100,
                "thickness": 8,
                "hole_diameter": 10,
                "hole_count_x": 4,
                "hole_count_y": 3,
                "hole_margin_x": 20,
                "hole_margin_y": 15,
            }
        )
        _assert_valid_workplane(wp)

    def test_export_step(self):
        wp = make_plate_with_holes(
            {"width": 100, "height": 60, "thickness": 5, "hole_diameter": 6}
        )
        _assert_exports_step(wp)


class TestBlock:
    def test_basic(self):
        wp = make_block({"width": 50, "depth": 30, "height": 20})
        _assert_valid_workplane(wp)

    def test_with_corner_radius(self):
        wp = make_block(
            {"width": 50, "depth": 30, "height": 20, "corner_radius": 2}
        )
        _assert_valid_workplane(wp)

    def test_export_step(self):
        wp = make_block({"width": 50, "depth": 30, "height": 20})
        _assert_exports_step(wp)


class TestBracketL:
    def test_basic(self):
        wp = make_bracket_l(
            {"leg1_length": 80, "leg2_length": 60, "width": 30, "thickness": 5}
        )
        _assert_valid_workplane(wp)

    def test_with_fillet(self):
        wp = make_bracket_l(
            {
                "leg1_length": 80,
                "leg2_length": 60,
                "width": 30,
                "thickness": 5,
                "fillet_radius": 3,
            }
        )
        _assert_valid_workplane(wp)

    def test_with_holes(self):
        wp = make_bracket_l(
            {
                "leg1_length": 80,
                "leg2_length": 60,
                "width": 30,
                "thickness": 5,
                "hole_diameter": 5,
                "holes_leg1": 2,
                "holes_leg2": 1,
            }
        )
        _assert_valid_workplane(wp)

    def test_export_step(self):
        wp = make_bracket_l(
            {"leg1_length": 80, "leg2_length": 60, "width": 30, "thickness": 5}
        )
        _assert_exports_step(wp)


class TestBracketU:
    def test_basic(self):
        wp = make_bracket_u(
            {"base_length": 60, "leg_height": 40, "width": 25, "thickness": 4}
        )
        _assert_valid_workplane(wp)

    def test_with_fillet(self):
        wp = make_bracket_u(
            {
                "base_length": 60,
                "leg_height": 40,
                "width": 25,
                "thickness": 4,
                "fillet_radius": 2,
            }
        )
        _assert_valid_workplane(wp)

    def test_export_step(self):
        wp = make_bracket_u(
            {"base_length": 60, "leg_height": 40, "width": 25, "thickness": 4}
        )
        _assert_exports_step(wp)


class TestExtrusionRectangular:
    def test_solid(self):
        wp = make_extrusion_rectangular(
            {"width": 40, "height": 20, "length": 200}
        )
        _assert_valid_workplane(wp)

    def test_hollow(self):
        wp = make_extrusion_rectangular(
            {"width": 40, "height": 20, "length": 200, "wall_thickness": 2}
        )
        _assert_valid_workplane(wp)

    def test_export_step(self):
        wp = make_extrusion_rectangular(
            {"width": 40, "height": 20, "length": 200}
        )
        _assert_exports_step(wp)


class TestExtrusionCircular:
    def test_solid(self):
        wp = make_extrusion_circular({"diameter": 30, "length": 150})
        _assert_valid_workplane(wp)

    def test_hollow(self):
        wp = make_extrusion_circular(
            {"diameter": 30, "length": 150, "wall_thickness": 2}
        )
        _assert_valid_workplane(wp)

    def test_export_step(self):
        wp = make_extrusion_circular({"diameter": 30, "length": 150})
        _assert_exports_step(wp)


class TestRegistry:
    def test_all_templates_registered(self):
        expected = {
            "bushing",
            "spacer",
            "tube",
            "plate",
            "plate_with_holes",
            "block",
            "bracket_l",
            "bracket_u",
            "extrusion_rectangular",
            "extrusion_circular",
        }
        assert set(TEMPLATE_REGISTRY.keys()) == expected

    def test_all_templates_callable(self):
        for name, fn in TEMPLATE_REGISTRY.items():
            assert callable(fn), f"Template '{name}' is not callable"
