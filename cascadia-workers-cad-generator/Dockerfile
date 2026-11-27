# Base digests pinned (resolved 2026-08-27) so the fragile conda solve builds
# from a known image; bump via `docker buildx imagetools inspect <image>`.
FROM condaforge/miniforge3:latest@sha256:f752860f77bd417aa4db35be3d2e906fdb740fb80f40755ed651fff9e8873aad AS build
# Build context is the repo root (not this directory): the image also carries
# the shared cascadia-workers-commons package alongside the worker source
# (JOBS-8).
COPY cascadia-workers-cad-generator/environment.yml /tmp/environment.yml
RUN conda env create -f /tmp/environment.yml && \
    conda install -y -n base conda-pack && \
    conda-pack -n cad-generator -o /tmp/env.tar && \
    mkdir /venv && cd /venv && tar xf /tmp/env.tar && /venv/bin/conda-unpack

# Collect the licence texts conda packages ship in their own metadata, so the
# image carries each component's terms as its authors published them. This is
# what LGPL asks for when it says a copy of the licence must accompany the
# work, and it covers the whole resolved environment rather than the handful
# of components THIRD-PARTY-NOTICES names by hand.
#
# Best effort by design: `|| true` because the package cache can legitimately
# be absent or pruned, and an image that fails to build over a missing licence
# cache would be a worse outcome than one that ships THIRD-PARTY-NOTICES with
# its canonical URLs and no local copies.
RUN mkdir -p /licenses && \
    (cd /opt/conda/pkgs && \
     find . -path '*/info/licenses/*' -type f -exec cp --parents {} /licenses/ \;) || true

FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587 AS runtime
RUN apt-get update && \
    apt-get install -y --no-install-recommends libgl1 libglib2.0-0 && \
    rm -rf /var/lib/apt/lists/*
COPY --from=build /venv /venv
ENV PATH="/venv/bin:$PATH" PYTHONPATH="/app/src:/app/common/src" PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
RUN groupadd -r cadworker && useradd -r -g cadworker -m cadworker
WORKDIR /app
RUN mkdir -p /vault && chown cadworker:cadworker /vault
# Attribution for everything this image redistributes. THIRD-PARTY-NOTICES is
# reviewed by hand and names the copyleft components and their obligations;
# /app/licenses carries the texts collected from the resolved environment.
COPY cascadia-workers-cad-generator/THIRD-PARTY-NOTICES /app/THIRD-PARTY-NOTICES
COPY --from=build /licenses /app/licenses

COPY cascadia-workers-cad-generator/src/ /app/src/
COPY cascadia-workers-commons/src/ /app/common/src/
COPY cascadia-workers-cad-generator/entrypoint.sh /app/entrypoint.sh
RUN sed -i 's/\r$//' /app/entrypoint.sh && chmod +x /app/entrypoint.sh
USER cadworker
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=60s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:${HEALTH_PORT:-3004}/health')"
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["--worker"]
