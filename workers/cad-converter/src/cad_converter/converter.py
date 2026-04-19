"""STEP/IGES to STL conversion using pythonocc-core."""

from __future__ import annotations

import json
import logging
import multiprocessing
import os
import struct
from pathlib import Path
from typing import Optional

from OCC.Core.BRepMesh import BRepMesh_IncrementalMesh
from OCC.Core.Bnd import Bnd_Box
from OCC.Core.BRepBndLib import brepbndlib
from OCC.Core.IGESControl import IGESControl_Reader
from OCC.Core.IFSelect import IFSelect_RetDone
from OCC.Core.STEPControl import STEPControl_Reader
from OCC.Core.StlAPI import StlAPI_Writer
from OCC.Core.TopoDS import TopoDS_Shape

from .models import BoundingBox, ConversionOutput, MeshQuality, MESH_PRESETS

logger = logging.getLogger(__name__)


def read_step(file_path: str) -> TopoDS_Shape:
    """Read a STEP file and return the compound shape."""
    reader = STEPControl_Reader()
    status = reader.ReadFile(file_path)
    if status != IFSelect_RetDone:
        raise ValueError(f"Failed to read STEP file: {file_path} (status={status})")
    reader.TransferRoots()
    shape = reader.OneShape()
    if shape.IsNull():
        raise ValueError(f"STEP file produced null shape: {file_path}")
    return shape


def read_iges(file_path: str) -> TopoDS_Shape:
    """Read an IGES file and return the compound shape."""
    reader = IGESControl_Reader()
    status = reader.ReadFile(file_path)
    if status != IFSelect_RetDone:
        raise ValueError(f"Failed to read IGES file: {file_path} (status={status})")
    reader.TransferRoots()
    shape = reader.OneShape()
    if shape.IsNull():
        raise ValueError(f"IGES file produced null shape: {file_path}")
    return shape


def read_cad_file(file_path: str) -> TopoDS_Shape:
    """Read a CAD file (STEP or IGES) based on extension."""
    ext = Path(file_path).suffix.lower()
    if ext in (".step", ".stp"):
        return read_step(file_path)
    elif ext in (".iges", ".igs"):
        return read_iges(file_path)
    else:
        raise ValueError(f"Unsupported CAD format: {ext}")


def tessellate(
    shape: TopoDS_Shape,
    linear_deflection: float = 0.1,
    angular_deflection: float = 0.5,
) -> None:
    """Tessellate a shape in-place for STL export."""
    mesh = BRepMesh_IncrementalMesh(shape, linear_deflection, False, angular_deflection)
    mesh.Perform()
    if not mesh.IsDone():
        raise RuntimeError("Tessellation failed")


def write_stl(shape: TopoDS_Shape, output_path: str, binary: bool = True) -> None:
    """Write a tessellated shape to an STL file."""
    writer = StlAPI_Writer()
    writer.SetASCIIMode(not binary)
    success = writer.Write(shape, output_path)
    if not success:
        raise RuntimeError(f"Failed to write STL: {output_path}")


def get_bounding_box(shape: TopoDS_Shape) -> BoundingBox:
    """Compute axis-aligned bounding box of a shape."""
    box = Bnd_Box()
    brepbndlib.Add(shape, box)
    xmin, ymin, zmin, xmax, ymax, zmax = box.Get()
    return BoundingBox(
        x=round(xmax - xmin, 4),
        y=round(ymax - ymin, 4),
        z=round(zmax - zmin, 4),
    )


def count_triangles_binary_stl(stl_path: str) -> int:
    """Count triangles in a binary STL file by reading the header."""
    with open(stl_path, "rb") as f:
        f.seek(80)  # Skip 80-byte header
        data = f.read(4)
        if len(data) < 4:
            return 0
        return struct.unpack("<I", data)[0]


def count_triangles_ascii_stl(stl_path: str) -> int:
    """Count triangles in an ASCII STL by counting 'facet' lines."""
    count = 0
    with open(stl_path, "r", errors="ignore") as f:
        for line in f:
            if line.strip().startswith("facet normal"):
                count += 1
    return count


def count_polygons(stl_path: str, binary: bool = True) -> int:
    """Count the number of triangles/polygons in an STL file."""
    if binary:
        return count_triangles_binary_stl(stl_path)
    else:
        return count_triangles_ascii_stl(stl_path)


