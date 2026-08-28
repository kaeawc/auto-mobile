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
# shellcheck source=scripts/ios/xcodegen_version.sh disable=SC1091
source "${SCRIPT_DIR}/xcodegen_version.sh"

current="$(installed_xcodegen_version)"

# Keyed on the binary version AND its templates: a previous run interrupted
# between the two copies leaves a correctly-versioned binary with no share/
# directory, and a version-only check would report "already installed" forever.
existing_bin="$(command -v xcodegen || true)"
if [[ "${current}" == "${XCODEGEN_VERSION}" && -n "${existing_bin}" ]] \
   && [[ -d "$(dirname "$(dirname "${existing_bin}")")/share/xcodegen" ]]; then
    echo "XcodeGen ${XCODEGEN_VERSION} already installed."
    exit 0
fi

# /usr/local is on PATH everywhere on macOS and writable on GitHub runners.
# Fall back to ~/.local for a laptop where it is not.
PREFIX="${XCODEGEN_PREFIX:-/usr/local}"
if ! mkdir -p "${PREFIX}/bin" "${PREFIX}/share" 2>/dev/null \
   || [[ ! -w "${PREFIX}/bin" || ! -w "${PREFIX}/share" ]]; then
    PREFIX="${HOME}/.local"
    mkdir -p "${PREFIX}/bin" "${PREFIX}/share"
fi

echo "Installing XcodeGen ${XCODEGEN_VERSION} (found '${current:-none}') into ${PREFIX}..."

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}" "${PREFIX}/share/.xcodegen-staged.$$" "${PREFIX}/bin/.xcodegen-staged.$$"' EXIT

curl -fsSL -o "${WORK_DIR}/xcodegen.zip" "${XCODEGEN_RELEASE_URL}"

# Release assets are mutable, so verify the bytes rather than trusting the tag.
if command -v shasum >/dev/null 2>&1; then
    actual_sha="$(shasum -a 256 "${WORK_DIR}/xcodegen.zip" | awk '{print $1}')"
else
    actual_sha="$(sha256sum "${WORK_DIR}/xcodegen.zip" | awk '{print $1}')"
fi
if [[ "${actual_sha}" != "${XCODEGEN_RELEASE_SHA256}" ]]; then
    echo "Error: XcodeGen archive digest mismatch." >&2
    echo "  expected ${XCODEGEN_RELEASE_SHA256}" >&2
    echo "  actual   ${actual_sha}" >&2
    echo "The release asset changed under tag ${XCODEGEN_VERSION}. Update" >&2
    echo "XCODEGEN_RELEASE_SHA256 in scripts/ios/xcodegen_version.sh and" >&2
    echo "regenerate the committed project files in the same PR." >&2
    exit 1
fi

unzip -qq -o "${WORK_DIR}/xcodegen.zip" -d "${WORK_DIR}"

# The archive expands to xcodegen/{bin,share}. The binary resolves its bundled
# templates relative to itself, so share/ must land alongside bin/.
mkdir -p "${PREFIX}/share"
chmod +x "${WORK_DIR}/xcodegen/bin/xcodegen"

# Stage both payloads into the destination filesystem, then move them into
# place. `cp -R` directly onto a live share/xcodegen races another installer
# (observed: "File exists" failures and nested share/xcodegen/xcodegen/ when
# several run concurrently against one prefix, which parallel agents sharing
# $HOME do). mv within a filesystem is atomic enough to avoid a half-copied tree.
staged_share="${PREFIX}/share/.xcodegen-staged.$$"
rm -rf "${staged_share}"
cp -R "${WORK_DIR}/xcodegen/share/xcodegen" "${staged_share}"
rm -rf "${PREFIX}/share/xcodegen"
mv "${staged_share}" "${PREFIX}/share/xcodegen"

staged_bin="${PREFIX}/bin/.xcodegen-staged.$$"
cp "${WORK_DIR}/xcodegen/bin/xcodegen" "${staged_bin}"
mv "${staged_bin}" "${PREFIX}/bin/xcodegen"

export PATH="${PREFIX}/bin:${PATH}"
# Later CI steps run in fresh shells, so PATH must persist beyond this process.
if [[ -n "${GITHUB_PATH:-}" ]]; then
    echo "${PREFIX}/bin" >> "${GITHUB_PATH}"
fi
# Bash caches resolved command paths; drop a stale entry for a previous xcodegen.
hash -r 2>/dev/null || true

require_pinned_xcodegen_version

echo "XcodeGen ${XCODEGEN_VERSION} installed to ${PREFIX}/bin/xcodegen."
# Note: this process exported PREFIX/bin onto PATH above, so testing $PATH here
# would always pass and tell the user nothing. Warn based on the prefix instead.
if [[ "${PREFIX}" == "${HOME}/.local" ]]; then
    echo "note: installed to ${PREFIX}/bin (…/usr/local was not writable)." >&2
    echo "Add ${PREFIX}/bin to your PATH to run xcodegen directly." >&2
fi
