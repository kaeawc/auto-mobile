#!/usr/bin/env bash
#
# Install a Darling tree staged by darling-build.sh onto this machine.
# Must run as root (the workflow invokes it with sudo): the extraction
# targets / and the darling launcher must be setuid root.
#
# Usage: sudo darling-install.sh <darling-install.tar.zst>

set -euo pipefail

TARBALL="${1:-}"
if [[ -z "${TARBALL}" || ! -f "${TARBALL}" ]]; then
    echo "Usage: sudo $0 <darling-install.tar.zst>" >&2
    echo "Error: tarball not found: '${TARBALL}'" >&2
    exit 2
fi

if [[ "$(id -u)" -ne 0 ]]; then
    echo "Error: this script must run as root (sudo)." >&2
    exit 2
fi

if ! command -v zstd >/dev/null 2>&1; then
    apt-get install -y --no-install-recommends zstd
fi

echo "Extracting ${TARBALL} to /..."
tar -C / -xpf "${TARBALL}"

# `sudo make install` normally sets this; a DESTDIR-staged tarball cannot
# carry setuid through non-root CI staging, so restore it explicitly. Without
# it every `darling` invocation fails at startup.
if [[ ! -x /usr/local/bin/darling ]]; then
    echo "Error: /usr/local/bin/darling missing after extraction." >&2
    exit 1
fi
chown root:root /usr/local/bin/darling
chmod u+s /usr/local/bin/darling

# Ubuntu 23.10+ restricts unprivileged user namespaces via AppArmor, which
# darlingserver's userspace sandboxing relies on. Best-effort: the knobs do
# not exist on every kernel.
sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 2>/dev/null || true
sysctl -w kernel.unprivileged_userns_clone=1 2>/dev/null || true

echo "Darling installed: $(/usr/local/bin/darling version 2>/dev/null || echo 'version probe failed (may be fine before first prefix init)')"
