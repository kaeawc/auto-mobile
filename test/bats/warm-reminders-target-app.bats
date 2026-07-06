#!/usr/bin/env bats
#
# Tests for scripts/ci/warm-reminders-target-app.sh
# Mocks the `auto-mobile` CLI so no real daemon/simulator/Reminders app is required.

SCRIPT="scripts/ci/warm-reminders-target-app.sh"

setup() {
  MOCK_BIN="$(mktemp -d)"
  ORIG_PATH="$PATH"
  ORIG_HOME="$HOME"
  FAKE_HOME="$(mktemp -d)"
  export HOME="$FAKE_HOME"
  export STATE_FILE="${MOCK_BIN}/warmup-calls"
  export INVOCATION_FILE="${MOCK_BIN}/invocations"
}

teardown() {
  rm -rf "$MOCK_BIN" "$FAKE_HOME"
  export PATH="$ORIG_PATH"
  export HOME="$ORIG_HOME"
}

make_mock_auto_mobile() {
  local ready_after="$1"
  cat > "${MOCK_BIN}/auto-mobile" <<SCRIPT
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "${INVOCATION_FILE}"
if [ "\$1" = "--cli" ] && [ "\$2" = "launchApp" ]; then
  calls=0
  [ -f "${STATE_FILE}" ] && calls="\$(cat "${STATE_FILE}")"
  calls=\$((calls + 1))
  echo "\$calls" > "${STATE_FILE}"
  if [ "\$calls" -gt "${ready_after}" ]; then
    echo '{"success":true}'
    exit 0
  fi
  echo "launch failed" >&2
  exit 1
fi
if [ "\$1" = "--cli" ] && [ "\$2" = "observe" ]; then
  echo '{"viewHierarchy":{}}'
  exit 0
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

@test "launches Reminders and observes on the first ready attempt" {
  make_mock_auto_mobile 0
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Reminders target app ready"* ]]
  grep -q -- "--cli launchApp --platform ios --appId com.apple.reminders" "$INVOCATION_FILE"
  grep -q -- "--cli observe --platform ios" "$INVOCATION_FILE"
}

@test "retries launch and observe until Reminders is ready" {
  make_mock_auto_mobile 2
  run env REMINDERS_TARGET_READY_MAX_ATTEMPTS=5 REMINDERS_TARGET_READY_DELAY_SECONDS=0 bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Reminders target app ready"* ]]
}

@test "fails with a bounded error when Reminders never becomes ready" {
  make_mock_auto_mobile 999
  run env REMINDERS_TARGET_READY_MAX_ATTEMPTS=2 REMINDERS_TARGET_READY_DELAY_SECONDS=0 bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"did not become ready after 2 attempts"* ]]
}
