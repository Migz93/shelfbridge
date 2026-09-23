# Base image pinned by digest so a rebuild can't silently pull a different
# toolchain under the same tag. Bump deliberately: resolve the new digest with
# `docker buildx imagetools inspect node:22-trixie-slim` and replace all four.
FROM node:22-trixie-slim@sha256:c5849ff9c9ebcd66615412f0b548ca5b8ecaef84003dc9ac2e077ebe46aaa3f6 AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# better-sqlite3 has no install/postinstall script of its own, so npm falls
# back to its legacy default for packages with a binding.gyp: it always runs
# `node-gyp rebuild` on install, even though better-sqlite3 already bundles a
# matching prebuilt binary. Provide node-gyp's native build requirements so
# that unconditional rebuild succeeds.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN npm ci

FROM node:22-trixie-slim@sha256:c5849ff9c9ebcd66615412f0b548ca5b8ecaef84003dc9ac2e077ebe46aaa3f6 AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-trixie-slim@sha256:c5849ff9c9ebcd66615412f0b548ca5b8ecaef84003dc9ac2e077ebe46aaa3f6 AS production-deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN npm ci --omit=dev

FROM node:22-trixie-slim@sha256:c5849ff9c9ebcd66615412f0b548ca5b8ecaef84003dc9ac2e077ebe46aaa3f6 AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=9303
ENV DATA_DIR=/config
# Build metadata — overridden by CI workflows via --build-arg
ARG BUILD_CHANNEL=custom
ARG COMMIT_SHA=local
ENV BUILD_CHANNEL=$BUILD_CHANNEL
ENV COMMIT_SHA=$COMMIT_SHA
RUN apt-get update \
  && apt-get install -y --no-install-recommends gosu python3 tzdata \
  && rm -rf /var/lib/apt/lists/*
# The runtime image never invokes a package manager (CMD runs node directly) —
# the npm, corepack and yarn CLIs bundled by the base image just sit there
# dragging in CVEs against their own dependencies (brace-expansion, tar,
# sigstore, etc). Drop them; the Yarn directory includes its version.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v* \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
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
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||9303)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server/server/index.js"]
