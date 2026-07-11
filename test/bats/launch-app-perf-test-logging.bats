#!/usr/bin/env bats
#
# Tests for the logging helpers in scripts/launch_app_perf_test.sh
#
# Regression guard for #3648: log_debug used `echo "$msg" >> "$DEBUG_LOG" >&2`,
# where the trailing `>&2` repoints stdout to stderr *after* the file redirect,
# so debug lines went to stderr and never reached the log file. This test
# extracts the log_debug function from the script and exercises it in isolation.

SCRIPT="scripts/launch_app_perf_test.sh"

setup() {
  WORK_DIR="$(mktemp -d)"
  # Load only the log_debug function definition (no side effects / no main).
  eval "$(sed -n '/^log_debug() {/,/^}/p' "$SCRIPT")"
}

teardown() {
  rm -rf "$WORK_DIR"
}

@test "log_debug writes the message to the debug log file" {
  DEBUG_LOG="$WORK_DIR/debug.log"
  log_debug "sentinel-debug-line"
  [ -f "$DEBUG_LOG" ]
  grep -q 'sentinel-debug-line' "$DEBUG_LOG"
  grep -q '\[DEBUG\]' "$DEBUG_LOG"
}
