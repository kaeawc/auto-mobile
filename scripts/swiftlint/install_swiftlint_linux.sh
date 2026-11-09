#!/usr/bin/env bash
#
# Install the pinned Linux SwiftLint binary from the official SwiftLint GitHub
# release, verifying the committed SHA-256 before anything is extracted (#17581).
#
# Usage: install_swiftlint_linux.sh
#   SWIFTLINT_INSTALL_DIR  install directory (default: $HOME/.local/bin)
#
# The release ships only an x86_64 Linux binary for the pinned version, so any
# other architecture fails instead of running a mismatched SwiftLint.

set -euo pipefail

SWIFTLINT_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=scripts/swiftlint/swiftlint_linux_pin.sh
source "${SWIFTLINT_SCRIPT_DIR}/swiftlint_linux_pin.sh"

SWIFTLINT_RELEASE_BASE_URL="https://github.com/realm/SwiftLint/releases/download"

# sha256sum is GNU coreutils; shasum covers hosts without it.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

swiftlint_linux_download_url() {
  echo "${SWIFTLINT_RELEASE_BASE_URL}/${SWIFTLINT_LINUX_VERSION}/${SWIFTLINT_LINUX_ASSET}"
}

install_swiftlint_linux() {
  local install_dir="${SWIFTLINT_INSTALL_DIR:-$HOME/.local/bin}"
  local arch temp_dir archive url actual_sha256
  arch="$(uname -m)"
  if [[ "$arch" != "x86_64" ]]; then
    echo "SwiftLint ${SWIFTLINT_LINUX_VERSION} ships a Linux binary for x86_64 only; this host is ${arch}." >&2
    return 1
  fi

  if ! bash "${SWIFTLINT_SCRIPT_DIR}/check_swiftlint_pin_consistency.sh" "${SWIFTLINT_SCRIPT_DIR}"; then
    return 1
  fi

  temp_dir="$(mktemp -d)"
  # shellcheck disable=SC2064 # expand now: temp_dir is local to this function.
  trap "rm -rf -- '${temp_dir}'" RETURN
  archive="${temp_dir}/${SWIFTLINT_LINUX_ASSET}"
  url="$(swiftlint_linux_download_url)"

  echo "Downloading ${url}"
  if ! curl -fsSL --retry 3 -o "$archive" "$url"; then
    echo "Failed to download SwiftLint from ${url}." >&2
    return 1
  fi

  actual_sha256="$(sha256_of "$archive")"
  if [[ "$actual_sha256" != "$SWIFTLINT_LINUX_SHA256" ]]; then
    echo "SwiftLint download checksum mismatch for ${SWIFTLINT_LINUX_ASSET}: expected ${SWIFTLINT_LINUX_SHA256}, got ${actual_sha256}." >&2
    echo "Refusing to install an unverified SwiftLint binary." >&2
    return 1
  fi
  echo "Verified SHA-256 ${actual_sha256} for ${SWIFTLINT_LINUX_ASSET}."

  if ! unzip -q -o "$archive" swiftlint -d "${temp_dir}/extract"; then
    echo "Failed to extract swiftlint from ${SWIFTLINT_LINUX_ASSET}." >&2
    return 1
  fi

  mkdir -p "$install_dir"
  if ! install -m 0755 "${temp_dir}/extract/swiftlint" "${install_dir}/swiftlint"; then
    echo "Failed to install swiftlint into ${install_dir}." >&2
    return 1
  fi
  echo "Installed SwiftLint ${SWIFTLINT_LINUX_VERSION} to ${install_dir}/swiftlint"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  install_swiftlint_linux
fi
