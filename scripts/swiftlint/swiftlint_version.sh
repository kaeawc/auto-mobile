#!/usr/bin/env bash

# Single source of truth for the SwiftLint pin and its enforcement helpers.
# Source this from every installer or write path that needs the formatter.

SWIFTLINT_VERSION="0.57.0"

installed_swiftlint_version() {
  if ! command -v swiftlint >/dev/null 2>&1; then
    return 0
  fi
  swiftlint version 2>/dev/null | awk '{ for (i = 1; i <= NF; i++) if ($i ~ /^[vV]?[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$/) { sub(/^[vV]/, "", $i); print $i; exit } }'
}

is_pinned_swiftlint_version() {
  [[ "$(installed_swiftlint_version)" == "$SWIFTLINT_VERSION" ]]
}

require_pinned_swiftlint_version() {
  local found
  found="$(installed_swiftlint_version)"
  if [[ "$found" == "$SWIFTLINT_VERSION" ]]; then
    return 0
  fi

  echo -e "${RED:-}SwiftLint version mismatch: found '${found:-none}', this repo pins '${SWIFTLINT_VERSION}'.${NC:-}" >&2
  echo -e "${RED:-}A different SwiftLint version can rewrite committed Swift sources differently, so refusing to apply fixes.${NC:-}" >&2
  echo -e "${RED:-}Install the pinned version: bash scripts/swiftlint/install_swiftlint.sh${NC:-}" >&2
  return 1
}
