#!/bin/sh
set -e

# Docker creates a fresh bind-mounted DATA_DIR as root:root before this script
# runs, so the unprivileged "node" user can't write to it yet on first start.
# Fix ownership here (while still root), then drop to "node" for the real process.
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  # Only chown entries that actually need it, rather than unconditionally
  # chown -R'ing the whole tree — DATA_DIR can hold a large image cache, and
  # most restarts touch nothing here. This still walks the tree (so nested
  # root-owned files from a restore/manual copy are caught, not just the
  # top-level directory), but issues a chown syscall only for mismatches.
  # -h is required: without it, chown follows a symlink to its target, so a
  # symlink under DATA_DIR pointing outside it would let this root-run repair
  # change ownership of an arbitrary file elsewhere on the filesystem.
  find "$DATA_DIR" \( ! -user node -o ! -group node \) -exec chown -h node:node {} +
  exec su-exec node "$@"
fi

exec "$@"
