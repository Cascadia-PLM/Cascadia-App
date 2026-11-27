# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Cascadia PLM LLC

"""The static guard is the first thing a model-written script meets.

Security gate: what it refuses never reaches a FreeCAD process. What it
admits is the whole vocabulary the agent is prompted with, so a false
positive here is a part that cannot be modelled — both directions matter.
"""

from __future__ import annotations

import pytest

from freecad_runner.guard import ALLOWED_IMPORT_ROOTS, MAX_SCRIPT_BYTES, check_script

GOOD_SCRIPT = """\
import math
from FreeCAD import Base
import Part

# A plate with four M4 clearance holes on a 40 x 20 pattern.
W, H, T = 60.0, 40.0, 5.0   # "open" in a comment is fine
plate = Part.makeBox(W, H, T, Base.Vector(-W / 2, -H / 2, 0))
holes = []
for dx in (-20, 20):
    for dy in (-10, 10):
        holes.append(Part.makeCylinder(2.2, T + 2, Base.Vector(dx, dy, -1)))
result = plate.cut(holes).removeSplitter()
print("volume", result.Volume, "label: 'open(' inside a string is fine")
"""


def test_the_prompted_vocabulary_passes():
    assert check_script(GOOD_SCRIPT) == []


@pytest.mark.parametrize(
    "line",
    [
        "import FreeCAD",
        "import FreeCAD as App",
        "from FreeCAD import Base, Vector",
        "import Part, Sketcher, PartDesign",
        "from math import pi, sin",
        "import itertools, functools",
        "from collections import namedtuple",
        "from dataclasses import dataclass",
    ],
)
def test_allowed_imports(line: str):
    assert check_script(f"{line}\nresult = None\n") == []


@pytest.mark.parametrize(
    "line, fragment",
    [
        ("import os", "'os'"),
        ("import sys", "'sys'"),
        ("import subprocess", "'subprocess'"),
        ("from socket import socket", "'socket'"),
        ("import shutil as sh", "'shutil'"),
        ("from pathlib import Path", "'pathlib'"),
        ("import urllib.request", "'urllib'"),
        ("import Import", "'Import'"),
        ("    import ctypes", "'ctypes'"),
        ("import math, os", "'os'"),
    ],
)
def test_blocked_imports_name_the_module(line: str, fragment: str):
    violations = check_script(f"{line}\nresult = None\n")
    assert len(violations) == 1
    assert violations[0].startswith("line 1:")
    assert fragment in violations[0]


@pytest.mark.parametrize(
    "line, fragment",
    [
        ("import FreeCADGui", "FreeCADGui"),
        ("FreeCADGui.ActiveDocument", "FreeCADGui"),
        ("fh = open('x.step', 'w')", "file access"),
        ("exec('print(1)')", "exec/eval"),
        ("eval('1+1')", "exec/eval"),
        ("compile('1', 'x', 'eval')", "exec/eval"),
        ("__import__('os')", "__import__"),
        ("exit()", "exit()"),
        ("quit(0)", "exit()"),
        ("sys.exit(1)", "sys.exit"),
        ("os._exit(0)", "os._exit"),
        ("name = input('?')", "interactive"),
        ("breakpoint()", "interactive"),
        ("().__class__.__subclasses__()", "dunder"),
        ("print(__builtins__)", "dunder"),
    ],
)
def test_forbidden_calls(line: str, fragment: str):
    violations = check_script(f"import Part\n{line}\nresult = None\n")
    assert any(v.startswith("line 2:") and fragment in v for v in violations), violations


def test_method_names_that_merely_end_in_open_are_fine():
    # `shape.open(` would be odd FreeCAD, but `reopen(`/`is_open(` must not
    # trip the `open(` rule: only a bare call does.
    assert check_script("import Part\nresult = Part.makeBox(1, 1, 1)\nx = doc.reopen()\nis_open(1)\n") == []


def test_comment_only_mentions_are_ignored():
    script = "import Part\n# call open() and FreeCADGui? no: exec()\nresult = Part.makeBox(1, 1, 1)  # sys.exit\n"
    assert check_script(script) == []


def test_string_literals_are_not_comments():
    # The `#` inside the string must not hide the real `open(` after it.
    script = "import Part\nlabel = '#'\nfh = open('x')\nresult = None\n"
    assert any("file access" in v for v in check_script(script))


def test_empty_and_oversized_scripts_are_rejected():
    assert check_script("   \n\n") == ["script is empty"]
    huge = "import Part\n" + ("x = 1\n" * (MAX_SCRIPT_BYTES // 6 + 10)) + "result = None\n"
    violations = check_script(huge)
    assert any("bytes" in v for v in violations)


def test_allowlist_excludes_file_and_process_modules():
    for banned in ("os", "sys", "subprocess", "socket", "shutil", "pathlib", "Import", "FreeCADGui"):
        assert banned not in ALLOWED_IMPORT_ROOTS
    for needed in ("FreeCAD", "App", "Part", "math"):
        assert needed in ALLOWED_IMPORT_ROOTS
