# Demo CAD dataset packaged as a tiny image.
#
# Loaded into the cascadia-demo stack via a one-shot init container that
# copies into a named volume; the app reads from that volume via the
# DEMO_DATA_DIR env. Kept separate from cascadia-app so production deploys
# don't carry demo data they will never use.
#
# Build context is `demo-data/`, NOT the repo root — the root .dockerignore
# excludes demo-data so the app/vault/jobs builds don't transfer it. STEP
# files are filtered out by demo-data/.dockerignore, which keeps this image
# identical whether it is built in CI (where step/ is gitignored and absent)
# or on a developer machine (where it is present).
#
#   docker build -f docker/demo-data.Dockerfile demo-data

FROM alpine:3.20

COPY robot-arm /demo-data/robot-arm

LABEL org.opencontainers.image.source="https://github.com/Cascadia-PLM/Cascadia-App"
LABEL org.opencontainers.image.description="Cascadia PLM demo dataset (TDJ-25 robot arm: 79 GLB + thumbnail pairs and a manifest)."
LABEL org.opencontainers.image.licenses="AGPL-3.0-only"
