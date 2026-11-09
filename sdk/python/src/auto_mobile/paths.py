"""Daemon state-file paths.

A port of ``resolveDaemonStatePath`` from the daemon: an explicit
``AUTOMOBILE_DAEMON_*_PATH`` override (resolved against the daemon launch directory)
wins, otherwise ``/tmp/auto-mobile-daemon-<uid><suffix>.<ext>``, where the suffix
isolates a daemon started with ``AUTOMOBILE_AUX_SOCKET_DIR``. On Windows the token
lives under ``%LOCALAPPDATA%\\auto-mobile``. Tested against the shared vectors in
``test/fixtures/daemon-isolation-paths.json`` that every other client port uses.
"""

from __future__ import annotations

import hashlib
import ntpath
import os
import posixpath
import tempfile
from collections.abc import Mapping
from typing import Literal

StateFile = Literal["sock", "pid", "lock", "token"]

AUX_SOCKET_DIR_ENV = "AUTOMOBILE_AUX_SOCKET_DIR"
DAEMON_LAUNCH_CWD_ENV = "AUTOMOBILE_DAEMON_LAUNCH_CWD"

_OVERRIDES: dict[str, tuple[str, ...]] = {
    "sock": ("AUTOMOBILE_DAEMON_SOCKET_PATH", "AUTO_MOBILE_DAEMON_SOCKET_PATH"),
    "pid": ("AUTOMOBILE_DAEMON_PID_FILE_PATH", "AUTO_MOBILE_DAEMON_PID_FILE_PATH"),
    "lock": ("AUTOMOBILE_DAEMON_LOCK_FILE_PATH", "AUTO_MOBILE_DAEMON_LOCK_FILE_PATH"),
    "token": ("AUTOMOBILE_DAEMON_TOKEN_FILE_PATH",),
}

_ISOLATION_HASH_HEX_CHARS = 10


def default_user_id(env: Mapping[str, str], windows: bool) -> str:
    """The id the daemon names its files after: the uid on POSIX, the username on Windows."""
    if windows:
        return env.get("USERNAME") or "default"
    getuid = getattr(os, "getuid", None)
    return str(getuid()) if getuid is not None else "default"


def _resolve_from_launch_cwd(path: str, env: Mapping[str, str], cwd: str, windows: bool) -> str:
    """Absolute paths stay verbatim; relative ones resolve (normalized) against the launch cwd."""
    flavor = ntpath if windows else posixpath
    if flavor.isabs(path):
        return path
    launch_cwd = (env.get(DAEMON_LAUNCH_CWD_ENV) or "").strip()
    base = launch_cwd if launch_cwd and flavor.isabs(launch_cwd) else cwd
    joined: str = flavor.normpath(flavor.join(base, path))
    return joined


def isolation_suffix(env: Mapping[str, str], cwd: str, windows: bool = False) -> str:
    """``-<first 10 hex of sha256(resolved aux dir)>``, or ``""`` without an aux dir."""
    aux_dir = (env.get(AUX_SOCKET_DIR_ENV) or "").strip()
    if not aux_dir:
        return ""
    resolved = _resolve_from_launch_cwd(aux_dir, env, cwd, windows)
    digest = hashlib.sha256(resolved.encode("utf-8")).hexdigest()
    return f"-{digest[:_ISOLATION_HASH_HEX_CHARS]}"


def resolve_state_path(
    file: StateFile,
    env: Mapping[str, str],
    *,
    cwd: str | None = None,
    user_id: str | None = None,
    windows: bool | None = None,
) -> str:
    """The effective path of one daemon state file for the given launch environment."""
    is_windows = os.name == "nt" if windows is None else windows
    base_cwd = cwd if cwd is not None else os.getcwd()
    # The first variable that is set wins, even when blank, as in the daemon.
    raw = next((env[name] for name in _OVERRIDES[file] if name in env), None)
    override = (raw or "").strip()
    if override:
        return _resolve_from_launch_cwd(override, env, base_cwd, is_windows)
    suffix = isolation_suffix(env, base_cwd, is_windows)
    if file == "token" and is_windows:
        local_app_data = env.get("LOCALAPPDATA") or tempfile.gettempdir()
        return ntpath.join(local_app_data, "auto-mobile", f"daemon{suffix}.token")
    uid = user_id if user_id is not None else default_user_id(env, is_windows)
    return f"/tmp/auto-mobile-daemon-{uid}{suffix}.{file}"
