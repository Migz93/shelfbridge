FROM node:22-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine

RUN apk add --no-cache tzdata

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
ENV PORT=9303
ENV DATA_DIR=/config
ARG BUILD_CHANNEL=develop
ARG COMMIT_SHA=local
ENV BUILD_CHANNEL=${BUILD_CHANNEL}
ENV COMMIT_SHA=${COMMIT_SHA}

EXPOSE 9303

CMD ["node", "dist/server/server/index.js"]
