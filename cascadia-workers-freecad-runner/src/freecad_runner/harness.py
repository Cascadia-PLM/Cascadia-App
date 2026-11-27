# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Cascadia PLM LLC

"""The script harness — runs inside the FreeCAD-capable interpreter.

``runner.py`` spawns this file as a separate process for every script. It is
deliberately self-contained (no imports from ``freecad_runner``) so it works
under any interpreter that can ``import FreeCAD``, including one that is not
the worker's own. Everything it needs arrives in environment variables:

    FREECAD_RUNNER_SCRIPT            path of the script to run
    FREECAD_RUNNER_REPORT            path to write the JSON report to
    FREECAD_RUNNER_STEP              path to export the STEP to
    FREECAD_RUNNER_ALLOWED_IMPORTS   comma-separated import roots (guard.py)
    FREECAD_LIB_DIR                  optional extra sys.path entries

The report file is the source of truth. The exit code and the captured output
are diagnostics: FreeCAD's own teardown is known to crash on exit, so the
harness writes the report first and then leaves through ``os._exit`` — which
also stops a script's stray ``sys.exit`` or a lingering thread from turning a
finished run into a hung one.

Validation is the contract the agent is prompted with: ``result`` must be a
``Part.Shape`` holding at least one valid solid of non-zero volume, in
millimetres. Anything else is reported with a message the model can act on.
"""

from __future__ import annotations

import builtins
import json
import os
import sys
import time
import traceback
from typing import Any

SCRIPT_FILENAME = "part_script.py"

# Blocked outright from the script's builtins. The import guard below covers
# modules; these cover the builtins that reach files or the interpreter.
_REMOVED_BUILTINS = (
    "open",
    "exec",
    "eval",
    "compile",
    "input",
    "breakpoint",
    "exit",
    "quit",
    "help",
    "globals",
    "memoryview",
)

_EXIT_OK = 0
_EXIT_SCRIPT_FAILED = 1
# FreeCAD itself could not be imported: an environment fault, not a script one.
_EXIT_NO_FREECAD = 2

# Below this the part is almost certainly in the wrong units (metres, inches).
_MIN_EXTENT_MM = 0.05
# Above this too — 20 m parts do not come out of a PLM BOM.
_MAX_EXTENT_MM = 20_000.0


def _write_report(path: str, report: dict[str, Any]) -> None:
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(report, fh)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def _finish(report_path: str, report: dict[str, Any], code: int) -> None:
    try:
        sys.stdout.flush()
        sys.stderr.flush()
    except Exception:
        pass
    _write_report(report_path, report)
    os._exit(code)


def _restricted_builtins(allowed_roots: set[str]) -> dict[str, Any]:
    """A copy of the builtins with file/interpreter access removed and a
    guarded ``__import__`` that admits only the allowlisted roots.

    This scopes to the script's own code: modules the script imports keep the
    real builtins in their own globals, so FreeCAD's Python workbenches are
    unaffected. It is a courtesy fence with a helpful message, not a sandbox
    — the process limits in runner.py and the container are the boundary.
    """
    safe = dict(vars(builtins))
    for name in _REMOVED_BUILTINS:
        safe.pop(name, None)

    real_import = builtins.__import__

    def guarded_import(name, globals=None, locals=None, fromlist=(), level=0):  # noqa: A002
        root = name.split(".")[0] if name else ""
        if level == 0 and root not in allowed_roots:
            raise ImportError(
                f"import of '{root}' is not allowed in a part script. "
                "Available: FreeCAD (App), Part, PartDesign, Sketcher, Draft, "
                "Mesh, MeshPart and pure standard-library modules such as math. "
                "Do not read or write files — the harness exports the STEP."
            )
        return real_import(name, globals, locals, fromlist, level)

    safe["__import__"] = guarded_import
    return safe


def _script_traceback(exc: BaseException) -> str:
    """The traceback with the harness's own frames removed."""
    frames = traceback.extract_tb(exc.__traceback__)
    script_frames = [f for f in frames if f.filename == SCRIPT_FILENAME]
    shown = script_frames if script_frames else frames
    lines = ["Traceback (most recent call last):"]
    lines.extend(traceback.format_list(shown))
    lines.extend(traceback.format_exception_only(type(exc), exc))
    return "".join(line if line.endswith("\n") else f"{line}\n" for line in lines)


