FROM node:22-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine

RUN apk add --no-cache tzdata su-exec

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY docker-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_ENV=production
ENV PORT=9303
ENV DATA_DIR=/config
ARG BUILD_CHANNEL=develop
ARG COMMIT_SHA=local
ENV BUILD_CHANNEL=${BUILD_CHANNEL}
ENV COMMIT_SHA=${COMMIT_SHA}

EXPOSE 9303

# Container starts as root so the entrypoint can fix DATA_DIR ownership on a
# fresh bind mount, then it drops to the unprivileged "node" user (UID/GID 1000)
# before running the app — the app process itself never runs as root.
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/server/server/index.js"]
