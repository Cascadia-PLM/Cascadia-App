# Demo CAD dataset (~592 MB) packaged as a tiny image.
#
# Loaded into the cascadia-demo stack via a one-shot init container that
# copies into a named volume; the app reads from that volume via the
# DEMO_DATA_DIR env. Kept separate from cascadia-app so production deploys
# don't carry demo data they will never use.
#
# Build context is the repo root.

FROM alpine:3.20

COPY demo-data/robot-arm /demo-data/robot-arm

LABEL org.opencontainers.image.source="https://github.com/Cascadia-PLM/Cascadia-App"
LABEL org.opencontainers.image.description="Cascadia PLM demo dataset (TDJ-25 robot arm: 79 STEP/GLB/PNG trios + manifest)."
LABEL org.opencontainers.image.licenses="AGPL-3.0-only"
