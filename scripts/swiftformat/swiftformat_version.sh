#!/usr/bin/env bash

# Single source of truth for the SwiftFormat pin and its enforcement helpers.
# Source this from every installer or write path that needs the formatter.

SWIFTFORMAT_VERSION="0.54.6"

installed_swiftformat_version() {
  if ! command -v swiftformat >/dev/null 2>&1; then
    return 0
  fi
  swiftformat --version 2>/dev/null | awk '{ for (i = 1; i <= NF; i++) if ($i ~ /^[vV]?[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$/) { sub(/^[vV]/, "", $i); print $i; exit } }'
}

is_pinned_swiftformat_version() {
  [[ "$(installed_swiftformat_version)" == "$SWIFTFORMAT_VERSION" ]]
}

require_pinned_swiftformat_version() {
  local found
  found="$(installed_swiftformat_version)"
  if [[ "$found" == "$SWIFTFORMAT_VERSION" ]]; then
    return 0
  fi

  echo -e "${RED:-}SwiftFormat version mismatch: found '${found:-none}', this repo pins '${SWIFTFORMAT_VERSION}'.${NC:-}" >&2
  echo -e "${RED:-}A different SwiftFormat version can rewrite committed Swift sources differently, so refusing to apply formatting.${NC:-}" >&2
  echo -e "${RED:-}Install the pinned version: bash scripts/swiftformat/install_swiftformat.sh${NC:-}" >&2
  return 1
}
