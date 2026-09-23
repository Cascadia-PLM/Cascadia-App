# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Cascadia PLM LLC

"""Assembly decomposition — extract individual parts from STEP assemblies using XDE."""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from typing import Callable, Optional

from OCC.Core.IFSelect import IFSelect_RetDone
from OCC.Core.STEPCAFControl import STEPCAFControl_Reader
from OCC.Core.TDF import TDF_Label, TDF_LabelSequence
from OCC.Core.TDocStd import TDocStd_Document
from OCC.Core.TopLoc import TopLoc_Location
from OCC.Core.XCAFApp import XCAFApp_Application
from OCC.Core.XCAFDoc import XCAFDoc_DocumentTool, XCAFDoc_ShapeTool

from .colors import (
    PartColor,
    extract_shape_colors,
    get_dominant_color,
    get_label_color,
    get_shape_color,
)
from .converter import (
    count_polygons,
    get_bounding_box,
    tessellate,
    write_stl,
)
from .gltf_writer import write_glb
from .models import ConversionOutput, MeshQuality, MESH_PRESETS

logger = logging.getLogger(__name__)


#: Marker `TDataStd_Name.Dump()` puts immediately before the name it holds.
_DUMP_NAME_MARKER = "Name=|"


def _name_attribute_id():
    """GUID of the name attribute, however this pythonocc spells the getter."""
    from OCC.Core.TDataStd import TDataStd_Name

    getter = getattr(TDataStd_Name, "GetID_s", None) or TDataStd_Name.GetID
    return getter()


def _name_from_dump(named) -> str:
    """
    The name out of an attribute's debug dump.

    Not a preference. OCCT's `TDataStd_Name::Get()` is simply **not wrapped**
    by pythonocc-core: the class binds `DownCast`, `Dump`, `GetID`, `Set` and
    `SetID` and nothing else, its `TDataStd_GenericExtString` base — where
    OCCT declares `Get()` — binds no members at all, and no module-level
    `TDataStd_Name_Get` is generated either. Checked against both builds
    conda-forge offers (7.8.1.1 and 7.9.3); neither has it. `Dump` is the only
    accessor left that reaches the string, and it writes

        	TDataStd_Name	Trans. 0; Valid;	ID = <guid>
 Name=|<name>|<guid>


    so the name is what sits between the marker and the last `|` — last, not
    first, because a CAD name may legitimately contain one and the closing
    delimiter is always the one before the trailing GUID.
    """
    try:
        dumped = named.Dump()
    except Exception:
        return ""

    # pythonocc binds Dump's `Standard_OStream&` out-parameter by returning
    # `(stream, text)` rather than writing into a stream handed to it.
    if isinstance(dumped, tuple):
        text = next((part for part in dumped if isinstance(part, str)), "")
    else:
        text = dumped if isinstance(dumped, str) else ""

    start = text.find(_DUMP_NAME_MARKER)
    if start < 0:
        return ""
    rest = text[start + len(_DUMP_NAME_MARKER) :]
    end = rest.rfind("|")
    if end < 0:
        return ""
    return rest[:end].strip()


def _get_label_name(label: TDF_Label) -> str:
    """
    The name STEP gave this label, or "" when it carries none.

    Never raises: a label with no name, and a pythonocc that will not give one
    up, are both "no name". That matters more than it looks — this is called
    from the assembly walks, and the previous implementation raised
    `TypeError` on every call against the pythonocc the image actually
    resolves, which turned every structured export into a silent flat one and
    made `decompose_step_assembly` fail outright.

    Two pythonocc shapes are load-bearing. `FindAttribute` binds its
    `handle<TDF_Attribute>&` out-parameter as the *return value*, so it takes
    `None` in that position and answers the attribute or `None` — passing a
    `TDataStd_Name()` there is what raised. And the name itself has to come
    out of `Dump`; see `_name_from_dump`.
    """
    from OCC.Core.TDataStd import TDataStd_Name

    try:
        attribute = label.FindAttribute(_name_attribute_id(), None)
    except Exception:
        return ""
    if attribute is None:
        return ""

    try:
        named = TDataStd_Name.DownCast(attribute)
    except Exception:
        return ""
    if named is None:
        return ""

    # Kept for a pythonocc that wraps the accessor OCCT actually declares.
    getter = getattr(named, "Get", None)
    if getter is not None:
        try:
            return getter().ToExtString()
        except Exception:
            pass

    return _name_from_dump(named)


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


