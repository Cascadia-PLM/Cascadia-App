"""Assembly decomposition — extract individual parts from STEP assemblies using XDE."""

from __future__ import annotations

import logging
import os
from typing import Callable, Optional

from OCC.Core.IFSelect import IFSelect_RetDone
from OCC.Core.STEPCAFControl import STEPCAFControl_Reader
from OCC.Core.TCollection import TCollection_ExtendedString
from OCC.Core.TDF import TDF_Label, TDF_LabelSequence
from OCC.Core.TDocStd import TDocStd_Document
from OCC.Core.TopLoc import TopLoc_Location
from OCC.Core.XCAFApp import XCAFApp_Application
from OCC.Core.XCAFDoc import XCAFDoc_DocumentTool, XCAFDoc_ShapeTool

from .colors import PartColor, extract_shape_colors, get_dominant_color, get_label_color
from .converter import (
    count_polygons,
    get_bounding_box,
    tessellate,
    write_stl,
)
from .gltf_writer import write_glb
from .models import ConversionOutput, MeshQuality, MESH_PRESETS

logger = logging.getLogger(__name__)


def _get_label_name(label: TDF_Label) -> str:
    """Extract the name string from an XDE label."""
    from OCC.Core.TDataStd import TDataStd_Name

    name_attr = TDataStd_Name()
    _get_id = getattr(TDataStd_Name, 'GetID_s', None) or TDataStd_Name.GetID
    if label.FindAttribute(_get_id(), name_attr):
        return name_attr.Get().ToExtString()
    return ""


def _location_to_matrix(loc: TopLoc_Location) -> list[float]:
    """Convert an OpenCASCADE location to a flat 4x4 transformation matrix."""
    trsf = loc.Transformation()
    matrix = []
    for row in range(1, 4):
        for col in range(1, 5):
            matrix.append(trsf.Value(row, col))
    # Add homogeneous row [0, 0, 0, 1]
    matrix.extend([0.0, 0.0, 0.0, 1.0])
    return [round(v, 8) for v in matrix]


def read_xde_shape_and_color(
    step_path: str,
) -> tuple["TopoDS_Shape", Optional[PartColor]]:
    """
    Read a STEP file via XDE and return the compound shape + dominant color.

    Uses the same XDE document approach as decompose_step_assembly() but only
    extracts the compound shape and dominant color — useful for rendering
    thumbnails with accurate geometry and color.
    """
    from OCC.Core.BRep import BRep_Builder
    from OCC.Core.TopoDS import TopoDS_Compound

    _get_app = getattr(XCAFApp_Application, 'GetApplication_s', None) or XCAFApp_Application.GetApplication
    app = _get_app()
    doc = TDocStd_Document(TCollection_ExtendedString("MDTV-XCAF"))
    app.InitDocument(doc)

    reader = STEPCAFControl_Reader()
    reader.SetNameMode(True)
    reader.SetColorMode(True)

    status = reader.ReadFile(step_path)
    if status != IFSelect_RetDone:
        raise ValueError(f"XDE ReadFile failed: {step_path} (status={status})")

    if not reader.Transfer(doc):
        raise ValueError(f"XDE Transfer failed: {step_path}")

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

    # Extract dominant color
    color_map = extract_shape_colors(doc)
    dominant_color = get_dominant_color(color_map)

    return shape, dominant_color


