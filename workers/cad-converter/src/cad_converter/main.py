# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Cascadia PLM contributors

"""Entry point: CLI mode for standalone conversion, or worker mode for RabbitMQ."""

from __future__ import annotations

import argparse
import logging
import os
import sys

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("cad_converter")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Cascadia CAD Converter — STEP/IGES to STL + GLB",
    )
    subparsers = parser.add_subparsers(dest="command")

    # Worker mode (default)
    worker_parser = subparsers.add_parser("worker", help="Run as RabbitMQ worker")
    parser.add_argument(
        "--worker",
        action="store_true",
        help="Run as RabbitMQ worker (default if no command given)",
    )

    # CLI convert mode
    convert_parser = subparsers.add_parser("convert", help="Convert a CAD file directly")
    convert_parser.add_argument("input", help="Path to STEP/IGES file")
    convert_parser.add_argument("-o", "--output", default="./output", help="Output directory")
    convert_parser.add_argument(
        "-q",
        "--quality",
        choices=["preview", "standard", "high"],
        default="standard",
        help="Mesh quality preset",
    )
    convert_parser.add_argument(
        "--decompose",
        action="store_true",
        help="Decompose assembly into individual parts",
    )
    convert_parser.add_argument(
        "--ascii",
        action="store_true",
        help="Write ASCII STL instead of binary",
    )
    convert_parser.add_argument(
        "--no-glb",
        action="store_true",
        default=False,
        help="Skip GLB generation (STL only)",
    )

    args = parser.parse_args()

    if args.command == "convert":
        _run_convert(args)
    else:
        _run_worker()


def _run_convert(args: argparse.Namespace) -> None:
    """Run standalone CLI conversion."""
    from .models import MeshQuality

    input_path = os.path.abspath(args.input)
    output_dir = os.path.abspath(args.output)
    quality = MeshQuality(args.quality)
    binary_stl = not args.ascii

    if not os.path.exists(input_path):
        logger.error("Input file not found: %s", input_path)
        sys.exit(1)

    logger.info("Input:   %s", input_path)
    logger.info("Output:  %s", output_dir)
    logger.info("Quality: %s", quality.value)
    logger.info("Mode:    %s", "decompose" if args.decompose else "single")
    logger.info("Format:  %s STL", "ASCII" if args.ascii else "Binary")

    os.makedirs(output_dir, exist_ok=True)

    if args.decompose:
        from .assembly import decompose_step_assembly

        def on_progress(pct: int, msg: str) -> None:
            logger.info("[%3d%%] %s", pct, msg)

        results = decompose_step_assembly(
            input_path, output_dir, quality, binary_stl, progress_callback=on_progress
        )
        total_polys = sum(r.polygon_count for r in results)
        logger.info("Done! %d parts, %d total polygons", len(results), total_polys)
        for r in results:
            logger.info("  %s: %d polygons", r.part_name, r.polygon_count)
    else:
        stem = os.path.splitext(os.path.basename(input_path))[0]
        stl_path = os.path.join(output_dir, f"{stem}.stl")

        if args.no_glb:
            from .converter import convert_single

            result = convert_single(input_path, stl_path, quality, binary_stl)
        else:
            from .converter import convert_single_with_colors

            glb_path = os.path.join(output_dir, f"{stem}.glb")
            result = convert_single_with_colors(
                input_path, stl_path, glb_path, quality, binary_stl
            )
            if result.glb_path:
                logger.info("GLB:     %s", result.glb_path)

        logger.info(
            "Done! %d polygons, bbox=(%.1f x %.1f x %.1f)",
            result.polygon_count,
            result.bounding_box.x if result.bounding_box else 0,
            result.bounding_box.y if result.bounding_box else 0,
            result.bounding_box.z if result.bounding_box else 0,
        )


def _run_worker() -> None:
    """Run as RabbitMQ worker."""
    logger.info("Starting CAD converter worker...")
    from .worker import run_worker

    run_worker()


if __name__ == "__main__":
    main()