# TDJ-25 Robot Arm — Demo Dataset

Sample engineering dataset bundled with the Cascadia demo (`docker-compose.demo.yml`). Loaded automatically by `scripts/seed-demo-robot-arm.ts` on first boot.

## What's here

```
manifest.json         pre-processed BOM (88 parts, 101 relationships)
glb/*.glb             pre-converted GLB (3D viewer payload, ~79 files)
thumbnails/*.png      pre-rendered thumbnails (item card previews, ~79 files)
```

`step/` is intentionally not committed — STEPs are build-time inputs to
`scripts/prepare-demo-cad.ts` only. The directory is gitignored. Run
`scripts/build-demo-manifest.ts` to materialize STEPs from the archive when
regenerating GLBs.

## Source

Originally exported from a SolidWorks assembly of the TDJ-25 6-DOF robot arm (FRC team build) and ported into this repo from the archived `CascadiaApp-archive/test-data/robot-arm/`. The raw `assembly-structure.json` from the archive contains 139 product instances; after deduplicating `_N` instance suffixes (e.g., `97431A340_1`, `97431A340_2` → `97431A340`) we get 88 unique parts and 101 BOM relationships.

Make/Buy classification is heuristic, based on naming patterns:

- **Manufacture**: `TDJ-25-*`, custom shafts, custom assemblies (e.g., `FALCON-MAX-PLANETARY-ASSY`)
- **Purchase**: COTS components — McMaster (`97431A*`, `98398A*`), West Coast Products (`WCP-*`), REV Robotics (`REV-*`), Vex (`217-*`), DIN/ANSI fasteners, motors

## Regenerating the dataset

If the archive's `assembly-structure.json` changes or you want to refresh the GLB/thumbnails:

```bash
# 1. Re-derive manifest.json + copy canonical STEPs from the archive
ARCHIVE_DIR="path/to/CascadiaApp-archive/test-data/robot-arm" \
  npx tsx scripts/build-demo-manifest.ts

# 2. Re-render GLB + thumbnails from the STEPs (requires Docker)
npx tsx scripts/prepare-demo-cad.ts
```

`scripts/prepare-demo-cad.ts` builds the cad-converter image if needed, then runs a single container that converts all STEPs in one pass. Allow ~10-20 minutes for ~79 files; the largest assembly (`TDJ-25-A-00000-MAIN-ASSEMBLY.step`, ~100 MB) dominates the runtime.

Or do both in one command:

```bash
npm run demo:build-data
```

## Layout invariants

The seed script assumes:

- `manifest.parts[].cadFileBase` is the basename (no extension) of the STEP file.
- For each part with `cadFileBase`, the seed looks for `step/{base}.step`, `glb/{base}.glb`, `thumbnails/{base}.png`. Missing files are tolerated (logged as "partial trio") but degrade the demo experience — a part without a GLB has no 3D viewer payload.

## Size

What ships in-repo:

- GLBs: ~200 MB (dominated by the master assembly + a handful of large sub-assemblies)
- Thumbnails: ~2 MB
- `manifest.json`: ~50 KB

Total ~200 MB committed. STEPs (~340 MB) live outside the repo — regenerated on demand from the archive when refreshing demo data.
