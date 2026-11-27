# Cascadia Jobs Server
# Background job processing workers

# =============================================================================
# Stage 1: Workspace manifests
# =============================================================================
# The single copy of the manifest list, discovered rather than written: every
# top-level `cascadia-*/package.json` the build context carries. Two stages
# below install from it. The list used to be transcribed by hand, once per
# stage, and a workspace that was renamed or deleted had to be fixed in every
# copy; the
# deleted `cad-generation` outlived its package that way. Nothing here runs:
# this stage is a file list the other stages read, not a layer either of them
# inherits. See cascadia-app/Dockerfile for the caching note; the two files
# keep this stage instruction-identical so the builds share its layers.
FROM docker.io/library/node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS manifests

WORKDIR /src
COPY . .

# Root manifests, then every workspace manifest under its own directory, before
# the install: `npm ci` in a workspace root reads them to know what each
# workspace depends on. Without them it succeeds and quietly installs only the
# root's dependencies. (Every npm workspace is a top-level `cascadia-*`
# directory with a package.json; the Python workers have none and are not npm
# workspaces, so the glob leaves them out.)
RUN mkdir /manifests && cp package.json package-lock.json /manifests/ && \
    for f in cascadia-*/package.json; do \
      mkdir -p "/manifests/${f%/*}" && cp "$f" "/manifests/$f"; \
    done

# =============================================================================
# Stage 2: Dependencies
# =============================================================================
FROM docker.io/library/node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS deps

WORKDIR /app

# Root manifests plus every workspace manifest, from the stage that owns the
# list. Building this stage alone therefore proves the whole list resolves,
# which is what CI's Docker Build Smoke job does on every run.
COPY --from=manifests /manifests/ ./

# Install all dependencies
RUN npm ci

# =============================================================================
# Stage 3: Builder
# =============================================================================
FROM docker.io/library/node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS builder

WORKDIR /app

# Copy dependencies
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build application (increase heap for large TanStack Start builds)
ENV NODE_OPTIONS="--max-old-space-size=4096"
RUN npm run build

# =============================================================================
# Stage 4: Runtime dependencies
# =============================================================================
# Split out of the production stage below so it can be built, and therefore
# smoke-tested, without the builder stage — the same seam, for the same reason,
# as cascadia-app/Dockerfile. The first `COPY --from=builder` begins stage 5.
FROM docker.io/library/node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS runtime-deps

WORKDIR /app

# Install dumb-init and additional tools for conversions
RUN apk add --no-cache \
    dumb-init \
    # For office document conversions (optional, adds ~200MB)
    # libreoffice \
    # For image processing
    imagemagick \
    # For PDF operations
    ghostscript

# The same manifest list the deps stage installed from — see stage 1. This
# install differs only in its flags, never in what it is told the workspaces
# are.
COPY --from=manifests /manifests/ ./

# Production deps only, lifecycle scripts off — the same policy as
# cascadia-app/Dockerfile. Nothing in the runtime tree needs a postinstall:
# @node-rs/argon2 is the only native runtime dependency and ships napi
# prebuilds, and `postgres` is pure JS. A dependency that does need one
# (sharp, say) fails at *runtime* with a missing-binary error, not at build
# time — if that happens, drop --ignore-scripts from both images, not one.
RUN npm ci --omit=dev --ignore-scripts && \
    npm cache clean --force

# =============================================================================
# Stage 5: Production
# =============================================================================
FROM runtime-deps AS production

# Copy built application
COPY --from=builder /app/.output ./.output

# Copy job-related code
COPY --from=builder /app/cascadia-api/src/db ./cascadia-api/src/db

# The entrypoint
COPY --from=builder /app/scripts/docker-entrypoint.sh ./scripts/docker-entrypoint.sh

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Create temp directory for conversions
RUN mkdir -p /app/tmp && \
    chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Environment defaults
ENV NODE_ENV=production
ENV WORKER_CONCURRENCY=5
ENV JOB_TYPES=*
ENV JOB_TIMEOUT=300000

# Health check (jobs server exposes metrics endpoint)
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3002/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Labels
LABEL org.opencontainers.image.title="Cascadia PLM - Jobs Server"
LABEL org.opencontainers.image.description="Background job workers for Cascadia PLM"

# The entrypoint hands off to dumb-init so signals are forwarded.
ENTRYPOINT ["sh", "/app/scripts/docker-entrypoint.sh"]
CMD ["node", ".output/cascadia/server/jobs-worker.mjs"]
