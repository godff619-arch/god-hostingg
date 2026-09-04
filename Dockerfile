# syntax=docker/dockerfile:1
#
# Single-container Docklift — API + dashboard on ONE port (default 3000).
#
# The docker-compose stack (docker-compose.yml) stays the recommended install: it
# runs the backend, the SPA and the nginx edge proxy as separate services. This
# image exists for platforms that give you exactly one container and one port —
# Coolify, Render, Railway, Fly, or a plain `docker run` — where a panel split
# across two ports is unreachable.
#
# Coolify: use docker-compose.coolify.yml (Build pack = Docker Compose, Base
#   directory = /, Compose file = /docker-compose.coolify.yml). It already wires the
#   socket, the volumes and the port, so nothing has to be reproduced by hand.
#   Prefer the Dockerfile build pack instead? Port = 3000, and add these mounts:
#     • /app/data        persistent volume — SQLite database + session secrets
#     • /deployments     persistent volume — cloned repos + generated compose files
#     • /var/run/docker.sock:/var/run/docker.sock — lets the panel deploy apps.
#       Without it the panel still boots and reports "Docker unavailable" honestly.
#
# First account: open by default — whoever opens /setup first becomes OWNER, and
# registration then closes. Set REQUIRE_BOOTSTRAP_SECRET=true to instead demand the
# secret this container prints to its logs on a fresh start.
#
# Build:  docker build -t docklift .
# Run:    docker run -p 3000:3000 -v docklift-data:/app/data \
#           -v /var/run/docker.sock:/var/run/docker.sock docklift

# ── 1. Dashboard (Vite SPA) ────────────────────────────────────────────────────
# Empty VITE_API_URL keeps the SPA same-origin, so /api and /ws resolve to
# whatever host serves it — no rebuild per domain.
FROM node:24-alpine AS frontend
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
ENV VITE_API_URL=""
RUN npm run build

# ── 2. API (TypeScript → dist) ─────────────────────────────────────────────────
FROM node:24-alpine AS backend
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
COPY backend/prisma ./prisma/
RUN npm ci --no-audit --no-fund
RUN npx prisma generate --no-hints
COPY backend/ ./
RUN npm run build

# ── 3. Runtime ─────────────────────────────────────────────────────────────────
FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATA_PATH=/app/data \
    DEPLOYMENTS_PATH=/deployments \
    NGINX_CONF_PATH=/nginx-conf \
    BACKUP_PATH=/app/data/backups \
    DATABASE_URL=file:/app/data/docklift.db

ARG TARGETARCH
ARG RAILPACK_VERSION=0.33.0

# docker-cli + buildx + compose: Docklift shells out to these to build and run the
# apps it deploys. git clones repositories; procps/util-linux back the metrics view.
RUN apk add --no-cache \
      docker-cli docker-cli-buildx docker-cli-compose \
      git procps bash util-linux wget

# Pinned automatic builder for repositories without a Dockerfile (musl = static).
# TARGETARCH is set by BuildKit; fall back to uname for plain `docker build`.
RUN ARCH="${TARGETARCH:-$(uname -m)}" \
    && case "$ARCH" in \
         amd64|x86_64) RAILPACK_ARCH=x86_64 ;; \
         arm64|aarch64) RAILPACK_ARCH=arm64 ;; \
         *) echo "Unsupported Railpack architecture: $ARCH" >&2; exit 1 ;; \
       esac \
    && wget -qO- "https://github.com/railwayapp/railpack/releases/download/v${RAILPACK_VERSION}/railpack-v${RAILPACK_VERSION}-${RAILPACK_ARCH}-unknown-linux-musl.tar.gz" \
       | tar -xz -C /usr/local/bin \
    && railpack --version

# Dev dependencies are kept on purpose: startup runs `prisma migrate deploy`
# through the prisma CLI, which ships as a devDependency.
COPY --from=backend /app/node_modules ./node_modules
COPY --from=backend /app/dist ./dist
COPY --from=backend /app/prisma ./prisma
COPY --from=backend /app/package.json ./
# Picked up automatically by backend/src/lib/staticSite.ts
COPY --from=frontend /frontend/dist ./public

RUN mkdir -p /app/data /deployments /nginx-conf

EXPOSE 3000

# /health/live needs no auth and no database, so an unconfigured install still
# reports healthy instead of crash-looping behind the platform's proxy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health/live" >/dev/null 2>&1 || exit 1

# Root is required for Docker socket access. Migrations run before the API binds.
CMD ["sh", "-c", "node dist/scripts/ensureDb.js && node dist/index.js"]
