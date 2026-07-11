#!/usr/bin/env bats
#
# Tests for scripts/ios/start-simulator.sh timeout handling
#
# Regression guard for #3644: the boot wait used GNU `timeout`, which is absent
# on stock macOS (only `gtimeout` when coreutils is brew-installed). Inside
# `if ! timeout ...` the resulting 127 read as "boot failed", so the script
# reported failure even when the simulator booted — on the local-macOS path its
# header advertises. The fix resolves timeout/gtimeout with a pure-bash fallback.

SCRIPT="scripts/ios/start-simulator.sh"

setup() {
  ABS_SCRIPT="$(cd "$(dirname "$SCRIPT")" && pwd)/$(basename "$SCRIPT")"
  WORK_DIR="$(mktemp -d)"
  # A PATH with only bash + sleep (no `timeout`/`gtimeout`), to force the
  # pure-bash fallback path deterministically. The fallback needs no other
  # external tools (command/kill/wait are builtins).
  BIN_DIR="$(mktemp -d)"
  ln -s "$(command -v bash)" "$BIN_DIR/bash"
  ln -s "$(command -v sleep)" "$BIN_DIR/sleep"

  # Extract run_with_timeout now (full PATH → awk available); run it later
  # under the restricted PATH by sourcing this file.
  FN_FILE="$WORK_DIR/run_with_timeout.sh"
  awk '/^run_with_timeout\(\) \{/{f=1} f{print} f&&/^\}/{exit}' "$ABS_SCRIPT" > "$FN_FILE"
}

teardown() {
  rm -rf "$BIN_DIR" "$WORK_DIR"
}

# $1 = snippet to eval after sourcing run_with_timeout, under the restricted PATH.
run_helper() {
  run env PATH="$BIN_DIR" bash -c 'source "$1"; eval "$2"' _ "$FN_FILE" "$1"
}

@test "boot wait no longer calls bare GNU timeout (uses run_with_timeout)" {
  local hits
  hits="$(grep -vE '^\s*#' "$SCRIPT" | grep -E '(^|[^_])timeout .*bootstatus' || true)"
  [ -z "$hits" ]
}

@test "run_with_timeout succeeds via bash fallback when timeout/gtimeout absent" {
  # Sanity: neither timeout nor gtimeout resolvable here.
  run env PATH="$BIN_DIR" bash -c 'command -v timeout || command -v gtimeout'
  [ "$status" -ne 0 ]

  run_helper 'run_with_timeout 5 true; echo "rc=$?"'
  [ "$status" -eq 0 ]
  [[ "$output" == *"rc=0"* ]]
}

@test "run_with_timeout reports failure when the command exceeds the limit" {
  run_helper 'run_with_timeout 1 sleep 5; echo "rc=$?"'
  [ "$status" -eq 0 ]
  [[ "$output" != *"rc=0"* ]]
}
