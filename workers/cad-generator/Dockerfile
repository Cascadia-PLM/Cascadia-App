FROM condaforge/miniforge3:latest AS build
COPY environment.yml /tmp/environment.yml
RUN conda env create -f /tmp/environment.yml && \
    conda install -y -n base conda-pack && \
    conda-pack -n cad-generator -o /tmp/env.tar && \
    mkdir /venv && cd /venv && tar xf /tmp/env.tar && /venv/bin/conda-unpack

FROM debian:bookworm-slim AS runtime
RUN apt-get update && \
    apt-get install -y --no-install-recommends libgl1 libglib2.0-0 && \
    rm -rf /var/lib/apt/lists/*
COPY --from=build /venv /venv
ENV PATH="/venv/bin:$PATH" PYTHONPATH="/app/src" PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
RUN groupadd -r cadworker && useradd -r -g cadworker -m cadworker
WORKDIR /app
RUN mkdir -p /vault && chown cadworker:cadworker /vault
COPY src/ /app/src/
COPY entrypoint.sh /app/entrypoint.sh
RUN sed -i 's/\r$//' /app/entrypoint.sh && chmod +x /app/entrypoint.sh
USER cadworker
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=60s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:${HEALTH_PORT:-3004}/health')"
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["--worker"]
