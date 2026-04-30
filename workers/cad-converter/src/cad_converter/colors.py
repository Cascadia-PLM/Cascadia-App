"""Extract per-face/solid colors from STEP XDE documents via XCAFDoc_ColorTool."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Optional

from OCC.Core.Quantity import Quantity_Color
from OCC.Core.TDF import TDF_ChildIterator, TDF_Label, TDF_LabelSequence
from OCC.Core.TDocStd import TDocStd_Document
from OCC.Core.TopAbs import TopAbs_FACE
from OCC.Core.TopExp import TopExp_Explorer
from OCC.Core.TopoDS import TopoDS_Shape, TopoDS_Iterator
from OCC.Core.XCAFDoc import (
    XCAFDoc_ColorGen,
    XCAFDoc_ColorSurf,
    XCAFDoc_DocumentTool,
    XCAFDoc_ShapeTool,
)

logger = logging.getLogger(__name__)


@dataclass
class PartColor:
    """RGB color with values in [0.0, 1.0]."""

    r: float
    g: float
    b: float

    def to_list(self) -> list[float]:
        return [self.r, self.g, self.b]


def _get_color_tool(doc: TDocStd_Document):
    """Get XCAFDoc_ColorTool from an XDE document."""
    from OCC.Core.XCAFDoc import XCAFDoc_ColorTool

    _set_fn = getattr(XCAFDoc_ColorTool, 'Set_s', None) or XCAFDoc_ColorTool.Set
    return _set_fn(doc.Main())


def get_label_color(color_tool, label: TDF_Label) -> Optional[PartColor]:
    """
    Extract the color assigned to an XDE label.

    Tries surface color first (most common for STEP), then general color as fallback.
    Some XDE label instances don't bind cleanly to the SWIG-generated GetColor
    overload set; those raise TypeError and we treat as "no label color".
    """
    color = Quantity_Color()
    try:
        if color_tool.GetColor(label, XCAFDoc_ColorSurf, color):
            return PartColor(color.Red(), color.Green(), color.Blue())
        if color_tool.GetColor(label, XCAFDoc_ColorGen, color):
            return PartColor(color.Red(), color.Green(), color.Blue())
    except TypeError:
        pass
    return None


def get_shape_color(color_tool, shape: TopoDS_Shape) -> Optional[PartColor]:
    """
    Extract color directly from a TopoDS_Shape via XCAFDoc_ColorTool.

    SolidWorks-exported AP214 STEP files attach colors to TShape objects
    rather than to XDE labels - so the label-based lookup misses them, but
    the shape-based lookup finds them. Falls back to general color if no
    surface color is set.
    """
    color = Quantity_Color()
    try:
        if color_tool.GetColor(shape, XCAFDoc_ColorSurf, color):
            return PartColor(color.Red(), color.Green(), color.Blue())
        if color_tool.GetColor(shape, XCAFDoc_ColorGen, color):
            return PartColor(color.Red(), color.Green(), color.Blue())
    except TypeError:
        pass
    return None


def _get_parent_color(
    color_tool, shape_tool: XCAFDoc_ShapeTool, label: TDF_Label
) -> Optional[PartColor]:
    """Walk up the label hierarchy to inherit parent assembly color."""
    father = label.Father()
    if father is None or father.IsNull():
        return None

    parent_color = get_label_color(color_tool, father)
    if parent_color is not None:
        return parent_color

    # Recurse up
    return _get_parent_color(color_tool, shape_tool, father)


def extract_shape_colors(
    doc: TDocStd_Document,
) -> dict[int, PartColor]:
    """
    Build a hash(face) -> PartColor map by walking located instances of the
    XDE assembly tree. Critical detail for SolidWorks AP214 STEPs: colors are
    attached to the *unlocated* part definition's TShape, but the compound
    iterated by the GLB writer contains *located* instances. TopoDS_Shape
    hashing is location-aware (proven by experiment), so we must:
      1. Walk LOCATED instance shapes (so face hashes match the compound).
      2. Resolve color via the unlocated referred shape (where it lives).
    """
    color_tool = _get_color_tool(doc)
    _shape_tool_fn = getattr(XCAFDoc_DocumentTool, 'ShapeTool_s', None) or XCAFDoc_DocumentTool.ShapeTool
    shape_tool = _shape_tool_fn(doc.Main())

    color_map: dict[int, PartColor] = {}

    # Pre-pass: walk EVERY label in the document and build a TShape-keyed
    # color map. SolidWorks-exported AP214 STEPs attach per-face colors via
    # sub-shape labels (decals, indicator lights, multi-material solids) that
    # the assembly walk doesn't visit. Faces in the compound have unique
    # location-aware hashes, but face.TShape() pointers are shared across
    # instances - hashing the TShape gives a location-independent key that
    # matches across labels (unlocated) and compound iteration (located).
    tshape_color_map: dict[int, PartColor] = {}

    def _walk_all_labels(label: TDF_Label) -> None:
        try:
            if shape_tool.IsShape(label):
                shp = shape_tool.GetShape(label)
                if shp is not None and not shp.IsNull():
                    c = get_shape_color(color_tool, shp)
                    if c is not None:
                        try:
                            tshape_color_map[hash(shp.TShape())] = c
                        except Exception:
                            pass
        except Exception as e:
            logger.debug("Pre-pass label skip: %s", e)
        try:
            it = TDF_ChildIterator(label, False)
            while it.More():
                _walk_all_labels(it.Value())
                it.Next()
        except Exception as e:
            logger.debug("Pre-pass child iter: %s", e)

    try:
        _walk_all_labels(doc.Main())
    except Exception as e:
        logger.debug("Pre-pass aborted: %s", e)
    logger.info("Pre-pass found %d distinct TShape colors", len(tshape_color_map))

    def _color_for_label(label: TDF_Label) -> Optional[PartColor]:
        """Try every way to find a color for this label's shape."""
        try:
            shape = shape_tool.GetShape(label)
        except Exception:
            return None
        if shape is None or shape.IsNull():
            return None

        # Direct lookups on the label and its located shape.
        c = get_label_color(color_tool, label)
        if c is not None:
            return c
        c = get_shape_color(color_tool, shape)
        if c is not None:
            return c

        # Resolve through the reference chain - colors typically attach to
        # the underlying part definition's TShape, not the instance.
        if shape_tool.IsReference(label):
            ref = TDF_Label()
            try:
                shape_tool.GetReferredShape(label, ref)
            except Exception:
                ref = TDF_Label()
            if not ref.IsNull():
                c = get_label_color(color_tool, ref)
                if c is not None:
                    return c
                try:
                    ref_shape = shape_tool.GetShape(ref)
                    if ref_shape is not None and not ref_shape.IsNull():
                        c = get_shape_color(color_tool, ref_shape)
                        if c is not None:
                            return c
                except Exception:
                    pass
        return None

    def _paint_faces(located_shape, color: PartColor) -> None:
        """Stamp the color onto every face hash of the located shape.

        Per-face colors (from the TShape-keyed pre-pass) win over the
        part-level color so decals / indicator lights / multi-material solids
        render with their actual hues.
        """
        try:
            explorer = TopExp_Explorer(located_shape, TopAbs_FACE)
            while explorer.More():
                face = explorer.Current()
                # Prefer per-face TShape color if known; else use part color.
                face_color = color
                try:
                    tshape_hash = hash(face.TShape())
                    if tshape_hash in tshape_color_map:
                        face_color = tshape_color_map[tshape_hash]
                except Exception:
                    pass
                color_map[hash(face)] = face_color
                explorer.Next()
        except Exception as e:
            logger.debug("Face hashing failed: %s", e)

    def _walk(shape: TopoDS_Shape, label: TDF_Label, inherited: Optional[PartColor]) -> None:
        """
        Walk the TopoDS compound tree in parallel with the XDE label tree.

        `shape` is the located shape at this position in the parent compound -
        its faces have the location chain we need so their hashes match the
        compound the GLB writer iterates. `label` is the XDE label we use for
        color lookup. The two trees mirror each other 1:1.
        """
        # Resolve color from the XDE label (handles reference resolution).
        try:
            own = _color_for_label(label)
        except Exception as e:
            logger.debug("Skipping label color lookup: %s", e)
            own = None
        effective = own if own is not None else inherited

        if effective is not None:
            _paint_faces(shape, effective)

        # Recurse: pair the TopoDS sub-shapes with the XDE component labels.
        # For a reference, the components live under the referred (definition)
        # label, but the located TopoDS sub-shapes are children of `shape`.
        try:
            target = label
            if shape_tool.IsReference(label):
                ref = TDF_Label()
                shape_tool.GetReferredShape(label, ref)
                if not ref.IsNull():
                    target = ref
            if not shape_tool.IsAssembly(target):
                return
            comps = TDF_LabelSequence()
            shape_tool.GetComponents(target, comps)

            # Walk shape's direct sub-shapes via TopoDS_Iterator (which already
            # applies the cumulative location to each child).
            it = TopoDS_Iterator(shape)
            comp_idx = 0
            while it.More() and comp_idx < comps.Length():
                sub_shape = it.Value()
                comp_label = comps.Value(comp_idx + 1)
                _walk(sub_shape, comp_label, effective)
                it.Next()
                comp_idx += 1
        except Exception as e:
            logger.debug("Assembly recursion failed: %s", e)

    free_shapes = TDF_LabelSequence()
    shape_tool.GetFreeShapes(free_shapes)
    for i in range(free_shapes.Length()):
        try:
            top_label = free_shapes.Value(i + 1)
            top_shape = shape_tool.GetShape(top_label)
            if top_shape is not None and not top_shape.IsNull():
                _walk(top_shape, top_label, None)
        except Exception as e:
            logger.debug("Free shape walk failed: %s", e)

    logger.info("Extracted colors for %d face hashes", len(color_map))
    return color_map


def get_dominant_color(color_map: dict[int, PartColor]) -> Optional[PartColor]:
    """Return the most common color in the color map, or None if empty."""
    if not color_map:
        return None

    # Count by rounded RGB to group similar colors
    from collections import Counter

    rounded = Counter(
        (round(c.r, 2), round(c.g, 2), round(c.b, 2)) for c in color_map.values()
    )
    most_common = rounded.most_common(1)[0][0]
    return PartColor(*most_common)