def convert_single(
    input_path: str,
    output_path: str,
    quality: MeshQuality = MeshQuality.STANDARD,
    binary_stl: bool = True,
    thumbnail_path: Optional[str] = None,
) -> ConversionOutput:
    """
    Convert a single CAD file (STEP/IGES) to STL.

    Returns conversion metadata including polygon count and bounding box.
    Optionally renders a thumbnail PNG from the B-Rep shape before tessellation.
    """
    logger.info("Reading CAD file: %s", input_path)
    shape = read_cad_file(input_path)

    # Render thumbnail from B-Rep geometry BEFORE tessellation for smooth output
    rendered_thumbnail: Optional[str] = None
    if thumbnail_path:
        from .thumbnail import render_thumbnail
        if render_thumbnail(shape, thumbnail_path):
            rendered_thumbnail = thumbnail_path

    linear, angular = MESH_PRESETS[quality]
    logger.info("Tessellating with quality=%s (linear=%.4f, angular=%.4f)", quality.value, linear, angular)
    tessellate(shape, linear, angular)

    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    logger.info("Writing STL: %s (binary=%s)", output_path, binary_stl)
    write_stl(shape, output_path, binary=binary_stl)

    polygon_count = count_polygons(output_path, binary=binary_stl)
    bbox = get_bounding_box(shape)

    file_size = os.path.getsize(output_path)
    logger.info(
        "Conversion complete: %d polygons, bbox=(%.1f x %.1f x %.1f), size=%d bytes",
        polygon_count,
        bbox.x,
        bbox.y,
        bbox.z,
        file_size,
    )

    return ConversionOutput(
        stl_path=output_path,
        part_name=Path(input_path).stem,
        polygon_count=polygon_count,
        bounding_box=bbox,
        thumbnail_path=rendered_thumbnail,
    )


# ---------------------------------------------------------------------------
# XDE subprocess target — runs in an isolated process so C++ crashes
# (Standard_NullObject, etc.) don't kill the main worker.
# ---------------------------------------------------------------------------

def _xde_glb_subprocess(
    input_path: str,
    glb_output_path: str,
    quality_value: str,
    result_path: str,
) -> None:
    """
    Subprocess target: read STEP via XDE, extract colors, write GLB.

    Communicates results back via a JSON file at result_path.
    If this process crashes (SIGABRT from OCCT), the parent detects a
    non-zero exit code and falls back gracefully.
    """
    try:
        from OCC.Core.BRep import BRep_Builder
        from OCC.Core.IFSelect import IFSelect_RetDone as _RetDone
        from OCC.Core.STEPCAFControl import STEPCAFControl_Reader
        from OCC.Core.TCollection import TCollection_ExtendedString
        from OCC.Core.TDF import TDF_LabelSequence
        from OCC.Core.TDocStd import TDocStd_Document
        from OCC.Core.TopoDS import TopoDS_Compound
        from OCC.Core.XCAFApp import XCAFApp_Application
        from OCC.Core.XCAFDoc import XCAFDoc_DocumentTool

        from .colors import PartColor, extract_shape_colors, get_dominant_color
        from .gltf_writer import write_glb

        quality = MeshQuality(quality_value)

        # Create XDE document
        _get_app = getattr(XCAFApp_Application, 'GetApplication_s', None) or XCAFApp_Application.GetApplication
        app = _get_app()
        doc = TDocStd_Document(TCollection_ExtendedString("MDTV-XCAF"))
        app.InitDocument(doc)

        reader = STEPCAFControl_Reader()
        reader.SetNameMode(True)
        reader.SetColorMode(True)

        status = reader.ReadFile(input_path)
        if status != _RetDone:
            raise ValueError(f"XDE ReadFile failed (status={status})")

        if not reader.Transfer(doc):
            raise ValueError("XDE Transfer failed")

        # Get shape tool
        _shape_tool_fn = getattr(XCAFDoc_DocumentTool, 'ShapeTool_s', None) or XCAFDoc_DocumentTool.ShapeTool
        shape_tool = _shape_tool_fn(doc.Main())

        # Build compound from free shapes
        free_shapes = TDF_LabelSequence()
        shape_tool.GetFreeShapes(free_shapes)

        shape = None
        if free_shapes.Length() == 1:
            shape = shape_tool.GetShape(free_shapes.Value(1))
        elif free_shapes.Length() > 1:
            builder = BRep_Builder()
            compound = TopoDS_Compound()
            builder.MakeCompound(compound)
            for i in range(free_shapes.Length()):
                s = shape_tool.GetShape(free_shapes.Value(i + 1))
                if s is not None and not s.IsNull():
                    builder.Add(compound, s)
            shape = compound

        if shape is None or shape.IsNull():
            raise ValueError("XDE produced no shapes")

        # Extract colors
        color_map = extract_shape_colors(doc)
        dominant_color = get_dominant_color(color_map)

        # Tessellate
        linear, angular = MESH_PRESETS[quality]
        tessellate(shape, linear, angular)

        # Write GLB
        os.makedirs(os.path.dirname(glb_output_path), exist_ok=True)
        glb_path, glb_polygons = write_glb(
            shape,
            color_map,
            glb_output_path,
            default_color=dominant_color or PartColor(0.45, 0.50, 0.56),
        )

        color_list = dominant_color.to_list() if dominant_color else None

        # Write result JSON
        result = {
            "glb_path": glb_path,
            "color": color_list,
            "polygon_count": glb_polygons,
        }
        with open(result_path, "w") as f:
            json.dump(result, f)

    except Exception as e:
        # Write error JSON so parent knows what happened
        try:
            with open(result_path, "w") as f:
                json.dump({"error": str(e)}, f)
        except Exception:
            pass


