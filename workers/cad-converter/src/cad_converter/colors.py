"""Extract per-face/solid colors from STEP XDE documents via XCAFDoc_ColorTool."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Optional

from OCC.Core.Quantity import Quantity_Color
from OCC.Core.TDF import TDF_Label, TDF_LabelSequence
from OCC.Core.TDocStd import TDocStd_Document
from OCC.Core.TopAbs import TopAbs_FACE
from OCC.Core.TopExp import TopExp_Explorer
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
    """
    color = Quantity_Color()

    # Try surface color first (XCAFDoc_ColorSurf) - most common in STEP files
    if color_tool.GetColor(label, XCAFDoc_ColorSurf, color):
        return PartColor(color.Red(), color.Green(), color.Blue())

    # Fall back to general color (XCAFDoc_ColorGen)
    if color_tool.GetColor(label, XCAFDoc_ColorGen, color):
        return PartColor(color.Red(), color.Green(), color.Blue())

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
    Extract colors for all shapes in an XDE document.

    Returns a mapping from shape.HashCode() to PartColor.
    Walks the assembly tree, trying direct color first, then inheriting from parent.
    """
    color_tool = _get_color_tool(doc)
    _shape_tool_fn = getattr(XCAFDoc_DocumentTool, 'ShapeTool_s', None) or XCAFDoc_DocumentTool.ShapeTool
    shape_tool = _shape_tool_fn(doc.Main())

    color_map: dict[int, PartColor] = {}

    # Collect all shape labels
    labels = TDF_LabelSequence()
    shape_tool.GetFreeShapes(labels)

    def _walk_labels(label: TDF_Label) -> None:
        try:
            # Only attempt GetShape on labels that are known shapes
            if not shape_tool.IsShape(label):
                pass  # still recurse into assemblies below
            else:
                shape = shape_tool.GetShape(label)
                if shape is not None and not shape.IsNull():
                    # Try direct color on this label
                    part_color = get_label_color(color_tool, label)

                    # Inherit from parent if no direct color
                    if part_color is None:
                        part_color = _get_parent_color(color_tool, shape_tool, label)

                    if part_color is not None:
                        hash_code = shape.HashCode(2147483647)
                        color_map[hash_code] = part_color

                        # Also map sub-face colors
                        try:
                            explorer = TopExp_Explorer(shape, TopAbs_FACE)
                            while explorer.More():
                                face = explorer.Current()
                                face_hash = face.HashCode(2147483647)
                                # Assign parent color by default; override if face has its own
                                color_map[face_hash] = part_color
                                explorer.Next()
                        except Exception as e:
                            logger.debug("Face color walk failed for label: %s", e)
        except Exception as e:
            logger.debug("Skipping label during color extraction: %s", e)

        # Recurse into sub-components
        try:
            if shape_tool.IsAssembly(label):
                components = TDF_LabelSequence()
                shape_tool.GetComponents(label, components)
                for i in range(components.Length()):
                    child = components.Value(i + 1)
                    if shape_tool.IsReference(child):
                        ref_label = TDF_Label()
                        shape_tool.GetReferredShape(child, ref_label)
                        _walk_labels(ref_label)
                    else:
                        _walk_labels(child)
        except Exception as e:
            logger.debug("Assembly walk failed for label: %s", e)

    for i in range(labels.Length()):
        try:
            _walk_labels(labels.Value(i + 1))
        except Exception as e:
            logger.debug("Skipping free shape %d during color extraction: %s", i, e)

    logger.info("Extracted colors for %d shapes", len(color_map))
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
