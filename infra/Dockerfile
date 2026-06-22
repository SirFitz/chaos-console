# syntax=docker/dockerfile:1

###############################################################################
# Chaos Console — multi-stage image
#   builder : Node 20 + corepack pnpm 9, full workspace install + build
#   runtime : slim glibc Node 20 (better-sqlite3 is a native addon), non-root,
#             runs the Fastify server which also serves packages/web/dist.
# Build (from repo root):  docker build -f infra/Dockerfile -t chaos-console:dev .
# NO AWS keys are baked in — credentials come from the task role / mounted profile.
###############################################################################

# ---------- builder ----------
FROM node:20-slim AS builder
ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH" \
    CI="true"
# Toolchain for native module compilation (better-sqlite3).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.7.0 --activate
WORKDIR /app

# Copy manifests first for cached, deterministic installs.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json  packages/shared/package.json
COPY packages/engine/package.json  packages/engine/package.json
COPY packages/server/package.json  packages/server/package.json
COPY packages/web/package.json     packages/web/package.json
RUN pnpm install --frozen-lockfile

# Copy the rest of the sources and build every package.
COPY tsconfig.base.json vitest.config.ts vitest.workspace.ts ./
COPY packages ./packages
RUN pnpm -r build

# Drop dev dependencies so only runtime deps are carried forward.
RUN pnpm -r --prod install --frozen-lockfile

# ---------- runtime ----------
FROM node:20-slim AS runtime
ENV NODE_ENV=production \
    NODE_OPTIONS=--conditions=production \
    PORT=8080 \
    CHAOS_CONFIG_DIR=/config \
    CHAOS_AUDIT_DB=/data/chaos-audit.sqlite
WORKDIR /app

# Minimal tooling for the HEALTHCHECK (curl). No build toolchain in runtime.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

# Bring in the built workspace + pruned node_modules from the builder.
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder /app/packages/shared/dist        ./packages/shared/dist
# NOTE: @chaos/shared has no third-party deps, so pnpm creates no
# packages/shared/node_modules. The @chaos/* workspace links live in the
# consuming packages' node_modules (engine/server below), so nothing is lost.
COPY --from=builder /app/packages/engine/package.json ./packages/engine/package.json
COPY --from=builder /app/packages/engine/dist        ./packages/engine/dist
COPY --from=builder /app/packages/engine/node_modules ./packages/engine/node_modules
COPY --from=builder /app/packages/server/package.json ./packages/server/package.json
COPY --from=builder /app/packages/server/dist        ./packages/server/dist
COPY --from=builder /app/packages/server/node_modules ./packages/server/node_modules
COPY --from=builder /app/packages/web/dist           ./packages/web/dist

# No config is baked in — the image is environment-agnostic. Mount your
# platforms.json + catalog.json + users.json at /config (CHAOS_CONFIG_DIR)
# at runtime; the server boots with empty defaults until then. See config/platforms.example.json.

# Non-root user; owns the audit-db + (runtime-mounted, empty by default) config dirs.
RUN useradd --system --uid 10001 --create-home --home-dir /home/chaos chaos \
 && mkdir -p /data /config \
 && chown -R chaos:chaos /data /config
USER chaos

VOLUME ["/data", "/config"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/healthz" || exit 1

# The server entrypoint resolves packages/web/dist as ../../web/dist from
# packages/server/dist, and reads config from CHAOS_CONFIG_DIR.
CMD ["node", "packages/server/dist/index.js"]
