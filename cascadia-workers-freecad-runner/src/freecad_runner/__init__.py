# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Cascadia PLM LLC

"""Cascadia FreeCAD runner — executes AI-written FreeCAD scripts headlessly.

Consumes ``generation.cad.freecad`` jobs: each carries a Python script the AI
agent wrote for one part. The script runs in a separate FreeCAD process under
a wall-clock budget, with a scrubbed environment and a restricted set of
imports; the worker reports what it built (or why it failed) and, when asked,
stores the resulting STEP in the vault.
"""
