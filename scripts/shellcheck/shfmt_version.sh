#!/usr/bin/env bash

# Single source of truth for the shfmt pin and its enforcement helpers.
# Source this from every installer or write path that needs the formatter.

SHFMT_VERSION="3.10.0"

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
