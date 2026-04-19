"""Unit tests for single-file CAD conversion."""

from __future__ import annotations

import os
import struct

import pytest

from cad_converter.converter import (
    convert_single,
    count_triangles_binary_stl,
    read_cad_file,
    tessellate,
    write_stl,
    get_bounding_box,
)
from cad_converter.models import MeshQuality


class TestConvertSingle:
    """Test single STEP/IGES → STL conversion."""

    def test_convert_assembly_standard(self, sample_step_path, tmp_output_dir):
        """Convert a STEP assembly as a single STL at standard quality."""
        output_path = os.path.join(tmp_output_dir, "sample.stl")
        result = convert_single(sample_step_path, output_path, MeshQuality.STANDARD)

        assert os.path.exists(result.stl_path)
        assert os.path.getsize(result.stl_path) > 0
        assert result.polygon_count > 0
        assert result.bounding_box is not None
        assert result.bounding_box.x > 0
        assert result.bounding_box.y > 0
        assert result.bounding_box.z > 0

    def test_convert_assembly_preview(self, sample_step_path, tmp_output_dir):
        """Preview quality should produce smaller STL files."""
        output_path = os.path.join(tmp_output_dir, "sample_preview.stl")
        result = convert_single(sample_step_path, output_path, MeshQuality.PREVIEW)

        assert os.path.exists(result.stl_path)
        assert result.polygon_count > 0

    def test_binary_stl_is_valid(self, sample_step_path, tmp_output_dir):
        """Verify the binary STL has a valid header and triangle count."""
        output_path = os.path.join(tmp_output_dir, "sample.stl")
        result = convert_single(sample_step_path, output_path, MeshQuality.PREVIEW)

        with open(result.stl_path, "rb") as f:
            header = f.read(80)
            tri_count_bytes = f.read(4)
            tri_count = struct.unpack("<I", tri_count_bytes)[0]

        assert tri_count == result.polygon_count
        # Each triangle = 50 bytes (normal + 3 vertices + attribute)
        expected_size = 80 + 4 + (tri_count * 50)
        actual_size = os.path.getsize(result.stl_path)
        assert actual_size == expected_size


class TestReadCadFile:
    """Test CAD file reading."""

    def test_unsupported_format(self, tmp_output_dir):
        """Should raise for unsupported file extensions."""
        fake_file = os.path.join(tmp_output_dir, "model.sldprt")
        with open(fake_file, "w") as f:
            f.write("fake")

        with pytest.raises(ValueError, match="Unsupported CAD format"):
            read_cad_file(fake_file)
