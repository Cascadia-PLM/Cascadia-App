# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Cascadia PLM LLC

"""Which derivative formats a conversion stores, and the STL fallback.

The invariant: a conversion that completes leaves at least one mesh in the
vault. The converter always produces the STL, but the GLB only for a STEP
source whose XDE step succeeds, so a GLB-only request must fall back to the
STL rather than finish with nothing stored, and must not store a redundant
STL when the GLB did land.

Pure functions only; no pythonocc, pika or database needed
(``pip install pytest pydantic`` is enough).
"""

from __future__ import annotations

import itertools

import pytest

from cad_converter.models import CadConversionPayload
from cad_converter.output_formats import plan_storage, stl_fallback_reason

FORMAT_LISTS = [[], ["glb"], ["stl"], ["glb", "stl"], ["stl", "glb"], ["obj"]]


def _settle(output_formats, decompose, *, glb_produced, glb_store_ok):
    """What reaches the vault, mirroring the worker's order of operations."""
    plan = plan_storage(output_formats, decompose)
    glb_stored = 1 if plan.store_glb and glb_produced and glb_store_ok else 0
    reason = stl_fallback_reason(
        plan, glb_produced=1 if glb_produced else 0, glb_stored=glb_stored
    )
    stl_stored = plan.store_stl or reason is not None
    return plan, stl_stored, glb_stored > 0, reason


@pytest.mark.parametrize(
    "output_formats,decompose,glb_produced,glb_store_ok",
    list(
        itertools.product(
            FORMAT_LISTS, [False, True], [False, True], [False, True]
        )
    ),
)
def test_a_completed_conversion_always_stores_a_mesh(
    output_formats, decompose, glb_produced, glb_store_ok
):
    _, stl_stored, glb_stored, _ = _settle(
        output_formats,
        decompose,
        glb_produced=glb_produced,
        glb_store_ok=glb_store_ok,
    )
    assert stl_stored or glb_stored


@pytest.mark.parametrize(
    "output_formats,decompose,glb_produced,glb_store_ok",
    list(
        itertools.product(
            FORMAT_LISTS, [False, True], [False, True], [False, True]
        )
    ),
)
def test_fallback_only_when_nothing_requested_was_stored(
    output_formats, decompose, glb_produced, glb_store_ok
):
    plan, _, glb_stored, reason = _settle(
        output_formats,
        decompose,
        glb_produced=glb_produced,
        glb_store_ok=glb_store_ok,
    )
    requested_stored = plan.store_stl or glb_stored
    assert (reason is not None) == (not requested_stored)


def test_glb_only_from_iges_falls_back_to_stl():
    # IGES never yields a GLB: the XDE reader is STEP-only.
    plan, stl_stored, glb_stored, reason = _settle(
        ["glb"], False, glb_produced=False, glb_store_ok=True
    )
    assert not plan.store_stl
    assert not glb_stored
    assert stl_stored
    assert reason is not None and "no GLB was produced" in reason


def test_glb_only_whose_store_failed_falls_back_to_stl():
    _, stl_stored, glb_stored, reason = _settle(
        ["glb"], False, glb_produced=True, glb_store_ok=False
    )
    assert not glb_stored
    assert stl_stored
    assert reason is not None and "could not be stored" in reason


def test_glb_only_that_succeeds_stores_no_stl():
    _, stl_stored, glb_stored, reason = _settle(
        ["glb"], False, glb_produced=True, glb_store_ok=True
    )
    assert glb_stored
    assert not stl_stored
    assert reason is None


@pytest.mark.parametrize("output_formats", FORMAT_LISTS)
def test_decomposition_always_stores_stl(output_formats):
    # The assembly manifest is keyed by each part's STL file id.
    assert plan_storage(output_formats, decompose=True).store_stl


def test_payload_without_formats_stores_both():
    # Rows queued before `outputFormats` existed carry none.
    payload = CadConversionPayload(
        vaultFileId="22222222-2222-4222-8222-222222222222",
        itemId="33333333-3333-4333-8333-333333333333",
        userId="44444444-4444-4444-8444-444444444444",
    )
    plan = plan_storage(payload.outputFormats, payload.decompose)
    assert plan.store_stl and plan.store_glb
