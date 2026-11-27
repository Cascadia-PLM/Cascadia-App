# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Cascadia PLM LLC

"""A stand-in `FreeCAD` module for the runner tests.

Just enough surface for harness.py to import, version and run: the real
kernel is conda-only, and what these tests pin is the harness's contract and
the runner's process handling, neither of which needs geometry.
"""

from __future__ import annotations

import os
import sys


def Version():  # noqa: N802 — FreeCAD's own name
    return ["1", "1", "3", "fake", "", "", ""]


class Vector:
    def __init__(self, x=0.0, y=0.0, z=0.0):
        self.x, self.y, self.z = float(x), float(y), float(z)


class Base:
    """`from FreeCAD import Base` — the namespace scripts take Vector from."""

    Vector = Vector


class Console:  # noqa: D101
    @staticmethod
    def PrintMessage(text):  # noqa: N802
        sys.stdout.write(text)

    @staticmethod
    def PrintError(text):  # noqa: N802
        sys.stderr.write(text)


# Lets a test see what the child process was given without a script being
# able to import `os` itself.
sys.stderr.write(f"FAKE_FREECAD_ENV DATABASE_URL={os.environ.get('DATABASE_URL')!r}\n")
sys.stderr.write(f"FAKE_FREECAD_ENV HOME={os.environ.get('HOME')!r}\n")
