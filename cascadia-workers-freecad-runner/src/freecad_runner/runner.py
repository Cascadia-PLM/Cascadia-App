# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Cascadia PLM LLC

"""Run one script in a separate FreeCAD process and collect its report.

Why a process per script rather than ``exec`` in the worker:

- A script is untrusted, model-written code. A child process gets a scrubbed
  environment (no database or broker credentials), a working directory of its
  own, resource limits, and a hard wall-clock deadline the parent enforces by
  killing it. None of that is available to code running in-process.
- FreeCAD's kernel is native code. An infinite loop in a boolean, a segfault
  on a degenerate face, or a leak across many scripts would otherwise take the
  worker down with the job. Here it takes down one child and the job is
  reported failed with the reason.
- The report file, not the process, carries the verdict — so FreeCAD's known
  crash-on-exit and a script's stray ``sys.exit`` cannot turn success into
  failure (see ``harness.py``).
"""

from __future__ import annotations

import json
import logging
import math
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from typing import Any, Optional

from .config import settings
from .guard import ALLOWED_IMPORT_ROOTS
from .models import FreecadScriptResult, GeometrySummary

logger = logging.getLogger(__name__)

HARNESS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "harness.py")

# Exit codes the harness uses (harness.py keeps its own copies: it imports
# nothing from this package).
EXIT_NO_FREECAD = 2

# Time allowed for the interpreter to start and import FreeCAD before the
# script's own budget begins to matter. Importing the kernel is seconds on a
# warm container and considerably longer on a cold one.
STARTUP_ALLOWANCE_S = 60.0


@dataclass
class ExecutionOutcome:
    """Everything the worker needs to build a ``FreecadScriptResult``."""

    report: dict[str, Any]
    stdout: str
    stderr: str
    duration_ms: int
    timed_out: bool = False
    exit_code: Optional[int] = None
    step_path: Optional[str] = None
    # Set when the *environment* failed rather than the script — FreeCAD not
    # importable, harness missing. The worker fails the job for these so the
    # ordinary retry path applies; a script error never reaches it.
    infrastructure_error: Optional[str] = None
    issues: list[str] = field(default_factory=list)


def interpreter() -> str:
    """The interpreter that can ``import FreeCAD``."""
    return settings.freecad_python or sys.executable


_probe_cache: Optional[dict[str, Any]] = None


def probe_freecad(force: bool = False) -> dict[str, Any]:
    """Whether FreeCAD imports in the configured interpreter, and its version.

    Cached after the first call: the answer is a property of the image, and
    the health endpoint asks every thirty seconds.
    """
    global _probe_cache
    if _probe_cache is not None and not force:
        return _probe_cache

    code = (
        "import os, sys\n"
        "d = os.environ.get('FREECAD_LIB_DIR', '')\n"
        "sys.path.extend(p for p in d.split(os.pathsep) if p)\n"
        "import FreeCAD\n"
        "print('.'.join(str(p) for p in FreeCAD.Version()[:3]))\n"
    )
    try:
        completed = subprocess.run(
            [interpreter(), "-c", code],
            capture_output=True,
            text=True,
            timeout=STARTUP_ALLOWANCE_S,
            env=_child_env(tempfile.gettempdir(), extra={}),
            stdin=subprocess.DEVNULL,
        )
        if completed.returncode == 0:
            version = completed.stdout.strip().splitlines()[-1] if completed.stdout.strip() else None
            _probe_cache = {"available": True, "version": version, "error": None}
        else:
            _probe_cache = {
                "available": False,
                "version": None,
                "error": (completed.stderr or completed.stdout).strip()[-500:],
            }
    except Exception as exc:  # timeout, missing interpreter
        _probe_cache = {"available": False, "version": None, "error": str(exc)}
    return _probe_cache


