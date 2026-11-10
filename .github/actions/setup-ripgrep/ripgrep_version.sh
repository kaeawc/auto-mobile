#!/usr/bin/env bash

# Single source of truth for the ripgrep pin used by the setup-ripgrep action.
# The action's tool cache is keyed on this file, so bumping the version or a
# checksum here starts a fresh cache entry.

# shellcheck disable=SC2034 # read by install-ripgrep.sh and the bats tests, which source this file
RIPGREP_VERSION="15.1.0"

# SHA-256 of each ripgrep-${RIPGREP_VERSION}-<target> release asset, from the
# release's per-asset .sha256 files. install-ripgrep.sh verifies the archive
# after every cache restore and every download (#17624); bump these with the
# version.
ripgrep_release_sha256() {
  case "$1" in
    x86_64-unknown-linux-musl) echo "1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599" ;;
    aarch64-unknown-linux-gnu) echo "2b661c6ef508e902f388e9098d9c4c5aca72c87b55922d94abdba830b4dc885e" ;;
    x86_64-apple-darwin) echo "64811cb24e77cac3057d6c40b63ac9becf9082eedd54ca411b475b755d334882" ;;
    aarch64-apple-darwin) echo "378e973289176ca0c6054054ee7f631a065874a352bf43f0fa60ef079b6ba715" ;;
    x86_64-pc-windows-msvc) echo "124510b94b6baa3380d051fdf4650eaa80a302c876d611e9dba0b2e18d87493a" ;;
    aarch64-pc-windows-msvc) echo "00d931fb5237c9696ca49308818edb76d8eb6fc132761cb2a1bd616b2df02f8e" ;;
    *) return 1 ;;
  esac
}
