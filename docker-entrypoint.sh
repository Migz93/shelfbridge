#!/bin/sh
set -e

# Docker creates a fresh bind-mounted DATA_DIR as root:root before this script
# runs, so the unprivileged "node" user can't write to it yet on first start.
# Fix ownership here (while still root), then drop to "node" for the real process.
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  # Only pay for a recursive chown when the top-level directory isn't already
  # node-owned — DATA_DIR can hold a large image cache, so re-walking it on
  # every restart once ownership is already correct would slow startup for
  # no benefit. A restored/copied-in DATA_DIR whose top level is node-owned
  # but contains stray root-owned files is not handled by this check.
  current_owner="$(stat -c '%u' "$DATA_DIR")"
  node_uid="$(id -u node)"
  if [ "$current_owner" != "$node_uid" ]; then
    chown -R node:node "$DATA_DIR"
  fi
  exec su-exec node "$@"
fi

exec "$@"
