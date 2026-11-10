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

  if [[ -z "$found" ]] && command -v swiftlint >/dev/null 2>&1; then
    # An installed binary that reports no version usually failed to start (for
    # example a missing shared library, #17777); show why instead of 'none'.
    local version_output version_status=0
    version_output="$(swiftlint version 2>&1)" || version_status=$?
    echo -e "${RED:-}SwiftLint at $(command -v swiftlint) reported no version (exit ${version_status}). Its output:${NC:-}" >&2
    echo "${version_output:-<no output>}" >&2
  fi
  echo -e "${RED:-}SwiftLint version mismatch: found '${found:-none}', this repo pins '${SWIFTLINT_VERSION}'.${NC:-}" >&2
  echo -e "${RED:-}A different SwiftLint version can rewrite committed Swift sources differently, so refusing to apply fixes.${NC:-}" >&2
  echo -e "${RED:-}Install the pinned version: bash scripts/swiftlint/install_swiftlint.sh${NC:-}" >&2
  return 1
}

# On Linux, SwiftLint loads libsourcekitdInProc.so from a Swift toolchain. Point
# LINUX_SOURCEKIT_LIB_PATH at the toolchain whose `swift` is on PATH, unless the
# caller already set it, and fail clearly when no toolchain provides the library.
# A no-op on macOS, where SwiftLint uses Xcode's sourcekitd.
export_linux_sourcekit_lib_path() {
  [[ "$(uname -s)" == "Linux" ]] || return 0
  if [[ -n "${LINUX_SOURCEKIT_LIB_PATH:-}" ]]; then
    return 0
  fi
  local swift_bin lib_dir
  swift_bin="$(command -v swift || true)"
  if [[ -n "$swift_bin" ]]; then
    lib_dir="$(cd "$(dirname "$(readlink -f "$swift_bin")")/../lib" 2>/dev/null && pwd)"
    if [[ -n "$lib_dir" && -f "$lib_dir/libsourcekitdInProc.so" ]]; then
      export LINUX_SOURCEKIT_LIB_PATH="$lib_dir"
      return 0
    fi
  fi
  echo -e "${RED:-}SwiftLint on Linux needs libsourcekitdInProc.so from a Swift toolchain: put swift on PATH or set LINUX_SOURCEKIT_LIB_PATH.${NC:-}" >&2
  return 1
}
