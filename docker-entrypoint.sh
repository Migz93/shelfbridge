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

  # The repair can be refused (for example on NFS with root_squash), so check
  # the result as node rather than let the app fail later on a bare EACCES.
  # Creating files needs search (x) as well as write permission, which a
  # well-meant `chmod 666` on the host leaves out.
  if ! gosu node sh -c 'test -w "$1" && test -x "$1"' sh "$DATA_DIR"; then
    echo "entrypoint: $DATA_DIR isn't writable by the node user (uid $(id -u node)). Change the bind mount's ownership or permissions on the host so that uid has write and execute (search) permission on it." >&2
    exit 1
  fi

  exec gosu node "$@"
fi

exec "$@"