def _child_env(work_dir: str, extra: dict[str, str]) -> dict[str, str]:
    """A minimal environment for the script process.

    Built from scratch rather than copied: the worker's environment carries
    ``DATABASE_URL`` and ``RABBITMQ_URL``, and a model-written script has no
    business seeing either. Only what an interpreter and FreeCAD need to start
    is passed through.
    """
    env: dict[str, str] = {
        "HOME": work_dir,
        "TMPDIR": work_dir,
        "TEMP": work_dir,
        "TMP": work_dir,
        "LANG": os.environ.get("LANG", "C.UTF-8"),
        "LC_ALL": os.environ.get("LC_ALL", os.environ.get("LANG", "C.UTF-8")),
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONUNBUFFERED": "1",
        "PYTHONIOENCODING": "utf-8",
        # Qt is linked in even headless; without a display it must be told so.
        "QT_QPA_PLATFORM": "offscreen",
        # FreeCAD writes its user configuration on first import; keep it out
        # of the worker's home and out of the next script's way.
        "FREECAD_USER_HOME": work_dir,
    }
    for name in ("PATH", "SYSTEMROOT", "PATHEXT", "COMSPEC", "LD_LIBRARY_PATH"):
        value = os.environ.get(name)
        if value:
            env[name] = value
    if settings.freecad_lib_dir:
        env["FREECAD_LIB_DIR"] = settings.freecad_lib_dir
    env.update(extra)
    return env


def _posix_limits(timeout_s: float):
    """A ``preexec_fn`` applying resource limits to the child (POSIX only)."""
    import resource  # noqa: PLC0415 — POSIX-only import

    def apply() -> None:
        # No core dumps: a segfaulting kernel must not fill the disk.
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        # A script has one file to write, the STEP; half a gigabyte is plenty.
        resource.setrlimit(resource.RLIMIT_FSIZE, (512 * 1024 * 1024, 512 * 1024 * 1024))
        # CPU time as a backstop behind the wall-clock kill.
        cpu = int(math.ceil(timeout_s)) + 30
        resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu + 10))
        if settings.script_memory_mb > 0:
            limit = settings.script_memory_mb * 1024 * 1024
            resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
        # Its own session, so the whole process group can be killed at once.
        os.setsid()

    return apply


def _tail(text: str, chars: int) -> str:
    if len(text) <= chars:
        return text
    return "…" + text[-chars:]


def _kill(proc: subprocess.Popen) -> None:
    """Kill the child and, on POSIX, everything it spawned."""
    try:
        if os.name == "posix":
            os.killpg(proc.pid, signal.SIGKILL)
        else:
            proc.kill()
    except ProcessLookupError:
        pass
    except Exception as exc:  # pragma: no cover — best effort
        logger.warning("Could not kill script process %s: %s", proc.pid, exc)


