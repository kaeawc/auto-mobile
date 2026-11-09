#!/usr/bin/env bash

# Single source of truth for the hadolint pin used by install_hadolint.sh and
# scripts/docker/validate_dockerfile.sh. Bumping the version or a checksum here
# starts a fresh tool-cache entry.

# shellcheck disable=SC2034 # read by the installers and bats tests that source this file
HADOLINT_VERSION="2.12.0"

# SHA-256 of each hadolint-<OS>-<arch> release asset either installer can
# request, from the release's per-asset .sha256 files. hadolint ships no
# Darwin-arm64 build, so Apple Silicon uses Darwin-x86_64 under Rosetta 2.
# Both installers verify the binary after every cache restore and every
# download (#17641); bump these with the version. Prints nothing for an asset
# without a pin, so callers under `set -e` can test the result instead of
# calling this in a condition.
hadolint_release_sha256() {
  case "$1" in
    hadolint-Linux-x86_64) echo "56de6d5e5ec427e17b74fa48d51271c7fc0d61244bf5c90e828aab8362d55010" ;;
    hadolint-Linux-arm64) echo "5798551bf19f33951881f15eb238f90aef023f11e7ec7e9f4c37961cb87c5df6" ;;
    hadolint-Darwin-x86_64) echo "2a5b7afcab91645c39a7cebefcd835b865f7488e69be24567f433dfc3d41cd27" ;;
    hadolint-Windows-x86_64.exe) echo "ed89a156290e15452276b2b4c84efa688a5183d3b578bfaec7cfdf986f0632a8" ;;
    *) ;;
  esac
}

# hadolint_release_url <asset-name>
hadolint_release_url() {
  printf 'https://github.com/hadolint/hadolint/releases/download/v%s/%s\n' "$HADOLINT_VERSION" "$1"
}
