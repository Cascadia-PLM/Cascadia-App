# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Cascadia PLM LLC

"""Convert tessellated pythonocc geometry + color map into .glb (binary glTF)."""

from __future__ import annotations

import logging
import struct
from pathlib import Path
from typing import Optional

import numpy as np
from OCC.Core.BRep import BRep_Tool
from OCC.Core.TopAbs import TopAbs_FACE
from OCC.Core.TopExp import TopExp_Explorer
from OCC.Core.TopoDS import TopoDS_Shape, topods

from .colors import PartColor

logger = logging.getLogger(__name__)

# Default steel-blue color when no color data is available
DEFAULT_COLOR = PartColor(0.45, 0.50, 0.56)

# STEP/IGES and the OpenCASCADE kernel are Z-up; glTF 2.0 mandates Y-up. The
# conversion is a -90 degree rotation about X, which sends model +Z to world +Y
# and model +Y to world -Z. Emitting it as a root-node rotation rather than
# baking it into the vertex data keeps the accessors in native part coordinates
# — the viewer overlays two revisions of a part without a registration step, and
# that only works while both sit in the coordinate system their CAD authored.
#
# Quaternion (x, y, z, w) for -90 degrees about X.
_SIN45 = 0.7071067811865476
Z_UP_TO_Y_UP_ROTATION = [-_SIN45, 0.0, 0.0, _SIN45]


def _extract_face_triangles(
    shape: TopoDS_Shape,
    color_map: dict[int, PartColor],
    default_color: PartColor,
    tshape_color_map: Optional[dict[int, PartColor]] = None,
) -> dict[tuple[float, float, float], list[np.ndarray]]:
    """
    Extract triangulated faces grouped by color.

    Returns a dict mapping (r, g, b) -> list of (N, 3, 3) vertex arrays,
    where each entry in the list is a face's triangle vertices.

    `color_map` is keyed by `hash(face)`, which folds in the face's location,
    so it only answers for the located compound it was built from.
    `tshape_color_map` is keyed by the TShape pointer that every occurrence of
    a part shares, and is consulted second: it is the only one of the two that
    can answer for an unplaced prototype, which is what the structured writer
    draws each part from.
    """
    color_groups: dict[tuple[float, float, float], list[np.ndarray]] = {}

    explorer = TopExp_Explorer(shape, TopAbs_FACE)
    while explorer.More():
        face = topods.Face(explorer.Current())
        # OCCT 7.8+ removed TopoDS_Shape.HashCode — use Python's hash().
        face_hash = hash(face)

        # Determine color for this face
        face_color = color_map.get(face_hash)
        if face_color is None and tshape_color_map is not None:
            try:
                face_color = tshape_color_map.get(hash(face.TShape()))
            except Exception:
                face_color = None
        if face_color is None:
            face_color = default_color
        color_key = (
            round(face_color.r, 4),
            round(face_color.g, 4),
            round(face_color.b, 4),
        )

        # Get triangulation. OCCT 7.8+ removed BRep_Tool.Location — pass an
        # empty TopLoc_Location to BRep_Tool.Triangulation, which fills it
        # in-place with the face's location while returning the triangulation.
        from OCC.Core.TopLoc import TopLoc_Location
        location = TopLoc_Location()
        triangulation = BRep_Tool.Triangulation(face, location)

        if triangulation is None:
            explorer.Next()
            continue

        nb_triangles = triangulation.NbTriangles()
        nb_nodes = triangulation.NbNodes()

        if nb_triangles == 0 or nb_nodes == 0:
            explorer.Next()
            continue

        # Check face orientation for winding order
        is_reversed = face.Orientation() == 1  # TopAbs_REVERSED = 1

        # Extract nodes (1-indexed)
        trsf = location.Transformation()
        nodes = []
        for i in range(1, nb_nodes + 1):
            pnt = triangulation.Node(i)
            pnt.Transform(trsf)
            nodes.append([pnt.X(), pnt.Y(), pnt.Z()])

        # Extract triangles (1-indexed)
        face_vertices = []
        for i in range(1, nb_triangles + 1):
            tri = triangulation.Triangle(i)
            n1, n2, n3 = tri.Get()

            if is_reversed:
                # Flip winding order for reversed faces
                face_vertices.append([nodes[n1 - 1], nodes[n3 - 1], nodes[n2 - 1]])
            else:
                face_vertices.append([nodes[n1 - 1], nodes[n2 - 1], nodes[n3 - 1]])

        if face_vertices:
            if color_key not in color_groups:
                color_groups[color_key] = []
            color_groups[color_key].append(np.array(face_vertices, dtype=np.float32))

        explorer.Next()

    return color_groups


