# Base digests pinned (resolved 2026-08-27, shared with the other Python
# workers) so the fragile conda solve builds from a known image; bump via
# `docker buildx imagetools inspect <image>`.
FROM condaforge/miniforge3:latest@sha256:f752860f77bd417aa4db35be3d2e906fdb740fb80f40755ed651fff9e8873aad AS build
# Build context is the repo root (not this directory): the image also carries
# the shared cascadia-workers-commons package alongside the worker source
# (JOBS-8).
COPY cascadia-workers-freecad-runner/environment.yml /tmp/environment.yml
# gmsh is a FreeCAD run dependency on conda-forge (FEM meshing) and is
# GPL-2.0-or-later, and this worker never invokes it. It is removed with
# --force to keep the image smaller and its notices shorter (see
# THIRD-PARTY-NOTICES). `|| true` because a future recipe may simply not pull
# it in.
RUN conda env create -f /tmp/environment.yml && \
    (conda remove -y -n freecad-runner --force gmsh || true) && \
    conda install -y -n base conda-pack && \
    conda-pack -n freecad-runner -o /tmp/env.tar --ignore-missing-files && \
    mkdir /venv && cd /venv && tar xf /tmp/env.tar && /venv/bin/conda-unpack

# Collect the licence texts conda packages ship in their own metadata, so the
# image carries each component's terms as its authors published them. Best
# effort by design — see the generator's Dockerfile for the reasoning.
RUN mkdir -p /licenses && \
    (cd /opt/conda/pkgs && \
     find . -path '*/info/licenses/*' -type f -exec cp --parents {} /licenses/ \;) || true

FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587 AS runtime
# FreeCAD links Qt and OpenGL even headless; these are the system libraries
# the conda-packed environment expects from the host image.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        libgl1 libglu1-mesa libegl1 libglib2.0-0 libgomp1 \
        libx11-6 libxext6 libxrender1 libxcb1 libsm6 libice6 \
        libxkbcommon0 libfontconfig1 libdbus-1-3 && \
    rm -rf /var/lib/apt/lists/*
COPY --from=build /venv /venv
ENV PATH="/venv/bin:$PATH" PYTHONPATH="/app/src:/app/common/src" PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 QT_QPA_PLATFORM=offscreen
RUN groupadd -r cadworker && useradd -r -g cadworker -m cadworker
WORKDIR /app
RUN mkdir -p /vault && chown cadworker:cadworker /vault
# Attribution for everything this image redistributes. THIRD-PARTY-NOTICES is
# reviewed by hand and names the copyleft components and their obligations;
# /app/licenses carries the texts collected from the resolved environment.
COPY cascadia-workers-freecad-runner/THIRD-PARTY-NOTICES /app/THIRD-PARTY-NOTICES
COPY --from=build /licenses /app/licenses

COPY cascadia-workers-freecad-runner/src/ /app/src/
COPY cascadia-workers-commons/src/ /app/common/src/
COPY cascadia-workers-freecad-runner/entrypoint.sh /app/entrypoint.sh
RUN sed -i 's/\r$//' /app/entrypoint.sh && chmod +x /app/entrypoint.sh
# Fail the build, not the first job, if FreeCAD cannot import headless here.
RUN python -c "import FreeCAD, Part; print('FreeCAD', '.'.join(str(p) for p in FreeCAD.Version()[:3]))"
USER cadworker
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=90s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:${HEALTH_PORT:-3005}/health')"
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["--worker"]
