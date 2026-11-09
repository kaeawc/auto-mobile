#!/usr/bin/env bash

# Single source of truth for the shfmt pin and its enforcement helpers.
# Source this from every installer or write path that needs the formatter.

SHFMT_VERSION="3.10.0"

# SHA-256 of each shfmt_v${SHFMT_VERSION}_<os>_<arch> release binary, from the
# release's sha256sums.txt. install_shfmt.sh verifies the binary after every
# cache restore and every download (#17624); bump these with the version.
shfmt_release_sha256() {
  case "$1" in
    darwin_amd64) echo "ef8d970b3f695a7e8e7d40730eedd2d935ab9599f78a365f319c515bc59d4c83" ;;
    darwin_arm64) echo "86030533a823c0a7cd92dee0f74094e5b901c3277b43def6337d5e19e56fe553" ;;
    linux_386) echo "a49ee3616afd262796e6791711ba62759d424cc85808390a5ac516af8001aa72" ;;
    linux_amd64) echo "1f57a384d59542f8fac5f503da1f3ea44242f46dff969569e80b524d64b71dbc" ;;
    linux_arm) echo "493c612d8f07ad60b3030bd84d7870cca2dc87e0fb06d2fdd93b2264460668db" ;;
    linux_arm64) echo "9d23013d56640e228732fd2a04a9ede0ab46bc2d764bf22a4a35fb1b14d707a8" ;;
    windows_386) echo "695d43b600103d8e8beb7460764f43da1d679576e67130012507a38238ef7dbd" ;;
    windows_amd64) echo "6e4c6acd38de7b4b1ba8f8082b9e688df8c9b861d3f8b2e7bb1b7270201a3587" ;;
    *) return 1 ;;
  esac
}

installed_shfmt_version() {
  if ! command -v shfmt >/dev/null 2>&1; then
    return 0
  fi
  shfmt --version 2>/dev/null | awk '{ for (i = 1; i <= NF; i++) if ($i ~ /^[vV]?[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$/) { sub(/^[vV]/, "", $i); print $i; exit } }'
}

is_pinned_shfmt_version() {
  [[ "$(installed_shfmt_version)" == "$SHFMT_VERSION" ]]
}

require_pinned_shfmt_version() {
  local found
  found="$(installed_shfmt_version)"
  if [[ "$found" == "$SHFMT_VERSION" ]]; then
    return 0
  fi

  echo -e "${RED:-}shfmt version mismatch: found '${found:-none}', this repo pins '${SHFMT_VERSION}'.${NC:-}" >&2
  echo -e "${RED:-}A different shfmt version can rewrite committed shell scripts differently, so refusing to apply formatting.${NC:-}" >&2
  echo -e "${RED:-}Install the pinned version: bash scripts/shellcheck/install_shfmt.sh${NC:-}" >&2
  return 1
}
