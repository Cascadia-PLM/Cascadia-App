# Cascadia Vault Service
# Standalone file storage and management service

# =============================================================================
# Stage 1: Dependencies
# =============================================================================
FROM node:20-alpine AS deps

WORKDIR /app

# Copy package files
COPY package*.json ./

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

# Build vault service
# Note: This builds the same codebase but entry point differs
RUN npm run build

# =============================================================================
# Stage 3: Production
# =============================================================================
FROM node:20-alpine AS production

WORKDIR /app

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production && \
    npm cache clean --force

# Copy built application
COPY --from=builder /app/.output ./.output

# Copy vault-specific code
COPY --from=builder /app/src/lib/vault ./src/lib/vault
COPY --from=builder /app/src/lib/db ./src/lib/db

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Create vault storage directory
RUN mkdir -p /app/vault && \
    chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Default vault port
EXPOSE 3001

# Environment defaults
ENV PORT=3001
ENV STORAGE_TYPE=local
ENV STORAGE_PATH=/app/vault

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3001/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Labels
LABEL org.opencontainers.image.title="Cascadia PLM - Vault Service"
LABEL org.opencontainers.image.description="File storage service for Cascadia PLM"

ENTRYPOINT ["dumb-init", "--"]

# Start vault service
# Note: Entry point script to be created - currently uses same app with different config
CMD ["node", ".output/server/index.mjs"]