def convert_single_with_colors(
    input_path: str,
    stl_output_path: str,
    glb_output_path: str,
    quality: MeshQuality = MeshQuality.STANDARD,
    binary_stl: bool = True,
    thumbnail_path: Optional[str] = None,
) -> ConversionOutput:
    """
    Convert a single STEP file to STL, then attempt GLB with colors.

    The STL conversion uses the reliable simple STEP reader.
    GLB+color extraction runs in an isolated subprocess via multiprocessing
    so that C++ crashes (Standard_NullObject) in the XDE code path don't
    kill the main worker process.

    Falls back to STL-only output if GLB generation fails or crashes.
    """
    # Step 1: Always do the reliable STL conversion first
    result = convert_single(input_path, stl_output_path, quality, binary_stl, thumbnail_path)

    # GLB with color extraction requires the XDE (XCAF) reader which only
    # supports STEP files. IGES and other formats lack the color/material
    # metadata that XDE relies on, so we skip GLB generation for non-STEP inputs.
    ext = Path(input_path).suffix.lower()
    if ext not in (".step", ".stp"):
        logger.info(
            "Skipping GLB generation for non-STEP file (%s); "
            "color extraction requires STEP format",
            ext,
        )
        return result

    # Step 2: Attempt GLB with colors in an isolated subprocess
    result_path = glb_output_path + ".result.json"

    try:
        logger.info("Attempting XDE color extraction in subprocess for: %s", input_path)

        proc = multiprocessing.Process(
            target=_xde_glb_subprocess,
            args=(input_path, glb_output_path, quality.value, result_path),
        )
        proc.start()
        proc.join(timeout=180)  # 3 minute timeout

        if proc.is_alive():
            logger.warning("XDE subprocess timed out, killing it")
            proc.kill()
            proc.join(timeout=5)
            return result

        if proc.exitcode != 0:
            logger.warning(
                "XDE subprocess crashed (exit=%s), continuing with STL only",
                proc.exitcode,
            )
            return result

        # Read subprocess result
        if not os.path.exists(result_path):
            logger.warning("XDE subprocess produced no result file")
            return result

        with open(result_path) as f:
            xde_result = json.load(f)

        if "error" in xde_result:
            logger.warning("XDE subprocess reported error: %s", xde_result["error"])
            return result

        # Merge GLB result into the STL conversion output
        result.glb_path = xde_result.get("glb_path")
        result.color = xde_result.get("color")

        if result.glb_path:
            logger.info(
                "GLB with colors generated: %d polygons",
                xde_result.get("polygon_count", 0),
            )

    except Exception as e:
        logger.warning("GLB color extraction failed (non-blocking): %s", e)

    finally:
        # Clean up result file
        try:
            if os.path.exists(result_path):
                os.unlink(result_path)
        except OSError:
            pass

    return result