def _version_string(freecad_module: Any) -> str | None:
    try:
        parts = [str(p) for p in freecad_module.Version()[:3]]
        return ".".join(p for p in parts if p)
    except Exception:
        return None


def _normalize_result(value: Any, part_module: Any) -> tuple[Any, list[str]]:
    """Coerce what the script left in ``result`` into one Part.Shape.

    Accepts a shape, a document object carrying a ``Shape``, or a list/tuple
    of either (made into a compound). Returns (shape, fatal_issues).
    """
    shape_type = getattr(part_module, "Shape", None)

    if value is None:
        return None, [
            "the script did not assign `result`. Assign the finished Part.Shape "
            "(a solid, or a compound of solids) to a variable named `result`."
        ]

    if shape_type is not None and isinstance(value, shape_type):
        return value, []

    inner = getattr(value, "Shape", None)
    if inner is not None and shape_type is not None and isinstance(inner, shape_type):
        return inner, []

    if isinstance(value, (list, tuple)):
        shapes = []
        for index, item in enumerate(value):
            shape, issues = _normalize_result(item, part_module)
            if issues:
                return None, [f"result[{index}]: {issues[0]}"]
            shapes.append(shape)
        if not shapes:
            return None, ["`result` is an empty list; it must hold at least one shape"]
        try:
            return part_module.makeCompound(shapes), []
        except Exception as exc:  # pragma: no cover — kernel-specific
            return None, [f"could not combine the shapes in `result` into a compound: {exc}"]

    return None, [
        f"`result` is a {type(value).__name__}, not a Part.Shape. Assign the "
        "finished solid (e.g. the return value of fuse/cut/extrude) to `result`."
    ]


def _bounding_box(shape: Any) -> dict[str, float]:
    bb = shape.BoundBox
    return {
        "minX": float(bb.XMin),
        "minY": float(bb.YMin),
        "minZ": float(bb.ZMin),
        "maxX": float(bb.XMax),
        "maxY": float(bb.YMax),
        "maxZ": float(bb.ZMax),
    }


def _center_of_mass(shape: Any) -> dict[str, float] | None:
    try:
        com = shape.CenterOfMass
        return {"x": float(com.x), "y": float(com.y), "z": float(com.z)}
    except Exception:
        return None


def _validate(shape: Any) -> tuple[list[str], list[str], dict[str, Any] | None]:
    """Return (fatal_issues, advisory_issues, geometry_summary)."""
    fatal: list[str] = []
    advisory: list[str] = []

    if shape.isNull():
        return ["`result` is a null shape — an operation produced nothing"], [], None

    solids = list(shape.Solids)
    if not solids:
        kind = getattr(shape, "ShapeType", "unknown")
        fatal.append(
            f"`result` contains no solids (ShapeType={kind}). Extrude or revolve "
            "faces into solids, and check that a boolean did not empty the shape."
        )

    is_valid = bool(shape.isValid())
    if not is_valid:
        fatal.append(
            "`result.isValid()` is False — the topology is defective (a "
            "self-intersection, or a degenerate face or edge). Check the boolean "
            "inputs for coincident faces; try shape.removeSplitter() or "
            "shape.fix(1e-6, 1e-6, 1e-6)."
        )

    volume = float(shape.Volume)
    if solids and volume <= 1e-9:
        fatal.append("`result` has zero volume")

    bbox = _bounding_box(shape)
    extents = (
        bbox["maxX"] - bbox["minX"],
        bbox["maxY"] - bbox["minY"],
        bbox["maxZ"] - bbox["minZ"],
    )
    largest = max(extents)
    if largest < _MIN_EXTENT_MM:
        fatal.append(
            f"`result` is only {largest:.4f} mm across — check the units; "
            "dimensions are millimetres."
        )
    elif largest > _MAX_EXTENT_MM:
        advisory.append(
            f"`result` is {largest:.0f} mm across — check the units; dimensions "
            "are millimetres."
        )

    if len(solids) > 1:
        advisory.append(
            f"`result` has {len(solids)} solids. If the part is one body, fuse "
            "them (and removeSplitter()); leave it a compound only for a "
            "genuinely multi-body part."
        )

    geometry = {
        "solidCount": len(solids),
        "faceCount": len(shape.Faces),
        "edgeCount": len(shape.Edges),
        "volumeMm3": volume,
        "surfaceAreaMm2": float(shape.Area),
        "isValid": is_valid,
        "boundingBox": bbox,
        "centerOfMass": _center_of_mass(shape) if solids else None,
    }
    return fatal, advisory, geometry


