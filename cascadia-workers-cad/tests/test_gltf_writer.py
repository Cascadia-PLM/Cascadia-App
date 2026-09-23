# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Cascadia PLM LLC

"""
Unit tests for the glTF writer's pure arithmetic.

Only the placement matrix is covered, and deliberately so: it is the one piece
of this module that fails *quietly*. A transposed rotation still loads, still
renders, and still puts every part somewhere plausible — it just puts them in
the wrong place, at angles that look almost right. Everything else here either
raises or produces a file no viewer will open.

`pytest.importorskip` because the module reaches OCCT at import time, and
pythonocc is a conda dependency the pure-Python test environments do not carry.
"""

from __future__ import annotations

import pytest

pytest.importorskip("OCC", reason="pythonocc-core not installed")

from cad_converter.gltf_writer import _location_to_gltf_matrix  # noqa: E402


class _FakeTrsf:
    """A `gp_Trsf` as far as `_location_to_gltf_matrix` is concerned.

    Holds the top three rows of a 4x4 in row-major order and answers
    `Value(row, col)` 1-indexed, the way OCCT does.
    """

    def __init__(self, rows: list[list[float]]) -> None:
        self._rows = rows

    def Value(self, row: int, col: int) -> float:  # noqa: N802 - OCCT's name
        return self._rows[row - 1][col - 1]


class _FakeLocation:
    def __init__(self, rows: list[list[float]] | None) -> None:
        self._rows = rows

    def IsIdentity(self) -> bool:  # noqa: N802 - OCCT's name
        return self._rows is None

    def Transformation(self) -> _FakeTrsf:  # noqa: N802 - OCCT's name
        assert self._rows is not None
        return _FakeTrsf(self._rows)


class TestLocationToGltfMatrix:
    def test_identity_is_omitted(self):
        """An identity placement returns None, so no matrix is written."""
        assert _location_to_gltf_matrix(_FakeLocation(None)) is None

    def test_none_is_omitted(self):
        assert _location_to_gltf_matrix(None) is None

    def test_pure_translation(self):
        """Translation lands in elements 12..14 — the last column."""
        matrix = _location_to_gltf_matrix(
            _FakeLocation([
                [1.0, 0.0, 0.0, 10.0],
                [0.0, 1.0, 0.0, 20.0],
                [0.0, 0.0, 1.0, 30.0],
            ])
        )

        assert matrix == [
            1.0, 0.0, 0.0, 0.0,
            0.0, 1.0, 0.0, 0.0,
            0.0, 0.0, 1.0, 0.0,
            10.0, 20.0, 30.0, 1.0,
        ]

    def test_rotation_is_transposed_to_column_major(self):
        """
        The invariant that matters: glTF is column-major, `Value(row, col)` is
        row-major, so the output is the transpose of the input's top-left 3x3.

        A 90 degree rotation about Z is asymmetric, so a missing transpose
        shows up as the inverse rotation rather than as an identical array.
        """
        matrix = _location_to_gltf_matrix(
            _FakeLocation([
                [0.0, -1.0, 0.0, 0.0],
                [1.0, 0.0, 0.0, 0.0],
                [0.0, 0.0, 1.0, 0.0],
            ])
        )
        assert matrix is not None

        # Column c of the glTF array is rows 1..3 at column c, then 0 or 1.
        assert matrix[0:4] == [0.0, 1.0, 0.0, 0.0]  # first basis column
        assert matrix[4:8] == [-1.0, 0.0, 0.0, 0.0]  # second
        assert matrix[8:12] == [0.0, 0.0, 1.0, 0.0]  # third
        assert matrix[12:16] == [0.0, 0.0, 0.0, 1.0]  # translation

    def test_bottom_row_is_affine(self):
        """Every basis column ends in 0 and the translation column in 1."""
        matrix = _location_to_gltf_matrix(
            _FakeLocation([
                [2.0, 3.0, 5.0, 7.0],
                [11.0, 13.0, 17.0, 19.0],
                [23.0, 29.0, 31.0, 37.0],
            ])
        )
        assert matrix is not None
        assert [matrix[3], matrix[7], matrix[11], matrix[15]] == [0.0, 0.0, 0.0, 1.0]

    def test_length_is_sixteen(self):
        matrix = _location_to_gltf_matrix(
            _FakeLocation([
                [1.0, 0.0, 0.0, 1.0],
                [0.0, 1.0, 0.0, 2.0],
                [0.0, 0.0, 1.0, 3.0],
            ])
        )
        assert matrix is not None
        assert len(matrix) == 16
