# Cascadia Jobs Server
# Background job processing workers

# =============================================================================
# Stage 1: Workspace manifests
# =============================================================================
# The single copy of the manifest list. Two stages below install from it, and
# each used to carry its own transcription of it — so a workspace that was
# renamed or deleted had to be fixed in two places, and the deleted
# `packages/cad-generation` duly outlived its package in both. An empty base
# image because nothing here runs: this stage is a file list the other stages
# read, not a layer either of them inherits.
FROM scratch AS manifests

COPY package.json package-lock.json ./

# Workspace manifests, before the install: `npm ci` in a workspace root reads
# them to know what each workspace depends on. Without them it succeeds and
# quietly installs only the root's dependencies. Listed one per line rather than
# globbed because `COPY packages/*/…` flattens the paths. A new workspace
# belongs here too.
COPY packages/core/package.json ./packages/core/
COPY apps/cascadia/package.json ./apps/cascadia/

# =============================================================================
# Stage 2: Dependencies
# =============================================================================
FROM node:22-alpine AS deps

WORKDIR /app

# Root manifests plus every workspace manifest, from the stage that owns the
# list. Building this stage alone therefore proves the whole list resolves,
# which is what CI's Docker Build Smoke job does on every run.
COPY --from=manifests / ./

# Install all dependencies
RUN npm ci

# =============================================================================
# Stage 3: Builder
# =============================================================================
FROM node:22-alpine AS builder

WORKDIR /app

# Copy dependencies
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build application (increase heap for large TanStack Start builds)
ENV NODE_OPTIONS="--max-old-space-size=4096"
# Which edition's job handlers this worker carries. See docker/app.Dockerfile.
ARG APP=cascadia
RUN npm run build:app -- "$APP"

# =============================================================================
# Stage 4: Production
# =============================================================================
FROM node:22-alpine AS production

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
COPY --from=manifests / ./

# Install only production dependencies
RUN npm ci --omit=dev && \
    npm cache clean --force

# Copy built application
COPY --from=builder /app/.output ./.output

# Copy job-related code
COPY --from=builder /app/packages/core/src/lib/db ./packages/core/src/lib/db

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

ENTRYPOINT ["dumb-init", "--"]

# Start jobs worker
# Re-declared: an ARG from an earlier stage is not in scope here. Shell form so
# ${APP} expands — the exec form would pass it literally.
ARG APP=cascadia
ENV APP=${APP}
CMD node .output/${APP}/server/jobs-worker.mjs
