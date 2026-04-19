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


def _extract_face_triangles(
    shape: TopoDS_Shape,
    color_map: dict[int, PartColor],
    default_color: PartColor,
) -> dict[tuple[float, float, float], list[np.ndarray]]:
    """
    Extract triangulated faces grouped by color.

    Returns a dict mapping (r, g, b) -> list of (N, 3, 3) vertex arrays,
    where each entry in the list is a face's triangle vertices.
    """
    color_groups: dict[tuple[float, float, float], list[np.ndarray]] = {}

    explorer = TopExp_Explorer(shape, TopAbs_FACE)
    while explorer.More():
        face = topods.Face(explorer.Current())
        face_hash = face.HashCode(2147483647)

        # Determine color for this face
        face_color = color_map.get(face_hash, default_color)
        color_key = (
            round(face_color.r, 4),
            round(face_color.g, 4),
            round(face_color.b, 4),
        )

        # Get triangulation
        _location_fn = getattr(BRep_Tool, 'Location_s', None) or BRep_Tool.Location
        _triangulation_fn = getattr(BRep_Tool, 'Triangulation_s', None) or BRep_Tool.Triangulation
        location = _location_fn(face)
        triangulation = _triangulation_fn(face, location)

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


def write_glb(
    shape: TopoDS_Shape,
    color_map: dict[int, PartColor],
    output_path: str,
    default_color: Optional[PartColor] = None,
) -> tuple[str, int]:
    """
    Convert a tessellated shape + color map to a .glb binary file.

    Args:
        shape: Tessellated TopoDS_Shape.
        color_map: Mapping from shape.HashCode() to PartColor.
        output_path: Path for the output .glb file.
        default_color: Fallback color for faces without color data.

    Returns:
        Tuple of (output_path, polygon_count).
    """
    if default_color is None:
        default_color = DEFAULT_COLOR

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)

    color_groups = _extract_face_triangles(shape, color_map, default_color)

    if not color_groups:
        raise RuntimeError("No triangulated faces found in shape for glTF export")

    # Build glTF structures
    total_polygons = 0
    buffers_data = bytearray()
    buffer_views = []
    accessors = []
    meshes_primitives = []
    materials = []
    material_indices: dict[tuple[float, float, float], int] = {}

    for color_key, face_arrays in color_groups.items():
        # Merge all faces with this color
        all_triangles = np.concatenate(face_arrays, axis=0)  # (N, 3, 3)
        n_triangles = all_triangles.shape[0]
        total_polygons += n_triangles

        # Flatten to (N*3, 3) for vertices
        vertices = all_triangles.reshape(-1, 3).astype(np.float32)

        # Compute normals
        normals_expanded = _compute_normals(all_triangles)
        normals = normals_expanded.reshape(-1, 3).astype(np.float32)

        # Create indices (simple sequential since we have per-triangle vertices)
        indices = np.arange(n_triangles * 3, dtype=np.uint32)

        # Get or create material
        if color_key not in material_indices:
            mat_idx = len(materials)
            material_indices[color_key] = mat_idx
            materials.append({
                "pbrMetallicRoughness": {
                    "baseColorFactor": [color_key[0], color_key[1], color_key[2], 1.0],
                    "metallicFactor": 0.3,
                    "roughnessFactor": 0.5,
                },
            })
        mat_idx = material_indices[color_key]

        # Pack buffers - indices
        indices_bytes = indices.tobytes()
        indices_offset = len(buffers_data)
        buffers_data.extend(indices_bytes)
        # Pad to 4-byte alignment
        while len(buffers_data) % 4 != 0:
            buffers_data.append(0)

        indices_bv_idx = len(buffer_views)
        buffer_views.append({
            "buffer": 0,
            "byteOffset": indices_offset,
            "byteLength": len(indices_bytes),
            "target": 34963,  # ELEMENT_ARRAY_BUFFER
        })

        indices_acc_idx = len(accessors)
        accessors.append({
            "bufferView": indices_bv_idx,
            "componentType": 5125,  # UNSIGNED_INT
            "count": len(indices),
            "type": "SCALAR",
            "max": [int(indices.max())],
            "min": [int(indices.min())],
        })

        # Pack buffers - vertices
        vertices_bytes = vertices.tobytes()
        vertices_offset = len(buffers_data)
        buffers_data.extend(vertices_bytes)
        while len(buffers_data) % 4 != 0:
            buffers_data.append(0)

        vertices_bv_idx = len(buffer_views)
        buffer_views.append({
            "buffer": 0,
            "byteOffset": vertices_offset,
            "byteLength": len(vertices_bytes),
            "target": 34962,  # ARRAY_BUFFER
        })

        vertices_acc_idx = len(accessors)
        v_min = vertices.min(axis=0).tolist()
        v_max = vertices.max(axis=0).tolist()
        accessors.append({
            "bufferView": vertices_bv_idx,
            "componentType": 5126,  # FLOAT
            "count": len(vertices),
            "type": "VEC3",
            "max": v_max,
            "min": v_min,
        })

        # Pack buffers - normals
        normals_bytes = normals.tobytes()
        normals_offset = len(buffers_data)
        buffers_data.extend(normals_bytes)
        while len(buffers_data) % 4 != 0:
            buffers_data.append(0)

        normals_bv_idx = len(buffer_views)
        buffer_views.append({
            "buffer": 0,
            "byteOffset": normals_offset,
            "byteLength": len(normals_bytes),
            "target": 34962,
        })

        normals_acc_idx = len(accessors)
        accessors.append({
            "bufferView": normals_bv_idx,
            "componentType": 5126,
            "count": len(normals),
            "type": "VEC3",
        })

        # Create mesh primitive
        meshes_primitives.append({
            "attributes": {
                "POSITION": vertices_acc_idx,
                "NORMAL": normals_acc_idx,
            },
            "indices": indices_acc_idx,
            "material": mat_idx,
        })

    # Build glTF JSON
    gltf_json = {
        "asset": {
            "version": "2.0",
            "generator": "Cascadia CAD Converter",
        },
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0}],
        "meshes": [{"primitives": meshes_primitives}],
        "materials": materials,
        "accessors": accessors,
        "bufferViews": buffer_views,
        "buffers": [{"byteLength": len(buffers_data)}],
    }

    # Write GLB binary
    import json

    json_bytes = json.dumps(gltf_json, separators=(",", ":")).encode("utf-8")
    # Pad JSON to 4-byte alignment with spaces
    while len(json_bytes) % 4 != 0:
        json_bytes += b" "

    # Pad binary buffer to 4-byte alignment
    bin_data = bytes(buffers_data)
    while len(bin_data) % 4 != 0:
        bin_data += b"\x00"

    # GLB header: magic + version + length
    # JSON chunk: length + type(JSON=0x4E4F534A) + data
    # BIN chunk: length + type(BIN=0x004E4942) + data
    total_length = (
        12  # GLB header
        + 8 + len(json_bytes)  # JSON chunk header + data
        + 8 + len(bin_data)  # BIN chunk header + data
    )

    with open(output_path, "wb") as f:
        # GLB header
        f.write(struct.pack("<I", 0x46546C67))  # magic: 'glTF'
        f.write(struct.pack("<I", 2))  # version
        f.write(struct.pack("<I", total_length))  # total length

        # JSON chunk
        f.write(struct.pack("<I", len(json_bytes)))  # chunk length
        f.write(struct.pack("<I", 0x4E4F534A))  # chunk type: JSON
        f.write(json_bytes)

        # BIN chunk
        f.write(struct.pack("<I", len(bin_data)))  # chunk length
        f.write(struct.pack("<I", 0x004E4942))  # chunk type: BIN
        f.write(bin_data)

    logger.info(
        "GLB written: %s (%d polygons, %d materials, %d bytes)",
        output_path,
        total_polygons,
        len(materials),
        total_length,
    )

    return output_path, total_polygons


