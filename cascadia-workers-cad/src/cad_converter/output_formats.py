# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Cascadia PLM LLC

"""Which derivative formats a conversion stores, and when STL steps in.

Pure decisions with no I/O, so they are unit-testable without pythonocc; the
worker does the storing.

The converter always writes the STL first and the GLB only sometimes: never
for an IGES source (the colour-aware XDE reader is STEP-only), and not when the
XDE subprocess times out, crashes or reports an error. A job that asked for GLB
alone could therefore finish "successfully" with nothing in the vault. The STL
is already on disk by then, so it is stored instead and the fallback recorded.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Optional

GLB = "glb"
STL = "stl"

#: What a payload queued before ``outputFormats`` existed asked for: both, as
#: every conversion stored then. The API resolves the deployment default
#: (``CAD_DEFAULT_OUTPUT_FORMATS``) before it queues a job, so a current
#: payload always names its formats and this is only the backstop.
DEFAULT_OUTPUT_FORMATS: tuple[str, ...] = (GLB, STL)


@dataclass(frozen=True)
class StoragePlan:
    """What to store before knowing what the converter managed to produce."""

    store_stl: bool
    store_glb: bool


def plan_storage(output_formats: Iterable[str], decompose: bool) -> StoragePlan:
    """The formats asked for, plus STL whenever an assembly is decomposed.

    Decomposition's manifest is keyed by each part's STL file id, so it
    cannot be written without them.
    """
    formats = set(output_formats)
    return StoragePlan(
        store_stl=STL in formats or decompose,
        store_glb=GLB in formats,
    )


def stl_fallback_reason(
    plan: StoragePlan,
    *,
    glb_produced: int,
    glb_stored: int,
) -> Optional[str]:
    """Why the STL must be stored after all, or None when it need not be.

    Called once the planned formats have been stored. STL already in the plan
    means a requested format was stored (the converter cannot finish without
    one), so nothing is left to fall back to. Otherwise the only thing that
    could have been asked for is GLB, and a job that stored none of it would
    leave the vault empty.
    """
    if plan.store_stl or glb_stored > 0:
        return None
    if not plan.store_glb:
        return "no supported output format was requested"
    if glb_produced > 0:
        return "a GLB was produced but could not be stored"
    return (
        "no GLB was produced (IGES sources have none; for STEP, GLB "
        "generation failed or timed out)"
    )
