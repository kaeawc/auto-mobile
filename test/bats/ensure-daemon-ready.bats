#!/usr/bin/env bats
#
# Tests for scripts/ci/ensure-daemon-ready.sh
# These tests mock the `auto-mobile` CLI so no real daemon/device is required.

SCRIPT="scripts/ci/ensure-daemon-ready.sh"

setup() {
  MOCK_BIN="$(mktemp -d)"
  ORIG_PATH="$PATH"
  # Isolate HOME so the script's ~/.bun/bin refresh cannot pick up a real CLI.
  ORIG_HOME="$HOME"
  FAKE_HOME="$(mktemp -d)"
  export HOME="$FAKE_HOME"
  # Health-poll state file lets the mock become ready after N calls.
  export STATE_FILE="${MOCK_BIN}/health-calls"
}

teardown() {
  rm -rf "$MOCK_BIN" "$FAKE_HOME"
  export PATH="$ORIG_PATH"
  export HOME="$ORIG_HOME"
}

# Writes a mock `auto-mobile` that becomes healthy after $1 failed health polls.
make_mock_auto_mobile() {
  local ready_after="$1"
  cat > "${MOCK_BIN}/auto-mobile" <<SCRIPT
#!/usr/bin/env bash
if [ "\$1" = "--daemon" ] && [ "\$2" = "start" ]; then
  exit 0
elif [ "\$1" = "--daemon" ] && [ "\$2" = "health" ]; then
  calls=0
  [ -f "${STATE_FILE}" ] && calls="\$(cat "${STATE_FILE}")"
  calls=\$((calls + 1))
  echo "\$calls" > "${STATE_FILE}"
  if [ "\$calls" -gt "${ready_after}" ]; then
    exit 0
  fi
  exit 1
fi
exit 0
SCRIPT
  chmod +x "${MOCK_BIN}/auto-mobile"
  export PATH="${MOCK_BIN}:${PATH}"
}

@test "script is executable" {
  [ -x "$SCRIPT" ]
}

@test "script has bash shebang" {
  head -1 "$SCRIPT" | grep -q "bash"
}

@test "fails fast with a clear diagnostic when auto-mobile is not on PATH" {
  # No mock created and PATH stripped to system dirs → auto-mobile is unresolvable.
  run env PATH="/usr/bin:/bin" bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"auto-mobile is not on PATH"* ]]
  [[ "$output" == *"bun add -g"* ]]
}

@test "succeeds once the daemon reports healthy on the first poll" {
  make_mock_auto_mobile 0
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Daemon ready after 1 attempt"* ]]
}

@test "polls with backoff until the daemon becomes healthy" {
  make_mock_auto_mobile 2
  run env DAEMON_READY_MAX_ATTEMPTS=5 DAEMON_READY_DELAY_SECONDS=0 bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Daemon ready after 3 attempt"* ]]
}

@test "fails with a bounded error when the daemon never becomes healthy" {
  make_mock_auto_mobile 999
  run env DAEMON_READY_MAX_ATTEMPTS=2 DAEMON_READY_DELAY_SECONDS=0 bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"did not become ready after 2 attempts"* ]]
}
