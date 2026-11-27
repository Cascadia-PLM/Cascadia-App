# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Cascadia PLM LLC

"""Static checks on a script before FreeCAD is even started.

The author of every script this worker runs is a language model, so the
script is untrusted code — and the trust boundary that actually holds is the
container the worker runs in, plus the scrubbed, limited child process the
runner spawns (see ``runner.py``). What this module adds is cheaper and
earlier: a scan that refuses the obvious escapes — GUI imports that cannot
work headless, file and network access the harness makes unnecessary, and
calls that would kill the harness before it can report — with a message the
agent can act on. Everything it names is also enforced at run time by the
harness's restricted builtins; the scan is the friendly copy, not the wall.

``ALLOWED_IMPORT_ROOTS`` is the one list both layers read: the scan here, and
the harness through the ``FREECAD_RUNNER_ALLOWED_IMPORTS`` environment
variable the runner derives from it.
"""

from __future__ import annotations

import re

MAX_SCRIPT_BYTES = 200_000

# Top-level modules a script may import. FreeCAD's own modules plus the pure
# parts of the standard library a geometry script has any use for. `Import`
# (FreeCAD's STEP/IGES I/O) is deliberately absent: the harness exports.
ALLOWED_IMPORT_ROOTS: frozenset[str] = frozenset(
    {
        # FreeCAD
        "FreeCAD",
        "App",
        "Part",
        "PartDesign",
        "Sketcher",
        "Draft",
        "DraftGeomUtils",
        "DraftVecUtils",
        "Mesh",
        "MeshPart",
        "BOPTools",
        "ProfileLib",
        "Base",
        # Standard library, pure computation only
        "math",
        "cmath",
        "itertools",
        "functools",
        "collections",
        "dataclasses",
        "typing",
        "random",
        "statistics",
        "re",
        "json",
        "copy",
        "operator",
        "enum",
        "numbers",
        "decimal",
        "fractions",
        "string",
        "time",
        "datetime",
        "abc",
        "heapq",
        "bisect",
        "array",
    }
)

_IMPORT_LINE = re.compile(
    r"^\s*(?:import\s+(?P<mods>[^\n#]+)|from\s+(?P<from>[A-Za-z_][\w.]*)\s+import\b)",
)

# (pattern, message). Patterns are matched per line so the message can carry
# a line number; comments are stripped first so a mention in prose passes.
_FORBIDDEN_CALLS: tuple[tuple[re.Pattern[str], str], ...] = (
    (
        re.compile(r"\bFreeCADGui\b"),
        "FreeCADGui is not available headless; build geometry with Part/App only",
    ),
    (
        re.compile(r"(?<![\w.])open\s*\("),
        "file access is blocked: the harness exports the STEP for you",
    ),
    (
        re.compile(r"(?<![\w.])(?:exec|eval|compile)\s*\("),
        "exec/eval/compile are blocked",
    ),
    (
        re.compile(r"\b__import__\s*\("),
        "__import__ is blocked; use a plain import statement",
    ),
    (
        re.compile(r"(?<![\w.])(?:exit|quit)\s*\("),
        "exit()/quit() would end the harness before it can report; just let the script finish",
    ),
    (
        re.compile(r"\bsys\.exit\b|\bos\._exit\b"),
        "sys.exit/os._exit would end the harness before it can report",
    ),
    (
        re.compile(r"(?<![\w.])(?:input|breakpoint|help)\s*\("),
        "interactive calls hang a headless run",
    ),
    (
        re.compile(r"__builtins__|__loader__|__spec__|__subclasses__|__globals__"),
        "dunder introspection is blocked",
    ),
)


def _code_only(line: str) -> str:
    """The line with string literal contents blanked and any comment removed.

    The forbidden-call patterns must see code, not prose: a print statement
    mentioning `open(` or a comment saying `# no exec()` is not a violation.
    Line-based, so a triple-quoted string spanning lines is not tracked — a
    false positive there names the line and is easy to act on.
    """
    out: list[str] = []
    in_str: str | None = None
    escaped = False
    for ch in line:
        if in_str:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == in_str:
                in_str = None
                out.append(ch)
            continue
        if ch in ("'", '"'):
            in_str = ch
            out.append(ch)
        elif ch == "#":
            break
        else:
            out.append(ch)
    return "".join(out)


def _import_roots(line: str) -> list[str]:
    """Top-level module names a line imports, or [] when it is not an import."""
    m = _IMPORT_LINE.match(line)
    if not m:
        return []
    if m.group("from"):
        return [m.group("from").split(".")[0]]
    roots: list[str] = []
    for part in m.group("mods").split(","):
        name = part.strip().split(" as ")[0].strip()
        if name:
            roots.append(name.split(".")[0])
    return roots


def check_script(script: str) -> list[str]:
    """Return every violation found, each with its line number. Empty is a pass."""
    violations: list[str] = []

    encoded = script.encode("utf-8", errors="replace")
    if len(encoded) > MAX_SCRIPT_BYTES:
        violations.append(
            f"script is {len(encoded)} bytes; the limit is {MAX_SCRIPT_BYTES}"
        )
    if not script.strip():
        violations.append("script is empty")
        return violations

    for number, raw in enumerate(script.splitlines(), start=1):
        line = _code_only(raw)
        if not line.strip():
            continue

        for root in _import_roots(line):
            if root not in ALLOWED_IMPORT_ROOTS:
                violations.append(
                    f"line {number}: import of '{root}' is not allowed. "
                    "Available: FreeCAD (App), Part, PartDesign, Sketcher, Draft, "
                    "Mesh, MeshPart and pure standard-library modules such as math"
                )

        for pattern, message in _FORBIDDEN_CALLS:
            if pattern.search(line):
                violations.append(f"line {number}: {message}")

    return violations
