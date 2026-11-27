# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Cascadia PLM LLC

"""Bushing template — hollow cylinder (OD/ID/length)."""

from __future__ import annotations

import cadquery as cq


def make_bushing(params: dict[str, float]) -> cq.Workplane:
    od = params["od"]
    id_ = params["id"]
    length = params["length"]
    return cq.Workplane("XY").circle(od / 2).circle(id_ / 2).extrude(length)
