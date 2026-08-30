# Stage 1: Build conda environment with pythonocc-core
# Base digests pinned (resolved 2026-08-27) so the fragile conda solve builds
# from a known image; bump via `docker buildx imagetools inspect <image>`.
FROM condaforge/miniforge3:latest@sha256:609d8012d8ad3ea46c8e531ce2de9e727031960067b3a1e412c6e2954ef551c9 AS build

# Build context is ./workers (not this directory): the image also carries
# the shared py-common package alongside the worker source (JOBS-8).
COPY cad-converter/environment.yml /tmp/environment.yml

RUN conda env create -f /tmp/environment.yml && \
    conda install -y -n base conda-pack && \
    conda-pack -n cad-converter -o /tmp/env.tar && \
    mkdir /venv && \
    cd /venv && \
    tar xf /tmp/env.tar && \
    /venv/bin/conda-unpack

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

# Stage 2: Slim runtime image
FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171 AS runtime

# Install runtime dependencies for OpenCASCADE + Xvfb for offscreen rendering
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        libgl1 \
        libglib2.0-0 \
        libgomp1 \
        libx11-6 \
        libxext6 \
        libxrender1 \
        xauth \
        xvfb \
    && rm -rf /var/lib/apt/lists/*

# Copy packed conda environment
COPY --from=build /venv /venv

# Set up environment
ENV PATH="/venv/bin:$PATH"
ENV PYTHONPATH="/app/src:/app/common/src"
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1

# Create non-root user and Xvfb socket directory
RUN groupadd -r cadworker && useradd -r -g cadworker -m cadworker && \
    mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

# Create app directory and vault mount point
WORKDIR /app
RUN mkdir -p /vault && chown cadworker:cadworker /vault

# Attribution for everything this image redistributes. THIRD-PARTY-NOTICES is
# reviewed by hand and names the copyleft components and their obligations;
# /app/licenses carries the texts collected from the resolved environment.
COPY cad-converter/THIRD-PARTY-NOTICES /app/THIRD-PARTY-NOTICES
COPY --from=build /licenses /app/licenses

# Copy application source and entrypoint
COPY cad-converter/src/ /app/src/
COPY py-common/src/ /app/common/src/
COPY cad-converter/entrypoint.sh /app/entrypoint.sh
RUN sed -i 's/\r$//' /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Switch to non-root user
USER cadworker

# Health check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=60s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:${HEALTH_PORT:-3003}/health')"

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["--worker"]
