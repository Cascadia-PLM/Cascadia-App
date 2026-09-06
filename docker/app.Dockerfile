# Cascadia Core App
# Multi-stage build for optimal image size

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
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS deps

WORKDIR /app

# Root manifests plus every workspace manifest, from the stage that owns the
# list. Building this stage alone therefore proves the whole list resolves,
# which is what CI's Docker Build Smoke job does on every run.
COPY --from=manifests / ./

# Install all dependencies (including dev for build)
RUN npm ci

# =============================================================================
# Stage 3: Builder
# =============================================================================
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS builder

WORKDIR /app

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build the application (increase heap for large Vite builds)
ENV NODE_OPTIONS="--max-old-space-size=4096"
# Which edition this image contains. This tree carries only the AGPL
# community build.
ARG APP=cascadia
RUN npm run build:app -- "$APP"

# =============================================================================
# Stage 4: Runtime dependencies
# =============================================================================
# Split out of the production stage below so it can be built, and therefore
# smoke-tested, without the builder stage. Everything here depends on the
# manifests alone; the first `COPY --from=builder` is what begins stage 5, and
# that copy is what used to drag a ten-minute Vite build in front of any
# attempt to exercise the install below. CI's Docker Build Smoke job builds
# this target for exactly that reason.
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS runtime-deps

WORKDIR /app

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# The same manifest list the deps stage installed from — see stage 1. This
# install differs only in its flags, never in what it is told the workspaces
# are.
COPY --from=manifests / ./

# Production deps only — the server is pre-bundled (see build-server.mjs) so
# tsx and other devDeps aren't needed at runtime.
# Lifecycle scripts stay off: no runtime dependency needs a postinstall (the
# one native package, @node-rs/argon2, ships napi prebuilds). A dependency
# that does need one fails at runtime with a missing binary, not at build
# time. workers/node/Dockerfile carries the same policy.
RUN npm ci --omit=dev --ignore-scripts && \
    npm cache clean --force

# tsx and drizzle-kit, the admin tools for running scripts/*.ts (seed, migrate,
# reset) via `docker exec`. They get their own tree rather than being added to
# the app's.
#
# They were previously installed into /app with:
#
#     npm install --no-save --no-package-lock --ignore-scripts tsx@^4 drizzle-kit@^0.31
#
# and that line broke the image outright. `--no-package-lock` makes npm discard
# the lockfile and re-resolve the whole tree live from the registry,
# devDependencies included, against the node_modules the install above has just
# pruned of them; arborist walks vitest's peer set, reaches a node that is not
# there, and exits 1 with "Cannot read properties of null (reading
# 'edgesOut')". Both architectures, every time. It had never been reproducible
# — whether it worked depended on what the registry resolved that day, not on
# anything in this repository — and by the time it was traced it had failed
# repeated publishes of the public image.
#
# Both in-tree repairs are worse than the crash. Adding `--omit=dev` makes npm
# silently *drop the two packages it was told to install*, because both are
# listed under devDependencies: the image builds green and fails later, at
# `docker exec` time, which is a far more expensive place to find it. Dropping
# `--no-package-lock` instead resolves against the lockfile and installs the
# entire dev tree — vitest, playwright and the rest, ~147MB — into a production
# image, defeating the `--omit=dev` above it.
#
# A separate prefix has neither failure mode. It is 43MB, it resolves in its
# own tree where nothing can perturb the app's, and it is reproducible.
# drizzle-kit declares no peerDependencies and bundles its own esbuild, so it
# needs nothing from /app/node_modules; the schema's `drizzle-orm` import
# resolves from the schema file, which lives in the app tree. Both entry points
# find these through PATH without knowing where they are: `npm run` keeps the
# inherited PATH, and scripts/drizzle.mjs shells out via `npx`, which falls
# through to PATH when a binary is not in a local node_modules.
RUN mkdir -p /opt/admin && cd /opt/admin && \
    npm init -y > /dev/null && \
    npm install --ignore-scripts tsx@^4 drizzle-kit@^0.31 && \
    npm cache clean --force
ENV PATH="/opt/admin/node_modules/.bin:${PATH}"

# =============================================================================
# Stage 5: Production
# =============================================================================
FROM runtime-deps AS production

# Copy bundled server + SPA build
COPY --from=builder /app/.output ./.output
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public

# Admin scripts (seed, migrate, reset) run via tsx and import from the
# workspace packages. The server itself reads none of this at runtime — only
# `scripts/*.ts` do. The catalog seed JSON under packages/core/test-data comes
# along with them: the bundled server inlines it, but tsx-run scripts read it
# from disk.
COPY --from=builder /app/tsconfig.base.json ./
COPY --from=builder /app/tsconfig.json ./
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps ./apps
COPY --from=builder /app/scripts ./scripts

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Create storage directories with correct permissions
RUN mkdir -p /app/storage/files /app/vault && \
    chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/api/v1/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Labels for container identification. VERSION/REVISION come from build args
# so `docker inspect` can answer "which release is this image?":
#   docker build --build-arg VERSION=0.5.0 --build-arg REVISION=$(git rev-parse HEAD) ...
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Cascadia PLM - Core App"
LABEL org.opencontainers.image.description="Core web application for Cascadia PLM"
LABEL org.opencontainers.image.source="https://github.com/Cascadia-PLM/Cascadia-App"
LABEL org.opencontainers.image.version="${VERSION}"
LABEL org.opencontainers.image.revision="${REVISION}"

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Re-declared: an ARG from an earlier stage is not in scope here. Carried into
# the environment so the CMD below can name the edition's output directory.
ARG APP=cascadia
ENV APP=${APP}

# Shell form deliberately — the exec form does not expand ${APP}.
CMD node .output/${APP}/server/index.mjs