@dataclass
class PlacedPart:
    """
    One leaf part of an assembly, and where the assembly puts it.

    `shape` is deliberately the *prototype* — the part as its own CAD authored
    it, with no assembly placement applied — and `location` carries the
    placement separately. That keeps each part in the coordinates its own CAD
    authored, so the viewer can overlay two revisions of it without a
    registration step; and a part used twenty times is twenty entries here
    sharing one prototype, which only stays cheap while the geometry is not
    copied per occurrence.

    The cost of the split is that an unplaced prototype's face hashes match
    nothing in a color map built from the located compound — an OCCT 7.8+ hash
    folds in the shape's location. Per-face color therefore has to be resolved
    through the TShape-keyed map instead; see `colors.ShapeColors`.
    """

    #: Unique within one assembly, and stable across re-conversions while the
    #: CAD structure is: the instance path, with `#2`, `#3` … disambiguating
    #: repeats. This is what a saved node → part-item link is keyed by.
    node_key: str
    #: The part's own name as the CAD authored it, which is what an automatic
    #: match against a BOM has to work from. Not unique: every occurrence of
    #: one part reports the same name.
    name: str
    #: Names from the assembly root down to this part, `node_key` unsuffixed.
    path: list[str] = field(default_factory=list)
    #: The prototype shape, unplaced. Typed loosely — `TopoDS_Shape` is only
    #: importable from OCC, which the type-checking-free worker never loads.
    shape: object = None
    #: Placement from assembly root to this occurrence.
    location: Optional[TopLoc_Location] = None
    #: Color on the part's own label, if the STEP assigned one there.
    color: Optional[PartColor] = None


def collect_placed_parts(
    shape_tool: XCAFDoc_ShapeTool,
    color_tool=None,
) -> list[PlacedPart]:
    """
    Every leaf part of the document, with its placement in the assembly.

    Distinct from `_collect_parts` below, which this does not replace: that one
    answers "which parts exist" for decomposition into separate files, and
    discards placement on the way. Occurrence *and* placement is what a single
    navigable assembly GLB needs, so this walk composes each component's
    location into the one it inherited, the way OCCT's own presentation
    traversal does. Without that a part used at three places on an arm renders
    three times at the prototype's origin, piled on top of each other.

    Color is inherited down the same walk, for the same reason `extract_shape_colors`
    does it: a STEP assembly commonly paints a subassembly and says nothing
    about the parts inside it. Resolving only the leaf's own label would draw
    those in the document's dominant color instead.
    """
    parts: list[PlacedPart] = []
    seen_keys: dict[str, int] = {}

    free_shapes = TDF_LabelSequence()
    shape_tool.GetFreeShapes(free_shapes)

    for i in range(free_shapes.Length()):
        root = free_shapes.Value(i + 1)
        _collect_placed_recursive(
            shape_tool,
            color_tool,
            root,
            TopLoc_Location(),
            [],
            parts,
            seen_keys,
            depth=0,
            inherited_color=None,
        )

    return parts


#: An assembly deeper than this is a cycle in the reference graph or a file
#: pathological enough that no viewer would be usable on it. Bounded rather
#: than tracked with a visited set, because the same prototype legitimately
#: appears many times and must be walked once per occurrence.
_MAX_ASSEMBLY_DEPTH = 32


