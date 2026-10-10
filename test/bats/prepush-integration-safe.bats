#!/usr/bin/env bats
# Exercises scripts/prepush-integration-safe.sh against a fake `bun` on PATH.
# The real safe tier is never executed from here.

ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
SCRIPT="$ROOT/scripts/prepush-integration-safe.sh"
ISOLATION_VARS=(
  AUTOMOBILE_DATA_DIR
  AUTOMOBILE_LOG_DIR
  AUTOMOBILE_DB_DIR
  AUTOMOBILE_COORDINATION_DIR
  AUTOMOBILE_AUX_SOCKET_DIR
  AUTOMOBILE_DAEMON_SOCKET_PATH
  AUTOMOBILE_DAEMON_PID_FILE_PATH
  AUTOMOBILE_DAEMON_LOCK_FILE_PATH
)

setup() {
  FAKE_BIN="$BATS_TEST_TMPDIR/bin"
  FAKE_HOME="$BATS_TEST_TMPDIR/home"
  FAKE_TMP="$BATS_TEST_TMPDIR/tmp"
  BUN_LOG="$BATS_TEST_TMPDIR/bun.log"
  TIER_FILE="$BATS_TEST_TMPDIR/tier.txt"
  mkdir -p "$FAKE_BIN" "$FAKE_HOME" "$FAKE_TMP"
  export BUN_LOG

  cat > "$FAKE_BIN/bun" <<'SHIM'
#!/bin/bash
{
  printf 'ARGS %s\n' "$*"
  printf 'CWD_WORK_EXISTS %s\n' "$([[ -d "$AUTOMOBILE_DATA_DIR" ]] && echo yes || echo no)"
  env | grep '^AUTOMOBILE_' | sort
} > "$BUN_LOG"
if [[ -n "${FAKE_BUN_OUTPUT:-}" ]]; then
  printf '%s\n' "$FAKE_BUN_OUTPUT"
fi
exit "${FAKE_BUN_STATUS:-0}"
SHIM
  chmod +x "$FAKE_BIN/bun"

  # Two real repo files stand in for integration tests; the runner only checks they exist.
  cat > "$TIER_FILE" <<'EOF'
# comment line
package.json | safe | pure fakes over a temp dir
README.md | unsafe | Bun.spawn of a real process
EOF
}

run_script() {
  run env PATH="$FAKE_BIN:$PATH" HOME="$FAKE_HOME" TMPDIR="${RUN_TMPDIR:-$FAKE_TMP}" \
    AUTOMOBILE_INTEGRATION_SAFE_TIER_FILE="$TIER_FILE" "$@" bash "$SCRIPT"
}

@test "runs only safe files with every isolation variable under one fresh temp dir" {
  run_script

  [ "$status" -eq 0 ]
  [[ "$output" == *"Safe integration tier: ok"* ]]
  grep -q 'package.json' "$BUN_LOG"
  ! grep -q 'README.md' "$BUN_LOG"
  grep -q '^ARGS test --isolate --timeout ' "$BUN_LOG"
  grep -q '^CWD_WORK_EXISTS yes' "$BUN_LOG"

  local var value work_dir=""
  for var in "${ISOLATION_VARS[@]}"; do
    value="$(grep "^${var}=" "$BUN_LOG" | cut -d= -f2-)"
    [ -n "$value" ]
    [[ "$value" == "$FAKE_TMP"/am-int-safe.* ]]
    case "$value" in "$FAKE_HOME"/*) false ;; esac
    if [[ -z "$work_dir" ]]; then
      work_dir="${value%/*}"
    fi
    [ "${value%/*}" = "$work_dir" ]
  done
  # The temp dir is removed when the run ends.
  [ ! -e "$work_dir" ]
}

@test "overrides isolation variables inherited from the caller" {
  run_script AUTOMOBILE_DATA_DIR="$FAKE_HOME/.auto-mobile" AUTOMOBILE_DAEMON_SOCKET_PATH=/tmp/auto-mobile-daemon-501.sock

  [ "$status" -eq 0 ]
  ! grep -q "$FAKE_HOME/.auto-mobile" "$BUN_LOG"
  ! grep -q 'auto-mobile-daemon-501' "$BUN_LOG"
}

@test "refuses when the temp base is under ~/.auto-mobile" {
  mkdir -p "$FAKE_HOME/.auto-mobile/tmp"
  RUN_TMPDIR="$FAKE_HOME/.auto-mobile/tmp"

  run_script

  [ "$status" -eq 2 ]
  [[ "$output" == *"Refusing to run"* ]]
  [[ "$output" == *"~/.auto-mobile"* ]]
  [ ! -e "$BUN_LOG" ]
}

@test "refuses when the temp base is under /tmp/auto-mobile-daemon-*" {
  RUN_TMPDIR="/tmp/auto-mobile-daemon-501-fixture"

  run_script

  [ "$status" -eq 2 ]
  [[ "$output" == *"Refusing to run"* ]]
  [[ "$output" == *"/tmp/auto-mobile-daemon-*"* ]]
  [ ! -e "$BUN_LOG" ]
}

@test "prints a compact failure list and keeps the exit status" {
  run_script FAKE_BUN_STATUS=1 FAKE_BUN_OUTPUT=$'package.json:\n(fail) suite > does a thing [1.20ms]\n 0 pass\n 1 fail'

  [ "$status" -eq 1 ]
  [[ "$output" == *"Safe integration tier: FAILED (exit 1)"* ]]
  [[ "$output" == *"package.json :: suite > does a thing"* ]]
}

@test "fails when a listed safe file is missing" {
  printf 'test/does-not-exist.integration.test.ts | safe | fixture\n' > "$TIER_FILE"

  run_script

  [ "$status" -eq 2 ]
  [[ "$output" == *"listed but missing"* ]]
  [ ! -e "$BUN_LOG" ]
}

@test "fails when the tier list has no safe files" {
  printf 'README.md | unsafe | Bun.spawn\n' > "$TIER_FILE"

  run_script

  [ "$status" -eq 2 ]
  [[ "$output" == *"No safe integration files"* ]]
}