def main() -> None:
    started = time.monotonic()
    script_path = os.environ["FREECAD_RUNNER_SCRIPT"]
    report_path = os.environ["FREECAD_RUNNER_REPORT"]
    step_path = os.environ.get("FREECAD_RUNNER_STEP") or None
    allowed_roots = {
        name.strip()
        for name in os.environ.get("FREECAD_RUNNER_ALLOWED_IMPORTS", "").split(",")
        if name.strip()
    }

    report: dict[str, Any] = {
        "ok": False,
        "freecadVersion": None,
        "geometry": None,
        "issues": [],
        "errorMessage": None,
        "traceback": None,
        "stepWritten": False,
        "harnessTimeMs": 0,
    }

    lib_dirs = os.environ.get("FREECAD_LIB_DIR", "")
    if lib_dirs:
        sys.path.extend(p for p in lib_dirs.split(os.pathsep) if p)

    try:
        import FreeCAD  # noqa: N813 — FreeCAD's own module name
        import Part
    except Exception as exc:
        report["errorMessage"] = f"FreeCAD is not importable in this interpreter: {exc}"
        report["issues"] = [report["errorMessage"]]
        _finish(report_path, report, _EXIT_NO_FREECAD)
        return

    report["freecadVersion"] = _version_string(FreeCAD)

    with open(script_path, "r", encoding="utf-8") as fh:
        source = fh.read()

    namespace: dict[str, Any] = {
        "__name__": "__cascadia_part__",
        "__builtins__": _restricted_builtins(allowed_roots),
        "FreeCAD": FreeCAD,
        "App": FreeCAD,
        "Part": Part,
    }

    try:
        code = compile(source, SCRIPT_FILENAME, "exec")
        exec(code, namespace)  # noqa: S102 — this is the whole point of the harness
    except BaseException as exc:  # SystemExit included: a script must not end the harness
        report["errorMessage"] = f"{type(exc).__name__}: {exc}"
        report["traceback"] = _script_traceback(exc)
        report["issues"] = [report["errorMessage"]]
        report["harnessTimeMs"] = int((time.monotonic() - started) * 1000)
        _finish(report_path, report, _EXIT_SCRIPT_FAILED)
        return

    shape, normalize_issues = _normalize_result(namespace.get("result"), Part)
    if normalize_issues:
        report["errorMessage"] = normalize_issues[0]
        report["issues"] = normalize_issues
        report["harnessTimeMs"] = int((time.monotonic() - started) * 1000)
        _finish(report_path, report, _EXIT_SCRIPT_FAILED)
        return

    try:
        fatal, advisory, geometry = _validate(shape)
    except Exception as exc:
        report["errorMessage"] = f"could not inspect `result`: {type(exc).__name__}: {exc}"
        report["issues"] = [report["errorMessage"]]
        report["traceback"] = _script_traceback(exc)
        report["harnessTimeMs"] = int((time.monotonic() - started) * 1000)
        _finish(report_path, report, _EXIT_SCRIPT_FAILED)
        return

    report["geometry"] = geometry
    report["issues"] = fatal + advisory

    if fatal:
        report["errorMessage"] = fatal[0]
        report["harnessTimeMs"] = int((time.monotonic() - started) * 1000)
        _finish(report_path, report, _EXIT_SCRIPT_FAILED)
        return

    if step_path:
        try:
            shape.exportStep(step_path)
        except Exception as exc:
            report["errorMessage"] = f"STEP export failed: {type(exc).__name__}: {exc}"
            report["issues"] = [report["errorMessage"]] + advisory
            report["harnessTimeMs"] = int((time.monotonic() - started) * 1000)
            _finish(report_path, report, _EXIT_SCRIPT_FAILED)
            return
        if not os.path.exists(step_path) or os.path.getsize(step_path) == 0:
            report["errorMessage"] = "STEP export produced no file"
            report["issues"] = [report["errorMessage"]] + advisory
            report["harnessTimeMs"] = int((time.monotonic() - started) * 1000)
            _finish(report_path, report, _EXIT_SCRIPT_FAILED)
            return
        report["stepWritten"] = True

    report["ok"] = True
    report["harnessTimeMs"] = int((time.monotonic() - started) * 1000)
    _finish(report_path, report, _EXIT_OK)


if __name__ == "__main__":
    main()
