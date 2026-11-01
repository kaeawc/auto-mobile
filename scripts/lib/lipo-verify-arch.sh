#!/usr/bin/env bash
# Assert that a Mach-O file contains every listed architecture. Sourcing is inert.
#
# Xcode 27.1 beta's lipo rejects several architectures after one -verify_arch flag
# ("lipo: -verify_arch requires exactly one input file"), while 26.x accepts them. Check one
# architecture per invocation so the result is the same on every toolchain (#15823).

lipo_verify_archs() {
  local binary="$1" arch
  shift
  if [[ $# -eq 0 ]]; then
    echo "lipo_verify_archs: at least one architecture is required" >&2
    return 2
  fi
  for arch in "$@"; do
    lipo "${binary}" -verify_arch "${arch}" || return $?
  done
}
