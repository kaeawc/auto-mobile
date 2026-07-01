#!/usr/bin/env bats
#
# Tests for scripts/ci/ensure-ctrl-proxy-ready.sh
# Mocks the `auto-mobile` CLI so no real daemon/simulator/CtrlProxy is required.

SCRIPT="scripts/ci/ensure-ctrl-proxy-ready.sh"

setup() {
  MOCK_BIN="$(mktemp -d)"
  ORIG_PATH="$PATH"
  ORIG_HOME="$HOME"
  FAKE_HOME="$(mktemp -d)"
  export HOME="$FAKE_HOME"
  export STATE_FILE="${MOCK_BIN}/observe-calls"
}

teardown() {
  rm -rf "$MOCK_BIN" "$FAKE_HOME"
  export PATH="$ORIG_PATH"
  export HOME="$ORIG_HOME"
}

# Writes a mock `auto-mobile` whose `observe` succeeds after $1 failed attempts.
make_mock_auto_mobile() {
  local ready_after="$1"
  cat > "${MOCK_BIN}/auto-mobile" <<SCRIPT
#!/usr/bin/env bash
if [ "\$1" = "--cli" ] && [ "\$2" = "observe" ]; then
  calls=0
  [ -f "${STATE_FILE}" ] && calls="\$(cat "${STATE_FILE}")"
  calls=\$((calls + 1))
  echo "\$calls" > "${STATE_FILE}"
  if [ "\$calls" -gt "${ready_after}" ]; then
    echo '{"viewHierarchy":{}}'
    exit 0
  fi
  echo "observe failed" >&2
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

@test "fails fast when auto-mobile is not on PATH" {
  run env PATH="/usr/bin:/bin" bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"auto-mobile is not on PATH"* ]]
}

@test "succeeds on the first observe when CtrlProxy is already up" {
  make_mock_auto_mobile 0
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"CtrlProxy ready"* ]]
}

@test "retries observe until CtrlProxy comes up" {
  make_mock_auto_mobile 2
  run env CTRL_PROXY_READY_MAX_ATTEMPTS=5 CTRL_PROXY_READY_DELAY_SECONDS=0 bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"CtrlProxy ready"* ]]
}

@test "fails with a bounded error when CtrlProxy never comes up" {
  make_mock_auto_mobile 999
  run env CTRL_PROXY_READY_MAX_ATTEMPTS=2 CTRL_PROXY_READY_DELAY_SECONDS=0 bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"did not become ready after 2 observe attempts"* ]]
}
