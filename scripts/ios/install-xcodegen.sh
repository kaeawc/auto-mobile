#!/bin/bash
#
# Installs XcodeGen at the pinned version (scripts/ios/xcodegen_version.sh).
#
# Deliberately does NOT use Homebrew. `brew install xcodegen` resolves against
# whatever formula index the machine happens to hold -- on GitHub runners that
# was a baked 2.45.4 while contributors had 2.46.0, and the two order the
# PBXProject `targets` array differently, so every PR failed the drift check
# with an ordering-only diff (issue #3975). Homebrew also cannot install an
# arbitrary older version, so pinning through it would hard-fail all iOS CI
# whenever the formula moves.
#
# The vendor's release archive carries the version in its URL, so it is
# version-exact by construction, and at ~4 MB it is far cheaper than the ~52 MB
# index refresh `brew update` needs to defeat a stale index.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ios/xcodegen_version.sh
source "${SCRIPT_DIR}/xcodegen_version.sh"

current="$(installed_xcodegen_version)"

if [[ "${current}" == "${XCODEGEN_VERSION}" ]]; then
    echo "XcodeGen ${XCODEGEN_VERSION} already installed."
    exit 0
fi

# /usr/local is on PATH everywhere on macOS and writable on GitHub runners.
# Fall back to ~/.local for a laptop where it is not.
PREFIX="${XCODEGEN_PREFIX:-/usr/local}"
if ! mkdir -p "${PREFIX}/bin" 2>/dev/null || [[ ! -w "${PREFIX}/bin" ]]; then
    PREFIX="${HOME}/.local"
    mkdir -p "${PREFIX}/bin"
fi

echo "Installing XcodeGen ${XCODEGEN_VERSION} (found '${current:-none}') into ${PREFIX}..."

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT

curl -fsSL -o "${WORK_DIR}/xcodegen.zip" "${XCODEGEN_RELEASE_URL}"
unzip -qq -o "${WORK_DIR}/xcodegen.zip" -d "${WORK_DIR}"

# The archive expands to xcodegen/{bin,share}. The binary resolves its bundled
# templates relative to itself, so share/ must land alongside bin/.
mkdir -p "${PREFIX}/share"
cp "${WORK_DIR}/xcodegen/bin/xcodegen" "${PREFIX}/bin/xcodegen"
rm -rf "${PREFIX}/share/xcodegen"
cp -R "${WORK_DIR}/xcodegen/share/xcodegen" "${PREFIX}/share/xcodegen"
chmod +x "${PREFIX}/bin/xcodegen"

export PATH="${PREFIX}/bin:${PATH}"
# Later CI steps run in fresh shells, so PATH must persist beyond this process.
if [[ -n "${GITHUB_PATH:-}" ]]; then
    echo "${PREFIX}/bin" >> "${GITHUB_PATH}"
fi
# Bash caches resolved command paths; drop a stale entry for a previous xcodegen.
hash -r 2>/dev/null || true

require_pinned_xcodegen_version

echo "XcodeGen ${XCODEGEN_VERSION} installed to ${PREFIX}/bin/xcodegen."
if [[ ":${PATH}:" != *":${PREFIX}/bin:"* ]]; then
    echo "warning: ${PREFIX}/bin is not on your PATH; add it to use xcodegen." >&2
fi