def _compute_normals(vertices: np.ndarray) -> np.ndarray:
    """Compute per-vertex normals from triangle vertices (N, 3, 3) -> (N, 3, 3)."""
    v0 = vertices[:, 0, :]
    v1 = vertices[:, 1, :]
    v2 = vertices[:, 2, :]

    edge1 = v1 - v0
    edge2 = v2 - v0
    normals = np.cross(edge1, edge2)

    # Normalize
    lengths = np.linalg.norm(normals, axis=1, keepdims=True)
    lengths = np.where(lengths < 1e-10, 1.0, lengths)
    normals = normals / lengths

    # Expand to per-vertex (same normal for all 3 vertices of each triangle)
    return np.repeat(normals[:, np.newaxis, :], 3, axis=1)



class _GlbBuilder:
    """
    Accumulates the flat arrays a glTF document is made of.

    One binary buffer, one accessor table and one material table are shared by
    every mesh in the file, so an assembly of eighty parts that are all the
    same anodized black emits one material rather than eighty. Extracted when
    the structured writer arrived: `write_glb` and the never-called
    `write_assembly_glb` were already two near-identical copies of this
    packing, and a third would have been the one that drifted.
    """

    def __init__(self) -> None:
        self.buffer_data = bytearray()
        self.buffer_views: list[dict] = []
        self.accessors: list[dict] = []
        self.materials: list[dict] = []
        self.polygon_count = 0
        self._material_indices: dict[tuple[float, float, float], int] = {}

    def _add_buffer_view(self, payload: bytes, target: int) -> int:
        """Append bytes to the buffer, 4-byte aligned as the spec requires."""
        offset = len(self.buffer_data)
        self.buffer_data.extend(payload)
        while len(self.buffer_data) % 4 != 0:
            self.buffer_data.append(0)

        self.buffer_views.append({
            "buffer": 0,
            "byteOffset": offset,
            "byteLength": len(payload),
            "target": target,
        })
        return len(self.buffer_views) - 1

    def _material_for(self, color_key: tuple[float, float, float]) -> int:
        """Index of the material for this color, creating it on first sight."""
        existing = self._material_indices.get(color_key)
        if existing is not None:
            return existing

        index = len(self.materials)
        self._material_indices[color_key] = index
        self.materials.append({
            "pbrMetallicRoughness": {
                "baseColorFactor": [color_key[0], color_key[1], color_key[2], 1.0],
                "metallicFactor": 0.3,
                "roughnessFactor": 0.5,
            },
        })
        return index

    def add_primitives(
        self,
        color_groups: dict[tuple[float, float, float], list[np.ndarray]],
    ) -> list[dict]:
        """Pack one mesh's triangles - a primitive per color - and return them."""
        primitives: list[dict] = []

        for color_key, face_arrays in color_groups.items():
            all_triangles = np.concatenate(face_arrays, axis=0)  # (N, 3, 3)
            n_triangles = all_triangles.shape[0]
            self.polygon_count += n_triangles

            # Per-triangle vertices, so indices are simply sequential
            vertices = all_triangles.reshape(-1, 3).astype(np.float32)
            normals = _compute_normals(all_triangles).reshape(-1, 3).astype(np.float32)
            indices = np.arange(n_triangles * 3, dtype=np.uint32)

            material_index = self._material_for(color_key)

            # 34963 = ELEMENT_ARRAY_BUFFER, 34962 = ARRAY_BUFFER
            indices_view = self._add_buffer_view(indices.tobytes(), 34963)
            indices_accessor = len(self.accessors)
            self.accessors.append({
                "bufferView": indices_view,
                "componentType": 5125,  # UNSIGNED_INT
                "count": len(indices),
                "type": "SCALAR",
                "max": [int(indices.max())],
                "min": [int(indices.min())],
            })

            vertices_view = self._add_buffer_view(vertices.tobytes(), 34962)
            vertices_accessor = len(self.accessors)
            self.accessors.append({
                "bufferView": vertices_view,
                "componentType": 5126,  # FLOAT
                "count": len(vertices),
                "type": "VEC3",
                # Required on POSITION by the spec - viewers frame from it
                "max": vertices.max(axis=0).tolist(),
                "min": vertices.min(axis=0).tolist(),
            })

            normals_view = self._add_buffer_view(normals.tobytes(), 34962)
            normals_accessor = len(self.accessors)
            self.accessors.append({
                "bufferView": normals_view,
                "componentType": 5126,
                "count": len(normals),
                "type": "VEC3",
            })

            primitives.append({
                "attributes": {
                    "POSITION": vertices_accessor,
                    "NORMAL": normals_accessor,
                },
                "indices": indices_accessor,
                "material": material_index,
            })

        return primitives


