# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Cascadia PLM LLC

"""Entry point: CLI mode for running one script, or worker mode for RabbitMQ."""

from __future__ import annotations

import argparse
import json
import logging
import os
import shutil
import sys
import tempfile

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("freecad_runner")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Cascadia FreeCAD runner — executes FreeCAD Python scripts headlessly",
    )
    subparsers = parser.add_subparsers(dest="command")

    # Worker mode (default)
    subparsers.add_parser("worker", help="Run as RabbitMQ worker")
    parser.add_argument(
        "--worker",
        action="store_true",
        help="Run as RabbitMQ worker (default if no command given)",
    )

    # CLI run mode — the same harness and guard the worker uses, for trying
    # a script by hand without a broker or a database.
    run_parser = subparsers.add_parser(
        "run", help="Run one script and print its report"
    )
    run_parser.add_argument("script", help="Path of the FreeCAD Python script")
    run_parser.add_argument(
        "-o", "--output", default="./output", help="Directory to copy the STEP into"
    )
    run_parser.add_argument(
        "--timeout",
        type=int,
        default=None,
        help="Script budget in seconds (default: SCRIPT_TIMEOUT_MS)",
    )

    subparsers.add_parser("probe", help="Report whether FreeCAD is importable")

    args = parser.parse_args()

    if args.command == "run":
        _run_once(args)
    elif args.command == "probe":
        _probe()
    else:
        _run_worker()


def _probe() -> None:
    from .runner import interpreter, probe_freecad

    result = probe_freecad(force=True)
    print(json.dumps({"interpreter": interpreter(), **result}, indent=2))
    sys.exit(0 if result["available"] else 1)


def _run_once(args: argparse.Namespace) -> None:
    """Run a script through the guard and the harness, print the report."""
    from .config import settings
    from .guard import check_script
    from .runner import build_result, copy_step, execute_script

    with open(args.script, "r", encoding="utf-8") as fh:
        script = fh.read()

    violations = check_script(script)
    if violations:
        for violation in violations:
            logger.error("Rejected: %s", violation)
        sys.exit(1)

    timeout_ms = (args.timeout * 1000) if args.timeout else settings.script_timeout_ms
    output_dir = os.path.abspath(args.output)

    with tempfile.TemporaryDirectory(prefix="freecad_run_") as work_dir:
        outcome = execute_script(script, timeout_ms=timeout_ms, work_dir=work_dir)
        if outcome.infrastructure_error:
            logger.error("FreeCAD unavailable: %s", outcome.infrastructure_error)
            sys.exit(2)

        result = build_result(outcome)
        if result.ok and outcome.step_path:
            os.makedirs(output_dir, exist_ok=True)
            destination = os.path.join(output_dir, "result.step")
            copy_step(outcome, destination)
            result.fileName = destination

    print(json.dumps(result.model_dump(), indent=2))
    if outcome.stdout:
        print("--- stdout ---", file=sys.stderr)
        print(outcome.stdout, file=sys.stderr)
    if outcome.stderr:
        print("--- stderr ---", file=sys.stderr)
        print(outcome.stderr, file=sys.stderr)
    sys.exit(0 if result.ok else 1)


def _run_worker() -> None:
    """Run as RabbitMQ worker."""
    logger.info("Starting FreeCAD runner worker...")
    from .worker import run_worker

    run_worker()


if __name__ == "__main__":
    main()
