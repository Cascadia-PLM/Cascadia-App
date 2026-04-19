# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Cascadia PLM contributors

"""Entry point: CLI mode for standalone generation, or worker mode for RabbitMQ."""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("cad_generator")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Cascadia Parametric CAD Generator — CadQuery templates to STEP",
    )
    subparsers = parser.add_subparsers(dest="command")

    # Worker mode (default)
    subparsers.add_parser("worker", help="Run as RabbitMQ worker")
    parser.add_argument(
        "--worker",
        action="store_true",
        help="Run as RabbitMQ worker (default if no command given)",
    )

    # CLI convert mode
    convert_parser = subparsers.add_parser(
        "convert", help="Generate a STEP file from a template"
    )
    convert_parser.add_argument(
        "--template", "-t", required=True, help="Template name (e.g. bushing, plate)"
    )
    convert_parser.add_argument(
        "--params",
        "-p",
        required=True,
        help='JSON string of parameters (e.g. \'{"od":20,"id":10,"length":30}\')',
    )
    convert_parser.add_argument(
        "-o", "--output", default="./output", help="Output directory"
    )
    convert_parser.add_argument(
        "--units",
        choices=["mm", "in"],
        default="mm",
        help="Input units (converted to mm internally)",
    )

    args = parser.parse_args()

    if args.command == "convert":
        _run_convert(args)
    else:
        _run_worker()


def _run_convert(args: argparse.Namespace) -> None:
    """Run standalone CLI generation."""
    from .export import compute_bounding_box, export_step
    from .templates import TEMPLATE_REGISTRY
    from .validation import validate_parameters

    template_name = args.template
    output_dir = os.path.abspath(args.output)

    try:
        parameters = json.loads(args.params)
    except json.JSONDecodeError as e:
        logger.error("Invalid JSON parameters: %s", e)
        sys.exit(1)

    if template_name not in TEMPLATE_REGISTRY:
        logger.error(
            "Unknown template: %s. Available: %s",
            template_name,
            ", ".join(TEMPLATE_REGISTRY.keys()),
        )
        sys.exit(1)

    # Validate parameters
    try:
        parameters = validate_parameters(template_name, parameters)
    except ValueError as e:
        logger.error("Validation error: %s", e)
        sys.exit(1)

    # Convert inches to mm if needed
    if args.units == "in":
        parameters = {k: v * 25.4 for k, v in parameters.items()}
        logger.info("Converted parameters from inches to mm")

    logger.info("Template: %s", template_name)
    logger.info("Parameters: %s", parameters)
    logger.info("Output: %s", output_dir)

    os.makedirs(output_dir, exist_ok=True)

    # Generate
    template_fn = TEMPLATE_REGISTRY[template_name]
    workplane = template_fn(parameters)

    # Export
    output_path = os.path.join(output_dir, f"{template_name}.step")
    export_step(workplane, output_path)

    # Bounding box
    bbox = compute_bounding_box(workplane)
    logger.info(
        "Done! STEP written to %s, bbox=(%.2f,%.2f,%.2f)-(%.2f,%.2f,%.2f)",
        output_path,
        bbox.minX,
        bbox.minY,
        bbox.minZ,
        bbox.maxX,
        bbox.maxY,
        bbox.maxZ,
    )


def _run_worker() -> None:
    """Run as RabbitMQ worker."""
    logger.info("Starting parametric CAD generator worker...")
    from .worker import run_worker

    run_worker()


if __name__ == "__main__":
    main()