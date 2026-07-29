#!/bin/sh
set -e

# Docker creates a fresh bind-mounted DATA_DIR as root:root before this script
# runs, so the unprivileged "node" user can't write to it yet on first start.
# Fix ownership here (while still root), then drop to "node" for the real process.
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR"
  exec su-exec node "$@"
fi

exec "$@"
