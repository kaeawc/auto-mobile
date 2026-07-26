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
  if [ "\$3" = "--debug" ]; then
    printf '%s\n' "enabled" > "${MOCK_BIN}/debug-mode"
  fi
  printf '%s\n' "\${AUTOMOBILE_DAEMON_STARTUP_TIMEOUT_MS:-unset}" > "${MOCK_BIN}/startup-timeout"
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

@test "fails fast with a clear diagnostic when auto-mobile is unresolvable and no built entry exists" {
  # No mock, PATH stripped, and an empty workspace → nothing to link, so it fails loudly.
  EMPTY_WS="$(mktemp -d)"
  run env PATH="/usr/bin:/bin" GITHUB_WORKSPACE="$EMPTY_WS" bash "$SCRIPT"
  rm -rf "$EMPTY_WS"
  [ "$status" -eq 1 ]
  [[ "$output" == *"no built entrypoint"* ]]
}

@test "links auto-mobile onto the built workspace entry when the global install is missing" {
  # Simulate a runner where `bun add -g .` left no runnable bin, but the build did
  # produce dist/src/index.js. The script should link to it and reach the daemon.
  WS="$(mktemp -d)"
  mkdir -p "${WS}/dist/src"
  cat > "${WS}/dist/src/index.js" <<'SCRIPT'
#!/usr/bin/env bash
if [ "$1" = "--daemon" ] && { [ "$2" = "start" ] || [ "$2" = "health" ]; }; then
  exit 0
fi
exit 0
SCRIPT
  chmod +x "${WS}/dist/src/index.js"

  run env PATH="/usr/bin:/bin" GITHUB_WORKSPACE="$WS" bash "$SCRIPT"
  rm -rf "$WS"
  [ "$status" -eq 0 ]
  [[ "$output" == *"linking"* ]]
  [[ "$output" == *"Daemon ready"* ]]
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

@test "gives the cold-runner daemon a 30s startup ceiling by default" {
  make_mock_auto_mobile 0
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(cat "${MOCK_BIN}/startup-timeout")" = "30000" ]
}

@test "respects an explicit daemon startup timeout override" {
  make_mock_auto_mobile 0
  run env AUTOMOBILE_DAEMON_STARTUP_TIMEOUT_MS=45000 bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(cat "${MOCK_BIN}/startup-timeout")" = "45000" ]
}

@test "starts the daemon in debug mode when requested" {
  make_mock_auto_mobile 0
  run env AUTOMOBILE_DAEMON_DEBUG=1 bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(cat "${MOCK_BIN}/debug-mode")" = "enabled" ]
}
