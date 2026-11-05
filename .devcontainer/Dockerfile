FROM mcr.microsoft.com/devcontainers/javascript-node:22

USER root
ARG PLAYWRIGHT_VERSION
RUN npm_config_cache=/tmp/playwright-npm npx --yes "playwright@${PLAYWRIGHT_VERSION}" install-deps chromium \
    && rm -rf /tmp/playwright-npm /var/lib/apt/lists/*
