# syntax=docker/dockerfile:1

# ---- build: install everything, compile the dashboard and the server ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
# Prisma's engines link against OpenSSL.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci

COPY . .
RUN npm run build \
  && npm prune --omit=dev \
  # Regenerate the Prisma client in case pruning touched it.
  && rm -f server/prisma/.generated \
  && node server/scripts/prepare-db.mjs --generate-only \
  && mkdir -p server/node_modules

# ---- runtime: production dependencies + build output, running as a non-root user ----
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data
# fontconfig + DejaVu: the photo commands draw text (meme captions), and the slim image ships no fonts.
# curl: for the health check below, and for platforms (Coolify and the like) that run their own
# HTTP check from inside the container and need curl or wget to do it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates tini curl fontconfig fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Owned by "node": switching database providers regenerates the Prisma client
# (node_modules/.prisma) and rewrites server/prisma/schema.prisma at boot.
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/server/package.json ./server/
COPY --from=build --chown=node:node /app/server/node_modules ./server/node_modules
COPY --from=build --chown=node:node /app/server/dist ./server/dist
COPY --from=build --chown=node:node /app/server/public ./server/public
COPY --from=build --chown=node:node /app/server/assets ./server/assets
COPY --from=build --chown=node:node /app/server/prisma ./server/prisma
COPY --from=build --chown=node:node /app/server/scripts ./server/scripts
RUN mkdir -p /app/data && chown node:node /app /app/server /app/data

USER node
# Sessions, the SQLite database, cached media, uploads and plugins all live here.
VOLUME /app/data
EXPOSE 3000

# Healthy once the server answers and can read its database. Checked every 15 seconds so a new
# deployment is recognised quickly; the first start may spend a while preparing the database.
HEALTHCHECK --interval=15s --timeout=5s --start-period=90s --retries=3 CMD curl -fsS -o /dev/null "http://127.0.0.1:${PORT:-3000}/api/health" || exit 1

ENTRYPOINT ["tini", "--"]
CMD ["node", "server/scripts/start.mjs"]
