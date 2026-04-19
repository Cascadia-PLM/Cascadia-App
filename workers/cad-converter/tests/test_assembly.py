"""Tests for assembly decomposition."""

from __future__ import annotations

import os

import pytest

from cad_converter.assembly import decompose_step_assembly
from cad_converter.models import MeshQuality


class TestDecomposeAssembly:
    """Test STEP assembly decomposition into individual parts."""

    def test_decompose_assembly(self, sample_step_path, tmp_output_dir):
        """Decompose a STEP assembly into individual part STL files."""
        progress_log: list[tuple[int, str]] = []

        def on_progress(pct: int, msg: str) -> None:
            progress_log.append((pct, msg))

        results = decompose_step_assembly(
            sample_step_path,
            tmp_output_dir,
            quality=MeshQuality.PREVIEW,  # Use preview for speed
            binary_stl=True,
            progress_callback=on_progress,
        )

        # Should extract multiple parts
        assert len(results) > 1, f"Expected multiple parts, got {len(results)}"

        # All output files should exist and have content
        for r in results:
            assert os.path.exists(r.stl_path), f"Missing STL: {r.stl_path}"
            assert os.path.getsize(r.stl_path) > 0, f"Empty STL: {r.stl_path}"
            assert r.polygon_count > 0, f"No polygons: {r.part_name}"
            assert r.part_name, "Empty part name"

        # Progress should have been reported
        assert len(progress_log) > 0
        # Final progress should be 100%
        assert progress_log[-1][0] == 100

        # Total polygon count should be substantial
        total_polys = sum(r.polygon_count for r in results)
        assert total_polys > 1000, f"Suspiciously low polygon count: {total_polys}"

    def test_decompose_produces_unique_filenames(self, sample_step_path, tmp_output_dir):
        """Output STL filenames should be unique even for duplicate part names."""
        results = decompose_step_assembly(
            sample_step_path,
            tmp_output_dir,
            quality=MeshQuality.PREVIEW,
        )

        stl_paths = [r.stl_path for r in results]
        assert len(stl_paths) == len(set(stl_paths)), "Duplicate STL file paths detected"
