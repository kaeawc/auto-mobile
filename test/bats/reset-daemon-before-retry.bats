#!/usr/bin/env bats

SCRIPT="scripts/android/reset-daemon-before-retry.sh"

setup() {
  SCRIPT_ABS="$(cd "$(dirname "$SCRIPT")" && pwd)/$(basename "$SCRIPT")"
  TEST_DIR="$(mktemp -d)"
  FAKE_BIN="${TEST_DIR}/bin"
  mkdir -p "$FAKE_BIN" "${TEST_DIR}/home"
  export DAEMON_CALLS="${TEST_DIR}/daemon-calls"

  cat > "${FAKE_BIN}/auto-mobile" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DAEMON_CALLS"
case "${DAEMON_RESULT:-success}" in
  error) echo "stub daemon stop failed"; exit 7 ;;
  stopped) echo "Daemon is not running" ;;
  *) echo "Daemon stopped" ;;
esac
EOF
  chmod +x "${FAKE_BIN}/auto-mobile"
}

teardown() {
  rm -rf "$TEST_DIR"
}

run_reset() {
  run env HOME="${TEST_DIR}/home" GITHUB_WORKSPACE="$TEST_DIR" \
    PATH="${FAKE_BIN}:${PATH}" "$@" bash "$SCRIPT_ABS"
}

@test "stops the daemon before retry" {
  run_reset
  [ "$status" -eq 0 ]
  [ "$(cat "$DAEMON_CALLS")" = "--daemon stop" ]
  [[ "$output" == *"Daemon stopped successfully"* ]]
}

@test "logs a stop error and still permits the retry" {
  run_reset DAEMON_RESULT=error
  [ "$status" -eq 0 ]
  [ "$(cat "$DAEMON_CALLS")" = "--daemon stop" ]
  [[ "$output" == *"Daemon reset errored (exit 7)"* ]]
}

@test "accepts an already stopped daemon" {
  run_reset DAEMON_RESULT=stopped
  [ "$status" -eq 0 ]
  [ "$(cat "$DAEMON_CALLS")" = "--daemon stop" ]
  [[ "$output" == *"Daemon already stopped"* ]]
}

@test "logs a timeout and still permits the retry" {
  cat > "${FAKE_BIN}/timeout" <<'EOF'
#!/usr/bin/env bash
exit 124
EOF
  chmod +x "${FAKE_BIN}/timeout"

  run_reset
  [ "$status" -eq 0 ]
  [[ "$output" == *"Daemon reset timed out after 20 seconds"* ]]
}