def write_assembly_glb(
    parts: list[tuple[TopoDS_Shape, dict[int, PartColor], str]],
    output_path: str,
    default_color: Optional[PartColor] = None,
) -> tuple[str, int]:
    """
    Convert multiple parts into a single .glb file with separate nodes.

    Args:
        parts: List of (shape, color_map, part_name) tuples.
        output_path: Path for the output .glb file.
        default_color: Fallback color.

    Returns:
        Tuple of (output_path, total_polygon_count).
    """
    if default_color is None:
        default_color = DEFAULT_COLOR

    # For now, merge all parts into a single shape's color space
    # Each part becomes its own mesh node in the scene
    # This is a simplified approach; full assembly would use transforms
    total_polygons = 0
    all_color_groups: dict[tuple[float, float, float], list[np.ndarray]] = {}

    for shape, color_map, _name in parts:
        groups = _extract_face_triangles(shape, color_map, default_color)
        for color_key, face_arrays in groups.items():
            if color_key not in all_color_groups:
                all_color_groups[color_key] = []
            all_color_groups[color_key].extend(face_arrays)

    # Reuse single-shape logic with merged data
    # Build a temporary combined shape isn't practical, so we'll build GLB directly
    # from the merged color groups
    if not all_color_groups:
        raise RuntimeError("No triangulated faces found in parts for glTF export")

    # This duplicates some of write_glb logic but works with pre-extracted groups
    buffers_data = bytearray()
    buffer_views = []
    accessors = []
    meshes_primitives = []
    materials = []
    material_indices: dict[tuple[float, float, float], int] = {}

    for color_key, face_arrays in all_color_groups.items():
        all_triangles = np.concatenate(face_arrays, axis=0)
        n_triangles = all_triangles.shape[0]
        total_polygons += n_triangles

        vertices = all_triangles.reshape(-1, 3).astype(np.float32)
        normals_expanded = _compute_normals(all_triangles)
        normals = normals_expanded.reshape(-1, 3).astype(np.float32)
        indices = np.arange(n_triangles * 3, dtype=np.uint32)

        if color_key not in material_indices:
            mat_idx = len(materials)
            material_indices[color_key] = mat_idx
            materials.append({
                "pbrMetallicRoughness": {
                    "baseColorFactor": [color_key[0], color_key[1], color_key[2], 1.0],
                    "metallicFactor": 0.3,
                    "roughnessFactor": 0.5,
                },
            })
        mat_idx = material_indices[color_key]

        # Indices
        indices_bytes = indices.tobytes()
        indices_offset = len(buffers_data)
        buffers_data.extend(indices_bytes)
        while len(buffers_data) % 4 != 0:
            buffers_data.append(0)

        indices_bv_idx = len(buffer_views)
        buffer_views.append({
            "buffer": 0,
            "byteOffset": indices_offset,
            "byteLength": len(indices_bytes),
            "target": 34963,
        })

        indices_acc_idx = len(accessors)
        accessors.append({
            "bufferView": indices_bv_idx,
            "componentType": 5125,
            "count": len(indices),
            "type": "SCALAR",
            "max": [int(indices.max())],
            "min": [int(indices.min())],
        })

        # Vertices
        vertices_bytes = vertices.tobytes()
        vertices_offset = len(buffers_data)
        buffers_data.extend(vertices_bytes)
        while len(buffers_data) % 4 != 0:
            buffers_data.append(0)

        vertices_bv_idx = len(buffer_views)
        buffer_views.append({
            "buffer": 0,
            "byteOffset": vertices_offset,
            "byteLength": len(vertices_bytes),
            "target": 34962,
        })

        vertices_acc_idx = len(accessors)
        accessors.append({
            "bufferView": vertices_bv_idx,
            "componentType": 5126,
            "count": len(vertices),
            "type": "VEC3",
            "max": vertices.max(axis=0).tolist(),
            "min": vertices.min(axis=0).tolist(),
        })

        # Normals
        normals_bytes = normals.tobytes()
        normals_offset = len(buffers_data)
        buffers_data.extend(normals_bytes)
        while len(buffers_data) % 4 != 0:
            buffers_data.append(0)

        normals_bv_idx = len(buffer_views)
        buffer_views.append({
            "buffer": 0,
            "byteOffset": normals_offset,
            "byteLength": len(normals_bytes),
            "target": 34962,
        })

        normals_acc_idx = len(accessors)
        accessors.append({
            "bufferView": normals_bv_idx,
            "componentType": 5126,
            "count": len(normals),
            "type": "VEC3",
        })

        meshes_primitives.append({
            "attributes": {
                "POSITION": vertices_acc_idx,
                "NORMAL": normals_acc_idx,
            },
            "indices": indices_acc_idx,
            "material": mat_idx,
        })

    import json

    gltf_json = {
        "asset": {"version": "2.0", "generator": "Cascadia CAD Converter"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0}],
        "meshes": [{"primitives": meshes_primitives}],
        "materials": materials,
        "accessors": accessors,
        "bufferViews": buffer_views,
        "buffers": [{"byteLength": len(buffers_data)}],
    }

    json_bytes = json.dumps(gltf_json, separators=(",", ":")).encode("utf-8")
    while len(json_bytes) % 4 != 0:
        json_bytes += b" "

    bin_data = bytes(buffers_data)
    while len(bin_data) % 4 != 0:
        bin_data += b"\x00"

    total_length = 12 + 8 + len(json_bytes) + 8 + len(bin_data)

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)

    with open(output_path, "wb") as f:
        f.write(struct.pack("<I", 0x46546C67))
        f.write(struct.pack("<I", 2))
        f.write(struct.pack("<I", total_length))
        f.write(struct.pack("<I", len(json_bytes)))
        f.write(struct.pack("<I", 0x4E4F534A))
        f.write(json_bytes)
        f.write(struct.pack("<I", len(bin_data)))
        f.write(struct.pack("<I", 0x004E4942))
        f.write(bin_data)

    logger.info(
        "Assembly GLB written: %s (%d polygons, %d materials)",
        output_path,
        total_polygons,
        len(materials),
    )

    return output_path, total_polygons
