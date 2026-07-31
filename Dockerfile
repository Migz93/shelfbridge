# Base image pinned by digest so a rebuild can't silently pull a different
# toolchain under the same tag. Bump deliberately: resolve the new digest with
# `docker buildx imagetools inspect node:22-trixie-slim` and replace all four.
FROM node:22-trixie-slim@sha256:517aa41d78545cb1b8c67b13655b4c13ede1ee9df1da8aab54cd7434aefbcaf8 AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# better-sqlite3 may not have a prebuilt binary for every Node and CPU
# combination, so provide node-gyp's native build requirements in this stage.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN npm ci

FROM node:22-trixie-slim@sha256:517aa41d78545cb1b8c67b13655b4c13ede1ee9df1da8aab54cd7434aefbcaf8 AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-trixie-slim@sha256:517aa41d78545cb1b8c67b13655b4c13ede1ee9df1da8aab54cd7434aefbcaf8 AS production-deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN npm ci --omit=dev

FROM node:22-trixie-slim@sha256:517aa41d78545cb1b8c67b13655b4c13ede1ee9df1da8aab54cd7434aefbcaf8 AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=9303
ENV DATA_DIR=/config
# Build metadata — overridden by CI workflows via --build-arg
ARG BUILD_CHANNEL=develop
ARG COMMIT_SHA=local
ENV BUILD_CHANNEL=$BUILD_CHANNEL
ENV COMMIT_SHA=$COMMIT_SHA
RUN apt-get update \
  && apt-get install -y --no-install-recommends gosu python3 tzdata \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/package.json ./package.json
COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY docker-entrypoint.sh /entrypoint.sh
COPY docker-ownership-repair.py /ownership-repair.py
RUN chmod 755 /entrypoint.sh
RUN mkdir -p /config && chown node:node /config
# The container starts as root so the entrypoint can repair /config ownership on
# a fresh bind mount, then drops to the unprivileged "node" user (UID/GID 1000)
# before running the app — the app process itself never runs as root.
ENTRYPOINT ["/entrypoint.sh"]
EXPOSE 9303
CMD ["node", "dist/server/server/index.js"]
