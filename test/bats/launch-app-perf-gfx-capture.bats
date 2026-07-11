#!/usr/bin/env bats
#
# Tests for the gfxinfo capture in scripts/launch_app_perf_test.sh
#
# Regression guard for #3647: under `set -euo pipefail`, the assignment
#   gfx_output=$($ADB_CMD shell dumpsys gfxinfo "$PACKAGE_NAME" 2>&1)
# takes the substitution's exit status, so a single non-zero adb call aborted
# the whole run (the function is captured via result=$(...)), and the
# gfx_exit-based retry/continue below was unreachable. The capture must be
# guarded so adb failure does not trip `set -e`.

SCRIPT="scripts/launch_app_perf_test.sh"

code() { grep -vE '^\s*#' "$SCRIPT"; }

@test "gfxinfo capture is guarded by an if so adb failure cannot trip set -e" {
  code | grep -qE 'if +gfx_output=\$\('
}

@test "no bare gfxinfo assignment relying on a following gfx_exit=\$?" {
  # The buggy form assigned gfx_output on its own line, then read gfx_exit=$?
  # on the next — unreachable under set -e. Ensure gfx_output is only assigned
  # inside the if-condition now.
  local bare
  bare="$(code | grep -nE '^[[:space:]]*gfx_output=\$\(' || true)"
  [ -z "$bare" ]
}
