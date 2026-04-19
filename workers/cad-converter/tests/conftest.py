"""Shared fixtures for CAD converter tests."""

from __future__ import annotations

import os
import tempfile

import pytest


@pytest.fixture
def tmp_output_dir():
    """Create a temporary directory for test output files."""
    with tempfile.TemporaryDirectory(prefix="cad_test_") as d:
        yield d


@pytest.fixture
def sample_step_path():
    """Path to a local STEP file for integration testing.

    Not shipped with the repo. Set CASCADIA_SAMPLE_STEP to an absolute path to
    enable the fixture; tests that depend on it will skip otherwise.
    """
    path = os.environ.get("CASCADIA_SAMPLE_STEP")
    if not path or not os.path.exists(path):
        pytest.skip("CASCADIA_SAMPLE_STEP env var not set or file not found")
    return path
