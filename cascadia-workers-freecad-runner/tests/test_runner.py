# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Cascadia PLM LLC

"""The runner + harness process contract, driven end to end.

Security and data-integrity gate: a model-written script runs in a child
process that must not see the worker's credentials, must be killed at its
deadline, and must not be able to turn a failure into a success (or the other
way round) by exiting early. The real FreeCAD is conda-only, so these tests
point the harness at ``tests/fake_freecad`` through ``FREECAD_LIB_DIR`` —
what is under test is everything around the kernel, not the kernel.
"""

from __future__ import annotations

import importlib.util
import os
import sys
import tempfile

import pytest

from freecad_runner import runner
from freecad_runner.runner import build_result, execute_script

FAKE_LIB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fake_freecad")


@pytest.fixture(autouse=True)
def _fake_freecad(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(runner.settings, "freecad_python", sys.executable)
    monkeypatch.setattr(runner.settings, "freecad_lib_dir", FAKE_LIB)
    monkeypatch.setattr(runner.settings, "output_capture_chars", 8000)
    # The worker's own credentials: the child must never see them.
    monkeypatch.setenv("DATABASE_URL", "postgresql://secret@db/cascadia")
    monkeypatch.setenv("RABBITMQ_URL", "amqp://secret@broker")


@pytest.fixture
def work_dir():
    with tempfile.TemporaryDirectory(prefix="freecad_test_") as d:
        yield d


def run(script: str, work_dir: str, timeout_ms: int = 30_000):
    return execute_script(script, timeout_ms=timeout_ms, work_dir=work_dir)


def test_a_valid_solid_is_reported_and_exported(work_dir):
    outcome = run(
        "import Part\nfrom FreeCAD import Base\n"
        "print('building')\n"
        "result = Part.makeBox(40, 20, 5, Base.Vector(-20, -10, 0))\n",
        work_dir,
    )

    assert outcome.infrastructure_error is None
    assert outcome.timed_out is False
    assert outcome.exit_code == 0
    assert outcome.report["ok"] is True
    assert outcome.report["freecadVersion"] == "1.1.3"
    assert outcome.step_path and os.path.getsize(outcome.step_path) > 0
    assert "building" in outcome.stdout

    result = build_result(outcome)
    assert result.ok is True
    assert result.errorMessage is None
    assert result.geometry is not None
    assert result.geometry.solidCount == 1
    assert result.geometry.volumeMm3 == pytest.approx(4000.0)
    assert result.geometry.boundingBox.minX == -20
    assert result.geometry.boundingBox.maxZ == 5


def test_the_child_never_sees_the_workers_credentials(work_dir):
    outcome = run("import Part\nresult = Part.makeBox(1, 1, 1)\n", work_dir)

    assert "DATABASE_URL=None" in outcome.stderr
    # HOME is the run's own directory, so FreeCAD's user files land there
    # and not in the worker's home.
    assert f"HOME={work_dir!r}" in outcome.stderr


def test_a_raising_script_reports_the_exception_with_its_own_frames_only(work_dir):
    outcome = run(
        "import Part\n"
        "def build():\n"
        "    return Part.makeBox(1, 1, undefined_height)\n"
        "result = build()\n",
        work_dir,
    )

    assert outcome.exit_code == 1
    assert outcome.report["ok"] is False
    assert outcome.report["errorMessage"].startswith("NameError")
    tb = outcome.report["traceback"]
    assert 'part_script.py", line 3' in tb
    assert "harness.py" not in tb

    result = build_result(outcome)
    assert result.ok is False
    assert result.errorMessage.startswith("NameError")


def test_a_script_that_forgets_result_is_told_so(work_dir):
    outcome = run("import Part\nbox = Part.makeBox(1, 1, 1)\n", work_dir)

    result = build_result(outcome)
    assert result.ok is False
    assert "did not assign `result`" in result.errorMessage
    assert result.geometry is None


def test_a_document_object_and_a_list_are_accepted(work_dir):
    outcome = run(
        "import Part\n"
        "feature = Part.Feature(Part.makeBox(10, 10, 10))\n"
        "result = [feature, Part.makeBox(5, 5, 5)]\n",
        work_dir,
    )

    result = build_result(outcome)
    assert result.ok is True
    assert result.geometry.solidCount == 2
    # Two solids is legal but worth a word; it is advisory, not fatal.
    assert any("2 solids" in issue for issue in result.issues)


def test_an_invalid_shape_is_a_failure(work_dir):
    outcome = run(
        "import Part\nresult = Part.Shape(10, 10, 10, valid=False)\n", work_dir
    )

    result = build_result(outcome)
    assert result.ok is False
    assert "isValid()" in result.errorMessage


def test_wrong_units_are_caught(work_dir):
    outcome = run("import Part\nresult = Part.makeBox(0.01, 0.01, 0.01)\n", work_dir)

    result = build_result(outcome)
    assert result.ok is False
    assert "millimetres" in result.errorMessage


def test_sys_exit_inside_the_script_cannot_fake_a_result(work_dir):
    # The static guard would refuse this; the harness must also hold when the
    # guard is bypassed, because SystemExit propagates through exec().
    outcome = run(
        "import Part\nresult = Part.makeBox(1, 1, 1)\nraise SystemExit(0)\n", work_dir
    )

    assert outcome.report["ok"] is False
    assert outcome.report["errorMessage"].startswith("SystemExit")


def test_blocked_imports_are_refused_at_run_time_too(work_dir):
    outcome = run("import Part\nimport os\nresult = Part.makeBox(1, 1, 1)\n", work_dir)

    result = build_result(outcome)
    assert result.ok is False
    assert result.errorMessage.startswith("ImportError")
    assert "'os' is not allowed" in result.errorMessage


def test_open_is_not_a_builtin_in_the_script(work_dir):
    outcome = run(
        "import Part\nopen('leak.txt', 'w').write('x')\nresult = Part.makeBox(1, 1, 1)\n",
        work_dir,
    )

    result = build_result(outcome)
    assert result.ok is False
    assert result.errorMessage.startswith("NameError")
    assert not os.path.exists(os.path.join(work_dir, "leak.txt"))


def test_a_runaway_script_is_killed_at_its_deadline(work_dir, monkeypatch):
    # Shrink the start-up allowance so the test does not wait a minute.
    monkeypatch.setattr(runner, "STARTUP_ALLOWANCE_S", 1.0)

    outcome = run("import Part\nwhile True:\n    pass\n", work_dir, timeout_ms=1_000)

    assert outcome.timed_out is True
    assert outcome.report == {}
    result = build_result(outcome)
    assert result.ok is False
    assert "budget" in result.errorMessage
    assert result.executionTimeMs < 15_000


def _real_freecad_present() -> bool:
    return importlib.util.find_spec("FreeCAD") is not None


@pytest.mark.skipif(
    _real_freecad_present(),
    reason="the interpreter has a real FreeCAD; the fake cannot be made absent",
)
def test_a_missing_freecad_is_an_infrastructure_error(work_dir, monkeypatch):
    monkeypatch.setattr(runner.settings, "freecad_lib_dir", "")

    outcome = run("import Part\nresult = Part.makeBox(1, 1, 1)\n", work_dir)

    assert outcome.exit_code == runner.EXIT_NO_FREECAD
    assert outcome.infrastructure_error is not None
    assert "not importable" in outcome.infrastructure_error


@pytest.mark.skipif(
    _real_freecad_present(),
    reason="the interpreter has a real FreeCAD, which the probe reports instead",
)
def test_probe_reports_the_fake_version(monkeypatch):
    monkeypatch.setattr(runner, "_probe_cache", None)
    probe = runner.probe_freecad(force=True)
    assert probe == {"available": True, "version": "1.1.3", "error": None}
