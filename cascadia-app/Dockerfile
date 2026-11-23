# Cascadia Core App
# Multi-stage build for optimal image size

# =============================================================================
# Stage 1: Workspace manifests
# =============================================================================
# The single copy of the manifest list, discovered rather than written: every
# top-level `cascadia-*/package.json` the build context carries, whichever
# edition this tree composes. Two stages below install from it. The list used
# to be transcribed by hand, once per stage and then once per edition, and a
# workspace that was renamed or deleted had to be fixed in every copy; the
# deleted `cad-generation` outlived its package that way. Nothing here runs:
# this stage is a file list the other stages read, not a layer either of them
# inherits.
#
# `COPY . .` makes this stage re-run on any change to the context, which costs
# seconds. The stages that install from it copy only `/manifests`, and BuildKit
# keys that copy on the checksum of what it copies, so `npm ci` stays cached
# until a manifest actually changes.
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

# Install all dependencies (including dev for build)
RUN npm ci

# =============================================================================
# Stage 3: Builder
# =============================================================================
FROM docker.io/library/node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS builder

WORKDIR /app

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build the application (increase heap for large Vite builds)
ENV NODE_OPTIONS="--max-old-space-size=4096"

# Which app this image contains. Empty by default, and empty is the common
# case: given no name, scripts/build-app.mjs resolves the edition this tree
# composes (see scripts/edition.mjs), so one Dockerfile builds whichever
# edition the context carries. `--build-arg APP=<name>` builds another app the
# tree also contains. Unquoted on purpose: an empty value must expand to no
# argument at all, not to an empty one.
ARG APP=

# Which build this is, for the stamp at the foot of the sidebar. Vite inlines
# any VITE_-prefixed variable present at build time, so these have to be set
# before build:app runs, not at container start — the client bundle is already
# written by then.
#
# Passed in rather than derived: `.git` is excluded from the build context (see
# .dockerignore), so `git describe` cannot run in here. The publish workflow
# passes the ref and short commit it is building; a build by hand can pass its
# own, e.g. --build-arg BUILD_TAG=v0.6.0 --build-arg BUILD_SHA=6f89879.
#
# BUILD_TAG defaults to empty, not `dev`: unstamped, a production build shows
# the release version from package.json (see cascadia-web/src/build-info.ts),
# and a non-empty default would hide that fallback behind a literal `dev`.
ARG BUILD_TAG=""
ARG BUILD_SHA=""
ARG BUILD_DIRTY=false
ENV VITE_BUILD_TAG=${BUILD_TAG}
ENV VITE_BUILD_SHA=${BUILD_SHA}
ENV VITE_BUILD_DIRTY=${BUILD_DIRTY}

RUN npm run build:app -- $APP

# Record which app was built, for the runtime: an ARG does not cross stages,
# and the server resolves its static root as `dist/$APP`
# (scripts/docker-entrypoint.sh exports it from this file).
RUN echo "${APP:-$(node --input-type=module -e "import { resolveApp } from './scripts/edition.mjs'; console.log(resolveApp())")}" > .edition

# The tree the production stage copies in one piece: the root tsconfigs, the
# scripts, the edition marker and every npm workspace, whole. The admin scripts
# (seed, migrate, reset) run via tsx and import from the workspace packages;
# the server itself reads none of this at runtime — only `scripts/*.ts` do.
# The catalog seed JSON under cascadia-api/test-data comes along with them: the
# bundled server inlines it, but tsx-run scripts read it from disk.
#
# Assembled with a shell glob rather than a COPY list, because a COPY of
# several directories flattens them into the destination and a list has to
# name every workspace by hand — which is how an image once installed a
# workspace it then never copied, and `scripts/edition.mjs`, which resolves the
# edition by probing for directories, picked it and found it empty. tar rather
# than cp because busybox cp has no --parents.
RUN mkdir /runtime && tar cf - tsconfig.base.json tsconfig.json scripts .edition \
      $(for d in cascadia-*/; do [ -f "$d/package.json" ] && printf '%s ' "$d"; done) \
    | tar xf - -C /runtime

# =============================================================================
# Stage 4: Runtime dependencies
# =============================================================================
# Split out of the production stage below so it can be built, and therefore
# smoke-tested, without the builder stage. Everything here depends on the
# manifests alone; the first `COPY --from=builder` is what begins stage 5, and
# that copy is what used to drag a ten-minute Vite build in front of any
# attempt to exercise the install below. CI's Docker Build Smoke job builds
# this target for exactly that reason.
FROM docker.io/library/node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS runtime-deps

WORKDIR /app

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# The same manifest list the deps stage installed from — see stage 1. This
# install differs only in its flags, never in what it is told the workspaces
# are.
COPY --from=manifests /manifests/ ./

# Production deps only — the server is pre-bundled (see build-server.mjs) so
# tsx and other devDeps aren't needed at runtime.
# Lifecycle scripts stay off: no runtime dependency needs a postinstall (the
# one native package, @node-rs/argon2, ships napi prebuilds). A dependency
# that does need one fails at runtime with a missing binary, not at build
# time. cascadia-workers-job/Dockerfile carries the same policy.
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
# drizzle-kit declares no peerDependencies, but its CLI still dynamically
# imports drizzle-orm and the selected database driver from its own module
# tree. Link the production copies already installed in /app rather than
# downloading second, potentially mismatched versions into /opt/admin. The
# import check runs from that prefix and makes the runtime-deps CI target fail
# if either package becomes invisible there again.
#
# Container entry points invoke `tsx` directly, and scripts/drizzle.mjs invokes
# `drizzle-kit` directly; both find the tools through PATH without knowing
# where they are. Do not wrap either command in `npx`: npm exec does not search
# PATH for these packages and downloads another copy into its cache instead.
RUN mkdir -p /opt/admin && cd /opt/admin && \
    npm init -y > /dev/null && \
    npm install --ignore-scripts tsx@^4 drizzle-kit@^0.31 && \
    ln -s /app/node_modules/drizzle-orm node_modules/drizzle-orm && \
    ln -s /app/node_modules/postgres node_modules/postgres && \
    node -e "Promise.all([import('drizzle-orm/version'), import('postgres')])" && \
    npm cache clean --force
ENV PATH="/opt/admin/node_modules/.bin:${PATH}"

# =============================================================================
# Stage 5: Production
# =============================================================================
FROM runtime-deps AS production

# Copy bundled server + SPA build
COPY --from=builder /app/.output ./.output
COPY --from=builder /app/dist ./dist

# The runtime tree the builder assembled — see stage 3 for what it holds and
# why it is one copy rather than a list.
COPY --from=builder /runtime/ ./

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
# SOURCE_URL defaults to the repository core is developed in; a build from
# another tree passes its own.
ARG VERSION=dev
ARG REVISION=unknown
ARG SOURCE_URL=https://github.com/Cascadia-PLM/Cascadia-App
LABEL org.opencontainers.image.title="Cascadia PLM - Core App"
LABEL org.opencontainers.image.description="Core web application for Cascadia PLM"
LABEL org.opencontainers.image.source="${SOURCE_URL}"
LABEL org.opencontainers.image.version="${VERSION}"
LABEL org.opencontainers.image.revision="${REVISION}"

# The entrypoint exports APP from the builder's `.edition` marker unless the
# caller set it, then hands off to dumb-init so signals are forwarded. Shell
# form for the command deliberately — the exec form expands nothing.
ENTRYPOINT ["sh", "/app/scripts/docker-entrypoint.sh"]
CMD node ".output/${APP}/server/index.mjs"
