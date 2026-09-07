# Express API image for MEAN-MultiChat.
# Build context must be backend/ so server.js can require ../config and ../utils.
#
# From repo root:
#   docker build -t mean-multichat-api -f backend/Dockerfile backend
#   npm run docker:api:build
#
# Render (Web Service):
#   Root Directory: backend
#   Dockerfile path: Dockerfile
#   Inject secrets via Environment (same keys as server/.env.example) — never bake .env into the image.

FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev

COPY config ./config
COPY utils ./utils
COPY server ./server

RUN mkdir -p /app/logs \
  && chown -R node:node /app

USER node

ENV NODE_ENV=production
ENV LOG_DIR=/app/logs
# Default for local docker run; Render assigns PORT at runtime.
ENV PORT=4800

EXPOSE 4800
WORKDIR /app/server

CMD ["node", "server.js"]