def execute_script(
    script: str,
    *,
    timeout_ms: int,
    work_dir: str,
    export_step: bool = True,
) -> ExecutionOutcome:
    """Run ``script`` under the harness and return what happened.

    ``work_dir`` must exist and be private to this run; the script, the
    report and the STEP all live there, and the child's HOME points at it.
    """
    started = time.monotonic()
    script_path = os.path.join(work_dir, "part_script.py")
    report_path = os.path.join(work_dir, "report.json")
    step_path = os.path.join(work_dir, "result.step") if export_step else None

    with open(script_path, "w", encoding="utf-8") as fh:
        fh.write(script)

    if not os.path.exists(HARNESS_PATH):
        return ExecutionOutcome(
            report={},
            stdout="",
            stderr="",
            duration_ms=0,
            infrastructure_error=f"harness not found at {HARNESS_PATH}",
        )

    timeout_s = timeout_ms / 1000.0
    env = _child_env(
        work_dir,
        extra={
            "FREECAD_RUNNER_SCRIPT": script_path,
            "FREECAD_RUNNER_REPORT": report_path,
            "FREECAD_RUNNER_STEP": step_path or "",
            "FREECAD_RUNNER_ALLOWED_IMPORTS": ",".join(sorted(ALLOWED_IMPORT_ROOTS)),
        },
    )

    popen_kwargs: dict[str, Any] = {
        "cwd": work_dir,
        "env": env,
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
        "text": True,
        "encoding": "utf-8",
        "errors": "replace",
    }
    if os.name == "posix":
        popen_kwargs["preexec_fn"] = _posix_limits(timeout_s)

    proc = subprocess.Popen([interpreter(), HARNESS_PATH], **popen_kwargs)

    timed_out = False
    try:
        stdout, stderr = proc.communicate(timeout=timeout_s + STARTUP_ALLOWANCE_S)
    except subprocess.TimeoutExpired:
        timed_out = True
        _kill(proc)
        try:
            stdout, stderr = proc.communicate(timeout=10)
        except Exception:
            stdout, stderr = "", ""

    duration_ms = int((time.monotonic() - started) * 1000)
    stdout = _tail(stdout or "", settings.output_capture_chars)
    stderr = _tail(stderr or "", settings.output_capture_chars)

    report: dict[str, Any] = {}
    if os.path.exists(report_path):
        try:
            with open(report_path, "r", encoding="utf-8") as fh:
                report = json.load(fh)
        except Exception as exc:
            logger.warning("Unreadable harness report: %s", exc)
            report = {}

    outcome = ExecutionOutcome(
        report=report,
        stdout=stdout,
        stderr=stderr,
        duration_ms=duration_ms,
        timed_out=timed_out,
        exit_code=proc.returncode,
        step_path=step_path if report.get("stepWritten") else None,
    )

    if timed_out:
        outcome.issues.append(
            f"the script exceeded its {timeout_s:.0f}s budget and was killed. "
            "Simplify the geometry, reduce boolean operands, or avoid loops "
            "that build many small features."
        )
        outcome.report = {}
        return outcome

    if proc.returncode == EXIT_NO_FREECAD or (not report and proc.returncode != 0):
        message = report.get("errorMessage") if report else None
        if not message:
            message = (
                f"the FreeCAD process exited with status {proc.returncode} without "
                f"writing a report: {(stderr or stdout).strip()[-400:] or 'no output'}"
            )
        if proc.returncode == EXIT_NO_FREECAD:
            outcome.infrastructure_error = message
        else:
            # A crash inside the kernel on this particular geometry: the
            # script's problem, reported as such so the agent can change tack.
            outcome.issues.append(
                f"FreeCAD crashed while running the script (exit status "
                f"{proc.returncode}). This usually means a boolean on degenerate "
                "or coincident geometry; add a small offset or simplify the operands."
            )
        return outcome

    if not report:
        outcome.issues.append(
            f"the script finished (exit status {proc.returncode}) but no report was "
            "produced; the harness may have been interrupted."
        )
    return outcome


def copy_step(outcome: ExecutionOutcome, destination: str) -> None:
    """Move the exported STEP out of the run's working directory."""
    if not outcome.step_path:
        raise ValueError("no STEP was exported by this run")
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    shutil.copy2(outcome.step_path, destination)


def build_result(outcome: ExecutionOutcome) -> FreecadScriptResult:
    """Translate a run's outcome into the job result the agent reads.

    ``ok`` requires all three: the harness said so, the process was not
    killed at its deadline, and the runner found nothing wrong around it (a
    crash, a missing report). ``errorMessage`` is the first reason otherwise.
    """
    report = outcome.report or {}
    issues = list(report.get("issues") or []) + list(outcome.issues)
    ok = bool(report.get("ok")) and not outcome.timed_out and not outcome.issues

    error_message = report.get("errorMessage")
    if not ok and not error_message:
        error_message = issues[0] if issues else "the script did not produce a report"

    geometry = None
    if report.get("geometry"):
        try:
            geometry = GeometrySummary(**report["geometry"])
        except Exception as exc:  # a harness/model drift, not a script fault
            logger.warning("Geometry summary did not validate: %s", exc)

    return FreecadScriptResult(
        ok=ok,
        freecadVersion=report.get("freecadVersion"),
        executionTimeMs=outcome.duration_ms,
        stdout=outcome.stdout,
        stderr=outcome.stderr,
        errorMessage=None if ok else error_message,
        traceback=report.get("traceback"),
        issues=issues,
        geometry=geometry,
    )