def _collect_placed_recursive(
    shape_tool: XCAFDoc_ShapeTool,
    color_tool,
    label: TDF_Label,
    location: TopLoc_Location,
    path: list[str],
    parts: list[PlacedPart],
    seen_keys: dict[str, int],
    depth: int,
    inherited_color: Optional[PartColor] = None,
    occurrence_color: Optional[PartColor] = None,
) -> None:
    """Walk one label, composing locations and color down into its components."""
    if depth > _MAX_ASSEMBLY_DEPTH:
        logger.warning(
            "Assembly nesting exceeded %d levels at '%s'; not descending further",
            _MAX_ASSEMBLY_DEPTH,
            "/".join(path) or "<root>",
        )
        return

    # Color precedence, mirroring `extract_shape_colors` so the two paths agree
    # about what a file says: this occurrence's own color first, then the
    # prototype label's, then the color on the prototype's *shape*, then
    # whatever an ancestor assembly painted. The occurrence outranks the
    # prototype because that is the only way a file can say "this one bracket
    # is red and its siblings are not"; the shape rung is below the label but
    # is the one that answers for most real files (see `_shape_color`).
    effective_color = occurrence_color
    if effective_color is None:
        effective_color = _label_color(color_tool, label)
    if effective_color is None:
        effective_color = _shape_color(color_tool, shape_tool, label)
    if effective_color is None:
        effective_color = inherited_color

    if shape_tool.IsAssembly(label):
        components = TDF_LabelSequence()
        shape_tool.GetComponents(label, components)
        for i in range(components.Length()):
            component = components.Value(i + 1)
            # Read on the component label, which is the occurrence; the
            # recursive call weighs it against the prototype's own.
            component_color = _label_color(color_tool, component)

            if shape_tool.IsReference(component):
                # The instance placement lives on the component label; the
                # geometry lives on the label it refers to, shared by every
                # other occurrence of the same part. `GetShape` on that
                # prototype hands back unplaced geometry, so the placement has
                # to be carried down and composed here.
                referred = TDF_Label()
                shape_tool.GetReferredShape(component, referred)
                target = referred
                child_location = _compose(
                    location, shape_tool.GetLocation(component)
                )
            else:
                # Components of an assembly are references in every file OCCT
                # produces, so this is the defensive arm — and it must NOT
                # compose. `GetShape` on a non-reference label already returns
                # the shape carrying whatever placement that label holds, so
                # composing it again would apply the same transform twice, and
                # the part would land at double its offset from the origin.
                target = component
                child_location = location

            # The product name is on the prototype; the component label
            # usually carries only an occurrence name like "Bracket_3". Prefer
            # the prototype, because that is what a BOM can be matched against.
            name = _get_label_name(target) or _get_label_name(component)
            _collect_placed_recursive(
                shape_tool,
                color_tool,
                target,
                child_location,
                path + [name or f"unnamed_{i + 1}"],
                parts,
                seen_keys,
                depth + 1,
                inherited_color=effective_color,
                occurrence_color=component_color,
            )
        return

    if not shape_tool.IsSimpleShape(label):
        return

    name = _get_label_name(label)
    effective_path = path if path else [name or f"unnamed_part_{len(parts)}"]
    leaf_name = effective_path[-1]

    base_key = "/".join(effective_path)
    count = seen_keys.get(base_key, 0)
    seen_keys[base_key] = count + 1
    node_key = base_key if count == 0 else f"{base_key}#{count + 1}"

    shape = shape_tool.GetShape(label)
    if shape is None or shape.IsNull():
        logger.warning("Skipping leaf '%s': null shape", node_key)
        return

    parts.append(
        PlacedPart(
            node_key=node_key,
            name=leaf_name,
            path=effective_path,
            shape=shape,
            location=location,
            color=effective_color,
        )
    )


def _label_color(color_tool, label: TDF_Label) -> Optional[PartColor]:
    """Color on this label, or None - including when there is no color tool."""
    if color_tool is None:
        return None
    try:
        return get_label_color(color_tool, label)
    except Exception:
        # `get_label_color` already absorbs the SWIG binding failure it knows
        # about; this is the belt for the rest, because losing a color must
        # not abandon the structure walk.
        return None


def _shape_color(
    color_tool, shape_tool: XCAFDoc_ShapeTool, label: TDF_Label
) -> Optional[PartColor]:
    """
    Color on the *shape* this label carries, rather than on the label.

    The rung that actually answers, and not a fallback in practice. STEP
    exporters commonly attach color to the TShape rather than to the XDE
    label — `get_shape_color`'s own docstring says so for SolidWorks AP214,
    and FreeCAD's exporter does the same. Measured on the demo cart's
    top-level assembly: the label lookup above resolves **0** of 248 leaf
    parts, this one resolves **218**. Without it every part in an assembly is
    drawn in the document's dominant color.
    """
    if color_tool is None:
        return None
    try:
        shape = shape_tool.GetShape(label)
    except Exception:
        return None
    if shape is None or shape.IsNull():
        return None
    try:
        return get_shape_color(color_tool, shape)
    except Exception:
        return None


def _compose(parent: TopLoc_Location, child: TopLoc_Location) -> TopLoc_Location:
    """
    Parent placement applied on top of a component's own — `parent * child`.

    The operator is what OCCT's presentation code uses, but pythonocc has
    exposed it under both a method and `__mul__` across versions, so ask for
    whichever this build has.
    """
    multiplied = getattr(parent, "Multiplied", None)
    if multiplied is not None:
        return multiplied(child)
    return parent * child


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
    doc = TDocStd_Document("MDTV-XCAF")
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
    doc = TDocStd_Document("MDTV-XCAF")
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
                        # OCCT 7.8+ removed TopoDS_Shape.HashCode — use Python's hash().
                        face_hash = hash(face)
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
