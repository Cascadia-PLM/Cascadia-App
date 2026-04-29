#!/usr/bin/env python3
"""
Helper that runs INSIDE the cad-converter container to batch-convert all STEP
files in /work/step/ into GLB (/work/glb/) + PNG thumbnails (/work/thumbnails/).

Invoked by scripts/prepare-demo-cad.ts. Requires Xvfb running on DISPLAY=:99
for thumbnail rendering — the orchestrator handles that.

Honors:
  FORCE=1   re-convert files that already have a GLB
  ONLY=str  only process basenames containing the substring
"""

from __future__ import annotations

import os
import sys
import time
import traceback
from pathlib import Path

WORK_DIR = Path(sys.argv[1] if len(sys.argv) > 1 else "/work")
STEP_DIR = WORK_DIR / "step"
GLB_DIR = WORK_DIR / "glb"
THUMB_DIR = WORK_DIR / "thumbnails"
TMP_STL_DIR = Path("/tmp/demo-stl")

FORCE = os.environ.get("FORCE", "0") == "1"
ONLY = os.environ.get("ONLY", "")

GLB_DIR.mkdir(parents=True, exist_ok=True)
THUMB_DIR.mkdir(parents=True, exist_ok=True)
TMP_STL_DIR.mkdir(parents=True, exist_ok=True)

# Make the cad_converter package importable.
sys.path.insert(0, "/app/src")

from cad_converter.converter import convert_single_with_colors  # noqa: E402
from cad_converter.models import MeshQuality  # noqa: E402

steps = sorted(STEP_DIR.glob("*.step"))
if ONLY:
    steps = [s for s in steps if ONLY.lower() in s.stem.lower()]

print(f"[helper] {len(steps)} STEP files (FORCE={FORCE}, ONLY={ONLY!r})", flush=True)

ok = 0
skipped = 0
failed: list[tuple[str, str]] = []

t0 = time.time()
for i, step in enumerate(steps, start=1):
    base = step.stem
    glb_out = GLB_DIR / f"{base}.glb"
    thumb_out = THUMB_DIR / f"{base}.png"
    stl_out = TMP_STL_DIR / f"{base}.stl"

    if not FORCE and glb_out.exists() and thumb_out.exists():
        skipped += 1
        continue

    print(f"[{i:>3}/{len(steps)}] {base}", flush=True)
    try:
        convert_single_with_colors(
            str(step),
            str(stl_out),
            str(glb_out),
            MeshQuality.STANDARD,
            True,
            str(thumb_out),
        )
        if glb_out.exists():
            ok += 1
        else:
            failed.append((base, "GLB not produced"))
        # STLs aren't shipped — discard.
        try:
            stl_out.unlink(missing_ok=True)
        except Exception:
            pass
    except Exception as e:
        failed.append((base, f"{type(e).__name__}: {e}"))
        traceback.print_exc()

elapsed = time.time() - t0
print()
print(f"[helper] done in {elapsed:.1f}s — ok={ok}, skipped={skipped}, failed={len(failed)}", flush=True)
if failed:
    print("[helper] failures:", flush=True)
    for base, why in failed:
        print(f"   {base}: {why}", flush=True)

# Exit success even with some failures — the seed handles missing assets gracefully.
sys.exit(0)
