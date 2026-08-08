#!/bin/sh
set -e

# Pin PATH to trusted system directories. Everything below runs as root before
# privileges are dropped, so without this an env var set at container launch
# could shadow `id`, `realpath` or `gosu` with a binary from a writable mount.
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

# Assigned on its own line rather than inlined into the `if` below: a command
# substitution's exit status doesn't propagate through `[ ]` to trigger set -e,
# so a failing `id -u` would silently read as "not root" and fall through to
# running the app as root, with no ownership repair and no drop to node.
current_uid="$(id -u)"

if [ "$current_uid" = "0" ]; then
  # DATA_DIR is user-configurable and is about to be walked and chowned as
  # root, so require it to resolve to exactly /config rather than to /config or
  # anything below it. A subpath would put attacker-writable bind mount content
  # in the path components that mkdir -p and the repair helper resolve through,
  # and a component swapped for a symlink between this check and those calls
  # could redirect them outside /config. Pinning to the literal mountpoint
  # removes that resolution step entirely.
  # realpath -m canonicalises without requiring the path to exist yet, catching
  # equivalent forms like "//", "/./" or "/config/.." that a plain string
  # comparison would miss.
  case "$DATA_DIR" in
    /*) ;;
    *) echo "entrypoint: DATA_DIR must be an absolute path, got '$DATA_DIR'" >&2; exit 1 ;;
  esac
  DATA_DIR="$(realpath -m -- "$DATA_DIR")"
  if [ "$DATA_DIR" != "/config" ]; then
    echo "entrypoint: DATA_DIR resolves to '$DATA_DIR', which must be exactly /config" >&2
    exit 1
  fi
  export DATA_DIR
  mkdir -p "$DATA_DIR"

  # /config may be a fresh host bind mount (created root-owned by Docker), or
  # hold files restored or copied in with different ownership. The helper walks
  # it using directory descriptors and no-follow operations at every level, so a
  # directory swapped for a symlink mid-walk cannot redirect a chown outside
  # /config, and it issues a chown only for entries that actually mismatch.
  python3 /ownership-repair.py "$DATA_DIR"

  exec gosu node "$@"
fi

exec "$@"
