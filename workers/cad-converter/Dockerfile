# Stage 1: Build conda environment with pythonocc-core
FROM condaforge/miniforge3:latest AS build

COPY environment.yml /tmp/environment.yml

RUN conda env create -f /tmp/environment.yml && \
    conda install -y -n base conda-pack && \
    conda-pack -n cad-converter -o /tmp/env.tar && \
    mkdir /venv && \
    cd /venv && \
    tar xf /tmp/env.tar && \
    /venv/bin/conda-unpack

# Stage 2: Slim runtime image
FROM debian:bookworm-slim AS runtime

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
ENV PYTHONPATH="/app/src"
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1

# Create non-root user and Xvfb socket directory
RUN groupadd -r cadworker && useradd -r -g cadworker -m cadworker && \
    mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

# Create app directory and vault mount point
WORKDIR /app
RUN mkdir -p /vault && chown cadworker:cadworker /vault

# Copy application source and entrypoint
COPY src/ /app/src/
COPY entrypoint.sh /app/entrypoint.sh
RUN sed -i 's/\r$//' /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Switch to non-root user
USER cadworker

# Health check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=60s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:${HEALTH_PORT:-3003}/health')"

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["--worker"]
