#!/usr/bin/env bash

# Single source of truth for the lychee pin. install_lychee.sh sources it, and
# CI keys the lychee tool cache on this file, so bumping the version or a
# checksum here starts a fresh cache entry.

# shellcheck disable=SC2034 # read by install_lychee.sh and the bats tests, which source this file
LYCHEE_VERSION="0.22.0"

# SHA-256 of each lychee-v${LYCHEE_VERSION} release asset the installer can
# request. lychee publishes no checksum files, so these were computed from the
# release assets themselves. install_lychee.sh verifies the asset after every
# cache restore and every download (#17641); bump these with the version.
lychee_release_sha256() {
  case "$1" in
    lychee-arm64-macos.tar.gz) echo "b80fe8185d9087e245c10549e47b60f6dabeac6e6a0fa5a64f37677618f43bca" ;;
    lychee-x86_64-unknown-linux-gnu.tar.gz) echo "d004215a789db155779d3263e6e18ad424879b18eeddb00745efb8d9b2bd8891" ;;
    lychee-aarch64-unknown-linux-gnu.tar.gz) echo "29901e5df983fe2ff961ee9660c4ef3b4a9eae85d4776d0dc89581332e82d6db" ;;
    lychee-armv7-unknown-linux-gnueabihf.tar.gz) echo "2ea6b90e003392a49b8b9509bbad61b0d3e1b2d44d57714b8e1bc8cb042ba962" ;;
    lychee-x86_64-windows.exe) echo "3f416d1243e7b65e23547e5995b0e3c3388c1bc6451d36764acfd3ee0e5c8968" ;;
    *) return 1 ;;
  esac
}
