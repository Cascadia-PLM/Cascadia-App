"""Tests for assembly composition — transform convention and STEP round-trip.

The rotation convention (rotateX -> rotateY -> rotateZ about the global
origin, degrees, then translate) must match the TypeScript KCL generator
(src/lib/cad-generation/kcl-generator.ts). A silent order/axis mismatch
would produce plausible-but-wrong assemblies, so these tests pin it.
"""

from __future__ import annotations

import os
import tempfile

import cadquery as cq
import pytest

from cad_generator.assembly import (
    apply_placement_transform,
    compose_assembly,
    compute_assembly_bounding_box,
)
from cad_generator.models import PlacementTransform, Vector3


def _transform(tx=0.0, ty=0.0, tz=0.0, rx=0.0, ry=0.0, rz=0.0) -> PlacementTransform:
    return PlacementTransform(
        translation=Vector3(x=tx, y=ty, z=tz),
        rotation=Vector3(x=rx, y=ry, z=rz),
    )


class TestPlacementTransform:
    def test_identity_is_noop(self):
        wp = cq.Workplane("XY").box(10, 20, 30)
        out = apply_placement_transform(wp, _transform())
        bb = out.val().BoundingBox()
        assert bb.xmax - bb.xmin == pytest.approx(10, abs=0.1)
        assert bb.ymax - bb.ymin == pytest.approx(20, abs=0.1)
        assert bb.zmax - bb.zmin == pytest.approx(30, abs=0.1)

    def test_rotation_z90_swaps_xy_extents(self):
        wp = cq.Workplane("XY").box(10, 20, 30)
        out = apply_placement_transform(wp, _transform(rz=90))
        bb = out.val().BoundingBox()
        assert bb.xmax - bb.xmin == pytest.approx(20, abs=0.1)
        assert bb.ymax - bb.ymin == pytest.approx(10, abs=0.1)
        assert bb.zmax - bb.zmin == pytest.approx(30, abs=0.1)

    def test_rotate_before_translate(self):
        # Rotation happens about the global origin BEFORE translation, so a
        # translated part keeps its translation instead of being swept
        # around the origin.
        wp = cq.Workplane("XY").box(10, 20, 30)
        out = apply_placement_transform(wp, _transform(tx=100, rz=90))
        bb = out.val().BoundingBox()
        assert (bb.xmin + bb.xmax) / 2 == pytest.approx(100, abs=0.1)
        assert (bb.ymin + bb.ymax) / 2 == pytest.approx(0, abs=0.1)
        # Extents reflect the rotation
        assert bb.xmax - bb.xmin == pytest.approx(20, abs=0.1)
        assert bb.ymax - bb.ymin == pytest.approx(10, abs=0.1)

    def test_euler_order_is_x_then_z(self):
        # A bar along +Z (10x10x100). Rx(90) maps +Z to -Y; Rz(90) then maps
        # -Y to +X. Applied X -> Y -> Z, the long axis ends along X.
        # If the order were Z-first, Rz would leave +Z unchanged and Rx
        # would put the long axis along Y — distinguishable by extents.
        wp = cq.Workplane("XY").box(10, 10, 100)
        out = apply_placement_transform(wp, _transform(rx=90, rz=90))
        bb = out.val().BoundingBox()
        assert bb.xmax - bb.xmin == pytest.approx(100, abs=0.1)
        assert bb.ymax - bb.ymin == pytest.approx(10, abs=0.1)
        assert bb.zmax - bb.zmin == pytest.approx(10, abs=0.1)


class TestComposeAssembly:
    def test_two_parts_bounding_box(self):
        a = cq.Workplane("XY").box(10, 10, 10)
        b = apply_placement_transform(
            cq.Workplane("XY").box(10, 10, 10), _transform(tx=20)
        )
        asm = compose_assembly("Test Assembly", [("part_a", a), ("part_b", b)])
        bb = compute_assembly_bounding_box(asm)
        # a spans -5..5, b spans 15..25
        assert bb.minX == pytest.approx(-5, abs=0.1)
        assert bb.maxX == pytest.approx(25, abs=0.1)
        assert bb.maxY - bb.minY == pytest.approx(10, abs=0.1)

    def test_step_roundtrip(self):
        a = cq.Workplane("XY").box(10, 10, 10)
        b = apply_placement_transform(
            cq.Workplane("XY").box(10, 10, 10), _transform(tx=20)
        )
        asm = compose_assembly("Roundtrip", [("part_a", a), ("part_b", b)])

        with tempfile.TemporaryDirectory() as tmp_dir:
            path = os.path.join(tmp_dir, "roundtrip.step")
            asm.save(path, exportType="STEP")
            assert os.path.exists(path)
            assert os.path.getsize(path) > 0

            # Re-import: transforms must be baked into the geometry
            reimported = cq.importers.importStep(path)
            bb = reimported.val().BoundingBox()
            assert bb.xmax - bb.xmin == pytest.approx(30, abs=0.5)

    def test_duplicate_names_are_deduplicated(self):
        a = cq.Workplane("XY").box(5, 5, 5)
        b = apply_placement_transform(
            cq.Workplane("XY").box(5, 5, 5), _transform(tx=10)
        )
        # Same part name twice must not collide in the XDE document
        asm = compose_assembly("Dedup", [("bracket", a), ("bracket", b)])
        names = [child.name for child in asm.children]
        assert len(names) == len(set(names))
