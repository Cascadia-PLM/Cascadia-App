# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Cascadia PLM LLC

"""A stand-in `Part` module: boxes with the attributes the harness inspects."""

from __future__ import annotations


class Vector:
    def __init__(self, x=0.0, y=0.0, z=0.0):
        self.x, self.y, self.z = float(x), float(y), float(z)


class BoundBox:
    def __init__(self, xmin, ymin, zmin, xmax, ymax, zmax):
        self.XMin, self.YMin, self.ZMin = xmin, ymin, zmin
        self.XMax, self.YMax, self.ZMax = xmax, ymax, zmax


class Shape:
    """A box-shaped 'solid'. `valid=False` and `null=True` fake defects."""

    ShapeType = "Solid"

    def __init__(self, l, w, h, origin=(0.0, 0.0, 0.0), *, valid=True, null=False):
        self._dims = (float(l), float(w), float(h))
        self._origin = origin
        self._valid = valid
        self._null = null

    def isNull(self):  # noqa: N802
        return self._null

    def isValid(self):  # noqa: N802
        return self._valid

    @property
    def Solids(self):  # noqa: N802
        return [] if self._null or self.Volume <= 0 else [self]

    @property
    def Faces(self):  # noqa: N802
        return list(range(6))

    @property
    def Edges(self):  # noqa: N802
        return list(range(12))

    @property
    def Volume(self):  # noqa: N802
        l, w, h = self._dims
        return l * w * h

    @property
    def Area(self):  # noqa: N802
        l, w, h = self._dims
        return 2 * (l * w + w * h + h * l)

    @property
    def BoundBox(self):  # noqa: N802
        x, y, z = self._origin
        l, w, h = self._dims
        return BoundBox(x, y, z, x + l, y + w, z + h)

    @property
    def CenterOfMass(self):  # noqa: N802
        x, y, z = self._origin
        l, w, h = self._dims
        return Vector(x + l / 2, y + w / 2, z + h / 2)

    def exportStep(self, path):  # noqa: N802
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n")


class Solid(Shape):
    pass


class Compound(Shape):
    ShapeType = "Compound"

    def __init__(self, shapes):
        self._shapes = list(shapes)
        first = self._shapes[0]
        super().__init__(*first._dims, first._origin, valid=all(s.isValid() for s in shapes))

    @property
    def Solids(self):  # noqa: N802
        return [s for shape in self._shapes for s in shape.Solids]


class Feature:
    """A document object carrying a Shape, as PartDesign would produce."""

    def __init__(self, shape):
        self.Shape = shape


def makeBox(l, w, h, pos=None):  # noqa: N802
    origin = (pos.x, pos.y, pos.z) if pos is not None else (0.0, 0.0, 0.0)
    return Solid(l, w, h, origin)


def makeCompound(shapes):  # noqa: N802
    return Compound(shapes)
