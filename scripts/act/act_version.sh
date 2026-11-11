#!/usr/bin/env bash

# Single source of truth for the act pin. install_act.sh sources it, so bumping
# the version or a checksum here starts a fresh tool-cache entry.

# shellcheck disable=SC2034 # read by install_act.sh and the bats tests, which source this file
ACT_VERSION="0.2.68"

# SHA-256 of each act v${ACT_VERSION} Linux release asset the installer can
# request, from the release's published checksums.txt. install_act.sh verifies
# the archive after every cache restore and every download (#17641); bump these
# with the version.
act_release_sha256() {
  case "$1" in
    act_Linux_x86_64.tar.gz) echo "b6898e98d2e22fb1f2dbcba946f686c5426fda42345a2d1d8d523d1a523cdf79" ;;
    act_Linux_arm64.tar.gz) echo "9979a1821f1efc9cfcb488d2d9f340d672fd1708dcfaac3991c965ce9fd7882f" ;;
    *) return 1 ;;
  esac
}
