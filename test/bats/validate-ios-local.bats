#!/usr/bin/env bats
#
# Tests for scripts/local/validate-ios.sh
#
# Regression guard for #3637: the Swift build pass/fail must be classified from
# the build's own exit status, not inferred from a `swift build 2>&1 | grep ...`
# pipeline. Under `set -o pipefail` a failing build made that pipeline non-zero
# even when grep matched the error line, so the component was added to NEITHER
# PASSED_BUILDS nor FAILED_BUILDS and the script reported success.
#
# Source-scan assertions (deterministic; a behavioral run depends on
# environment-specific grep/pipefail interactions).

SCRIPT="scripts/local/validate-ios.sh"

@test "Swift build result is not inferred from a 'swift build | grep' pipeline" {
  # The buggy form was: if (cd ... && swift build 2>&1 | grep -E "..."); then
  # Ignore comment lines (the fix documents the old pattern in a comment).
  local hits
  hits="$(grep -nE 'swift build[^|]*\| *grep' "$SCRIPT" | grep -vE '^[0-9]+: *#' || true)"
  [ -z "$hits" ]
}

@test "Swift build pass/fail is classified from an explicit exit status" {
  # The fix captures the build's status in build_ok before classifying.
  grep -q 'build_ok' "$SCRIPT"
}
