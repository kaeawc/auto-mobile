"""Daemon HTTP bearer-token discovery.

``AUTOMOBILE_DAEMON_HTTP_TOKEN`` (client-only override) wins; otherwise the token
file the daemon publishes is read and trimmed. On POSIX the file must be a regular
file, not a symlink, owned by the current uid with mode ``0600``. The token is never
logged or put in an exception message.
"""

from __future__ import annotations

import os
import stat
from collections.abc import Mapping
from typing import Protocol

from .paths import resolve_state_path

HTTP_TOKEN_ENV = "AUTOMOBILE_DAEMON_HTTP_TOKEN"


class TokenProvider(Protocol):
    """Supplies the current daemon HTTP token, or ``None`` when none is published."""

    def read(self) -> str | None: ...


class UnsafeTokenFileError(OSError):
    """The token file failed the ownership, mode or file-type checks."""


def read_token_file(path: str, *, posix: bool | None = None) -> str | None:
    """Read and validate one token file; ``None`` when it does not exist or is blank."""
    is_posix = os.name != "nt" if posix is None else posix
    try:
        if stat.S_ISLNK(os.lstat(path).st_mode):
            raise UnsafeTokenFileError("daemon HTTP token file is a symlink")
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
        fd = os.open(path, flags)
    except FileNotFoundError:
        return None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise UnsafeTokenFileError("daemon HTTP token file is not a regular file")
        if is_posix:
            getuid = getattr(os, "getuid", None)
            if getuid is not None and info.st_uid != getuid():
                raise UnsafeTokenFileError("daemon HTTP token file is not owned by this user")
            if stat.S_IMODE(info.st_mode) != 0o600:
                raise UnsafeTokenFileError("daemon HTTP token file mode is not 0600")
        with os.fdopen(fd, "rb", closefd=True) as handle:
            fd = -1
            token = handle.read().decode("utf-8").strip()
    finally:
        if fd >= 0:
            os.close(fd)
    return token or None


class FileTokenProvider:
    """Re-resolves and re-reads the token on every call, so a daemon restart is picked up."""

    def __init__(self, env: Mapping[str, str], cwd: str | None = None) -> None:
        self._env = env
        self._cwd = cwd

    @property
    def path(self) -> str:
        return resolve_state_path("token", self._env, cwd=self._cwd)

    def read(self) -> str | None:
        override = (self._env.get(HTTP_TOKEN_ENV) or "").strip()
        if override:
            return override
        return read_token_file(self.path)
