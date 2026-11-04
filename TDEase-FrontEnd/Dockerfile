# =============================================================================
# Stage 1: Build the Vue/Vite application
# =============================================================================
FROM node:20-slim AS builder

# Install pnpm globally
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy dependency manifests first (leverages Docker layer caching)
COPY pnpm-lock.yaml package.json ./

# Install dependencies (fail if lockfile is out of sync)
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build the application (vue-tsc --noEmit && vite build)
RUN pnpm build

# =============================================================================
# Stage 2: Serve via Nginx
# =============================================================================
FROM nginx:alpine

# Install curl for HEALTHCHECK
RUN apk add --no-cache curl

# Copy custom Nginx configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy built artifacts from builder stage
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy runtime entrypoint for env var injection
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl --fail http://localhost:80/ || exit 1

ENTRYPOINT ["/docker-entrypoint.sh"]
