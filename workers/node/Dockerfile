# Cascadia Jobs Server
# Background job processing workers

# =============================================================================
# Stage 1: Dependencies
# =============================================================================
FROM node:20-alpine AS deps

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install all dependencies
RUN npm ci

# =============================================================================
# Stage 2: Builder
# =============================================================================
FROM node:20-alpine AS builder

WORKDIR /app

# Copy dependencies
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build application (increase heap for large TanStack Start builds)
ENV NODE_OPTIONS="--max-old-space-size=4096"
RUN npm run build

# =============================================================================
# Stage 3: Production
# =============================================================================
FROM node:20-alpine AS production

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

# Copy package files
COPY package.json package-lock.json ./

# Install only production dependencies
RUN npm ci --omit=dev && \
    npm cache clean --force

# Copy built application
COPY --from=builder /app/.output ./.output

# Copy job-related code
COPY --from=builder /app/src/lib/db ./src/lib/db

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
CMD ["node", ".output/server/jobs-worker.mjs"]