def decompose_step_assembly(
    step_path: str,
    output_dir: str,
    quality: MeshQuality = MeshQuality.STANDARD,
    binary_stl: bool = True,
    progress_callback: Optional[Callable[[int, str], None]] = None,
) -> list[ConversionOutput]:
    """
    Decompose a STEP assembly into individual part STL files.

    Uses XDE (Extended Data Framework) to preserve assembly structure,
    part names, and transformations.

    Args:
        step_path: Path to input STEP file.
        output_dir: Directory for output STL files.
        quality: Mesh quality preset.
        binary_stl: Write binary STL (True) or ASCII (False).
        progress_callback: Optional callback(percent, message) for progress updates.

    Returns:
        List of ConversionOutput for each extracted part.
    """
    logger.info("Decomposing STEP assembly: %s", step_path)
    os.makedirs(output_dir, exist_ok=True)

    # Create XDE document
    _get_app = getattr(XCAFApp_Application, 'GetApplication_s', None) or XCAFApp_Application.GetApplication
    app = _get_app()
    doc = TDocStd_Document(TCollection_ExtendedString("MDTV-XCAF"))
    app.InitDocument(doc)

    # Read STEP with XDE reader
    reader = STEPCAFControl_Reader()
    reader.SetNameMode(True)
    reader.SetColorMode(True)

    status = reader.ReadFile(step_path)
    if status != IFSelect_RetDone:
        raise ValueError(f"Failed to read STEP assembly: {step_path} (status={status})")

    if not reader.Transfer(doc):
        raise ValueError(f"Failed to transfer STEP assembly data: {step_path}")

    # Get the shape tool and color tool from the document
    _shape_tool_fn = getattr(XCAFDoc_DocumentTool, 'ShapeTool_s', None) or XCAFDoc_DocumentTool.ShapeTool
    shape_tool = _shape_tool_fn(doc.Main())

    # Get color tool for per-label color extraction
    from OCC.Core.XCAFDoc import XCAFDoc_ColorTool

    _color_set_fn = getattr(XCAFDoc_ColorTool, 'Set_s', None) or XCAFDoc_ColorTool.Set
    color_tool = _color_set_fn(doc.Main())

    # Collect all leaf parts (free shapes that are simple shapes or components)
    parts: list[tuple[str, TDF_Label]] = []
    _collect_parts(shape_tool, parts)

    total_parts = len(parts)
    logger.info("Found %d parts in assembly", total_parts)

    if total_parts == 0:
        logger.warning("No parts found in assembly, falling back to single conversion")
        from .converter import convert_single

        result = convert_single(step_path, os.path.join(output_dir, "assembly.stl"), quality, binary_stl)
        return [result]

    linear, angular = MESH_PRESETS[quality]
    results: list[ConversionOutput] = []
    seen_names: dict[str, int] = {}

    for idx, (part_name, label) in enumerate(parts):
        # Deduplicate names
        if part_name in seen_names:
            seen_names[part_name] += 1
            unique_name = f"{part_name}_{seen_names[part_name]}"
        else:
            seen_names[part_name] = 0
            unique_name = part_name

        # Sanitize filename
        safe_name = _sanitize_filename(unique_name)
        stl_filename = f"{safe_name}.stl"
        stl_path = os.path.join(output_dir, stl_filename)

        try:
            shape = shape_tool.GetShape(label)
            if shape.IsNull():
                logger.warning("Skipping part '%s': null shape", part_name)
                continue

            # Get transformation
            loc = shape_tool.GetLocation(label)
            transform = _location_to_matrix(loc) if not loc.IsIdentity() else None

            # Extract per-label color
            part_color = get_label_color(color_tool, label)
            color_list = part_color.to_list() if part_color else None

            # Tessellate and write STL
            tessellate(shape, linear, angular)
            write_stl(shape, stl_path, binary=binary_stl)

            polygon_count = count_polygons(stl_path, binary=binary_stl)
            bbox = get_bounding_box(shape)

            # Write GLB with color
            glb_path: Optional[str] = None
            try:
                glb_filename = f"{safe_name}.glb"
                glb_output = os.path.join(output_dir, glb_filename)
                # Build a color map for this part's faces
                face_color_map: dict[int, PartColor] = {}
                if part_color:
                    from OCC.Core.TopAbs import TopAbs_FACE
                    from OCC.Core.TopExp import TopExp_Explorer

                    explorer = TopExp_Explorer(shape, TopAbs_FACE)
                    while explorer.More():
                        face = explorer.Current()
                        face_hash = face.HashCode(2147483647)
                        face_color_map[face_hash] = part_color
                        explorer.Next()

                default_color = part_color or PartColor(0.45, 0.50, 0.56)
                glb_path, _ = write_glb(shape, face_color_map, glb_output, default_color=default_color)
            except Exception as e:
                logger.warning("GLB export failed for part '%s' (non-blocking): %s", part_name, e)

            results.append(
                ConversionOutput(
                    stl_path=stl_path,
                    part_name=part_name,
                    polygon_count=polygon_count,
                    bounding_box=bbox,
                    transform=transform,
                    glb_path=glb_path,
                    color=color_list,
                )
            )

            if progress_callback:
                pct = int(((idx + 1) / total_parts) * 100)
                progress_callback(pct, f"Converted part {idx + 1}/{total_parts}: {part_name}")

        except Exception as e:
            logger.error("Failed to convert part '%s': %s", part_name, e)
            # Continue with other parts instead of failing entirely
            continue

    logger.info(
        "Assembly decomposition complete: %d/%d parts converted",
        len(results),
        total_parts,
    )
    return results


def _collect_parts(
    shape_tool: XCAFDoc_ShapeTool,
    parts: list[tuple[str, TDF_Label]],
) -> None:
    """Recursively collect all leaf part labels from the assembly tree."""
    free_shapes = TDF_LabelSequence()
    shape_tool.GetFreeShapes(free_shapes)

    for i in range(free_shapes.Length()):
        label = free_shapes.Value(i + 1)  # 1-indexed
        _collect_parts_recursive(shape_tool, label, parts, depth=0)


def _collect_parts_recursive(
    shape_tool: XCAFDoc_ShapeTool,
    label: TDF_Label,
    parts: list[tuple[str, TDF_Label]],
    depth: int,
) -> None:
    """Recurse into assembly components, collecting leaf parts."""
    name = _get_label_name(label) or f"unnamed_part_{len(parts)}"

    if shape_tool.IsAssembly(label):
        # Recurse into sub-components
        components = TDF_LabelSequence()
        shape_tool.GetComponents(label, components)
        for i in range(components.Length()):
            child = components.Value(i + 1)
            # Resolve reference if it's a reference label
            if shape_tool.IsReference(child):
                ref_label = TDF_Label()
                shape_tool.GetReferredShape(child, ref_label)
                _collect_parts_recursive(shape_tool, ref_label, parts, depth + 1)
            else:
                _collect_parts_recursive(shape_tool, child, parts, depth + 1)
    elif shape_tool.IsSimpleShape(label):
        # Leaf part — collect it
        parts.append((name, label))


def _sanitize_filename(name: str) -> str:
    """Sanitize a part name for use as a filename."""
    # Replace problematic characters
    for ch in r'<>:"/\|?*':
        name = name.replace(ch, "_")
    # Collapse multiple underscores and trim
    while "__" in name:
        name = name.replace("__", "_")
    return name.strip("_")[:200]  # Limit length
