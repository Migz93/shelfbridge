FROM mcr.microsoft.com/devcontainers/javascript-node:22

USER root
RUN --mount=type=bind,source=package-lock.json,target=/tmp/devcontainer-package-lock.json \
    playwright_version="$(node -p 'require("/tmp/devcontainer-package-lock.json").packages["node_modules/playwright"].version')" \
    && npm_config_cache=/tmp/playwright-npm npx --yes "playwright@${playwright_version}" install-deps chromium \
    && rm -rf /tmp/playwright-npm /var/lib/apt/lists/*
