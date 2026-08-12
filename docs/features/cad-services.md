# CAD Generation Services

**Not included in this edition.** Generative CAD ships in the proprietary
edition of Cascadia, licensed separately from the AGPL edition published in this
repository.

## What it does

Turns text descriptions into CAD geometry — part generation through a
text-to-CAD service, and assembly composition through generated KCL (KittyCAD
Language). Output lands in the vault as STEP files attached to real parts, so
downstream conversion and viewing work exactly as they do for hand-authored CAD.

## What is in this edition

The distinction worth drawing: **CAD _conversion_ is part of this edition; CAD
_generation_ is not.**

- `workers/cad-converter/` — the Python worker that turns STEP and IGES into STL
  and GLB, preserving per-face colour. Present here, and it is what makes 3D
  viewing work.
- The file vault that stores the geometry —
  [file-vault.md](./file-vault.md)
- The 3D viewer — [visualization.md](./visualization.md)

An instance without the generation package can upload, convert, view, and
version CAD normally. It just cannot author it from a prompt.

## Getting it

Offered under a separate written agreement by Cascadia PLM LLC. See the
[project README](../../README.md) for contact details.
