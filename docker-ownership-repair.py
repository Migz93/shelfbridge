#!/usr/bin/env python3
"""Repair DATA_DIR ownership without following mutable path components."""

import errno
import os
import pwd
import sys

# Errors expected while walking a tree whose contents can change underneath
# us: an entry removed or replaced mid-walk (ELOOP is a directory swapped for
# a symlink), or one root isn't allowed to open. Anything else is unexpected
# and gets a warning, but the walk still carries on.
EXPECTED_WALK_ERRORS = {
    errno.ENOENT,
    errno.ENOTDIR,
    errno.ELOOP,
    errno.EACCES,
    errno.EPERM,
}


def warn_unexpected(error: OSError, what: str) -> None:
    if error.errno not in EXPECTED_WALK_ERRORS:
        print(f"warning: unable to read {what}: {error.strerror}", file=sys.stderr)


def repair_entry(name: str, directory_fd: int, node_uid: int, node_gid: int) -> None:
    try:
        entry = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if entry.st_uid != node_uid or entry.st_gid != node_gid:
            os.chown(
                name,
                node_uid,
                node_gid,
                dir_fd=directory_fd,
                follow_symlinks=False,
            )
    except FileNotFoundError:
        return
    except OSError as error:
        print(
            f"warning: unable to repair ownership for {name!r}: {error.strerror}",
            file=sys.stderr,
        )


def repair_tree(directory_fd: int, node_uid: int, node_gid: int) -> None:
    # Keep traversal depth independent of Python's recursion limit. Directory
    # descriptors are opened lazily one level at a time and closed after
    # processing, so descriptor usage is bounded by traversal depth rather
    # than directory breadth.
    stack = [(directory_fd, False, None, 0)]
    while stack:
        current_fd, close_after, child_names, child_index = stack[-1]

        if child_names is None:
            try:
                entries = list(os.scandir(current_fd))
            except OSError as error:
                warn_unexpected(error, "a directory listing")
                entries = []

            child_names = []
            for entry in entries:
                repair_entry(entry.name, current_fd, node_uid, node_gid)
                # is_dir() needs an lstat on filesystems that don't report the
                # entry type in the listing, and that can be refused.
                try:
                    if entry.is_dir(follow_symlinks=False):
                        child_names.append(entry.name)
                except OSError as error:
                    print(
                        f"warning: unable to inspect {entry.name!r}: {error.strerror}",
                        file=sys.stderr,
                    )
            stack[-1] = (current_fd, close_after, child_names, 0)
            continue

        if child_index == len(child_names):
            stack.pop()
            if close_after:
                os.close(current_fd)
            continue

        child_name = child_names[child_index]
        stack[-1] = (current_fd, close_after, child_names, child_index + 1)
        try:
            child_fd = os.open(
                child_name,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                dir_fd=current_fd,
            )
        except OSError as error:
            warn_unexpected(error, repr(child_name))
            continue
        stack.append((child_fd, True, None, 0))


def repair(data_dir: str) -> None:
    node = pwd.getpwnam("node")
    node_uid = node.pw_uid
    node_gid = node.pw_gid
    try:
        root_fd = os.open(
            data_dir,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
        )
    except OSError as error:
        # On NFS with root_squash, root can be denied a directory node can
        # still use. Skip the repair and leave it to the entrypoint's check
        # as node.
        print(
            f"warning: unable to open {data_dir!r} to repair ownership: {error.strerror}",
            file=sys.stderr,
        )
        return
    try:
        root = os.fstat(root_fd)
        if root.st_uid != node_uid or root.st_gid != node_gid:
            try:
                os.fchown(root_fd, node_uid, node_gid)
            except OSError as error:
                # Root can be denied on some mounts, such as NFS with
                # root_squash or a read-only bind mount. Carry on: the
                # entrypoint then checks node can write to the directory.
                print(
                    f"warning: unable to repair ownership for {data_dir!r}: {error.strerror}",
                    file=sys.stderr,
                )
        repair_tree(root_fd, node_uid, node_gid)
    finally:
        os.close(root_fd)


if __name__ == "__main__":
    repair(sys.argv[1])
