"""Offscreen thumbnail rendering using pythonocc V3d viewer."""

from __future__ import annotations

import logging
import os

from OCC.Core.TopoDS import TopoDS_Shape

logger = logging.getLogger(__name__)


def render_thumbnail(
    shape: TopoDS_Shape,
    output_path: str,
    width: int = 512,
    height: int = 512,
    color: tuple[float, float, float] | None = None,
) -> bool:
    """
    Render a thumbnail PNG from a B-Rep shape using offscreen V3d rendering.

    Requires DISPLAY environment variable pointing to a running Xvfb server.
    Renders from the original B-Rep geometry (not tessellated mesh) for smooth output.

    Args:
        shape: OpenCASCADE TopoDS_Shape to render.
        output_path: Path where the PNG will be written.
        width: Thumbnail width in pixels (default 512).
        height: Thumbnail height in pixels (default 512).
        color: Optional RGB tuple (r, g, b) in [0.0, 1.0] to use instead of default steel-blue.

    Returns:
        True if the thumbnail was generated successfully, False otherwise.
        Never raises — thumbnail failure is non-blocking.
    """
    try:
        from OCC.Display.OCCViewer import Viewer3d
        from OCC.Core.Quantity import Quantity_Color, Quantity_TOC_RGB

        # Verify DISPLAY is set (Xvfb must be running)
        if not os.environ.get("DISPLAY"):
            logger.warning("DISPLAY not set, skipping thumbnail render")
            return False

        # Create offscreen viewer
        viewer = Viewer3d()
        viewer.Create(create_default_lights=True)
        viewer.SetSize(width, height)

        # Subtle gradient background (light gray to white)
        viewer.set_bg_gradient_color([240, 240, 245], [255, 255, 255])

        # Solid shaded rendering (not wireframe)
        viewer.SetModeShaded()

        # Anti-aliasing for smoother edges
        viewer.SetNbMsaaSample(4)

        # Display the shape with the provided color or default steel-blue
        if color:
            steel_color = Quantity_Color(color[0], color[1], color[2], Quantity_TOC_RGB)
        else:
            steel_color = Quantity_Color(0.45, 0.50, 0.56, Quantity_TOC_RGB)
        viewer.DisplayShape(shape, color=steel_color, update=True)

        # Isometric camera angle (standard engineering view) and fit to shape
        viewer.View_Iso()
        viewer.FitAll()

        # Ensure output directory exists
        os.makedirs(os.path.dirname(output_path), exist_ok=True)

        # Export to image file
        viewer.ExportToImage(output_path)

        if os.path.exists(output_path) and os.path.getsize(output_path) > 0:
            logger.info(
                "Thumbnail rendered: %s (%d bytes)",
                output_path,
                os.path.getsize(output_path),
            )
            return True
        else:
            logger.warning("Thumbnail file empty or missing after render: %s", output_path)
            return False

    except ImportError as e:
        logger.warning("Thumbnail rendering unavailable (missing dependency): %s", e)
        return False
    except Exception as e:
        logger.warning("Thumbnail rendering failed (non-blocking): %s", e)
        return False
