#!/usr/bin/env python3
"""Repair DATA_DIR ownership without following mutable path components."""

import os
import pwd
import sys


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
    except PermissionError:
        print(
            f"warning: unable to repair ownership for {name!r}",
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
            except OSError:
                entries = []

            child_names = []
            for entry in entries:
                repair_entry(entry.name, current_fd, node_uid, node_gid)
                if entry.is_dir(follow_symlinks=False):
                    child_names.append(entry.name)
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
        except (FileNotFoundError, NotADirectoryError, PermissionError):
            continue
        stack.append((child_fd, True, None, 0))


def repair(data_dir: str) -> None:
    node = pwd.getpwnam("node")
    node_uid = node.pw_uid
    node_gid = node.pw_gid
    root_fd = os.open(
        data_dir,
        os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
    )
    try:
        root = os.fstat(root_fd)
        if root.st_uid != node_uid or root.st_gid != node_gid:
            os.fchown(root_fd, node_uid, node_gid)
        repair_tree(root_fd, node_uid, node_gid)
    finally:
        os.close(root_fd)


if __name__ == "__main__":
    repair(sys.argv[1])