def _write_glb_file(gltf_json: dict, bin_data: bytes, output_path: str) -> None:
    """Serialize a glTF document and its buffer into a .glb container."""
    import json

    json_bytes = json.dumps(gltf_json, separators=(",", ":")).encode("utf-8")
    # Both chunks are 4-byte aligned: JSON padded with spaces, BIN with nulls
    while len(json_bytes) % 4 != 0:
        json_bytes += b" "
    while len(bin_data) % 4 != 0:
        bin_data += b"\x00"

    total_length = (
        12  # GLB header
        + 8 + len(json_bytes)  # JSON chunk header + data
        + 8 + len(bin_data)  # BIN chunk header + data
    )

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)

    with open(output_path, "wb") as f:
        f.write(struct.pack("<I", 0x46546C67))  # magic: 'glTF'
        f.write(struct.pack("<I", 2))  # version
        f.write(struct.pack("<I", total_length))

        f.write(struct.pack("<I", len(json_bytes)))
        f.write(struct.pack("<I", 0x4E4F534A))  # chunk type: JSON
        f.write(json_bytes)

        f.write(struct.pack("<I", len(bin_data)))
        f.write(struct.pack("<I", 0x004E4942))  # chunk type: BIN
        f.write(bin_data)


def write_glb(
    shape: TopoDS_Shape,
    color_map: dict[int, PartColor],
    output_path: str,
    default_color: Optional[PartColor] = None,
) -> tuple[str, int]:
    """
    Convert a tessellated shape + color map to a .glb binary file.

    One mesh, its triangles grouped by color. Use `write_structured_glb` for
    an assembly the viewer should be able to take apart.

    Args:
        shape: Tessellated TopoDS_Shape.
        color_map: Mapping from hash(shape) to PartColor.
        output_path: Path for the output .glb file.
        default_color: Fallback color for faces without color data.

    Returns:
        Tuple of (output_path, polygon_count).
    """
    if default_color is None:
        default_color = DEFAULT_COLOR

    color_groups = _extract_face_triangles(shape, color_map, default_color)
    if not color_groups:
        raise RuntimeError("No triangulated faces found in shape for glTF export")

    builder = _GlbBuilder()
    primitives = builder.add_primitives(color_groups)

    gltf_json = {
        "asset": {"version": "2.0", "generator": "Cascadia CAD Converter"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [
            {"rotation": Z_UP_TO_Y_UP_ROTATION, "children": [1]},
            {"mesh": 0},
        ],
        "meshes": [{"primitives": primitives}],
        "materials": builder.materials,
        "accessors": builder.accessors,
        "bufferViews": builder.buffer_views,
        "buffers": [{"byteLength": len(builder.buffer_data)}],
    }

    _write_glb_file(gltf_json, bytes(builder.buffer_data), output_path)

    logger.info(
        "GLB written: %s (%d polygons, %d materials)",
        output_path,
        builder.polygon_count,
        len(builder.materials),
    )

    return output_path, builder.polygon_count


def _location_to_gltf_matrix(location) -> Optional[list[float]]:
    """
    An OCCT placement as a glTF node matrix, or None when it is the identity.

    glTF node matrices are **column-major**, while `gp_Trsf.Value(row, col)` is
    1-indexed row-major over the top three rows of the 4x4 - so this is a
    transpose, not a copy. Getting it wrong does not fail loudly: a rotation
    reads as its inverse and the assembly comes apart at angles that look
    almost plausible.
    """
    if location is None or location.IsIdentity():
        return None

    trsf = location.Transformation()
    matrix: list[float] = []
    for col in range(1, 5):
        matrix.extend(
            [trsf.Value(1, col), trsf.Value(2, col), trsf.Value(3, col)]
        )
        # Bottom row of an affine transform: 0 under each basis column, 1
        # under the translation column.
        matrix.append(1.0 if col == 4 else 0.0)
    return [round(v, 8) for v in matrix]


def write_structured_glb(
    parts: list,
    color_map: dict[int, PartColor],
    output_path: str,
    default_color: Optional[PartColor] = None,
    tshape_color_map: Optional[dict[int, PartColor]] = None,
) -> tuple[str, int, list[dict]]:
    """
    Write an assembly as one .glb whose parts are separately addressable.

    Each leaf part becomes its own glTF node - named, carrying its instance
    path in `extras`, and placed by its own matrix - under the same Z-up to
    Y-up root node a flat export uses. That is the whole difference, and it is
    what lets the viewer raycast to a part rather than to "the model": the flat
    writer groups triangles by *color*, so an assembly of eighty parts arrives
    as about six primitives, and two brackets at opposite ends of an arm are
    literally the same one.

    Geometry stays in each part's own coordinates with the placement on the
    node, rather than being baked into the vertices — the viewer can then
    overlay two revisions of a part without a registration step.

    That choice is what makes the color lookup here subtle, and it is worth
    being explicit about because getting it wrong is invisible rather than
    loud. An OCCT 7.8+ face hash folds in the shape's location, so the
    document-wide `color_map` — built by walking the *located* compound —
    answers only for located faces. The prototypes this writer draws from are
    unplaced, so they miss it just as surely as a transformed shape would.
    `tshape_color_map` is keyed by the TShape pointer every occurrence shares
    and is location-independent, which is why it is the map that resolves per-
    face color here; without it a part renders flat in its part-level color.

    Args:
        parts: Leaf `PlacedPart`s, from `assembly.collect_placed_parts`. Typed
            loosely to keep this module free of the import cycle that naming
            the dataclass would create.
        color_map: Mapping from hash(face) to PartColor, document-wide.
        output_path: Path for the output .glb file.
        default_color: Fallback color for faces without color data.
        tshape_color_map: Mapping from hash(face.TShape()) to PartColor. The
            location-independent one, and so the map that actually resolves
            here — see the paragraph above and `colors.ShapeColors`. Without
            it every part is drawn flat in its part-level color.

    Returns:
        (output_path, polygon_count, nodes) - `nodes` being the manifest of
        what actually ended up in the file, for the vault record to carry.
    """
    if default_color is None:
        default_color = DEFAULT_COLOR

    builder = _GlbBuilder()
    meshes: list[dict] = []
    part_nodes: list[dict] = []
    manifest: list[dict] = []

    for part in parts:
        part_default = part.color or default_color
        color_groups = _extract_face_triangles(
            part.shape, color_map, part_default, tshape_color_map
        )
        if not color_groups:
            # A part whose faces never tessellated has nothing to draw and
            # nothing to select. Skipping it keeps the manifest honest about
            # what is in the file.
            logger.warning(
                "No triangulated faces for part '%s'; skipping", part.node_key
            )
            continue

        polygons_before = builder.polygon_count
        primitives = builder.add_primitives(color_groups)

        mesh_index = len(meshes)
        meshes.append({"name": part.node_key, "primitives": primitives})

        node: dict = {
            # The node key, not the display name: the viewer looks a selection
            # up by this, and every occurrence of one part shares a name.
            "name": part.node_key,
            "mesh": mesh_index,
            "extras": {
                "cascadiaNodeKey": part.node_key,
                "cascadiaPartName": part.name,
                "cascadiaPath": part.path,
            },
        }
        matrix = _location_to_gltf_matrix(part.location)
        if matrix is not None:
            node["matrix"] = matrix
        part_nodes.append(node)

        manifest.append({
            "nodeKey": part.node_key,
            "name": part.name,
            "path": part.path,
            "polygonCount": builder.polygon_count - polygons_before,
        })

    if not part_nodes:
        raise RuntimeError("No triangulated faces found in any part for glTF export")

    # Node 0 is the root; the part nodes follow it, so their indices start at 1
    root = {
        "rotation": Z_UP_TO_Y_UP_ROTATION,
        "children": list(range(1, len(part_nodes) + 1)),
    }

    gltf_json = {
        "asset": {"version": "2.0", "generator": "Cascadia CAD Converter"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [root, *part_nodes],
        "meshes": meshes,
        "materials": builder.materials,
        "accessors": builder.accessors,
        "bufferViews": builder.buffer_views,
        "buffers": [{"byteLength": len(builder.buffer_data)}],
    }

    _write_glb_file(gltf_json, bytes(builder.buffer_data), output_path)

    logger.info(
        "Structured GLB written: %s (%d parts, %d polygons, %d materials)",
        output_path,
        len(part_nodes),
        builder.polygon_count,
        len(builder.materials),
    )

    return output_path, builder.polygon_count, manifest
